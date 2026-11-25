/**
 * Per-combo speed analytics — shared contract between
 * `GET /api/combos/speed-analytics` (server) and the Control Center
 * Speed Analytics card (dashboard).
 *
 * Pure module on purpose: the summary math (most-used model, most-successful
 * model, fallback/RPM rollups) is unit-testable without auth, HTTP or a
 * running scheduler.
 */

export type SpeedAnalyticsRange = "live" | "24h" | "7d" | "30d";

/** Window length per range; `live` reads the in-memory metrics only. */
export const SPEED_ANALYTICS_RANGES: Record<SpeedAnalyticsRange, number> = {
  live: 0,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
};

export function normalizeSpeedAnalyticsRange(value: unknown): SpeedAnalyticsRange {
  return typeof value === "string" && Object.hasOwn(SPEED_ANALYTICS_RANGES, value)
    ? (value as SpeedAnalyticsRange)
    : "live";
}

export interface SpeedAnalyticsModelEntry {
  modelStr: string;
  provider: string | null;
  requests: number;
  /** Share of the combo's requests in this range (0..1). */
  share: number;
  successes: number;
  failures: number;
  /** Successes / requests; null when the model served no requests. */
  successRate: number | null;
  /** Observed 429 attempts in this range; null when the source tracks none (live view). */
  rateLimitedCount: number | null;
  ttftCount: number;
  avgTtftMs: number | null;
  avgDurationMs: number | null;
  lastUsedAt: number | null;
  /** In-memory view only: the metric's ok/error classification of the last attempt. */
  lastStatus?: "ok" | "error" | null;
}

export interface SpeedAnalyticsSummary {
  totalRequests: number;
  successRate: number | null;
  avgTtftMs: number | null;
  mostUsedModel: string | null;
  mostSuccessfulModel: string | null;
  fallbackEvents: number;
  requestsWithFallback: number;
  /** Fallback events per request; null when no requests in range. */
  fallbackRate: number | null;
  /** Sum of per-model 429 attempts; null when the source tracks none (live view). */
  rpmLimitHits: number | null;
}

/**
 * A model only qualifies as "most successful" once it carried real traffic:
 * at least 3 requests and at least 5% of the combo's requests in the range,
 * so one lucky request cannot take the title from the workhorse.
 */
export function minRequestsForMostSuccessful(totalRequests: number): number {
  return Math.max(3, Math.ceil(totalRequests * 0.05));
}

export function computeSpeedAnalyticsSummary(
  models: SpeedAnalyticsModelEntry[],
  fallback: { fallbackEvents: number; requestsWithFallback: number }
): SpeedAnalyticsSummary {
  const totalRequests = models.reduce((sum, m) => sum + m.requests, 0);
  const totalSuccesses = models.reduce((sum, m) => sum + m.successes, 0);
  const ttftCount = models.reduce((sum, m) => sum + m.ttftCount, 0);
  const sumTtftWeighted = models.reduce(
    (sum, m) => sum + (m.avgTtftMs ?? 0) * m.ttftCount,
    0
  );
  const rateLimitedTracks = models.filter((m) => m.rateLimitedCount !== null);
  const rpmLimitHits =
    rateLimitedTracks.length > 0
      ? rateLimitedTracks.reduce((sum, m) => sum + (m.rateLimitedCount ?? 0), 0)
      : null;

  let mostUsedModel: string | null = null;
  let mostUsedRequests = -1;
  for (const m of models) {
    if (m.requests > mostUsedRequests) {
      mostUsedModel = m.modelStr;
      mostUsedRequests = m.requests;
    }
  }
  if (mostUsedRequests <= 0) mostUsedModel = null;

  const minRequests = minRequestsForMostSuccessful(totalRequests);
  let mostSuccessfulModel: string | null = null;
  let bestSuccessRate = -1;
  let bestRequests = -1;
  for (const m of models) {
    if (m.requests < minRequests || m.successRate === null) continue;
    if (m.successRate > bestSuccessRate || (m.successRate === bestSuccessRate && m.requests > bestRequests)) {
      mostSuccessfulModel = m.modelStr;
      bestSuccessRate = m.successRate;
      bestRequests = m.requests;
    }
  }

  return {
    totalRequests,
    successRate: totalRequests > 0 ? totalSuccesses / totalRequests : null,
    avgTtftMs: ttftCount > 0 ? sumTtftWeighted / ttftCount : null,
    mostUsedModel,
    mostSuccessfulModel,
    fallbackEvents: fallback.fallbackEvents,
    requestsWithFallback: fallback.requestsWithFallback,
    fallbackRate: totalRequests > 0 ? fallback.requestsWithFallback / totalRequests : null,
    rpmLimitHits,
  };
}
