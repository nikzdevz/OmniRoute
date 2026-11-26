// Response Processor engine — compile, text processing, body traversal and streaming rewriter.
import test from "node:test";
import assert from "node:assert/strict";

const { compileResponseProcessor, validateResponseProcessorRules, MAX_HOLDBACK } = await import(
  "../../../open-sse/services/responseProcessor/compile.ts"
);
const { processText, processResponseBody } = await import(
  "../../../open-sse/services/responseProcessor/engine.ts"
);
const { StreamTextRewriter } = await import(
  "../../../open-sse/services/responseProcessor/stream.ts"
);

const rule = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  enabled: true,
  match: "PECUTI",
  matchType: "literal",
  anchor: "anywhere",
  action: "replace",
  replaceWith: "",
  ...over,
});

const processor = (rules: unknown[]) =>
  compileResponseProcessor({ enabled: true, rules }).processor;

/* -- compile ----------------------------------------------------------- */

test("compile drops empty and oversized patterns with issues", () => {
  const empty = compileResponseProcessor({ enabled: true, rules: [rule({ match: "" })] });
  assert.equal(empty.processor.rules.length, 0);
  assert.equal(empty.issues.length, 1);
  assert.match(empty.issues[0].message, /empty/);

  const oversized = compileResponseProcessor({
    enabled: true,
    rules: [rule({ match: "a".repeat(600) })],
  });
  assert.equal(oversized.processor.rules.length, 0);
  assert.match(oversized.issues[0].message, /512/);
});

test("compile rejects catastrophic regex shapes and invalid regex sources", () => {
  const bad = compileResponseProcessor({
    enabled: true,
    rules: [rule({ match: "(a+)+", matchType: "regex" })],
  });
  assert.equal(bad.processor.rules.length, 0);
  assert.match(bad.issues[0].message, /catastrophic/);

  const invalid = compileResponseProcessor({
    enabled: true,
    rules: [rule({ match: "(unclosed", matchType: "regex" })],
  });
  assert.equal(invalid.processor.rules.length, 0);
  assert.match(invalid.issues[0].message, /invalid regex/);
});

test("compile keeps a disabled processor inert", () => {
  const disabled = compileResponseProcessor({ enabled: false, rules: [rule()] }).processor;
  assert.equal(disabled.enabled, false);
  const result = processText("PECUTI says hi", disabled);
  assert.equal(result.text, "PECUTI says hi");
  assert.equal(result.changed, false);
});

test("validateResponseProcessorRules reports problems without building a processor", () => {
  const issues = validateResponseProcessorRules([rule({ match: "(a+)+", matchType: "regex" })]);
  assert.equal(issues.length, 1);
  assert.equal(validateResponseProcessorRules([rule()]).length, 0);
});

/* -- processText: actions ---------------------------------------------- */

test("replace rewrites every occurrence and reports the count", () => {
  const result = processText(
    "PECUTI and PECUTI again",
    processor([rule({ replaceWith: "Proxion" })])
  );
  assert.equal(result.text, "Proxion and Proxion again");
  assert.equal(result.changed, true);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].count, 2);
});

test("remove drops the match and tidies the blank-line run it leaves", () => {
  const result = processText(
    "first\n\n\n\nPECUTI\n\n\n\nrest",
    processor([rule({ action: "remove" })])
  );
  assert.equal(result.text, "first\n\n\n\n\n\n\n\nrest".replace(/\n{3,}/g, "\n\n"));
});

test("case-insensitive by default, case-sensitive on request", () => {
  const insensitive = processText("pecuti", processor([rule({ replaceWith: "X" })]));
  assert.equal(insensitive.text, "X");

  const sensitive = processText(
    "pecuti PECUTI",
    processor([rule({ replaceWith: "X", caseSensitive: true })])
  );
  assert.equal(sensitive.text, "pecuti X");
});

test("whole-response replaces the entire text only when the whole text matches", () => {
  const p = processor([
    rule({
      match: "Hi, I'm PECUTI AI. How can I help?",
      anchor: "whole-response",
      action: "replace-whole-response",
      replaceWith: "How can I help?",
    }),
  ]);
  const exact = processText("Hi, I'm PECUTI AI. How can I help?", p);
  assert.equal(exact.text, "How can I help?");

  const partial = processText("Hi, I'm PECUTI AI. How can I help? More text", p);
  assert.equal(partial.text, "Hi, I'm PECUTI AI. How can I help? More text");
  assert.equal(partial.changed, false);
});

test("start anchor replaces only a leading banner and keeps the rest", () => {
  const p = processor([
    rule({ match: "⚡ Powered by PECUTI", anchor: "start", replaceWith: "" }),
  ]);
  const result = processText("⚡ Powered by PECUTI\n\nActual answer", p);
  assert.equal(result.text, "Actual answer");
  assert.equal(result.changed, true);
});

test("conditions gate a rule", () => {
  const p = processor([
    rule({
      match: "PECUTI",
      replaceWith: "X",
      conditions: [{ type: "not-contains", value: "reseller" }],
    }),
  ]);
  const blocked = processText("PECUTI reseller text", p);
  assert.equal(blocked.text, "PECUTI reseller text");

  const allowed = processText("PECUTI normal text", p);
  assert.equal(allowed.text, "X normal text");
});

