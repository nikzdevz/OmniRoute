/**
 * GET /api/combos/speed-analytics — per-combo speed analytics route.
 *
 * Auth is disarmed on the fresh isolated DB (no key configured), same as the
 * discovery-routes pattern. Pins the S4 contract the Control Center card
 * consumes: summary rollups (most-used / most-successful / fallbacks / RPM
 * hits), per-model rows for live + persisted ranges, and the live fused
 * ranking payload.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDataDir: string;
let core: typeof import("@/lib/db/core");
let combosDb: typeof import("@/lib/db/combos");
let speedStats: typeof import("@/lib/db/comboSpeedStats");
let speedAnalyticsRoute: typeof import("@/app/api/combos/speed-analytics/route");

function req(url: string): Request {
  return new Request(`http://localhost${url}`, { method: "GET" });
}

before(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "omniroute-speed-analytics-"));
  process.env.DATA_DIR = tmpDataDir;
  delete process.env.REQUIRE_API_KEY;
  process.env.OMNIROUTE_DISABLE_AUTH = "1";
  core = await import("@/lib/db/core");
  core.resetDbInstance();
  core.getDbInstance();
  combosDb = await import("@/lib/db/combos");
  speedStats = await import("@/lib/db/comboSpeedStats");
  speedAnalyticsRoute = await import("@/app/api/combos/speed-analytics/route");

  await combosDb.createCombo({
    id: "c-speed-1",
    name: "speedy",
    models: ["prov/m1", "prov/m2"],
    strategy: "speed-combo",
    isActive: true,
    sortOrder: 0,
  } as never);

  const ts = Date.now();
  // prov/m1: 8 ok attempts (400ms TTFT), 1 rate-limited (429), 1 failure (500).
  for (let i = 0; i < 8; i++) {
    speedStats.recordComboSpeedStat({
      comboName: "speedy",
      provider: "prov",
      model: "m1",
      status: 200,
      ttftMs: 400,
      durationMs: 1500,
      timestamp: ts,
    });
  }
  speedStats.recordComboSpeedStat({
    comboName: "speedy",
    provider: "prov",
    model: "m1",
    status: 429,
    durationMs: 50,
    timestamp: ts,
  });
  speedStats.recordComboSpeedStat({
    comboName: "speedy",
    provider: "prov",
    model: "m1",
    status: 500,
    durationMs: 200,
    timestamp: ts,
  });
  // prov/m2: 3 ok attempts (700ms TTFT).
  for (let i = 0; i < 3; i++) {
    speedStats.recordComboSpeedStat({
      comboName: "speedy",
      provider: "prov",
      model: "m2",
      status: 200,
      ttftMs: 700,
      durationMs: 2200,
      timestamp: ts,
    });
  }
  speedStats.recordComboFallbackEvents("speedy", 4, 2, ts);
});

after(() => {
  core.resetDbInstance();
  if (tmpDataDir) {
    rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("combo speed-analytics route", () => {
  test("rejects a missing combo name and an unknown combo", async () => {
    const bad = await speedAnalyticsRoute.GET(req("/api/combos/speed-analytics"));
    assert.equal(bad.status, 400);
    const missing = await speedAnalyticsRoute.GET(
      req("/api/combos/speed-analytics?combo=nope")
    );
    assert.equal(missing.status, 404);
  });

  test("7d range returns persisted rollups with most-used model, RPM hits and fallbacks", async () => {
    const res = await speedAnalyticsRoute.GET(
      req("/api/combos/speed-analytics?combo=speedy&range=7d")
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.comboName, "speedy");
    assert.equal(body.strategy, "speed-combo");
    assert.equal(body.range, "7d");

    assert.equal(body.summary.totalRequests, 13);
    assert.equal(body.summary.mostUsedModel, "prov/m1");
    assert.equal(body.summary.rpmLimitHits, 1);
    assert.equal(body.summary.fallbackEvents, 4);
    assert.equal(body.summary.requestsWithFallback, 2);
    assert.ok(Math.abs(body.summary.successRate - 11 / 13) < 1e-9);
    // Weighted average TTFT across both models: (8*400 + 3*700) / 11.
    assert.ok(Math.abs(body.summary.avgTtftMs - (8 * 400 + 3 * 700) / 11) < 1e-9);
    // m1 has 10 requests of 13 — above the 3-request floor but its success
    // rate (8/10) beats m2's (3/3): floor(13*0.05)=1 → min is 3, m2 qualifies.
    assert.equal(body.summary.mostSuccessfulModel, "prov/m2");

    assert.equal(body.models.length, 2);
    assert.equal(body.models[0].modelStr, "prov/m1");
    assert.equal(body.models[0].requests, 10);
    assert.equal(body.models[0].rateLimitedCount, 1);
    assert.ok(Math.abs(body.models[0].share - 10 / 13) < 1e-9);
    assert.ok(Math.abs(body.models[0].successRate - 0.8) < 1e-9);
    assert.equal(body.models[1].modelStr, "prov/m2");
    assert.ok(Math.abs(body.models[1].successRate - 1) < 1e-9);

    // Live fused ranking is always attached (unknown bucket without probes).
    assert.equal(body.ranking.length, 2);
    assert.ok(body.ranking.every((r: { bucket: number }) => r.bucket === 1));
    assert.ok(body.ranking.some((r: { modelStr: string }) => r.modelStr === "prov/m2"));
  });

  test("live range reads the in-memory metrics view and tolerates empty state", async () => {
    const res = await speedAnalyticsRoute.GET(
      req("/api/combos/speed-analytics?combo=speedy")
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.range, "live");
    assert.equal(body.models.length, 0);
    assert.equal(body.summary.totalRequests, 0);
    assert.equal(body.summary.mostUsedModel, null);
    assert.equal(body.summary.mostSuccessfulModel, null);
    assert.equal(body.summary.rpmLimitHits, null);
  });

  test("an invalid range falls back to live instead of failing", async () => {
    const res = await speedAnalyticsRoute.GET(
      req("/api/combos/speed-analytics?combo=speedy&range=banana")
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.range, "live");
  });
});
