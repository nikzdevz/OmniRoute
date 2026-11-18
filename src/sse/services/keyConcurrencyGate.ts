/**
 * keyConcurrencyGate — per-API-key concurrency admission (fail-fast).
 *
 * Caps the number of in-flight chat requests admitted for a single API key.
 * The cap is the key's `max_concurrent` column (0/NULL = unlimited). Unlike
 * the provider-connection semaphore (accountSemaphore with its bounded
 * queue), this gate is strictly fail-fast: when every slot for the key is
 * held, the request is rejected immediately with 429 — it never queues.
 *
 * Slots are released through the admission lease composition
 * ({@link attachKeySlotRelease}), so the release rides the same response
 * lifecycle the adaptive admission runtime already owns: stream end, client
 * disconnect, or handler throw.
 */

import { acquire } from "@omniroute/open-sse/services/accountSemaphore.ts";
import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";
import { CORS_HEADERS } from "@omniroute/open-sse/utils/cors.ts";
import { getApiKeyConcurrencyCap } from "@/lib/db/apiKeys";

export const API_KEY_CONCURRENCY_LIMITED_CODE = "api_key_concurrency_limited";

/** Process-wide gate key for one API key. Namespaced so it can never collide with the
 * provider:accountKey gates owned by accountSemaphore. */
export function buildApiKeyConcurrencyGateKey(apiKeyId: string): string {
  return `apikey:${apiKeyId}`;
}

export type KeyConcurrencySlot = { release(): void };

export type KeyConcurrencyAcquireResult =
  | { status: "bypass" }
  | { status: "admitted"; slot: KeyConcurrencySlot }
  | { status: "limited"; response: Response };

/**
 * Short TTL cache so the admission hot path does not hit SQLite per request.
 * A cap change made in the dashboard takes effect within this window.
 */
const CAP_CACHE_TTL_MS = 5_000;
const capCache = new Map<string, { cap: number; ts: number }>();

function resolveCapCached(apiKeyId: string): number {
  const cached = capCache.get(apiKeyId);
  const now = Date.now();
  if (cached && now - cached.ts < CAP_CACHE_TTL_MS) return cached.cap;
  const cap = getApiKeyConcurrencyCap(apiKeyId);
  if (capCache.size > 2000) capCache.clear();
  capCache.set(apiKeyId, { cap, ts: now });
  return cap;
}

export function resetKeyConcurrencyCapCacheForTests(): void {
  capCache.clear();
}

function buildLimitedResponse(): Response {
  const body = buildErrorBody(429, "API key concurrency limit reached", undefined, {
    type: "rate_limit_error",
    code: API_KEY_CONCURRENCY_LIMITED_CODE,
  });
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, "Retry-After": "1" },
  });
}

/**
 * Try to take one concurrency slot for the API key.
 *
 * - `bypass`: no key, or cap unset/0 (unlimited) — no gating.
 * - `admitted`: slot taken; the caller MUST release it when the request ends.
 * - `limited`: every slot is held — the 3rd concurrent request fails here.
 */
export async function tryAcquireApiKeyConcurrencySlot(
  apiKeyId: string | null | undefined,
  deps: { resolveCap?: (id: string) => number } = {}
): Promise<KeyConcurrencyAcquireResult> {
  if (!apiKeyId || typeof apiKeyId !== "string" || apiKeyId.trim() === "") {
    return { status: "bypass" };
  }
  const cap = (deps.resolveCap ?? resolveCapCached)(apiKeyId);
  if (!(cap > 0)) return { status: "bypass" };

  try {
    // failFast: never queue. When the gate is full the promise rejects with
    // SEMAPHORE_QUEUE_FULL and we convert that into the 429 response.
    const release = await acquire(buildApiKeyConcurrencyGateKey(apiKeyId), {
      maxConcurrency: cap,
      failFast: true,
      maxQueueSize: 0,
    });
    return { status: "admitted", slot: { release } };
  } catch {
    return { status: "limited", response: buildLimitedResponse() };
  }
}

/**
 * Shape of an admission lease the composite release can wrap. Structural so the
 * gate does not need to import the admission types.
 */
interface ReleasableLease {
  id: string;
  cost: number;
  readonly released: boolean;
  release(outcome?: unknown, meta?: unknown): void;
}

/**
 * Wrap an admission lease so releasing it also releases the key-concurrency
 * slot. The wrapper owns its own released flag: the runtime's release-once
 * guard consults `released` before calling `release()`, and the inner lease
 * may already report released in some modes (e.g. admission "off" admits
 * virtual no-op leases). Reporting not-released until BOTH are released keeps
 * the key slot release reachable in every mode.
 */
export function attachKeySlotRelease<L extends ReleasableLease>(
  lease: L,
  keySlotRelease: () => void
): L {
  let keyReleased = false;
  const composite = {
    id: lease.id,
    cost: lease.cost,
    get released(): boolean {
      return keyReleased && lease.released;
    },
    release(outcome?: unknown, meta?: unknown): void {
      if (keyReleased) return;
      keyReleased = true;
      keySlotRelease();
      lease.release(outcome, meta);
    },
  };
  return composite as unknown as L;
}
