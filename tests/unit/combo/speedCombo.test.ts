/**
 * Speed-Combo strategy (services/speedCombo.ts) — fused ordering tests.
 *
 * Pins the three-bucket contract inherited from responsive-priority:
 *  - bucket 0: scored targets ascending by fused effective latency
 *    (probe TTFB blended with traffic EWMA, success/RPM penalties applied);
 *  - bucket 1: no probe and no traffic → operator-declared order, middle;
 *  - bucket 2: probe failures / open breaker / model lockout → last, declared order.
 *  - pure permutation: input set never changes.
 *
 * Also pins the probe-scheduler coverage extension: models backing
 * `speed-combo` combos are collected for probing alongside responsive-priority.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSpeedHealth,
  orderBySpeedHealth,
  getSpeedHealthSnapshot,
} from "../../../open-sse/services/speedCombo.ts";
import {
  clearLatencyHealth,
  collectResponsivePriorityModels,
  recordLatencySample,
} from "../../../open-sse/services/responsivePriority.ts";
import {
  recordQualityEvent,
  resetQualityTracker,
} from "../../../open-sse/services/routing/quality.ts";
import {
  getCircuitBreaker,
  resetAllCircuitBreakers,
} from "../../../src/shared/utils/circuitBreaker";
import { lockModel } from "../../../open-sse/services/accountFallback.ts";
import type { ResolvedComboTarget } from "../../../open-sse/services/combo/types.ts";

const NOW = 1_700_000_000_000;

function target(modelStr: string, provider?: string): ResolvedComboTarget {
  return {
    modelStr,
    provider: provider || modelStr.slice(0, modelStr.indexOf("/")),
    connectionId: null,
  } as unknown as ResolvedComboTarget;
}

function resetStores() {
  clearLatencyHealth();
  resetQualityTracker();
  resetAllCircuitBreakers();
}

test("cold cache: no probe and no traffic keeps the operator-declared order", () => {
  resetStores();
  const targets = [target("p/a"), target("p/b"), target("p/c")];
  const ordered = orderBySpeedHealth(targets, NOW);
  assert.deepEqual(ordered.map((t) => t.modelStr), ["p/a", "p/b", "p/c"]);
  for (const t of targets) {
    assert.equal(evaluateSpeedHealth(t, NOW).bucket, 1);
  }
});

test("fresh ok probes reorder ascending by latency; unknown stays behind scored targets", () => {
  resetStores();
  recordLatencySample("p/a", { latencyMs: 300, ok: true, probedAt: NOW });
  recordLatencySample("p/b", { latencyMs: 600, ok: true, probedAt: NOW });
  const targets = [target("p/c"), target("p/a"), target("p/b")];
  const ordered = orderBySpeedHealth(targets, NOW);
  assert.deepEqual(ordered.map((t) => t.modelStr), ["p/a", "p/b", "p/c"]);
});

test("failed probe demotes below unknown targets, never dropped", () => {
  resetStores();
  recordLatencySample("p/a", { latencyMs: 300, ok: true, probedAt: NOW });
  recordLatencySample("p/c", { latencyMs: 0, ok: false, probedAt: NOW });
  const targets = [target("p/c"), target("p/b"), target("p/a")];
  const ordered = orderBySpeedHealth(targets, NOW);
  assert.deepEqual(ordered.map((t) => t.modelStr), ["p/a", "p/b", "p/c"]);
  const demoted = evaluateSpeedHealth(target("p/c"), NOW);
  assert.equal(demoted.bucket, 2);
  assert.equal(demoted.hardDemotionReason, "probe_failed");
});

test("traffic failures penalize a fast-probing model below an equally fast reliable one", () => {
  resetStores();
  recordLatencySample("p/a", { latencyMs: 300, ok: true, probedAt: NOW });
  recordLatencySample("p/b", { latencyMs: 300, ok: true, probedAt: NOW });
  for (let i = 0; i < 10; i++) {
    recordQualityEvent({
      provider: "p",
      model: "a",
      outcome: "failure",
      status: 500,
      latencyMs: 400,
    });
    recordQualityEvent({
      provider: "p",
      model: "b",
      outcome: "success",
      status: 200,
      latencyMs: 400,
      ttftMs: 350,
    });
  }
  const ordered = orderBySpeedHealth([target("p/a"), target("p/b")], NOW);
  assert.equal(ordered[0].modelStr, "p/b");
  const a = evaluateSpeedHealth(target("p/a"), NOW);
  const b = evaluateSpeedHealth(target("p/b"), NOW);
  assert.ok(a.score && b.score && a.score > b.score);
});

test("429-heavy traffic penalizes a model even though 429s are quality-neutral", () => {
  resetStores();
  recordLatencySample("p/a", { latencyMs: 300, ok: true, probedAt: NOW });
  recordLatencySample("p/b", { latencyMs: 300, ok: true, probedAt: NOW });
  for (let i = 0; i < 10; i++) {
    recordQualityEvent({
      provider: "p",
      model: "a",
      outcome: "rate_limited",
      status: 429,
      latencyMs: 50,
    });
    recordQualityEvent({
      provider: "p",
      model: "b",
      outcome: "success",
      status: 200,
      latencyMs: 400,
      ttftMs: 350,
    });
  }
  const ordered = orderBySpeedHealth([target("p/a"), target("p/b")], NOW);
  assert.equal(ordered[0].modelStr, "p/b");
  const a = evaluateSpeedHealth(target("p/a"), NOW);
  assert.ok(a.rateLimitedRatio > 0.5);
  assert.ok(a.score && a.score > 300);
});

test("open provider breaker demotes to bucket 2 with circuit_open reason", async () => {
  resetStores();
  recordLatencySample("p/a", { latencyMs: 300, ok: true, probedAt: NOW });
  const breaker = getCircuitBreaker("p", { failureThreshold: 1, resetTimeout: 300_000 });
  await assert.rejects(() => breaker.execute(() => Promise.reject(new Error("boom"))));
  assert.equal(breaker.getStatus().state, "OPEN");
  const entry = evaluateSpeedHealth(target("p/a"), NOW);
  assert.equal(entry.bucket, 2);
  assert.equal(entry.hardDemotionReason, "circuit_open");
  resetAllCircuitBreakers();
});

test("locked model demotes to bucket 2 with model_locked reason", () => {
  resetStores();
  recordLatencySample("pl/ml", { latencyMs: 300, ok: true, probedAt: NOW });
  lockModel("pl", "", "ml", "rate_limit", 60_000);
  const entry = evaluateSpeedHealth(target("pl/ml"), NOW);
  assert.equal(entry.bucket, 2);
  assert.equal(entry.hardDemotionReason, "model_locked");
});

test("orderBySpeedHealth is a pure permutation of its input", () => {
  resetStores();
  recordLatencySample("p/b", { latencyMs: 600, ok: true, probedAt: NOW });
  recordLatencySample("p/c", { latencyMs: 0, ok: false, probedAt: NOW });
  const targets = [target("p/a"), target("p/b"), target("p/c")];
  const ordered = orderBySpeedHealth(targets, NOW);
  assert.deepEqual(
    ordered.map((t) => t.modelStr).sort(),
    targets.map((t) => t.modelStr).sort()
  );
  assert.equal(ordered.length, targets.length);
});

test("stale probe (older than 60s TTL) reads as unknown, not scored", () => {
  resetStores();
  recordLatencySample("p/a", { latencyMs: 300, ok: true, probedAt: NOW - 120_000 });
  const entry = evaluateSpeedHealth(target("p/a"), NOW);
  assert.equal(entry.bucket, 1);
  assert.equal(entry.probeLatencyMs, null);
});

test("getSpeedHealthSnapshot returns ranked entries with fused scores", () => {
  resetStores();
  recordLatencySample("p/a", { latencyMs: 300, ok: true, probedAt: NOW });
  recordLatencySample("p/b", { latencyMs: 700, ok: true, probedAt: NOW });
  const snapshot = getSpeedHealthSnapshot([target("p/b"), target("p/a")], NOW);
  assert.deepEqual(
    snapshot.map((e) => e.modelStr),
    ["p/a", "p/b"]
  );
  assert.equal(snapshot[0].bucket, 0);
  assert.equal(snapshot[0].score, 300);
  assert.equal(snapshot[0].probeOk, true);
});

test("probe scheduler collects speed-combo models alongside responsive-priority", () => {
  const combos = [
    { name: "rp", strategy: "responsive-priority", models: ["prov/m1"] },
    { name: "sc", strategy: "speed-combo", models: ["prov/m2", { kind: "model", model: "prov/m3" }] },
    { name: "other", strategy: "priority", models: ["prov/m4"] },
  ];
  const models = collectResponsivePriorityModels(combos);
  assert.ok(models.includes("prov/m1"));
  assert.ok(models.includes("prov/m2"));
  assert.ok(models.includes("prov/m3"));
  assert.ok(!models.includes("prov/m4"));
});