test("rules apply in order, so a later rule sees the earlier replacement", () => {
  const p = processor([
    rule({ id: "a", match: "AAA", replaceWith: "BBB" }),
    rule({ id: "b", match: "BBB", replaceWith: "CCC" }),
  ]);
  assert.equal(processText("AAA", p).text, "CCC");
});

test("regex rules apply with the global flag", () => {
  const p = processor([
    rule({ match: "request [0-9a-f-]{8,}", matchType: "regex", replaceWith: "request <id>" }),
  ]);
  const result = processText("failed (request 0d61feb6-1234)", p);
  assert.equal(result.text, "failed (request <id>)");
});

/* -- processResponseBody: wire shapes ---------------------------------- */

test("processResponseBody rewrites OpenAI chat message content and nothing else", () => {
  const p = processor([rule({ match: "PECUTI", replaceWith: "Proxion" })]);
  const body = {
    id: "chatcmpl-1",
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "PECUTI here" },
        finish_reason: "stop",
      },
    ],
    usage: { total_tokens: 12 },
  };
  const result = processResponseBody(body, p);
  assert.equal(result.changed, true);
  const next = result.body as typeof body;
  assert.equal(next.choices[0].message.content, "Proxion here");
  assert.equal(next.id, "chatcmpl-1");
  assert.equal(next.model, "gpt-4o");
  assert.equal(next.usage.total_tokens, 12);
});

test("processResponseBody rewrites Claude content parts and leaves tool_use alone", () => {
  const p = processor([rule({ match: "PECUTI", replaceWith: "Proxion" })]);
  const body = {
    content: [
      { type: "text", text: "PECUTI banner" },
      { type: "tool_use", id: "tool-1", name: "search", input: { q: "PECUTI" } },
    ],
  };
  const result = processResponseBody(body, p);
  const next = result.body as typeof body;
  assert.equal(next.content[0].text, "Proxion banner");
  assert.equal(next.content[1].input.q, "PECUTI");
});

test("processResponseBody rewrites Responses API output and output_text", () => {
  const p = processor([rule({ match: "PECUTI", replaceWith: "Proxion" })]);
  const body = {
    output: [{ type: "message", content: [{ type: "output_text", text: "PECUTI body" }] }],
    output_text: "PECUTI summary",
  };
  const result = processResponseBody(body, p);
  const next = result.body as typeof body;
  assert.equal(next.output[0].content[0].text, "Proxion body");
  assert.equal(next.output_text, "Proxion summary");
});

test("processResponseBody rewrites the error message of a provider error envelope", () => {
  const p = processor([rule({ match: "upstream error", replaceWith: "provider failure" })]);
  const result = processResponseBody(
    { error: { message: "upstream error from provider", type: "server_error" } },
    p
  );
  const next = result.body as { error: { message: string; type: string } };
  assert.equal(next.error.message, "provider failure from provider");
  assert.equal(next.error.type, "server_error");
});

test("processResponseBody is a no-op on a body without answer fields", () => {
  const p = processor([rule({ match: "PECUTI", replaceWith: "Proxion" })]);
  const body = { id: "x", object: "list", data: [{ id: "m1" }] };
  const result = processResponseBody(body, p);
  assert.equal(result.changed, false);
  assert.equal(result.body, body);
});

/* -- streaming rewriter ------------------------------------------------ */

test("stream rewriter emits the replacement and never loses text", () => {
  const p = processor([rule({ match: "PECUTI", replaceWith: "Proxion" })]);
  const rewriter = new StreamTextRewriter(p);
  const chunks = ["hello ", "PECU", "TI world", " done"];
  let out = "";
  for (const chunk of chunks) out += rewriter.push(chunk).text;
  out += rewriter.flush().text;
  assert.equal(out, "hello Proxion world done");
});

test("stream rewriter handles a match split across three chunks", () => {
  const p = processor([rule({ match: "Kendala pada model", replaceWith: "Error" })]);
  const rewriter = new StreamTextRewriter(p);
  let out = rewriter.push("Kenda").text;
  out += rewriter.push("la pada ").text;
  out += rewriter.push("model test").text;
  out += rewriter.flush().text;
  assert.equal(out, "Error test");
});

test("stream rewriter keeps the whole text when nothing matches", () => {
  const p = processor([rule({ match: "PECUTI", replaceWith: "Proxion" })]);
  const rewriter = new StreamTextRewriter(p);
  let out = rewriter.push("nothing to ").text;
  out += rewriter.push("replace here").text;
  out += rewriter.flush().text;
  assert.equal(out, "nothing to replace here");
});

test("stream rewriter drops the whole-response rule set from the streaming path", () => {
  const p = processor([
    rule({
      match: "Hi, I'm PECUTI AI. How can I help?",
      anchor: "whole-response",
      action: "replace-whole-response",
      replaceWith: "How can I help?",
    }),
  ]);
  const rewriter = new StreamTextRewriter(p);
  let out = rewriter.push("Hi, I'm PECUTI AI. How can I help?").text;
  out += rewriter.flush().text;
  assert.equal(out, "Hi, I'm PECUTI AI. How can I help?");
});

test("holdback never exceeds the compiled ceiling", () => {
  const p = processor([rule({ match: "x".repeat(400) })]);
  assert.ok(p.holdback <= MAX_HOLDBACK);
});
