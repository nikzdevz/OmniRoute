/**
 * Tests for combo_speed_stats / combo_fallback_stats (migration 243) and the
 * DB module src/lib/db/comboSpeedStats.ts plus the fallback flusher
 * open-sse/services/comboSpeedStatsFlush.ts.
 *
 * Verifies:
 *  - recordComboSpeedStat upsert-accumulates within one bucket hour and
 *    across two bucket hours (one row per (combo, stat_key, bucket));
 *  - success/failure/429 classification (200/302 success, 429 failure AND
 *    rate_limited, 500 failure, no TTFT → ttft_count 0);
 *  - getComboSpeedStatsSince aggregates only in-range rows, orders by
 *    requests DESC and reports lastUsedAt as the newest bucket hour;
 *  - fallback upsert-accumulate + windowed aggregation;
 *  - the flusher's pending map drains into the DB via flushPendingFallbackEvents;
 *  - missing-table resilience (pre-migration DB).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-css-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const stats = await import("../../../src/lib/db/comboSpeedStats.ts");
const flusher = await import("../../../open-sse/services/comboSpeedStatsFlush.ts");

const HOUR_MS = 3_600_000;
const NOW = Date.now();
const THIS_HOUR = Math.floor(NOW / HOUR_MS) * HOUR_MS;
const PREV_HOUR = THIS_HOUR - HOUR_MS;

async function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  // Drain any pending flusher counters into the outgoing DB before it is reset.
  try {
    flusher.flushPendingFallbackEvents();
  } catch {
    /* best effort */
  }
  await resetDb();
});

