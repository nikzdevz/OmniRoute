/**
 * Responsive-Priority Strategy: latency health probing
 *
 * The `responsive-priority` combo strategy orders a combo's models by their
 * *measured* upstream latency health. This module owns two concerns:
 *
 *  1. An in-memory latency health store with a short TTL (60s) that maps a
 *     `provider/model` string to the last real probe result.
 *  2. A background scheduler that runs *minimal real generation probes* every
 *     30s for the models that back `responsive-priority` combos, deduplicated
 *     across combos, with bounded concurrency and no overlapping ticks.
 *
 * Design constraints (intentional):
 *  - Probes MUST NOT reuse the authenticated user request closure
 *    (`handleSingleModel`) on an interval. Instead each probe reuses the
 *    existing combo test machinery (`testComboModel`, the same core the
 *    dashboard's combo test button uses): a real chat completion through the
 *    /v1 pipeline, marked `X-Internal-Test` so it never carries user auth.
 *  - Model probes are deduplicated across combos: one probe per unique model
 *    string per tick, even when several combos share it.
 *  - No invented rate-limit / RPM data. Only real measured latency is stored.
 *  - Timeout tiers shorten per-probe timeouts after consecutive failures so a
 *    failing tick never burns the full 15s window while still re-checking
 *    recovery on each cadence.
 *  - The ok policy demotes a model once its consecutive failures exceed a
 *    threshold; demoted models go to the very bottom of the ordering, below
 *    healthy and unknown models, but are never dropped.
 *  - TTL is 60s. Stale or missing samples fall back to the combo's existing
 *    priority order, so routing never depends on absent data.
 *
 * Import-safe: nothing runs on import. The scheduler is started explicitly from
 * the Node instrumentation hook and stopped on shutdown / in tests.
 */

import { resolveNestedComboModels } from "./combo.ts";
import type { ComboLike } from "./combo/types.ts";
import { findAllStaleComboModelRefs } from "../../src/lib/combos/staleModelRefs.ts";
import { pruneStaleComboModelRefs } from "../../src/lib/combos/staleModelPrune.ts";
import { isStaleComboAutoPruneEnabled } from "../../src/lib/combos/staleModelPrune.ts";

// ── Constants ────────────────────────────────────────────────────────────────

/** Probe cadence (ms). */
export const PROBE_INTERVAL_MS = 30_000;
/** Latency sample freshness window (ms). */
export const LATENCY_TTL_MS = 60_000;
/** Max concurrent probes per tick (bounded). */
export const PROBE_CONCURRENCY = 3;
/** Per-probe hard timeout (ms) so a hung upstream cannot stall the tick. */
export const PROBE_TIMEOUT_MS = 15_000;
/** Timeout (ms) for a model that has failed once consecutively. */
export const PROBE_TIMEOUT_FAST_MS = 4_000;
/** Timeout (ms) for a model degrading through repeated failures. */
export const PROBE_TIMEOUT_DEGRADED_MS = 8_000;
/** Failures at which the timeout drops to the degraded tier. */
export const PROBE_TIMEOUT_DEGRADED_AT_FAILURES = 2;
/** Failures at which the timeout drops to the fast tier. */
export const PROBE_TIMEOUT_FAST_AT_FAILURES = 1;
/**
 * Ok policy: consecutive failures after which a model is demoted by the
 * ok policy. Routing keeps the declared order for demoted models.
 */
export const OK_POLICY_MAX_CONSECUTIVE_FAILURES = 3;
/** Strategy identifier this module serves. */
export const RESPONSIVE_PRIORITY_STRATEGY = "responsive-priority";

const LOG_PREFIX = "[ResponsivePriority]";

// ── Latency health store ─────────────────────────────────────────────────────

export interface LatencySample {
  /** Measured round-trip latency in milliseconds. */
  latencyMs: number;
  /** Whether the probe produced a usable response. */
  ok: boolean;
  /** Epoch ms when the sample was recorded. */
  probedAt: number;
}

interface SchedulerState {
  /** `provider/model` → last sample. */
  samples: Map<string, LatencySample>;
  /** `provider/model` → consecutive failed probe count (ok=false samples). */
  consecutiveFailures: Map<string, number>;
  timer: ReturnType<typeof setInterval> | null;
  running: Promise<void> | null;
  controller: AbortController | null;
}

function createState(): SchedulerState {
  return {
    samples: new Map(),
    consecutiveFailures: new Map(),
    timer: null,
    running: null,
    controller: null,
  };
}

