/**
 * Speed-Combo Strategy: fused speed / reliability / RPM ordering.
 *
 * The `speed-combo` combo strategy orders a combo's models by a fused score
 * instead of probe latency alone (that is `responsive-priority`). Three signal
 * families feed the ranking, all in-memory and O(1) per target so the orderer
 * never touches the DB hot path:
 *
 *  1. **Probe reachability** — the 30s `responsive-priority` probe scheduler
 *     (services/responsivePriority.ts) also probes the models backing
 *     `speed-combo` combos, giving a fresh TTFB sample per model (60s TTL).
 *  2. **Real traffic** — the routing quality tracker
 *     (services/routing/quality.ts) keeps confidence-blended EWMA of success,
 *     latency, TTFT and 429 counts per provider/model. A model that probes fine
 *     but fails real prompts loses rank here.
 *  3. **Hard reliability / RPM** — provider + connection circuit breakers,
 *     model lockouts and repeated probe failures demote a target to the
 *     bottom bucket; a high 429 ratio soft-penalizes the score so an
 *     RPM-limited provider falls behind equivalent models elsewhere.
 *
 * Ordering contract (mirrors `orderByLatencyHealth`):
 *  - three buckets: scored (bucket 0, ascending by fused score), unknown
 *    (bucket 1, keeps the operator-declared order), demoted (bucket 2, last);
 *  - pure permutation: no target is ever dropped, the attempt loop's gates own
 *    the actual skip/exhaust decisions;
 *  - cold cache ⇒ exactly the declared priority order, so routing never
 *    depends on absent data.
 *
 * Import-safe: nothing runs on import. Probes are owned by the
 * responsive-priority scheduler, which also collects `speed-combo` models.
 */

import { getCircuitBreaker } from "../../src/shared/utils/circuitBreaker";
import { connectionCircuitBreakerName } from "./connectionCircuitBreaker.ts";
import { isModelLocked } from "./accountFallback.ts";
import { parseModel } from "./model.ts";
import { getProviderQuality } from "./routing/quality.ts";
import { getLatencyHealth, isModelOk } from "./responsivePriority.ts";
import type { ResolvedComboTarget } from "./combo/types.ts";

/** Strategy identifier this module serves. */
export const SPEED_COMBO_STRATEGY = "speed-combo";

/** Fused-latency blend: fresh probe TTFB vs real-traffic latency. */
const PROBE_LATENCY_WEIGHT = 0.6;
const TRAFFIC_LATENCY_WEIGHT = 0.4;
/**
 * Traffic signals only count once the tracker has enough samples for the
 * confidence blend to mean something (quality.ts blends toward 0.5 when cold).
 */
const TRAFFIC_MIN_SAMPLES = 5;
/** Effective-latency multiplier added at the worst observed success rate. */
const SUCCESS_PENALTY_MAX_MULTIPLIER = 0.75;
/** Effective-latency multiplier added when every observed request was a 429. */
const RATE_LIMIT_PENALTY_MAX_MULTIPLIER = 1.0;

export type SpeedBucket = 0 | 1 | 2;

export type SpeedDemotionReason = "probe_failed" | "circuit_open" | "model_locked";

export interface SpeedHealthEntry {
  modelStr: string;
  provider: string;
  model: string;
  bucket: SpeedBucket;
  /** Fused effective latency in ms; `null` for the unknown bucket. */
  score: number | null;
  /** Fresh probe TTFB in ms, or null when absent/stale. */
  probeLatencyMs: number | null;
  probeOk: boolean | null;
  /** Confidence-blended operational quality [0,1] from the traffic tracker. */
  operationalQuality: number;
  successEwma: number;
  trafficSamples: number;
  ttftEwmaMs: number | null;
  /** Observed 429 share of traffic (0 when no traffic). */
  rateLimitedRatio: number;
  hardDemotionReason: SpeedDemotionReason | null;
}

function isCircuitOpen(provider: string, connectionId?: string | null): boolean {
  if (!provider || provider === "unknown") return false;
  if (getCircuitBreaker(provider).getStatus().state === "OPEN") return true;
  if (!connectionId) return false;
  return getCircuitBreaker(connectionCircuitBreakerName(provider, connectionId)).getStatus()
    .state === "OPEN";
}

/**
 * Evaluate one target's fused speed health. In-memory only — breaker, lockout,
 * probe store and quality tracker are all read from process state.
 */
