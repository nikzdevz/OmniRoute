-- 242_api_keys_max_concurrent.sql
-- Per-API-key concurrency cap (mirrors provider_connections.max_concurrent, but
-- scoped to an API key instead of an upstream account). 0/NULL = unlimited.
-- Enforcement: fail-fast semaphore keyed by api key id in
-- src/sse/services/keyConcurrencyGate.ts — the 3rd concurrent request is
-- rejected with 429 instead of queueing.

ALTER TABLE api_keys ADD COLUMN max_concurrent INTEGER;
