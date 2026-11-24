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
import { getDbInstance } from "@/lib/db/core";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

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

function parseJsonArray(value: unknown): string[] {
  if (!value || typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((e): e is string => typeof e === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Extract the API key from either the `?key=` query parameter or the
 * `X-API-Key` request header.
 */
function extractKey(request: Request): string | null {
  const url = new URL(request.url);
  const queryKey = url.searchParams.get("key");
  if (queryKey && queryKey.trim().length > 0) return queryKey.trim();

  const headerKey = request.headers.get("x-api-key");
  if (headerKey && headerKey.trim().length > 0) return headerKey.trim();

  return null;
}

/**
 * Classify the key's strategy based on its limit/quota rows and expiry.
 */
function classifyStrategy(
  tokenLimits: JsonRecord | null,
  quotaLimits: JsonRecord | null,
  apiKeyRow: JsonRecord
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
  const isActive = toBoolean(apiKeyRow.is_active);
  const revokedAt = toStringOrNull(apiKeyRow.revoked_at);

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
  const maxReqDay = toNumber(apiKeyRow.max_requests_per_day);
  const maxReqMin = toNumber(apiKeyRow.max_requests_per_minute);
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
  const expiresAt = toStringOrNull(apiKeyRow.expires_at);
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
    const dbRec = db as unknown as { prepare: (sql: string) => JsonRecord };

    // Look up the key row directly by the key string
    const keyRow = dbRec
      .prepare("SELECT * FROM api_keys WHERE key = ?")
      .get(apiKey) as JsonRecord | undefined;

    if (!keyRow) {
      return NextResponse.json({ error: "API key not found" }, { status: 404 });
    }

    const apiKeyId = keyRow.id as string;

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

    const strategyInfo = classifyStrategy(tokenLimits, quotaLimits, keyRow);

    const tokensUsed = toNumber(tokenCounters?.tokens_used);
    const tokensLimit = strategyInfo.tokenLimit;
    const tokensRemaining =
      tokensLimit && tokensLimit > 0 ? Math.max(0, tokensLimit - tokensUsed) : null;
    const usagePercent =
      tokensLimit && tokensLimit > 0
        ? Math.round((tokensUsed / tokensLimit) * 10000) / 100
        : null;

    // Merge allowed_models and allowed_combos
    const allowedModels = parseJsonArray(keyRow.allowed_models);
    const allowedCombos = parseJsonArray(keyRow.allowed_combos);
    const mergedModels = [...new Set([...allowedModels, ...allowedCombos])];

    const rateLimits = parseJsonArray(keyRow.rate_limits);

    return NextResponse.json({
      key_name: keyRow.name || null,
      is_active: toBoolean(keyRow.is_active),
      created_at: keyRow.created_at || null,
      expires_at: keyRow.expires_at || null,
      last_used_at: keyRow.last_used_at || null,
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
      rate_limit: rateLimits.length > 0 ? rateLimits : null,
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
