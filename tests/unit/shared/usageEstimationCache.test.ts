import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateInputTokens, getBodyShape } from "../../../open-sse/utils/usageEstimation.ts";

function chatBody(messageCount: number, textLength = 40) {
  return {
    model: "test/model",
    messages: Array.from({ length: messageCount }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "word ".repeat(Math.max(1, Math.ceil(textLength / 5))),
    })),
  };
}

describe("estimateInputTokens caching", () => {
  it("returns a positive estimate for a chat body", () => {
    const body = chatBody(4, 200);
    assert.ok(estimateInputTokens(body) > 0);
  });

  it("returns the same value on repeated calls for an unchanged body", () => {
    const body = chatBody(6, 500);
    const first = estimateInputTokens(body);
    const second = estimateInputTokens(body);
    const third = estimateInputTokens(body);
    assert.equal(second, first);
    assert.equal(third, first);
  });

  it("recomputes when a message is appended to the same array", () => {
    const body = chatBody(4, 400);
    const before = estimateInputTokens(body);
    body.messages.push({ role: "user", content: "word ".repeat(200) } as never);
    const after = estimateInputTokens(body);
    assert.ok(after > before, `expected ${after} > ${before} after appending a message`);
  });

  it("recomputes when tools are added", () => {
    const body = chatBody(4, 400) as ReturnType<typeof chatBody> & { tools?: unknown[] };
    const before = estimateInputTokens(body);
    body.tools = [{ type: "function", function: { name: "run", parameters: { a: 1 } } }];
    const after = estimateInputTokens(body);
    assert.ok(after >= before);
  });

  it("keeps separate bodies independent", () => {
    const small = chatBody(1, 100);
    const large = chatBody(20, 2000);
    const smallFirst = estimateInputTokens(small);
    const largeFirst = estimateInputTokens(large);
    assert.ok(largeFirst > smallFirst);
    assert.equal(estimateInputTokens(small), smallFirst);
    assert.equal(estimateInputTokens(large), largeFirst);
  });
});

describe("getBodyShape", () => {
  it("reports message and tool counts", () => {
    const shape = getBodyShape({ messages: [1, 2, 3], tools: [1, 2] });
    assert.deepEqual(shape, { messages: 3, tools: 2, promptChars: 0 });
  });

  it("counts string and array prompt fields", () => {
    const shape = getBodyShape({ input: "abcd", system: "ef", prompt: [1, 2, 3] });
    assert.equal(shape.promptChars, 9);
  });

  it("uses -1 for absent arrays so absence differs from an empty array", () => {
    assert.equal(getBodyShape({}).messages, -1);
    assert.equal(getBodyShape({ messages: [] }).messages, 0);
  });
});
