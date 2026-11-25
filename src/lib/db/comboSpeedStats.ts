/**
 * Per-combo speed/reliability rollups (combo_speed_stats / combo_fallback_stats,
 * migration 243).
 *
 * call_logs rows have short retention, so the per-combo analytics page reads
 * these persisted hourly rollups (24h / 7d / 30d) instead of scanning raw
 * request history. Rows are upsert-accumulated per (combo, stat_key, bucket
 * hour) via the unique indexes, so the writers are plain counter increments.
 *
 * Written from the call_logs insert hook (src/lib/usage/callLogs.ts) and from
 * the fallback flusher (open-sse/services/comboSpeedStatsFlush.ts). Every
 * function tolerates a database booted before the migration: a missing table
 * drops the sample or reads as empty instead of throwing.
 */

import { getDbInstance } from "./core";

/** One hour in epoch ms; buckets are floored to this boundary. */
const HOUR_MS = 3_600_000;

export interface ComboSpeedStatRow {
  statKey: string;
  provider: string | null;
  model: string;
  requests: number;
  successes: number;
  failures: number;
  rateLimitedCount: number;
  ttftCount: number;
  sumTtftMs: number;
  sumDurationMs: number;
  lastUsedAt: number | null;
}

function bucketHourFor(timestampMs: number): number {
  return Math.floor(timestampMs / HOUR_MS) * HOUR_MS;
}

