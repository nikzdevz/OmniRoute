import test from "node:test";
import assert from "node:assert/strict";

import {
  recordLatencySample,
  getLatencyHealth,
  getLatencyHealthSnapshot,
  clearLatencyHealth,
  orderByLatencyHealth,
  collectResponsivePriorityModels,
  runProbeTick,
  startResponsivePriorityScheduler,
  stopResponsivePriorityScheduler,
  isResponsivePrioritySchedulerRunning,
  LATENCY_TTL_MS,
  PROBE_CONCURRENCY,
  PROBE_INTERVAL_MS,
  RESPONSIVE_PRIORITY_STRATEGY,
} from "../../open-sse/services/responsivePriority.ts";

const NOW = 5_000_000;

async function reset() {
  clearLatencyHealth();
  await stopResponsivePriorityScheduler();
}

test("constants: probe cadence is 30s, TTL 60s, bounded concurrency", () => {
  assert.equal(PROBE_INTERVAL_MS, 30_000);
  assert.equal(LATENCY_TTL_MS, 60_000);
  assert.ok(PROBE_CONCURRENCY >= 1 && PROBE_CONCURRENCY <= 10);
});

test("store: records and reads a fresh sample", () => {
  reset();
  recordLatencySample("openai/gpt-4o", { latencyMs: 250, ok: true, probedAt: NOW });
  const sample = getLatencyHealth("openai/gpt-4o", NOW + 1_000);
  assert.ok(sample);
  assert.equal(sample.latencyMs, 250);
  assert.equal(sample.ok, true);
});

test("store: expires a sample after 60s TTL", () => {
  reset();
  recordLatencySample("openai/gpt-4o", { latencyMs: 250, ok: true, probedAt: NOW });
  assert.equal(getLatencyHealth("openai/gpt-4o", NOW + LATENCY_TTL_MS + 1), null);
  assert.ok(getLatencyHealth("openai/gpt-4o", NOW + LATENCY_TTL_MS));
});

test("store: ignores invalid samples", () => {
  reset();
  recordLatencySample("x/y", { latencyMs: Number.NaN, ok: true, probedAt: NOW });
  recordLatencySample("x/y", { latencyMs: -5, ok: true, probedAt: NOW });
  assert.equal(getLatencyHealth("x/y", NOW), null);
});

test("store: snapshot only returns fresh samples", () => {
  reset();
  recordLatencySample("a/fresh", { latencyMs: 100, ok: true, probedAt: NOW });
  recordLatencySample("b/stale", { latencyMs: 200, ok: true, probedAt: NOW - LATENCY_TTL_MS - 5 });
  const snap = getLatencyHealthSnapshot(NOW);
  assert.ok(snap["a/fresh"]);
  assert.equal(snap["b/stale"], undefined);
});

test("ordering: keeps priority order when there is no data (cold cache)", () => {
  const models = ["p/m1", "p/m2", "p/m3"];
  assert.deepEqual(orderByLatencyHealth(models, NOW), models);
});

test("ordering: ranks fastest healthy model first", () => {
  reset();
  recordLatencySample("p/slow", { latencyMs: 900, ok: true, probedAt: NOW });
  recordLatencySample("p/fast", { latencyMs: 100, ok: true, probedAt: NOW });
  recordLatencySample("p/mid", { latencyMs: 400, ok: true, probedAt: NOW });
  assert.deepEqual(orderByLatencyHealth(["p/slow", "p/mid", "p/fast"], NOW), [
    "p/fast",
    "p/mid",
    "p/slow",
  ]);
});

test("ordering: places failed models last, healthy first", () => {
  reset();
  recordLatencySample("p/healthy", { latencyMs: 700, ok: true, probedAt: NOW });
  recordLatencySample("p/failed", { latencyMs: 0, ok: false, probedAt: NOW });
  assert.deepEqual(orderByLatencyHealth(["p/failed", "p/healthy"], NOW), ["p/healthy", "p/failed"]);
});

test("ordering: keeps unknown models between healthy and failed", () => {
  reset();
  recordLatencySample("p/healthy", { latencyMs: 800, ok: true, probedAt: NOW });
  recordLatencySample("p/failed", { latencyMs: 0, ok: false, probedAt: NOW });
  recordLatencySample("p/failed2", { latencyMs: 900, ok: false, probedAt: NOW });
  assert.deepEqual(
    orderByLatencyHealth(["p/unknown", "p/failed", "p/healthy", "p/unknown2", "p/failed2"], NOW),
    ["p/healthy", "p/unknown", "p/unknown2", "p/failed", "p/failed2"]
  );
});