/**
 * Pick a per-probe timeout tier from the model's consecutive failure count so
 * a failing tick never burns the full 15s window while still re-checking
 * recovery on each cadence.
 * @param {string} modelStr
 * @param {number} [now] - Override clock (tests).
 * @returns {number} Timeout in ms.
 */
export function probeTimeoutForModel(modelStr: string, now: number = Date.now()): number {
  const failures = getState().consecutiveFailures.get(modelStr) || 0;
  if (failures >= PROBE_TIMEOUT_DEGRADED_AT_FAILURES) return PROBE_TIMEOUT_DEGRADED_MS;
  if (failures >= PROBE_TIMEOUT_FAST_AT_FAILURES) return PROBE_TIMEOUT_FAST_MS;
  return PROBE_TIMEOUT_MS;
}

/**
 * Ok-policy: whether a model should be demoted by routing because its
 * consecutive failures exceed the threshold. Returns false for models that
 * are healthy or below the threshold.
 * @param {string} modelStr
 * @param {number} [now] - Override clock (tests).
 * @returns {boolean} true when the model is demoted by the ok policy.
 */
export function isModelOk(modelStr: string, now: number = Date.now()): boolean {
  const failures = getState().consecutiveFailures.get(modelStr) || 0;
  return failures < OK_POLICY_MAX_CONSECUTIVE_FAILURES;
}

// Survive HMR re-evaluation within a single process.
declare global {
  var __omnirouteResponsivePriority: SchedulerState | undefined;
}

function getState(): SchedulerState {
  if (!globalThis.__omnirouteResponsivePriority) {
    globalThis.__omnirouteResponsivePriority = createState();
  }
  return globalThis.__omnirouteResponsivePriority;
}

/**
 * Record a latency sample for a model.
 */
export function recordLatencySample(modelStr: string, sample: LatencySample): void {
  if (!modelStr || typeof modelStr !== "string") return;
  if (!Number.isFinite(sample.latencyMs) || sample.latencyMs < 0) return;
  const state = getState();
  state.samples.set(modelStr, {
    latencyMs: sample.latencyMs,
    ok: sample.ok !== false,
    probedAt: Number.isFinite(sample.probedAt) ? sample.probedAt : Date.now(),
  });
  if (sample.ok !== false) {
    state.consecutiveFailures.delete(modelStr);
  } else {
    const prev = state.consecutiveFailures.get(modelStr) || 0;
    state.consecutiveFailures.set(modelStr, prev + 1);
  }
}

/**
 * Get a fresh latency sample for a model, or `null` when absent/expired.
 * @param {string} modelStr
 * @param {number} [now] - Override clock (tests).
 */
export function getLatencyHealth(modelStr: string, now: number = Date.now()): LatencySample | null {
  const sample = getState().samples.get(modelStr);
  if (!sample) return null;
  if (now - sample.probedAt > LATENCY_TTL_MS) return null;
  return { ...sample };
}

/**
 * Return a JSON-friendly snapshot of the store (only fresh samples).
 */
export function getLatencyHealthSnapshot(now: number = Date.now()): Record<string, LatencySample> {
  const out: Record<string, LatencySample> = {};
  for (const [modelStr, sample] of getState().samples.entries()) {
    if (now - sample.probedAt <= LATENCY_TTL_MS) out[modelStr] = { ...sample };
  }
  return out;
}

/**
 * Clear the store. Used by tests and on teardown.
 */
export function clearLatencyHealth(): void {
  const state = getState();
  state.samples.clear();
  state.consecutiveFailures.clear();
}

/**
 * Order models by measured latency health.
 *
 * Healthy (ok) models sort first, ascending by latency. Models without a fresh
 * sample keep priority-adjacent placement (middle bucket), and failed probes
 * (ok=false) sort last. Ties keep the original ordering (stable), so:
 *  - cold cache → exactly the existing priority order;
 *  - failures → demoted but never dropped;
 *  - input set is never changed (pure permutation for the fallback loop).
 *
 * @param {string[]} models - Flat model strings, e.g. ["openai/gpt-4o", ...]
 * @param {number} [now] - Override clock (tests).
 * @returns {string[]} Re-ordered copy (never mutates the input)
 */
