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
 *  - TTL is 60s. Stale or missing samples fall back to the combo's existing
 *    priority order, so routing never depends on absent data.
 *
 * Import-safe: nothing runs on import. The scheduler is started explicitly from
 * the Node instrumentation hook and stopped on shutdown / in tests.
 */

import { resolveNestedComboModels } from "./combo.ts";
import type { ComboLike } from "./combo/types.ts";

// ── Constants ────────────────────────────────────────────────────────────────

/** Probe cadence (ms). */
export const PROBE_INTERVAL_MS = 30_000;
/** Latency sample freshness window (ms). */
export const LATENCY_TTL_MS = 60_000;
/** Max concurrent probes per tick (bounded). */
export const PROBE_CONCURRENCY = 3;
/** Per-probe hard timeout (ms) so a hung upstream cannot stall the tick. */
export const PROBE_TIMEOUT_MS = 15_000;
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
  timer: ReturnType<typeof setInterval> | null;
  running: Promise<void> | null;
  controller: AbortController | null;
}

function createState(): SchedulerState {
  return { samples: new Map(), timer: null, running: null, controller: null };
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
  getState().samples.set(modelStr, {
    latencyMs: sample.latencyMs,
    ok: sample.ok !== false,
    probedAt: Number.isFinite(sample.probedAt) ? sample.probedAt : Date.now(),
  });
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
  getState().samples.clear();
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

  const rank = (modelStr: string): [number, number] => {
    const sample = getLatencyHealth(modelStr, now);
    if (!sample) return [1, 0];
    if (sample.ok) return [0, sample.latencyMs];
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
          const timeout = setTimeout(() => probeController.abort(), PROBE_TIMEOUT_MS);
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