test("ordering: preserves original order as stable tie-break", () => {
  reset();
  recordLatencySample("p/a", { latencyMs: 200, ok: true, probedAt: NOW });
  recordLatencySample("p/b", { latencyMs: 200, ok: true, probedAt: NOW });
  assert.deepEqual(orderByLatencyHealth(["p/a", "p/b"], NOW), ["p/a", "p/b"]);
});

test("ordering: does not mutate input and treats stale samples as unknown", () => {
  reset();
  const models = ["p/a", "p/b"];
  recordLatencySample("p/b", { latencyMs: 10, ok: true, probedAt: NOW });
  const result = orderByLatencyHealth(models, NOW);
  assert.deepEqual(models, ["p/a", "p/b"]); // input not mutated
  assert.deepEqual(result, ["p/b", "p/a"]);
  // Stale (past TTL) behaves as unknown → priority order kept
  const staleNow = NOW + LATENCY_TTL_MS + 1;
  assert.deepEqual(orderByLatencyHealth(["p/z", "p/b"], staleNow), ["p/z", "p/b"]);
});

test("collect: only collects models from responsive-priority combos", () => {
  const combos = [
    { name: "rp", strategy: RESPONSIVE_PRIORITY_STRATEGY, models: ["p/a", "p/b"] },
    { name: "prio", strategy: "priority", models: ["p/c"] },
  ];
  assert.deepEqual(collectResponsivePriorityModels(combos).sort(), ["p/a", "p/b"]);
});

test("collect: flattens nested combos and deduplicates shared models", () => {
  const combos = [
    { name: "outer1", strategy: RESPONSIVE_PRIORITY_STRATEGY, models: ["p/a", "shared"] },
    { name: "outer2", strategy: RESPONSIVE_PRIORITY_STRATEGY, models: ["p/c", "shared"] },
    { name: "shared", strategy: "priority", models: ["p/b", "p/d"] },
  ];
  assert.deepEqual(collectResponsivePriorityModels(combos).sort(), ["p/a", "p/b", "p/c", "p/d"]);
});

test("collect: empty when no combo uses the strategy", () => {
  assert.deepEqual(collectResponsivePriorityModels([{ name: "x", strategy: "priority" }]), []);
  assert.deepEqual(collectResponsivePriorityModels(undefined), []);
});

test("tick: probes each unique model once and records latency", async () => {
  await reset();
  const combos = [
    { name: "rp1", strategy: RESPONSIVE_PRIORITY_STRATEGY, models: ["openai/gpt-4o", "p/x"] },
    // shared model across combos must still be probed once
    { name: "rp2", strategy: RESPONSIVE_PRIORITY_STRATEGY, models: ["openai/gpt-4o"] },
  ];
  const probed = [];
  await runProbeTick({
    loadCombos: async () => combos,
    probeModel: async (modelStr) => {
      probed.push(modelStr);
      return modelStr === "openai/gpt-4o" ? 120 : 500;
    },
    log: () => {},
    now: () => 7_000_000,
  });
  assert.equal(probed.length, 2); // dedup across combos
  assert.ok(probed.includes("openai/gpt-4o"));
  assert.ok(probed.includes("p/x"));

  const gpt = getLatencyHealth("openai/gpt-4o", 7_000_000 + 10);
  assert.ok(gpt);
  assert.equal(gpt.latencyMs, 120);
  assert.equal(gpt.ok, true);
  const px = getLatencyHealth("p/x", 7_000_000 + 10);
  assert.equal(px.latencyMs, 500);
});

test("tick: marks probe failure as ok=false without inventing latency", async () => {
  await reset();
  const combos = [
    { name: "rp", strategy: RESPONSIVE_PRIORITY_STRATEGY, models: ["openai/gpt-4o"] },
  ];
  await runProbeTick({
    loadCombos: async () => combos,
    probeModel: async () => {
      throw new Error("boom");
    },
    log: () => {},
    now: () => 8_000_000,
  });
  const sample = getLatencyHealth("openai/gpt-4o", 8_000_000 + 10);
  assert.ok(sample);
  assert.equal(sample.ok, false);
  assert.equal(sample.latencyMs, 0);
});

test("tick: does nothing when no combo uses the strategy", async () => {
  await reset();
  let probed = 0;
  await runProbeTick({
    loadCombos: async () => [{ name: "p", strategy: "priority", models: ["p/x"] }],
    probeModel: async () => {
      probed++;
      return 100;
    },
    log: () => {},
  });
  assert.equal(probed, 0);
});

