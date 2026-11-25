/**
 * Public API key information endpoint.
 *
 * GET /api/key-info?key=<api-key>
 * or
 * GET /api/key-info  with header: X-API-Key: <api-key>
 *
 * Returns only metadata about the requested API key. No admin authentication
 * is required — the API key itself is the authorization.
 */

import { NextResponse } from "next/server";
import { getApiKeyById, getApiKeyMetadata } from "@/lib/db/apiKeys";
import { getDbInstance } from "@/lib/db/core";

type JsonRecord = Record<string, unknown>;

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toBoolean(value: unknown): boolean {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return false;
}

/**
 * Extract the API key from any of these sources, in priority order:
 *   1. `?key=` query parameter
 *   2. `X-API-Key` request header
 *   3. `Authorization: Bearer <key>` header
 */
function extractKey(request: Request): string | null {
  const url = new URL(request.url);
  const queryKey = url.searchParams.get("key");
  if (queryKey && queryKey.trim().length > 0) return queryKey.trim();

  const headerKey = request.headers.get("x-api-key");
  if (headerKey && headerKey.trim().length > 0) return headerKey.trim();

  const authHeader = request.headers.get("authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch && bearerMatch[1].trim().length > 0) return bearerMatch[1].trim();

  return null;
}

/**
 * Classify the key's strategy based on its limit/quota rows and expiry.
 */
function classifyStrategy(
  tokenLimits: JsonRecord | null,
  quotaLimits: JsonRecord | null,
  metadata: {
    isActive: boolean;
    revokedAt: string | null;
    expiresAt: string | null;
    maxRequestsPerDay: number | null;
    maxRequestsPerMinute: number | null;
  }
): {
  strategy: string;
  isUnlimited: boolean;
  hasTokenLimit: boolean;
  hasQuotaWindow: boolean;
  tokenLimit: number | null;
  resetInterval: string | null;
  resetTime: string | null;
  quotaWindow: string | null;
} {
  const isActive = metadata.isActive;
  const revokedAt = metadata.revokedAt;

  if (!isActive || revokedAt) {
    return {
      strategy: "revoked",
      isUnlimited: false,
      hasTokenLimit: false,
      hasQuotaWindow: false,
      tokenLimit: null,
      resetInterval: null,
      resetTime: null,
      quotaWindow: null,
    };
  }

  // 1) Hard token limit with reset interval
  if (tokenLimits && toBoolean(tokenLimits.enabled)) {
    const tokenLimit = toNumber(tokenLimits.token_limit) || null;
    const resetInterval = toStringOrNull(tokenLimits.reset_interval) || null;
    const resetTime = toStringOrNull(tokenLimits.reset_time) || null;

    if (tokenLimit && tokenLimit > 0) {
      let strategy: string;
      let quotaWindow: string | null = null;

      switch (resetInterval) {
        case "daily":
          strategy = "token-based with daily quota window";
          quotaWindow = "daily";
          break;
        case "weekly":
          strategy = "token-based with weekly quota window";
          quotaWindow = "weekly";
          break;
        case "monthly":
        default:
          strategy = "monthly-based token limit";
          quotaWindow = "monthly";
          break;
      }

      return {
        strategy,
        isUnlimited: false,
        hasTokenLimit: true,
        hasQuotaWindow: true,
        tokenLimit,
        resetInterval,
        resetTime,
        quotaWindow,
      };
    }

    // Token limit row exists but no actual token_limit value
    return {
      strategy: "unlimited with no expiration date",
      isUnlimited: true,
      hasTokenLimit: false,
      hasQuotaWindow: false,
      tokenLimit: null,
      resetInterval: resetInterval || null,
      resetTime: resetTime || null,
      quotaWindow: null,
    };
  }

  // 2) Quota-based limits
  if (quotaLimits) {
    const tpm = toNumber(quotaLimits.tpm_limit);
    const rpm = toNumber(quotaLimits.rpm_limit);
    const monthlyUsd = toNumber(quotaLimits.monthly_amount_usd);

    let parts: string[] = [];
    if (tpm && tpm > 0) parts.push(`${tpm} tokens/min`);
    if (rpm && rpm > 0) parts.push(`${rpm} requests/min`);
    if (monthlyUsd && monthlyUsd > 0) parts.push(`$${monthlyUsd}/month`);

    if (parts.length > 0) {
      return {
        strategy: "quota-based",
        isUnlimited: false,
        hasTokenLimit: false,
        hasQuotaWindow: true,
        tokenLimit: null,
        resetInterval: null,
        resetTime: null,
        quotaWindow: "rate-based",
      };
    }
  }

  // 3) Request-based limits on the key itself
  const maxReqDay = toNumber(metadata.maxRequestsPerDay);
  const maxReqMin = toNumber(metadata.maxRequestsPerMinute);
  if (maxReqDay && maxReqDay > 0) {
    return {
      strategy: "quota-based",
      isUnlimited: false,
      hasTokenLimit: false,
      hasQuotaWindow: true,
      tokenLimit: null,
      resetInterval: null,
      resetTime: null,
      quotaWindow: "daily requests",
    };
  }
  if (maxReqMin && maxReqMin > 0) {
    return {
      strategy: "quota-based",
      isUnlimited: false,
      hasTokenLimit: false,
      hasQuotaWindow: true,
      tokenLimit: null,
      resetInterval: null,
      resetTime: null,
      quotaWindow: "minute requests",
    };
  }

  // 4) No limits at all — check expiry
  const expiresAt = metadata.expiresAt;
  if (expiresAt) {
    return {
      strategy: "unlimited but days defined",
      isUnlimited: true,
      hasTokenLimit: false,
      hasQuotaWindow: false,
      tokenLimit: null,
      resetInterval: null,
      resetTime: null,
      quotaWindow: null,
    };
  }

  return {
    strategy: "unlimited with no expiration date",
    isUnlimited: true,
    hasTokenLimit: false,
    hasQuotaWindow: false,
    tokenLimit: null,
    resetInterval: null,
    resetTime: null,
    quotaWindow: null,
  };
}

export async function GET(request: Request): Promise<Response> {
  const apiKey = extractKey(request);

  if (!apiKey) {
    return NextResponse.json(
      {
        error: "API key required",
        hint: "Pass the API key as ?key= or in the X-API-Key header",
      },
      { status: 400 }
    );
  }

  try {
    const db = getDbInstance();
    const dbRec = db as unknown as {
      prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
    };

    // Identity via the hot-path lookup: `getApiKeyMetadata` resolves by SHA-256
    // `key_hash` (the plaintext `key` column is encrypted at rest, `enc:v1:…`,
    // so a raw-string lookup can never match — this was the original 404).
    // It also backfills legacy rows without a hash on lookup miss.
    const metadata = await getApiKeyMetadata(apiKey, { bypassCache: true });
    if (!metadata) {
      return NextResponse.json({ error: "API key not found" }, { status: 404 });
    }

    const apiKeyId = metadata.id;

    // Token limits
    const tokenLimits = dbRec
      .prepare("SELECT * FROM api_key_token_limits WHERE api_key_id = ?")
      .get(apiKeyId) as JsonRecord | null;

    // Token counters (current usage in the active window)
    const tokenCounters = dbRec
      .prepare(
        "SELECT * FROM api_key_token_counters WHERE limit_id = ? ORDER BY window_start DESC LIMIT 1"
      )
      .get(tokenLimits ? tokenLimits.id : null) as JsonRecord | null;

    // Quota limits
    const quotaLimits = dbRec
      .prepare("SELECT * FROM api_key_quota_limits WHERE api_key_id = ?")
      .get(apiKeyId) as JsonRecord | null;

    // Usage history total
    const usageRow = dbRec
      .prepare(
        "SELECT SUM(tokens_input + tokens_output) AS total_tokens, COUNT(*) AS total_requests FROM usage_history WHERE api_key_id = ?"
      )
      .get(apiKeyId) as {
        total_tokens?: number | null;
        total_requests?: number;
      };

    const strategyInfo = classifyStrategy(tokenLimits, quotaLimits, metadata);

    const tokensUsed = toNumber(tokenCounters?.tokens_used);
    const tokensLimit = strategyInfo.tokenLimit;
    const tokensRemaining =
      tokensLimit && tokensLimit > 0 ? Math.max(0, tokensLimit - tokensUsed) : null;
    const usagePercent =
      tokensLimit && tokensLimit > 0
        ? Math.round((tokensUsed / tokensLimit) * 10000) / 100
        : null;

    // Merge allowed_models and allowed_combos (metadata parsers already
    // decoded the JSON columns)
    const mergedModels = [...new Set([...metadata.allowedModels, ...metadata.allowedCombos])];

    const keyRowById = await getApiKeyById(apiKeyId, { readOnly: true });

    return NextResponse.json({
      key_name: metadata.name || null,
      is_active: metadata.isActive,
      created_at: keyRowById?.createdAt || null,
      expires_at: metadata.expiresAt || null,
      last_used_at: keyRowById?.lastUsedAt || null,
      is_unlimited: strategyInfo.isUnlimited,
      has_token_limit: strategyInfo.hasTokenLimit,
      has_quota_window: strategyInfo.hasQuotaWindow,
      token_limit: tokensLimit,
      token_limit_reset_interval: strategyInfo.resetInterval,
      token_limit_reset_time: strategyInfo.resetTime,
      quota_window: strategyInfo.quotaWindow,
      tokens_used: tokensUsed,
      token_remaining: tokensRemaining,
      usage_percentage: usagePercent,
      rate_limit: metadata.rateLimits?.length ? metadata.rateLimits : null,
      tpm_limit: toNumber(quotaLimits?.tpm_limit) || null,
      rpm_limit: toNumber(quotaLimits?.rpm_limit) || null,
      allowed_models: mergedModels,
      usage_history: {
        total_tokens: toNumber(usageRow?.total_tokens),
        total_requests: toNumber(usageRow?.total_requests),
      },
      strategy: strategyInfo.strategy,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Internal server error", detail: message },
      { status: 500 }
    );
  }
}
