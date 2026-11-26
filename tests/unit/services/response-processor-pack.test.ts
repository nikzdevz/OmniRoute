// Response Processor — the starter pack and the settings/preview API surface.
import test from "node:test";
import assert from "node:assert/strict";

const { DEFAULT_RESPONSE_PROCESSOR_PACK } = await import(
  "../../../open-sse/services/responseProcessor/defaultPack.ts"
);
const { compileResponseProcessor, processText, normalizeResponseProcessorConfig } = await import(
  "../../../open-sse/services/responseProcessor/index.ts"
);

const pack = DEFAULT_RESPONSE_PROCESSOR_PACK;

test("the starter pack is inert until an operator saves it", () => {
  assert.equal(pack.enabled, false);
  assert.ok(pack.rules.length >= 40);
});

test("every pack rule has a unique id and compiles without issues", () => {
  const ids = new Set<string>();
  for (const rule of pack.rules) {
    assert.ok(rule.id, "every rule needs an id");
    assert.equal(ids.has(rule.id), false, `duplicate rule id ${rule.id}`);
    ids.add(rule.id);
  }
  const { issues } = compileResponseProcessor({ enabled: true, rules: pack.rules });
  assert.deepEqual(issues, []);
});

test("emoji rules ship disabled, everything else ships enabled", () => {
  for (const rule of pack.rules) {
    const isEmoji = rule.id.startsWith("emoji-");
    assert.equal(rule.enabled, !isEmoji, `${rule.id} enabled state`);
  }
});

test("the pack removes the reseller banner and the brand identifiers", () => {
  const processor = compileResponseProcessor({ enabled: true, rules: pack.rules }).processor;

  const banner = processText("⚡ Powered by PECUTI\n\nHere is your answer.", processor);
  assert.equal(banner.text.includes("PECUTI"), false);
  assert.equal(banner.text.includes("Powered by"), false);
  assert.ok(banner.text.includes("Here is your answer."));

  const greeting = processText("Hi, I'm PECUTI AI. How can I help?", processor);
  assert.equal(greeting.text, "How can I help?");
});

test("the pack neutralizes the upstream rejection wrapper", () => {
  const processor = compileResponseProcessor({ enabled: true, rules: pack.rules }).processor;
  const result = processText(
    "Warning | the request was rejected as invalid. Check the request format and try again",
    processor
  );
  assert.equal(result.text.includes("rejected as invalid"), false);
  assert.equal(result.text.includes("Check the request format"), false);
  assert.ok(result.text.includes("The upstream provider rejected this request."));
});

test("the pack is provider-agnostic: it touches no legitimate answer text", () => {
  const processor = compileResponseProcessor({ enabled: true, rules: pack.rules }).processor;
  const answer =
    "Here is a short summary of the article. The author argues that distributed systems trade " +
    "consistency for availability, and explains the trade-off with three concrete examples.";
  assert.equal(processText(answer, processor).changed, false);
});

test("normalization coerces stored values and drops unusable entries", () => {
  const config = normalizeResponseProcessorConfig({
    enabled: true,
    rules: [
      { id: "a", enabled: true, match: "x".repeat(600), action: "replace" },
      { id: "b", enabled: true, match: "ok", action: "nonsense", anchor: "nonsense" },
      { id: "c", enabled: true, match: "" },
      "not-a-rule",
    ],
  });
  assert.equal(config.enabled, true);
  // `a` is kept but truncated to the source cap, which compiles (the cap is inclusive).
  assert.equal(config.rules.length, 2);
  assert.equal(config.rules[0].match.length, 512);
  assert.equal(config.rules[1].match, "ok");
  assert.equal(config.rules[1].action, "replace");
  assert.equal(config.rules[1].anchor, "anywhere");
  const { issues, processor } = compileResponseProcessor(config);
  assert.deepEqual(issues, []);
  assert.equal(processor.rules.length, 2);
});

test("a garbage stored value normalizes to a disabled empty config", () => {
  for (const value of [null, "text", 42, [], { enabled: "yes" }]) {
    const config = normalizeResponseProcessorConfig(value);
    assert.equal(config.enabled, false);
    assert.deepEqual(config.rules, []);
  }
});