test("tick: overlapping calls share the same in-flight tick", async () => {
  await reset();
  const combos = [{ name: "rp", strategy: RESPONSIVE_PRIORITY_STRATEGY, models: ["a/1", "b/2"] }];
  let started = 0;
  const slowProbe = async () => {
    started++;
    await new Promise((r) => setTimeout(r, 30));
    return 50;
  };
  const first = runProbeTick({
    loadCombos: async () => combos,
    probeModel: slowProbe,
    log: () => {},
    now: () => 8_300_000,
  });
  const second = runProbeTick({
    loadCombos: async () => combos,
    probeModel: slowProbe,
    log: () => {},
    now: () => 8_300_000,
  });
  await Promise.all([first, second]);
  assert.equal(started, 2); // each model probed once — not four times
});

test("tick: bounds concurrency to PROBE_CONCURRENCY", async () => {
  await reset();
  const combos = [
    {
      name: "rp",
      strategy: RESPONSIVE_PRIORITY_STRATEGY,
      models: ["a/1", "b/2", "c/3", "d/4", "e/5", "f/6"],
    },
  ];
  let active = 0;
  let maxActive = 0;
  await runProbeTick({
    loadCombos: async () => combos,
    probeModel: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return 100;
    },
    log: () => {},
    now: () => 9_000_000,
  });
  assert.ok(maxActive <= PROBE_CONCURRENCY, `expected maxActive <= 3, got ${maxActive}`);
});

test("tick: cancelled tick leaves no failure samples", async () => {
  await reset();
  const combos = [
    { name: "rp", strategy: RESPONSIVE_PRIORITY_STRATEGY, models: ["a/1", "b/2", "c/3"] },
  ];
  const tickPromise = runProbeTick({
    loadCombos: async () => combos,
    probeModel: async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 100;
    },
    log: () => {},
    now: () => 9_200_000,
  });
  await stopResponsivePriorityScheduler(); // aborts in-flight tick
  await tickPromise.catch(() => {});
  assert.equal(Object.keys(getLatencyHealthSnapshot(9_200_000 + 1000)).length, 0);
});

test("tick: drops stale samples for models no longer using the strategy", async () => {
  await reset();
  recordLatencySample("openai/gpt-4o", { latencyMs: 100, ok: true, probedAt: 9_400_000 });
  const combos = [{ name: "rp", strategy: RESPONSIVE_PRIORITY_STRATEGY, models: ["p/x"] }];
  await runProbeTick({
    loadCombos: async () => combos,
    probeModel: async () => 100,
    log: () => {},
    now: () => 9_400_000,
  });
  assert.equal(getLatencyHealth("openai/gpt-4o", 9_400_000 + 10), null);
});

test("scheduler: start/stop lifecycle is idempotent", async () => {
  await reset();
  startResponsivePriorityScheduler({ log: () => {} });
  assert.equal(isResponsivePrioritySchedulerRunning(), true);
  startResponsivePriorityScheduler({ log: () => {} }); // no double timers
  assert.equal(isResponsivePrioritySchedulerRunning(), true);
  await stopResponsivePriorityScheduler();
  assert.equal(isResponsivePrioritySchedulerRunning(), false);
});

test("scheduler: respects OMNIROUTE_DISABLE_RESPONSIVE_PRIORITY=1", async () => {
  await reset();
  process.env.OMNIROUTE_DISABLE_RESPONSIVE_PRIORITY = "1";
  try {
    startResponsivePriorityScheduler({ log: () => {} });
    assert.equal(isResponsivePrioritySchedulerRunning(), false);
  } finally {
    delete process.env.OMNIROUTE_DISABLE_RESPONSIVE_PRIORITY;
  }
});

test("ordering is a pure permutation: fallback loop contract", () => {
  // The strategy returns a permutation of the input, never dropping or adding
  // models — the existing fallback loop then tries them in that order.
  reset();
  const models = ["a/1", "b/2", "c/3", "d/4"];
  recordLatencySample("c/3", { latencyMs: 50, ok: true, probedAt: NOW });
  recordLatencySample("d/4", { latencyMs: 20, ok: true, probedAt: NOW });
  const ordered = orderByLatencyHealth(models, NOW);
  assert.deepEqual([...ordered].sort(), [...models].sort()); // same set
  assert.deepEqual(ordered, ["d/4", "c/3", "a/1", "b/2"]);
});
