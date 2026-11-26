import test from "node:test";
import assert from "node:assert/strict";

import {
  clearLatencyHealth,
  getLatencyHealth,
  getLatencyHealthSnapshot,
  isModelOk,
  orderByLatencyHealth,
  probeTimeoutForModel,
  recordLatencySample,
  PROBE_TIMEOUT_FAST_MS,
  PROBE_TIMEOUT_DEGRADED_MS,
  PROBE_TIMEOUT_MS,
  LATENCY_TTL_MS,
  OK_POLICY_MAX_CONSECUTIVE_FAILURES,
} from "../../../open-sse/services/responsivePriority.ts";

test("timeout tiers: no failures → full PROBE_TIMEOUT_MS", () => {
  clearLatencyHealth();
  recordLatencySample("openai/gpt-4o", { latencyMs: 100, ok: true, probedAt: Date.now() });
  assert.equal(probeTimeoutForModel("openai/gpt-4o"), PROBE_TIMEOUT_MS);
});

test("timeout tiers: 1 consecutive failure → fast tier", () => {
  clearLatencyHealth();
  recordLatencySample("openai/gpt-4o", { latencyMs: 100, ok: false, probedAt: Date.now() });
  assert.equal(probeTimeoutForModel("openai/gpt-4o"), PROBE_TIMEOUT_FAST_MS);
});

test("timeout tiers: 2 consecutive failures → degraded tier", () => {
  clearLatencyHealth();
  recordLatencySample("openai/gpt-4o", { latencyMs: 100, ok: false, probedAt: Date.now() });
  recordLatencySample("openai/gpt-4o", { latencyMs: 100, ok: false, probedAt: Date.now() });
  assert.equal(probeTimeoutForModel("openai/gpt-4o"), PROBE_TIMEOUT_DEGRADED_MS);
});

test("ok policy: below threshold → ok", () => {
  clearLatencyHealth();
  recordLatencySample("openai/gpt-4o", { latencyMs: 100, ok: false, probedAt: Date.now() });
  assert.equal(isModelOk("openai/gpt-4o"), true);
});

test("ok policy: at threshold → not ok", () => {
  clearLatencyHealth();
  for (let i = 0; i < OK_POLICY_MAX_CONSECUTIVE_FAILURES; i++) {
    recordLatencySample("openai/gpt-4o", { latencyMs: 100, ok: false, probedAt: Date.now() });
  }
  assert.equal(isModelOk("openai/gpt-4o"), false);
});

test("ok policy: a success resets consecutive failures", () => {
  clearLatencyHealth();
  recordLatencySample("openai/gpt-4o", { latencyMs: 100, ok: false, probedAt: Date.now() });
  recordLatencySample("openai/gpt-4o", { latencyMs: 100, ok: false, probedAt: Date.now() });
  assert.equal(isModelOk("openai/gpt-4o"), true);
  recordLatencySample("openai/gpt-4o", { latencyMs: 100, ok: true, probedAt: Date.now() });
  assert.equal(isModelOk("openai/gpt-4o"), true);
});

test("orderByLatencyHealth: ok policy demotes over-threshold models", () => {
  clearLatencyHealth();
  for (let i = 0; i < OK_POLICY_MAX_CONSECUTIVE_FAILURES; i++) {
    recordLatencySample("slow/failing", { latencyMs: 5, ok: false, probedAt: Date.now() });
  }
  // Healthy model has worse raw latency but sorts first; failing model is demoted.
  recordLatencySample("fast/ok", { latencyMs: 1000, ok: true, probedAt: Date.now() });
  const ordered2 = orderByLatencyHealth(["slow/failing", "fast/ok"]);
  assert.deepEqual(ordered2, ["fast/ok", "slow/failing"]);
});

test("orderByLatencyHealth: cold cache → declared order", () => {
  clearLatencyHealth();
  const ordered = orderByLatencyHealth(["openai/gpt-4o", "anthropic/claude", "meta/llama"]);
  assert.deepEqual(ordered, ["openai/gpt-4o", "anthropic/claude", "meta/llama"]);
});

test("orderByLatencyHealth: healthy samples sort by latency ascending", () => {
  clearLatencyHealth();
  recordLatencySample("slow/ok", { latencyMs: 1200, ok: true, probedAt: Date.now() });
  recordLatencySample("fast/ok", { latencyMs: 50, ok: true, probedAt: Date.now() });
  recordLatencySample("mid/ok", { latencyMs: 500, ok: true, probedAt: Date.now() });
  const ordered = orderByLatencyHealth(["slow/ok", "fast/ok", "mid/ok"]);
  assert.deepEqual(ordered, ["fast/ok", "mid/ok", "slow/ok"]);
});

test("orderByLatencyHealth: demoted models sit below unknown models (very bottom)", () => {
  clearLatencyHealth();
  // Demote "bottom/me" past the threshold; "unknown/me" has no sample at all.
  for (let i = 0; i < OK_POLICY_MAX_CONSECUTIVE_FAILURES; i++) {
    recordLatencySample("bottom/me", { latencyMs: 5, ok: false, probedAt: Date.now() });
  }
  const ordered = orderByLatencyHealth(["bottom/me", "unknown/me"]);
  assert.deepEqual(ordered, ["unknown/me", "bottom/me"]);
});

test("orderByLatencyHealth: ok=false sample sorts last but never dropped", () => {
  clearLatencyHealth();
  recordLatencySample("broken/ok", { latencyMs: 0, ok: false, probedAt: Date.now() });
  recordLatencySample("good/ok", { latencyMs: 100, ok: true, probedAt: Date.now() });
  const ordered = orderByLatencyHealth(["broken/ok", "good/ok"]);
  assert.deepEqual(ordered, ["good/ok", "broken/ok"]);
});

test("getLatencyHealth: expired sample returns null", () => {
  clearLatencyHealth();
  const now = 1000;
  recordLatencySample("openai/gpt-4o", {
    latencyMs: 100,
    ok: true,
    probedAt: now - (LATENCY_TTL_MS + 10_000),
  });
  assert.equal(getLatencyHealth("openai/gpt-4o", now), null);
});

test("clearLatencyHealth resets consecutive failures and samples", () => {
  clearLatencyHealth();
  recordLatencySample("openai/gpt-4o", { latencyMs: 100, ok: false, probedAt: Date.now() });
  recordLatencySample("openai/gpt-4o", { latencyMs: 100, ok: false, probedAt: Date.now() });
  // Below the threshold of 3: still ok.
  assert.equal(isModelOk("openai/gpt-4o"), true);
  clearLatencyHealth();
  assert.equal(isModelOk("openai/gpt-4o"), true);
  assert.equal(getLatencyHealth("openai/gpt-4o"), null);
});

test("snapshot only returns fresh samples", () => {
  clearLatencyHealth();
  const now = 1000;
  recordLatencySample("fresh", { latencyMs: 10, ok: true, probedAt: now - 100 });
  recordLatencySample("stale", {
    latencyMs: 10,
    ok: true,
    probedAt: now - (LATENCY_TTL_MS + 10_000),
  });
  const snap = getLatencyHealthSnapshot(now);
  assert.ok("fresh" in snap);
  assert.equal("stale" in snap, false);
});
