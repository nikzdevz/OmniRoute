/**
 * Fallback-counter flusher for per-combo speed analytics (combo_fallback_stats,
 * migration 243).
 *
 * comboMetrics.recordComboRequest counts fallback events in memory on the hot
 * routing path; this module parks those increments in a small pending map (one
 * entry per combo) and a 60s interval drains them into SQLite via
 * recordComboFallbackEvents. Routing never touches the DB synchronously, and a
 * DB problem can never affect routing: recordPendingFallbackEvent only writes
 * to memory, and a failed flush leaves the entry pending for the next tick.
 *
 * Import-safe: nothing runs on import. Started from src/instrumentation-node.ts
 * (startComboSpeedStatsFlusher) and stopped on shutdown
 * (stopComboSpeedStatsFlusher).
 */

import { recordComboFallbackEvents } from "../../src/lib/db/comboSpeedStats.ts";

/** Flush cadence (ms). */
const FLUSH_INTERVAL_MS = 60_000;

const LOG_PREFIX = "[ComboSpeedStats]";

interface PendingFallbackCounters {
  fallbackEvents: number;
  requestsWithFallback: number;
}

interface FlusherState {
  /** `comboName` → increments waiting for the next flush. */
  pending: Map<string, PendingFallbackCounters>;
  timer: ReturnType<typeof setInterval> | null;
}

// Survive HMR re-evaluation within a single process (same pattern as
// responsivePriority.ts).
declare global {
  var __omnirouteComboSpeedStatsFlusher: FlusherState | undefined;
}

function getState(): FlusherState {
  if (!globalThis.__omnirouteComboSpeedStatsFlusher) {
    globalThis.__omnirouteComboSpeedStatsFlusher = {
      pending: new Map(),
      timer: null,
    };
  }
  return globalThis.__omnirouteComboSpeedStatsFlusher;
}

/**
 * Park fallback-counter increments for the next flush (called from the routing
 * hot path via comboMetrics.recordComboRequest). In-memory only and never
 * throws, so analytics can never affect routing.
 */
export function recordPendingFallbackEvent(
  comboName: string,
  fallbackEvents: number,
  requestsWithFallback: number
): void {
  try {
    if (!comboName) return;
    const state = getState();
    const existing = state.pending.get(comboName) ?? {
      fallbackEvents: 0,
      requestsWithFallback: 0,
    };
    const events = Number(fallbackEvents);
    const requests = Number(requestsWithFallback);
    if (Number.isFinite(events)) existing.fallbackEvents += Math.max(0, events);
    if (Number.isFinite(requests)) existing.requestsWithFallback += Math.max(0, requests);
    state.pending.set(comboName, existing);
  } catch {
    // Never let analytics break routing.
  }
}

/**
 * Drain the pending map into combo_fallback_stats. Each entry clears only
 * after its write succeeds; a failed write stays pending for the next tick.
 * Never throws.
 */
export function flushPendingFallbackEvents(): void {
  const state = getState();
  for (const [comboName, counters] of state.pending) {
    try {
      recordComboFallbackEvents(
        comboName,
        counters.fallbackEvents,
        counters.requestsWithFallback
      );
      state.pending.delete(comboName);
    } catch (err) {
      // Keep the entry pending; retry on the next tick.
      console.warn(
        `${LOG_PREFIX} could not flush fallback counters for "${comboName}":`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

/**
 * Start the flusher (idempotent). Does nothing when the
 * `OMNIROUTE_DISABLE_SPEED_STATS` kill switch is set.
 */
export function startComboSpeedStatsFlusher(): void {
  const state = getState();
  if (state.timer) return;

  const raw = process.env.OMNIROUTE_DISABLE_SPEED_STATS;
  if (raw && new Set(["1", "true", "yes", "on"]).has(raw.trim().toLowerCase())) return;

  state.timer = setInterval(() => {
    try {
      flushPendingFallbackEvents();
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} flush tick error:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }, FLUSH_INTERVAL_MS);
  state.timer.unref?.();
  console.log(`${LOG_PREFIX} fallback flusher started (every ${FLUSH_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop the flusher, draining any pending counters first.
 */
export async function stopComboSpeedStatsFlusher(): Promise<void> {
  const state = getState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  try {
    flushPendingFallbackEvents();
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} final flush on stop failed:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}