export function orderByLatencyHealth(models: string[], now: number = Date.now()): string[] {
  if (!Array.isArray(models) || models.length <= 1) {
    return Array.isArray(models) ? [...models] : [];
  }

  const state = getState();
  const rank = (modelStr: string): [number, number] => {
    const consecutiveFailures = state.consecutiveFailures.get(modelStr) || 0;
    const sample = getLatencyHealth(modelStr, now);
    if (sample && sample.ok) return [0, sample.latencyMs];
    if (!sample) return [1, 0];
    // Ok policy: demote models whose consecutive failures exceed the threshold,
    // plus any sample that already failed. They keep the combo's declared order
    // among themselves but sit at the very bottom — never dropped, never above
    // healthy or unknown models.
    if (consecutiveFailures >= OK_POLICY_MAX_CONSECUTIVE_FAILURES) return [2, 0];
    return [2, 0];
  };

  return models
    .map((modelStr, index) => ({ modelStr, index, rank: rank(modelStr) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.index - b.index)
    .map((d) => d.modelStr);
}

// ── Probe scheduling ────────────────────────────────────────────────────────

/**
 * Scheduler dependencies. Every dependency is injectable so tests never touch
 * the network or DB.
 */
export interface SchedulerDeps {
  /** Load all combos (defaults to DB). */
  loadCombos?: () => Promise<ComboLike[]>;
  /** Probe a single model; defaults to the existing combo test machinery. */
  probeModel?: (modelStr: string, signal: AbortSignal) => Promise<number>;
  /** Internal base URL for the default probe (defaults to runtime ports). */
  internalBaseUrl?: string;
  /** Per-tick warning sink (defaults to console.warn). */
  log?: (message: string) => void;
  /** Clock for sample timestamps (tests). */
  now?: () => number;
}

/**
 * Collect the unique model strings that back every `responsive-priority` combo.
 * Nested combos are flattened so shared leaf models are probed only once.
 *
 * @param {Array} combos - All combos from the DB.
 * @returns {string[]} Unique model strings.
 */
export function collectResponsivePriorityModels(
  combos: Array<ComboLike | Record<string, unknown>>
): string[] {
  const all = Array.isArray(combos) ? combos : [];
  const seen = new Set<string>();

  for (const combo of all) {
    if (!combo || combo.strategy !== RESPONSIVE_PRIORITY_STRATEGY) continue;
    const flat = resolveNestedComboModels(combo as ComboLike, all as ComboLike[]);
    for (const modelStr of flat) {
      if (typeof modelStr === "string" && modelStr) seen.add(modelStr);
    }
  }

  return [...seen];
}

/**
 * Default probe: reuse the existing combo test machinery (`testComboModel`).
 * Sends a real chat completion through the internal /v1 endpoint with the
 * `X-Internal-Test` marker (no user auth involved) and returns the measured
 * latency. Cancelable via the provided AbortSignal — the signal propagates
 * into the probe's own fetch.
 *
 * @returns measured latency in ms on success
 * @throws when the probe fails or is aborted
 */
async function defaultProbeModel(
  modelStr: string,
  signal: AbortSignal,
  internalBaseUrl?: string
): Promise<number> {
  const { testComboModel } = await import("../../src/lib/combos/testHealth.ts");
  const { getRuntimePorts } = await import("../../src/lib/runtime/ports.ts");

  const base = internalBaseUrl || `http://127.0.0.1:${getRuntimePorts().dashboardPort}`;
  const result = await testComboModel(modelStr, `${base}/v1/chat/completions`, {
    signal,
    probe: true,
  });

  if (result?.status !== "ok") {
    throw new Error(result?.error || `probe failed for ${modelStr}`);
  }
  return typeof result.latencyMs === "number" ? result.latencyMs : 0;
}

/**
 * Execute one probing tick.
 *
 * Guarded against overlap: while a tick is in flight, `state.running` holds its
 * promise and any further `runProbeTick` call awaits/share that same tick
 * instead of starting a second one. Each unique model is probed exactly once,
 * regardless of how many combos reference it. Ticks track their own
 * AbortController so `stopResponsivePriorityScheduler` cancels in-flight work.
 */
export async function runProbeTick(deps: SchedulerDeps = {}): Promise<void> {
  const state = getState();

  // No overlapping ticks: reuse the in-flight tick if one exists.
  if (state.running) return state.running;

  const log = deps.log || ((msg: string) => console.warn(msg));
  const controller = new AbortController();
  state.controller = controller;

  const loadCombos =
    deps.loadCombos ||
    (async () => {
      const { getCombos } = await import("../../src/lib/db/combos");
      return getCombos();
    });

  const tick = (async () => {
    const combos = await loadCombos();
    const models = collectResponsivePriorityModels(combos);
    if (models.length === 0) return; // nothing uses this strategy — no probes

    // Drop stale entries for models no longer using this strategy.
    const modelSet = new Set(models);
    for (const key of state.samples.keys()) {
      if (!modelSet.has(key)) state.samples.delete(key);
    }

    const now = deps.now || Date.now;
    const probeModel = deps.probeModel
      ? deps.probeModel
      : (modelStr: string, signal: AbortSignal) =>
          defaultProbeModel(modelStr, signal, deps.internalBaseUrl);

    let cursor = 0;
    const workers = Array.from(
      { length: Math.max(1, Math.min(PROBE_CONCURRENCY, models.length)) },
      async () => {
        while (!controller.signal.aborted && cursor < models.length) {
          const modelStr = models[cursor++];
          const probeController = new AbortController();
          const onOuterAbort = () => probeController.abort();
          if (controller.signal.aborted) probeController.abort();
          else controller.signal.addEventListener("abort", onOuterAbort, { once: true });
          const probeTimeoutMs = probeTimeoutForModel(modelStr, now());
          const timeout = setTimeout(() => probeController.abort(), probeTimeoutMs);
          try {
            const latencyMs = await probeModel(modelStr, probeController.signal);
            if (!controller.signal.aborted) {
              recordLatencySample(modelStr, {
                latencyMs,
                ok: true,
                probedAt: now(),
              });
            }
          } catch (err) {
            // Cancelled ticks leave no sample: routing keeps the last known
            // state instead of penalizing models for a shutdown.
            if (!controller.signal.aborted) {
              recordLatencySample(modelStr, {
                latencyMs: 0,
                ok: false,
                probedAt: now(),
              });
              if (err?.name !== "AbortError" && err?.message !== "aborted") {
                log(`${LOG_PREFIX} probe failed for ${modelStr}: ${err?.message || err}`);
              }
            }
          } finally {
            clearTimeout(timeout);
            controller.signal.removeEventListener("abort", onOuterAbort);
          }
        }
      }
    );

    await Promise.all(workers);
  })();

  state.running = tick.finally(() => {
    state.running = null;
    state.controller = null;
  });

  return state.running;
}

/**
 * Catalog-prune helper (#13505 follow-up).
 *
 * Removes explicit combo model steps that pin a provider model missing from
 * the provider's authoritative live catalog. Fail-open: with no authoritative
 * catalog nothing is flagged; a combo whose every step would be pruned is left
 * untouched so pruning never empties it; one combo's failure never blocks the
 * rest. Gated behind the opt-in `COMBO_AUTO_PRUNE_STALE_STEPS` feature flag.
 *
 * Returns `{ flagged, pruned }` counts.
 */
export async function pruneStaleCatalogRefs(): Promise<{
  flagged: number;
  pruned: number;
}> {
  // Opt-in only; with no flag set nothing is flagged or removed.
  if (!isStaleComboAutoPruneEnabled()) {
    return { flagged: 0, pruned: 0 };
  }
  const refs = await findAllStaleComboModelRefs();
  const pruned = await pruneStaleComboModelRefs(refs);
  return { flagged: refs.length, pruned: pruned.length };
}

/**
 * Start the responsive-priority probe scheduler (idempotent).
 * Does nothing when `OMNIROUTE_DISABLE_RESPONSIVE_PRIORITY` is set.
 * @param {SchedulerDeps} deps
 */
export function startResponsivePriorityScheduler(deps: SchedulerDeps = {}): void {
  const state = getState();
  if (state.timer) return;

  const raw = process.env.OMNIROUTE_DISABLE_RESPONSIVE_PRIORITY;
  if (raw && new Set(["1", "true", "yes", "on"]).has(raw.trim().toLowerCase())) return;

  const log = deps.log || ((m: string) => console.log(m));
  log(`${LOG_PREFIX} probe scheduler started (every ${PROBE_INTERVAL_MS / 1000}s)`);

  state.timer = setInterval(() => {
    runProbeTick(deps).catch((err: unknown) =>
      log(`${LOG_PREFIX} tick error: ${err instanceof Error ? err.message : String(err)}`)
    );
  }, PROBE_INTERVAL_MS);
  state.timer.unref?.();
}

/**
 * Stop the scheduler, cancelling any in-flight probes and awaiting their
 * cleanup.
 */
export async function stopResponsivePriorityScheduler(): Promise<void> {
  const state = getState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.controller) state.controller.abort();
  if (state.running) await state.running.catch(() => {});
  state.controller = null;
  console.log(`${LOG_PREFIX} scheduler stopped`);
}

/**
 * Test-only: whether the scheduler timer is active.
 */
export function isResponsivePrioritySchedulerRunning(): boolean {
  return Boolean(getState().timer);
}
