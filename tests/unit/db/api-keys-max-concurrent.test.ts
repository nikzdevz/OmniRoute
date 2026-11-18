/**
 * DB-layer coverage for the per-API-key max_concurrent column:
 * migration column presence, permission-update persistence, metadata and
 * cap-lookup reads. Mirrors the bootstrap shape of tests/unit/db/api-keys.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-db-key-maxconc-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-secret";

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");

const MACHINE_ID = "machine1234567890";

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("new keys default to unlimited (maxConcurrent 0)", async () => {
  const created = await apiKeysDb.createApiKey("unlimited", MACHINE_ID);
  assert.equal(apiKeysDb.getApiKeyConcurrencyCap(created.id), 0);
});

test("updateApiKeyPermissions persists maxConcurrent and the cap lookup reads it", async () => {
  const created = await apiKeysDb.createApiKey("capped", MACHINE_ID);

  const updated = await apiKeysDb.updateApiKeyPermissions(created.id, {
    maxConcurrent: 2,
  });
  assert.equal(updated, true);
  assert.equal(apiKeysDb.getApiKeyConcurrencyCap(created.id), 2);

  const keys = await apiKeysDb.getApiKeys();
  const row = keys.find((k) => k.id === created.id) as { maxConcurrent?: number } | undefined;
  assert.equal(row?.maxConcurrent, 2);
});

test("maxConcurrent 0 clears the cap", async () => {
  const created = await apiKeysDb.createApiKey("capped-then-cleared", MACHINE_ID);
  await apiKeysDb.updateApiKeyPermissions(created.id, { maxConcurrent: 5 });
  assert.equal(apiKeysDb.getApiKeyConcurrencyCap(created.id), 5);
  await apiKeysDb.updateApiKeyPermissions(created.id, { maxConcurrent: 0 });
  assert.equal(apiKeysDb.getApiKeyConcurrencyCap(created.id), 0);
});

test("negative and fractional caps are clamped to a non-negative integer", async () => {
  const created = await apiKeysDb.createApiKey("clamp", MACHINE_ID);
  await apiKeysDb.updateApiKeyPermissions(created.id, { maxConcurrent: 2.9 });
  assert.equal(apiKeysDb.getApiKeyConcurrencyCap(created.id), 2);
  await apiKeysDb.updateApiKeyPermissions(created.id, { maxConcurrent: -3 });
  assert.equal(apiKeysDb.getApiKeyConcurrencyCap(created.id), 0);
});

test("unknown and env key ids resolve to unlimited", () => {
  assert.equal(apiKeysDb.getApiKeyConcurrencyCap("does-not-exist"), 0);
  assert.equal(apiKeysDb.getApiKeyConcurrencyCap(null), 0);
  assert.equal(apiKeysDb.getApiKeyConcurrencyCap(""), 0);
});
