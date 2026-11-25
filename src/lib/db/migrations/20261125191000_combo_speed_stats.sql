-- 20261125191000_combo_speed_stats.sql
-- Per-combo speed/reliability rollups for the speed-combo strategy and the
-- per-combo analytics page. call_logs rows keep only a short retention window,
-- so per-combo per-model counters (requests, successes, failures, 429s, TTFT
-- sums, duration sums) and per-combo fallback counters are upsert-accumulated
-- into hourly buckets here and survive call-log rotation. Writers:
-- src/lib/db/comboSpeedStats.ts (recordComboSpeedStat, hooked from the
-- call_logs insert in src/lib/usage/callLogs.ts, and recordComboFallbackEvents,
-- fed by the flusher in open-sse/services/comboSpeedStatsFlush.ts).

CREATE TABLE IF NOT EXISTS combo_speed_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  combo_name TEXT NOT NULL,
  -- Execution key when the attempt carried one, else `provider/model@connectionId`.
  stat_key TEXT NOT NULL,
  combo_step_id TEXT,
  combo_execution_key TEXT,
  provider TEXT,
  model TEXT NOT NULL,
  connection_id TEXT,
  -- Epoch ms floored to the hour: Math.floor(ts / 3_600_000) * 3_600_000.
  bucket_hour INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  rate_limited_count INTEGER NOT NULL DEFAULT 0,
  ttft_count INTEGER NOT NULL DEFAULT 0,
  sum_ttft_ms REAL NOT NULL DEFAULT 0,
  sum_duration_ms REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Upsert-accumulate target: one row per (combo, stat_key, bucket hour).
CREATE UNIQUE INDEX IF NOT EXISTS idx_combo_speed_stats_unique
  ON combo_speed_stats(combo_name, stat_key, bucket_hour);
CREATE INDEX IF NOT EXISTS idx_combo_speed_stats_combo_bucket
  ON combo_speed_stats(combo_name, bucket_hour);

CREATE TABLE IF NOT EXISTS combo_fallback_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  combo_name TEXT NOT NULL,
  bucket_hour INTEGER NOT NULL,
  fallback_events INTEGER NOT NULL DEFAULT 0,
  requests_with_fallback INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_combo_fallback_stats_unique
  ON combo_fallback_stats(combo_name, bucket_hour);
