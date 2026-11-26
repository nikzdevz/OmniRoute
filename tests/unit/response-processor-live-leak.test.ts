// End-to-end proof of the reported bug, through the real streaming pipeline with the real
// SSE text transform and the response processor enabled.
//
// Before the fix a client received:
//   reportedreportedunknownunknown
//   estimatedrequest_body_heuristicestimatedobserved_charactersunknownunknown
// as the answer text, because usage-metadata strings entered the holdback buffers.
import test from "node:test";
import assert from "node:assert/strict";

const { createSseTextTransform } = await import("../../src/lib/sseTextTransform.ts");
const { compileResponseProcessor } = await import(
  "../../open-sse/services/responseProcessor/compile.ts"
);
const { createResponseProcessorSseTransform } = await import(
  "../../open-sse/services/responseProcessor/sseTransform.ts"
);

/** A banned brand rule, the exact shape the operator configured. */
const BAN = compileResponseProcessor({
  enabled: true,
  rules: [
    {
      id: "ban",
      enabled: true,
      match: "Upgrade limit Rp1.500/RPM di bot @IkonaOniAIBot.",
      matchType: "literal",
      anchor: "anywhere",
      action: "remove",
    },
  ],
}).processor;

const frame = (json: unknown) => `data: ${JSON.stringify(json)}\n\n`;

function streamChunks(): string[] {
  return [
    frame({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
    frame({
      choices: [
        {
          index: 0,
          delta: { content: "Upgrade limit Rp1.500/RPM di bot " },
        },
      ],
    }),
    // A match split across the frame boundary, exactly as a real stream delivers it.
    frame({ choices: [{ index: 0, delta: { content: "@IkonaOniAIBot." } }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    frame({
      choices: [],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
        usage_evidence: {
          input: { source: "estimated", method: "request_body_heuristic" },
          output: { source: "estimated", method: "observed_characters" },
          cacheRead: { source: "unknown" },
          cacheCreation: { source: "unknown" },
        },
        estimated: true,
      },
    }),
    "data: [DONE]\n\n",
  ];
}

async function run(transform: TransformStream | null, chunks: string[]): Promise<string> {
  assert.ok(transform, "the processor transform must exist for an enabled rule set");
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const writing = (async () => {
    for (const chunk of chunks) await writer.write(new TextEncoder().encode(chunk));
    await writer.close();
  })();
  let out = "";
  let res = await reader.read();
  while (!res.done) {
    out += new TextDecoder().decode(res.value);
    res = await reader.read();
  }
  await writing;
  return out;
}

function answerText(output: string): string {
  let text = "";
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const segment = line.slice(5).trim();
    if (!segment.startsWith("{")) continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(segment) as Record<string, unknown>;
    } catch {
      continue;
    }
    const choices = Array.isArray(json.choices) ? (json.choices as Record<string, unknown>[]) : [];
    for (const choice of choices) {
      const delta = (choice?.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.content === "string") text += delta.content;
      if (typeof delta.reasoning_content === "string") text += delta.reasoning_content;
    }
  }
  return text;
}

test("the banned banner is removed and metering evidence never becomes answer text", async () => {
  const transform = createResponseProcessorSseTransform(BAN);
  const output = await run(transform, streamChunks());
  const answer = answerText(output);

  assert.equal(answer.includes("Upgrade limit"), false, `banner leaked: ${answer}`);
  assert.equal(answer.includes("IkonaOniAIBot"), false, `handle leaked: ${answer}`);
  for (const token of [
    "reported",
    "unknown",
    "estimated",
    "request_body_heuristic",
    "observed_characters",
  ]) {
    assert.equal(answer.includes(token), false, `metadata "${token}" leaked into the answer: ${answer}`);
  }
});

test("usage evidence still reaches the client on the usage object", async () => {
  const transform = createResponseProcessorSseTransform(BAN);
  const output = await run(transform, streamChunks());
  assert.ok(output.includes("usage_evidence"), "metering evidence must stay in the payload");
  assert.ok(output.includes("request_body_heuristic"), "the method stays on the usage object");
});

test("the plain PII transform is not affected by the metadata change", async () => {
  const seen: string[] = [];
  const transform = createSseTextTransform((text) => {
    seen.push(text);
    return text;
  });
  const output = await run(transform, streamChunks());
  assert.deepEqual(seen.filter((text) => text !== ""), [
    "Upgrade limit Rp1.500/RPM di bot ",
    "@IkonaOniAIBot.",
  ]);
  assert.equal(answerText(output).includes("unknown"), false);
});