/** The sibling modules' pre-migration guard: a missing table is not an error here. */
function isMissingTableError(err: unknown): boolean {
  return String((err as { message?: unknown })?.message ?? err).includes("no such table");
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toFiniteCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Accumulate one combo attempt into the hourly speed/reliability rollup.
 *
 * Success convention mirrors comboHealth.ts performance queries:
 * HTTP 200-399 counts as a success; anything else (including 429) is a
 * failure, and 429 additionally increments rate_limited_count.
 */
export function recordComboSpeedStat(input: {
  comboName: string;
  stepId?: string | null;
  executionKey?: string | null;
  provider?: string | null;
  model: string;
  connectionId?: string | null;
  status: number;
  ttftMs?: number | null;
  durationMs?: number | null;
  timestamp?: number;
}): void {
  const comboName = toOptionalString(input?.comboName);
  if (!comboName) return;

  const model =
    typeof input.model === "string" && input.model.length > 0 ? input.model : "-";
  const statKey = toOptionalString(input.executionKey) ?? `${input.provider ?? ""}/${model}@${input.connectionId ?? ""}`;
  const status = Number(input.status);
  const isSuccess = Number.isFinite(status) && status >= 200 && status < 400;
  const isRateLimited = Number.isFinite(status) && status === 429;
  const ttftMs = typeof input.ttftMs === "number" && Number.isFinite(input.ttftMs) ? input.ttftMs : null;
  const durationMs =
    typeof input.durationMs === "number" && Number.isFinite(input.durationMs) ? input.durationMs : null;
  const timestamp =
    typeof input.timestamp === "number" && Number.isFinite(input.timestamp) ? input.timestamp : Date.now();
  const bucketHour = bucketHourFor(timestamp);
  const now = new Date(timestamp).toISOString();

  const db = getDbInstance();
  try {
    db.prepare(
      `INSERT INTO combo_speed_stats (
         combo_name, stat_key, combo_step_id, combo_execution_key, provider, model,
         connection_id, bucket_hour, requests, successes, failures, rate_limited_count,
         ttft_count, sum_ttft_ms, sum_duration_ms, created_at, updated_at
       ) VALUES (
         @comboName, @statKey, @stepId, @executionKey, @provider, @model,
         @connectionId, @bucketHour, 1, @successes, @failures, @rateLimited,
         @ttftCount, @sumTtftMs, @sumDurationMs, @now, @now
       )
       ON CONFLICT(combo_name, stat_key, bucket_hour) DO UPDATE SET
         requests = requests + 1,
         successes = successes + excluded.successes,
         failures = failures + excluded.failures,
         rate_limited_count = rate_limited_count + excluded.rate_limited_count,
         ttft_count = ttft_count + excluded.ttft_count,
         sum_ttft_ms = sum_ttft_ms + excluded.sum_ttft_ms,
         sum_duration_ms = sum_duration_ms + excluded.sum_duration_ms,
         updated_at = excluded.updated_at`
    ).run({
      comboName,
      statKey,
      stepId: toOptionalString(input.stepId),
      executionKey: toOptionalString(input.executionKey),
      provider: toOptionalString(input.provider),
      model,
      connectionId: toOptionalString(input.connectionId),
      bucketHour,
      successes: isSuccess ? 1 : 0,
      failures: isSuccess ? 0 : 1,
      rateLimited: isRateLimited ? 1 : 0,
      ttftCount: ttftMs !== null ? 1 : 0,
      sumTtftMs: ttftMs ?? 0,
      sumDurationMs: durationMs ?? 0,
      now,
    });
  } catch (err) {
    if (isMissingTableError(err)) return;
    throw err;
  }
}

/**
 * Accumulate fallback counters for one combo into the hourly bucket. Called by
 * the flusher, so a real DB error propagates and the pending entry is retried
 * on the next tick; a missing table (pre-migration DB) just drops the sample.
 */
export function recordComboFallbackEvents(
  comboName: string,
  fallbackEvents: number,
  requestsWithFallback: number,
  timestamp?: number
): void {
  const combo = toOptionalString(comboName);
  if (!combo) return;

  const ts =
    typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Date.now();
  const bucketHour = bucketHourFor(ts);
  const now = new Date(ts).toISOString();

  const db = getDbInstance();
  try {
    db.prepare(
      `INSERT INTO combo_fallback_stats (
         combo_name, bucket_hour, fallback_events, requests_with_fallback,
         created_at, updated_at
       ) VALUES (
         @comboName, @bucketHour, @fallbackEvents, @requestsWithFallback, @now, @now
       )
       ON CONFLICT(combo_name, bucket_hour) DO UPDATE SET
         fallback_events = fallback_events + excluded.fallback_events,
         requests_with_fallback = requests_with_fallback + excluded.requests_with_fallback,
         updated_at = excluded.updated_at`
    ).run({
      comboName: combo,
      bucketHour,
      fallbackEvents: toFiniteCount(fallbackEvents),
      requestsWithFallback: toFiniteCount(requestsWithFallback),
      now,
    });
  } catch (err) {
    if (isMissingTableError(err)) return;
    throw err;
  }
}

/**
 * Hourly rollups for one combo aggregated over the window that starts at
 * `sinceMs` (floored to the hour), grouped per stat key and ordered by
 * request volume. `lastUsedAt` is the newest bucket hour that contributed.
 */
export function getComboSpeedStatsSince(comboName: string, sinceMs: number): ComboSpeedStatRow[] {
  const combo = toOptionalString(comboName);
  if (!combo) return [];

  try {
    const db = getDbInstance();
    const rows = db
      .prepare(
        `SELECT
           stat_key AS statKey,
           provider AS provider,
           model AS model,
           COALESCE(SUM(requests), 0) AS requests,
           COALESCE(SUM(successes), 0) AS successes,
           COALESCE(SUM(failures), 0) AS failures,
           COALESCE(SUM(rate_limited_count), 0) AS rateLimitedCount,
           COALESCE(SUM(ttft_count), 0) AS ttftCount,
           COALESCE(SUM(sum_ttft_ms), 0) AS sumTtftMs,
           COALESCE(SUM(sum_duration_ms), 0) AS sumDurationMs,
           MAX(bucket_hour) AS lastUsedAt
         FROM combo_speed_stats
         WHERE combo_name = @comboName AND bucket_hour >= @sinceBucket
         GROUP BY stat_key, model, provider
         ORDER BY requests DESC`
      )
      .all({ comboName: combo, sinceBucket: bucketHourFor(Number(sinceMs) || 0) }) as Array<{
        statKey: string;
        provider: string | null;
        model: string;
        requests: unknown;
        successes: unknown;
        failures: unknown;
        rateLimitedCount: unknown;
        ttftCount: unknown;
        sumTtftMs: unknown;
        sumDurationMs: unknown;
        lastUsedAt: number | null;
      }>;

    return rows.map((row) => ({
      statKey: row.statKey,
      provider: row.provider,
      model: row.model,
      requests: toNumber(row.requests),
      successes: toNumber(row.successes),
      failures: toNumber(row.failures),
      rateLimitedCount: toNumber(row.rateLimitedCount),
      ttftCount: toNumber(row.ttftCount),
      sumTtftMs: toNumber(row.sumTtftMs),
      sumDurationMs: toNumber(row.sumDurationMs),
      lastUsedAt: row.lastUsedAt,
    }));
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
}

/**
 * Fallback counters for one combo summed over the window that starts at
 * `sinceMs` (floored to the hour). `{0, 0}` when no rows are in range.
 */
export function getComboFallbackStatsSince(
  comboName: string,
  sinceMs: number
): { fallbackEvents: number; requestsWithFallback: number } {
  const combo = toOptionalString(comboName);
  if (!combo) return { fallbackEvents: 0, requestsWithFallback: 0 };

  try {
    const db = getDbInstance();
    const row = db
      .prepare(
        `SELECT
           COALESCE(SUM(fallback_events), 0) AS fallbackEvents,
           COALESCE(SUM(requests_with_fallback), 0) AS requestsWithFallback
         FROM combo_fallback_stats
         WHERE combo_name = @comboName AND bucket_hour >= @sinceBucket`
      )
      .get({ comboName: combo, sinceBucket: bucketHourFor(Number(sinceMs) || 0) }) as
      | { fallbackEvents?: unknown; requestsWithFallback?: unknown }
      | undefined;

    return {
      fallbackEvents: toNumber(row?.fallbackEvents),
      requestsWithFallback: toNumber(row?.requestsWithFallback),
    };
  } catch (err) {
    if (isMissingTableError(err)) return { fallbackEvents: 0, requestsWithFallback: 0 };
    throw err;
  }
}
