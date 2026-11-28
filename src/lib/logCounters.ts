/**
 * In-memory counters for high-volume log events that should be metrics, not log lines.
 * Reset on process restart. Exposed via /api/monitoring/health for observability.
 */

interface CounterBucket {
  count: number;
  since: string;
}

const counters = new Map<string, CounterBucket>();

export function incrementLogCounter(key: string, increment = 1): void {
  const now = Date.now();
  const bucket = counters.get(key);
  if (!bucket) {
    counters.set(key, { count: increment, since: new Date(now).toISOString() });
    return;
  }
  bucket.count += increment;
}

export function getLogCounters(): Record<string, { count: number; since: string }> {
  const result: Record<string, { count: number; since: string }> = {};
  for (const [key, bucket] of counters.entries()) {
    result[key] = { count: bucket.count, since: bucket.since };
  }
  return result;
}

export function resetLogCounters(): void {
  counters.clear();
}

// Well-known counter keys
export const LogCounterKeys = {
  SSE_TRANSFORM_NO_SANITIZE: "sse_transform_no_sanitize",
  PROXY_EGRESS_ERROR: "proxy_egress_error",
} as const;