test.after(async () => {
  try {
    await flusher.stopComboSpeedStatsFlusher();
  } catch {
    /* best effort */
  }
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("recordComboSpeedStat upsert-accumulates within one bucket and across bucket hours", () => {
  stats.recordComboSpeedStat({
    comboName: "combo-a",
    provider: "openai",
    model: "openai/gpt-4o",
    connectionId: "conn-1",
    status: 200,
    ttftMs: 50,
    durationMs: 100,
    timestamp: THIS_HOUR + 1_000,
  });
  stats.recordComboSpeedStat({
    comboName: "combo-a",
    provider: "openai",
    model: "openai/gpt-4o",
    connectionId: "conn-1",
    status: 200,
    ttftMs: 70,
    durationMs: 200,
    timestamp: THIS_HOUR + 2_000,
  });
  // Same combo+model, previous bucket hour → a second row.
  stats.recordComboSpeedStat({
    comboName: "combo-a",
    provider: "openai",
    model: "openai/gpt-4o",
    connectionId: "conn-1",
    status: 500,
    durationMs: 300,
    timestamp: PREV_HOUR + 500_000,
  });

  const db = core.getDbInstance();
  const rows = db
    .prepare(
      "SELECT bucket_hour, stat_key, requests, successes, failures, ttft_count, sum_ttft_ms, sum_duration_ms FROM combo_speed_stats WHERE combo_name = ? ORDER BY bucket_hour"
    )
    .all("combo-a") as Array<Record<string, unknown>>;

  assert.equal(rows.length, 2, "one row per bucket hour");
  const [prev, curr] = rows;
  assert.equal(prev.bucket_hour, PREV_HOUR);
  assert.equal(prev.requests, 1);
  assert.equal(prev.successes, 0);
  assert.equal(prev.failures, 1);
  assert.equal(prev.sum_duration_ms, 300);
  assert.equal(curr.bucket_hour, THIS_HOUR);
  assert.equal(curr.requests, 2, "same-bucket writes upsert-accumulate");
  assert.equal(curr.successes, 2);
  assert.equal(curr.failures, 0);
  assert.equal(curr.ttft_count, 2);
  assert.equal(curr.sum_ttft_ms, 120);
  assert.equal(curr.sum_duration_ms, 300);
  assert.equal(curr.stat_key, "openai/openai/gpt-4o@conn-1", "falls back to provider/model@connection");

  // An attempt carrying an execution key rolls up under that key instead.
  stats.recordComboSpeedStat({
    comboName: "combo-a",
    executionKey: "exec-key-1",
    stepId: "step-1",
    provider: "openai",
    model: "openai/gpt-4o",
    connectionId: "conn-1",
    status: 200,
    timestamp: THIS_HOUR + 3_000,
  });
  const keyedRows = db
    .prepare("SELECT stat_key, combo_execution_key, requests FROM combo_speed_stats WHERE stat_key = ?")
    .all("exec-key-1") as Array<Record<string, unknown>>;
  assert.equal(keyedRows.length, 1);
  assert.equal(keyedRows[0].requests, 1);
  assert.equal(keyedRows[0].combo_execution_key, "exec-key-1");
});

test("classification: 200/302 success, 429 failure AND rate-limited, 500 failure, no ttft → ttft_count 0", () => {
  const record = (status: number) =>
    stats.recordComboSpeedStat({
      comboName: "combo-cls",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-6",
      status,
      durationMs: 10,
      timestamp: THIS_HOUR,
    });

  record(200);
  record(302);
  record(429);
  record(500);

  const rows = stats.getComboSpeedStatsSince("combo-cls", 0);
  assert.equal(rows.length, 1, "one stat key within the bucket");
  const row = rows[0];
  assert.equal(row.requests, 4);
  assert.equal(row.successes, 2, "200 and 302 count as success (2xx-3xx)");
  assert.equal(row.failures, 2, "429 and 500 count as failures");
  assert.equal(row.rateLimitedCount, 1, "429 also increments rate_limited_count");
  assert.equal(row.ttftCount, 0, "no ttftMs reported → ttft_count stays 0");
  assert.equal(row.sumTtftMs, 0);
  assert.equal(row.sumDurationMs, 40);
});

test("getComboSpeedStatsSince: only in-range rows, ordered by requests DESC, lastUsedAt is the newest bucket", () => {
  const hit = (
    model: string,
    timestamp: number,
    count = 1,
  ) => {
    for (let i = 0; i < count; i++) {
      stats.recordComboSpeedStat({
        comboName: "combo-ord",
        provider: "p",
        model,
        status: 200,
        timestamp: timestamp + i,
      });
    }
  };

  // model-a: 3 requests this hour; model-b: 2 this hour + 2 previous hour;
  // model-c: 5 requests in the previous hour only.
  hit("model-a", THIS_HOUR + 1_000, 3);
  hit("model-b", THIS_HOUR + 2_000, 2);
  hit("model-b", PREV_HOUR + 2_000, 2);
  hit("model-c", PREV_HOUR + 3_000, 5);

  const recent = stats.getComboSpeedStatsSince("combo-ord", THIS_HOUR);
  assert.deepEqual(
    recent.map((r) => r.model),
    ["model-a", "model-b"],
    "orders by requests DESC and excludes out-of-range buckets"
  );
  assert.equal(recent[0].requests, 3);
  assert.equal(recent[0].lastUsedAt, THIS_HOUR);
  assert.equal(recent[1].requests, 2, "model-b's previous-hour requests are out of range");
  assert.equal(recent[1].lastUsedAt, THIS_HOUR);

  const all = stats.getComboSpeedStatsSince("combo-ord", 0);
  assert.deepEqual(
    all.map((r) => r.model),
    ["model-c", "model-b", "model-a"],
    "includes every bucket since the epoch floor, still requests DESC"
  );
  assert.equal(all[0].requests, 5);
  assert.equal(all[1].requests, 4, "model-b sums 2 + 2 across both buckets");
  assert.equal(all[1].lastUsedAt, THIS_HOUR, "lastUsedAt is the newest contributing bucket");
  assert.equal(all[2].requests, 3);
});

test("recordComboFallbackEvents upsert-accumulates and getComboFallbackStatsSince sums the window", () => {
  stats.recordComboFallbackEvents("combo-fb", 2, 1, THIS_HOUR + 1_000);
  stats.recordComboFallbackEvents("combo-fb", 3, 1, THIS_HOUR + 2_000);
  stats.recordComboFallbackEvents("combo-fb", 4, 1, PREV_HOUR + 1_000);

  assert.deepEqual(stats.getComboFallbackStatsSince("combo-fb", THIS_HOUR), {
    fallbackEvents: 5,
    requestsWithFallback: 2,
  });
  assert.deepEqual(stats.getComboFallbackStatsSince("combo-fb", 0), {
    fallbackEvents: 9,
    requestsWithFallback: 3,
  });
  assert.deepEqual(stats.getComboFallbackStatsSince("combo-fb", THIS_HOUR + HOUR_MS), {
    fallbackEvents: 0,
    requestsWithFallback: 0,
  });
  assert.deepEqual(stats.getComboFallbackStatsSince("missing-combo", 0), {
    fallbackEvents: 0,
    requestsWithFallback: 0,
  });

  const db = core.getDbInstance();
  const rowCount = db
    .prepare("SELECT COUNT(*) AS n FROM combo_fallback_stats WHERE combo_name = ?")
    .get("combo-fb") as { n: number };
  assert.equal(rowCount.n, 2, "one row per bucket hour");
});

test("flusher: recordPendingFallbackEvent accumulates and drains via flushPendingFallbackEvents", () => {
  flusher.recordPendingFallbackEvent("combo-flush", 2, 1);
  flusher.recordPendingFallbackEvent("combo-flush", 3, 1);
  flusher.recordPendingFallbackEvent("combo-flush-2", 1, 1);

  // Not written until the flush drains the pending map.
  assert.deepEqual(stats.getComboFallbackStatsSince("combo-flush", 0), {
    fallbackEvents: 0,
    requestsWithFallback: 0,
  });

  flusher.flushPendingFallbackEvents();

  assert.deepEqual(stats.getComboFallbackStatsSince("combo-flush", 0), {
    fallbackEvents: 5,
    requestsWithFallback: 2,
  });
  assert.deepEqual(stats.getComboFallbackStatsSince("combo-flush-2", 0), {
    fallbackEvents: 1,
    requestsWithFallback: 1,
  });

  // Draining is idempotent: a second flush with an empty map adds nothing.
  flusher.flushPendingFallbackEvents();
  assert.deepEqual(stats.getComboFallbackStatsSince("combo-flush", 0), {
    fallbackEvents: 5,
    requestsWithFallback: 2,
  });
});

test("missing-table resilience: reads are empty and writes are dropped, never thrown", () => {
  // The test harness applies every migration on the first DB open, so a
  // genuinely pre-migration database cannot be produced here. Dropping the
  // tables reproduces the exact "no such table" state the guards protect.
  const db = core.getDbInstance();
  db.exec("DROP TABLE combo_speed_stats; DROP TABLE combo_fallback_stats;");

  assert.doesNotThrow(() =>
    stats.recordComboSpeedStat({
      comboName: "combo-pre",
      provider: "p",
      model: "m",
      status: 200,
      timestamp: THIS_HOUR,
    })
  );
  assert.doesNotThrow(() => stats.recordComboFallbackEvents("combo-pre", 1, 1, THIS_HOUR));
  assert.deepEqual(stats.getComboSpeedStatsSince("combo-pre", 0), []);
  assert.deepEqual(stats.getComboFallbackStatsSince("combo-pre", 0), {
    fallbackEvents: 0,
    requestsWithFallback: 0,
  });
  assert.doesNotThrow(() => {
    flusher.recordPendingFallbackEvent("combo-pre", 1, 1);
    flusher.flushPendingFallbackEvents();
  });
});
