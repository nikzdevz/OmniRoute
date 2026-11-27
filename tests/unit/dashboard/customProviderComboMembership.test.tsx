import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildComboMembership,
  buildModelIdentity,
  dirtyKey,
  resolveSelectedComboIds,
  stepMatchesModel,
} from "@/app/(dashboard)/dashboard/custom-provider-combos/comboMembership";

// Matching identity is (provider identity, model id), not the raw stored string:
// a step may name the provider by routing prefix, by raw node id, or not at all and
// rely on `providerId`.

const IDENTITY = buildModelIdentity({
  providerId: "openai-compatible-chat-a1b2",
  prefix: "myprefix",
  alias: "mp",
  modelId: "llama-3.1-70b",
  qualifiedModel: "myprefix/llama-3.1-70b",
});

describe("stepMatchesModel", () => {
  it("matches the routing prefix spelling", () => {
    assert.equal(stepMatchesModel({ kind: "model", model: "myprefix/llama-3.1-70b" }, IDENTITY), true);
  });

  it("matches the raw node id spelling", () => {
    assert.equal(
      stepMatchesModel({ kind: "model", model: "openai-compatible-chat-a1b2/llama-3.1-70b" }, IDENTITY),
      true
    );
  });

  it("matches a bare model id when the step names the provider", () => {
    assert.equal(
      stepMatchesModel(
        { kind: "model", model: "llama-3.1-70b", providerId: "openai-compatible-chat-a1b2" }, IDENTITY),
      true
    );
  });

  it("rejects a bare model id without a provider name", () => {
    assert.equal(stepMatchesModel({ kind: "model", model: "llama-3.1-70b" }, IDENTITY), false);
  });

  it("rejects a different model id", () => {
    assert.equal(stepMatchesModel({ kind: "model", model: "myprefix/qwen-2.5" }, IDENTITY), false);
  });

  it("rejects a different provider's same model id", () => {
    assert.equal(
      stepMatchesModel({ kind: "model", model: "otherprefix/llama-3.1-70b" }, IDENTITY),
      false
    );
  });

  it("never matches a provider wildcard or combo reference", () => {
    assert.equal(
      stepMatchesModel(
        { kind: "provider-wildcard", providerId: "openai-compatible-chat-a1b2", modelPattern: "*" }, IDENTITY),
      false
    );
    assert.equal(
      stepMatchesModel({ kind: "combo-ref", comboName: "myprefix/llama-3.1-70b" }, IDENTITY),
      false
    );
  });

  it("accepts a legacy plain-string step", () => {
    assert.equal(stepMatchesModel("myprefix/llama-3.1-70b", IDENTITY), true);
  });
});

describe("buildComboMembership", () => {
  it("reports the combos a model already belongs to", () => {
    const membership = buildComboMembership(
      [
        { id: "c1", models: ["myprefix/llama-3.1-70b", "myprefix/other"] },
        { id: "c2", models: [{ kind: "model", model: "myprefix/qwen-2.5" }] },
        { id: "c3", models: [{ kind: "combo-ref", comboName: "myprefix/llama-3.1-70b" }] },
      ],
      [["myprefix/llama-3.1-70b", IDENTITY]]
    );
    assert.deepEqual([...(membership.get("myprefix/llama-3.1-70b") ?? [])], ["c1"]);
  });
});

describe("resolveSelectedComboIds", () => {
  const stored = new Set(["c1"]);

  it("returns stored membership with no edits", () => {
    assert.deepEqual(resolveSelectedComboIds(["c1", "c2"], "myprefix/llama-3.1-70b", stored, {}), ["c1"]);
  });

  it("inverts a flipped pair (add)", () => {
    assert.deepEqual(
      resolveSelectedComboIds(["c1", "c2"], "myprefix/llama-3.1-70b", stored, { [dirtyKey("c2", "myprefix/llama-3.1-70b")]: true }),
      ["c1", "c2"]
    );
  });

  it("inverts a flipped pair (remove)", () => {
    // c2 was never stored, so flipping the stored c1 leaves the selection empty.
    assert.deepEqual(
      resolveSelectedComboIds(["c1", "c2"], "myprefix/llama-3.1-70b", stored, { [dirtyKey("c1", "myprefix/llama-3.1-70b")]: true }),
      []
    );
  });

  it("supports add and remove together", () => {
    const three = new Set(["c1", "c3"]);
    assert.deepEqual(
      resolveSelectedComboIds(
        ["c1", "c2", "c3"],
        "myprefix/llama-3.1-70b",
        three,
        {
          [dirtyKey("c1", "myprefix/llama-3.1-70b")]: true,
          [dirtyKey("c2", "myprefix/llama-3.1-70b")]: true,
        }
      ),
      ["c2", "c3"]
    );
  });
});