export function evaluateSpeedHealth(
  target: ResolvedComboTarget,
  now: number = Date.now()
): SpeedHealthEntry {
  const modelStr = target.modelStr;
  const parsed = parseModel(modelStr);
  const provider = target.provider || parsed.provider || "unknown";
  const model = parsed.model || modelStr;

  const probe = getLatencyHealth(modelStr, now);
  const probeOk = probe !== null && probe.ok;
  const quality = getProviderQuality(provider, model);
  const trafficSamples = quality.samples;
  const rateLimitedRatio =
    trafficSamples > 0 ? quality.rateLimited / trafficSamples : 0;

  let hardDemotionReason: SpeedDemotionReason | null = null;
  if ((probe !== null && !probe.ok) || !isModelOk(modelStr)) {
    hardDemotionReason = "probe_failed";
  } else if (isCircuitOpen(provider, target.connectionId)) {
    hardDemotionReason = "circuit_open";
  } else if (
    provider !== "unknown" &&
    model &&
    isModelLocked(provider, target.connectionId || "", model)
  ) {
    hardDemotionReason = "model_locked";
  }

  if (hardDemotionReason !== null) {
    return {
      modelStr,
      provider,
      model,
      bucket: 2,
      score: null,
      probeLatencyMs: probe ? probe.latencyMs : null,
      probeOk: probe === null ? null : probe.ok,
      operationalQuality: quality.operational,
      successEwma: quality.successEwma,
      trafficSamples,
      ttftEwmaMs: quality.ttftEwmaMs,
      rateLimitedRatio,
      hardDemotionReason,
    };
  }

  const hasProbe = probeOk === true;
  const hasTraffic = trafficSamples > 0;
  if (!hasProbe && !hasTraffic) {
    return {
      modelStr,
      provider,
      model,
      bucket: 1,
      score: null,
      probeLatencyMs: probe ? probe.latencyMs : null,
      probeOk: probe === null ? null : probe.ok,
      operationalQuality: quality.operational,
      successEwma: quality.successEwma,
      trafficSamples,
      ttftEwmaMs: quality.ttftEwmaMs,
      rateLimitedRatio,
      hardDemotionReason: null,
    };
  }

  const probeMs = hasProbe ? (probe as { latencyMs: number }).latencyMs : null;
  const trafficMs =
    trafficSamples > 0 ? quality.ttftEwmaMs ?? quality.latencyEwmaMs : null;

  let base: number;
  if (probeMs !== null && trafficMs !== null && trafficMs > 0) {
    base = probeMs * PROBE_LATENCY_WEIGHT + trafficMs * TRAFFIC_LATENCY_WEIGHT;
  } else {
    base = probeMs !== null ? probeMs : (trafficMs as number);
  }

  const trafficTrusted = trafficSamples >= TRAFFIC_MIN_SAMPLES;
  const successPenalty = trafficTrusted ? 1 - quality.successEwma : 0;
  const rpmPenalty = trafficTrusted ? rateLimitedRatio : 0;

  const score =
    base *
    (1 + successPenalty * SUCCESS_PENALTY_MAX_MULTIPLIER) *
    (1 + rpmPenalty * RATE_LIMIT_PENALTY_MAX_MULTIPLIER);

  return {
    modelStr,
    provider,
    model,
    bucket: 0,
    score,
    probeLatencyMs: probeMs,
    probeOk: hasProbe,
    operationalQuality: quality.operational,
    successEwma: quality.successEwma,
    trafficSamples,
    ttftEwmaMs: quality.ttftEwmaMs,
    rateLimitedRatio,
    hardDemotionReason: null,
  };
}

/**
 * Order targets by fused speed health. Pure permutation:
 *  - bucket 0 (fresh probe and/or traffic) ascending by fused score;
 *  - bucket 1 (no data yet) keeps the operator-declared order in the middle;
 *  - bucket 2 (probe failed / breaker open / model locked) keeps declared
 *    order at the very bottom — never dropped, the attempt loop still tries
 *    them as last resort.
 *
 * @param targets - Resolved combo targets (never mutated).
 * @param now - Override clock (tests).
 */
export function orderBySpeedHealth(
  targets: ResolvedComboTarget[],
  now: number = Date.now()
): ResolvedComboTarget[] {
  if (!Array.isArray(targets) || targets.length <= 1) {
    return Array.isArray(targets) ? [...targets] : [];
  }

  return targets
    .map((target, index) => ({
      target,
      index,
      entry: evaluateSpeedHealth(target, now),
    }))
    .sort(
      (a, b) =>
        a.entry.bucket - b.entry.bucket ||
        (a.entry.score ?? Number.POSITIVE_INFINITY) -
          (b.entry.score ?? Number.POSITIVE_INFINITY) ||
        a.index - b.index
    )
    .map((d) => d.target);
}

/**
 * Snapshot of the fused view for a target list — the live-ranking payload
 * behind the combo speed analytics API (`/api/combos/speed-analytics`).
 */
export function getSpeedHealthSnapshot(
  targets: ResolvedComboTarget[],
  now: number = Date.now()
): SpeedHealthEntry[] {
  return targets
    .map((target, index) => ({ entry: evaluateSpeedHealth(target, now), index }))
    .sort(
      (a, b) =>
        a.entry.bucket - b.entry.bucket ||
        (a.entry.score ?? Number.POSITIVE_INFINITY) -
          (b.entry.score ?? Number.POSITIVE_INFINITY) ||
        a.index - b.index
    )
    .map((d) => d.entry);
}
