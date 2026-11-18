/**
 * Unit coverage for the per-API-key concurrency gate (fail-fast 429).
 *
 * Cap semantics: `max_concurrent` on the api_keys row; 0/NULL = unlimited.
 * With cap = 2 the first two acquires succeed, the third is rejected
 * immediately with a 429 response (never queued), and releasing a slot lets
 * the next request in.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-key-concurrency-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-secret";

const { resetAll } = await import("../../../open-sse/services/accountSemaphore.ts");
const {
  tryAcquireApiKeyConcurrencySlot,
  attachKeySlotRelease,
  buildApiKeyConcurrencyGateKey,
  API_KEY_CONCURRENCY_LIMITED_CODE,
} = await import("../../../src/sse/services/keyConcurrencyGate.ts");

test.after(() => {
  resetAll();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function gateWithCap(cap: number) {
  return { resolveCap: () => cap };
}

test("bypasses gating when the cap is unset or zero", async () => {
  const noKey = await tryAcquireApiKeyConcurrencySlot(null);
  assert.equal(noKey.status, "bypass");

  const unlimited = await tryAcquireApiKeyConcurrencySlot("key-unlimited", gateWithCap(0));
  assert.equal(unlimited.status, "bypass");
});

test("admits up to the cap and rejects the next request with 429", async () => {
  const keyId = "key-cap-2";
  const first = await tryAcquireApiKeyConcurrencySlot(keyId, gateWithCap(2));
  const second = await tryAcquireApiKeyConcurrencySlot(keyId, gateWithCap(2));
  assert.equal(first.status, "admitted");
  assert.equal(second.status, "admitted");
  if (first.status !== "admitted" || second.status !== "admitted") return;

  const third = await tryAcquireApiKeyConcurrencySlot(keyId, gateWithCap(2));
  assert.equal(third.status, "limited");
  if (third.status !== "limited") return;
  assert.equal(third.response.status, 429);
  const body = (await third.response.json()) as { error?: { code?: string } };
  assert.equal(body.error?.code, API_KEY_CONCURRENCY_LIMITED_CODE);

  // Releasing one slot admits the next request immediately.
  first.slot.release();
  const fourth = await tryAcquireApiKeyConcurrencySlot(keyId, gateWithCap(2));
  assert.equal(fourth.status, "admitted");
  if (fourth.status === "admitted") fourth.slot.release();
  second.slot.release();
});

test("caps are per key, not global", async () => {
  const a = await tryAcquireApiKeyConcurrencySlot("key-a", gateWithCap(1));
  const b = await tryAcquireApiKeyConcurrencySlot("key-b", gateWithCap(1));
  assert.equal(a.status, "admitted");
  assert.equal(b.status, "admitted");
  if (a.status === "admitted") a.slot.release();
  if (b.status === "admitted") b.slot.release();
});

test("gate keys are namespaced away from provider connection gates", () => {
  assert.equal(buildApiKeyConcurrencyGateKey("abc"), "apikey:abc");
});

test("attachKeySlotRelease releases both the key slot and the inner lease once", () => {
  let keyReleased = 0;
  let innerReleased = 0;
  const inner = {
    id: "lease-1",
    cost: 1,
    get released() {
      return innerReleased > 0;
    },
    release() {
      innerReleased += 1;
    },
  };

  const composite = attachKeySlotRelease(inner, () => {
    keyReleased += 1;
  });

  assert.equal(composite.released, false);
  composite.release("success");
  assert.equal(keyReleased, 1);
  assert.equal(innerReleased, 1);
  assert.equal(composite.released, true);

  // Double release is idempotent for both.
  composite.release("success");
  assert.equal(keyReleased, 1);
  assert.equal(innerReleased, 1);
});

test("attachKeySlotRelease keeps the key slot reachable when the inner lease reports released", () => {
  // Admission "off" mode hands out virtual no-op leases whose `released` is
  // always true. The composite must still route one release into the key slot.
  let keyReleased = 0;
  const inner = {
    id: "lease-2",
    cost: 1,
    get released() {
      return true;
    },
    release() {},
  };

  const composite = attachKeySlotRelease(inner, () => {
    keyReleased += 1;
  });
  assert.equal(composite.released, false);
  composite.release("success");
  assert.equal(keyReleased, 1);
});
