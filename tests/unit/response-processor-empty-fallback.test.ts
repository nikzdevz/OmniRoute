// Empty-response fallback: when a rule set removes an answer field down to nothing, the
// configured reply substitutes for the client — on both the non-streaming and streaming paths.
import test from "node:test";
import assert from "node:assert/strict";

const { compileResponseProcessor, MAX_EMPTY_FALLBACK_LENGTH } = await import(
  "../../open-sse/services/responseProcessor/compile.ts"
);
const { processText, processResponseBody } = await import(
  "../../open-sse/services/responseProcessor/engine.ts"
);
const { StreamTextRewriter } = await import("../../open-sse/services/responseProcessor/stream.ts");

const removeRule = {
  id: "wipe",
  enabled: true,
  match: "secret",
  matchType: "literal",
  anchor: "anywhere",
  action: "remove",
  replaceWith: "",
};

const compiled = (emptyFallback: string) =>
  compileResponseProcessor({ enabled: true, rules: [removeRule], emptyFallback }).processor;

test("empty answer becomes the configured reply, with no fallback it stays empty", () => {
  const withFallback = compiled("Not available.");
  const result = processText("secret", withFallback);
  assert.equal(result.text, "Not available.");
  assert.equal(result.changed, true);

  const noFallback = compiled("");
  assert.equal(processText("secret", noFallback).text, "");
});

test("partial removal leaves prose untouched and never gains the reply", () => {
  const result = processText("secret value", compiled("Not available."));
  assert.equal(result.text, " value");
  assert.notEqual(result.text, "Not available.");
});

test("text that never matched stays byte-identical", () => {
  const result = processText("plain prose", compiled("Not available."));
  assert.equal(result.changed, false);
  assert.equal(result.text, "plain prose");
});

test("non-streaming message.content receives the reply; reasoning does not", () => {
  const body = {
    choices: [
      { message: { content: "secret", reasoning_content: "secret" } },
    ],
  };
  const result = processResponseBody(
    JSON.parse(JSON.stringify(body)),
    compiled("Not available.")
  );
  const message = (
    result.body as { choices: Array<{ message: { content: string; reasoning_content: string } }> }
  ).choices[0].message;
  assert.equal(message.content, "Not available.");
  // An emptied thought stays empty rather than turning into an answer.
  assert.equal(message.reasoning_content, "");
});

test("oversized configured reply is trimmed to the ceiling", () => {
  assert.equal(MAX_EMPTY_FALLBACK_LENGTH, 2048);
  const oversized = compileResponseProcessor({
    enabled: true,
    rules: [removeRule],
    emptyFallback: "x".repeat(MAX_EMPTY_FALLBACK_LENGTH + 10),
  });
  assert.equal(oversized.processor.emptyFallback.length, MAX_EMPTY_FALLBACK_LENGTH);
});

test("streaming: a fully consumed answer emits the reply on flush; a never-fed lane stays silent", () => {
  const compiledProcessor = compiled("Filtered by policy.");
  const lane = new StreamTextRewriter(compiledProcessor);
  const pushed = lane.push("secret");
  assert.equal(pushed.text, "");
  const flushed = lane.flush();
  assert.equal(flushed.text, "Filtered by policy.");

  // A tool-call lane never receives text: flush must not inject the reply.
  const silentLane = new StreamTextRewriter(compiledProcessor);
  assert.equal(silentLane.flush().text, "");

  // A reasoning lane may not turn an emptied thought into an answer.
  const reasoningLane = new StreamTextRewriter(compiledProcessor, false);
  reasoningLane.push("secret");
  assert.equal(reasoningLane.flush().text, "");
});

test("streaming: partial removal streams normally and never emits the reply", () => {
  const lane = new StreamTextRewriter(compiled("Filtered by policy."));
  let emitted = lane.push("secret value");
  emitted.text += lane.flush().text;
  // The chunk boundary may trim the orphaned leading space; the reply must never appear.
  assert.equal(emitted.text.trim(), "value");
  assert.ok(!emitted.text.includes("Filtered"));
});
