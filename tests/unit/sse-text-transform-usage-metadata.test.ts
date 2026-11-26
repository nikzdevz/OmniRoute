// Regression: metering metadata must never enter the answer lanes.
//
// `usage_evidence` (open-sse/utils/usageEvidence.ts) is decorated onto the final usage object
// with a `source`/`method` pair per field. Those are metadata strings, but the generic SSE
// walker classified every unknown key as "content", so they entered the streaming holdback
// buffer and were re-emitted as a synthetic content delta:
//   reportedreportedunknownunknown
//   estimatedrequest_body_heuristicestimatedobserved_charactersunknownunknown
// A client sees that spliced into (or replacing) the real answer, and an agent reading it as
// the next turn's text stops making progress.
import test from "node:test";
import assert from "node:assert/strict";

const { createSseTextTransform, classifyField } = await import("../../src/lib/sseTextTransform.ts");

async function run(transform: TransformStream, chunks: string[]): Promise<string> {
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

/** Answer text of every emitted delta, read the way a client concatenates it. */
function deltaText(output: string): string {
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
      for (const key of ["content", "reasoning_content", "reasoning", "text"]) {
        if (typeof delta[key] === "string") text += delta[key];
      }
    }
    if (typeof json.delta === "string") text += json.delta;
  }
  return text;
}

test("the metering-evidence keys are classified as metadata", () => {
  // `usage` is already metadata, and a metadata key's value is never walked, so the nested
  // `source`/`method` strings cannot reach a processor. The explicit entries keep the intent
  // readable if an evidence object ever appears outside `usage`.
  assert.equal(classifyField("usage_evidence"), null);
  assert.equal(classifyField("usageEvidence"), null);
  assert.equal(classifyField("usage"), null);
});

test("a usage object nested under a metadata key is never walked", async () => {
  const seen: string[] = [];
  const transform = createSseTextTransform((text) => {
    seen.push(text);
    return text;
  });

  await run(transform, [
    `data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n`,
    `data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3,"usage_evidence":{"input":{"source":"reported"},"output":{"source":"reported"},"cacheRead":{"source":"unknown"},"cacheCreation":{"source":"unknown"}}}}\n\n`,
    `data: [DONE]\n\n`,
  ]);

  assert.deepEqual(seen, ["hi"], `metadata must not reach the processor, saw ${seen.join(",")}`);
});

test("the estimated-evidence shape does not leak its method strings", async () => {
  const seen: string[] = [];
  const transform = createSseTextTransform((text) => {
    seen.push(text);
    return text;
  });

  const output = await run(transform, [
    `data: {"choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n`,
    `data: {"choices":[],"usage":{"total_tokens":5,"usage_evidence":{"input":{"source":"estimated","method":"request_body_heuristic"},"output":{"source":"estimated","method":"observed_characters"},"cacheRead":{"source":"unknown"},"cacheCreation":{"source":"unknown"}}}}\n\n`,
    `data: [DONE]\n\n`,
  ]);

  assert.deepEqual(seen, ["answer"]);
  assert.equal(deltaText(output), "answer");
  assert.equal(
    output.includes("request_body_heuristic") && deltaText(output).includes("request_body_heuristic"),
    false,
    "the heuristic name must never appear in answer text"
  );
});

test("logprobs token text stays out of the answer lanes", async () => {
  const seen: string[] = [];
  const transform = createSseTextTransform((text) => {
    seen.push(text);
    return text;
  });

  await run(transform, [
    `data: {"choices":[{"index":0,"delta":{"content":"ok"},"logprobs":{"content":[{"token":"Hello","logprob":-0.1}]}}]}\n\n`,
    `data: [DONE]\n\n`,
  ]);

  assert.deepEqual(seen, ["ok"]);
});

test("a real answer under a non-metadata object is still processed", async () => {
  const seen: string[] = [];
  const transform = createSseTextTransform((text) => {
    seen.push(text);
    return text.toUpperCase();
  });

  const output = await run(transform, [
    `data: {"choices":[{"index":0,"delta":{"content":"still works"}}]}\n\n`,
    `data: [DONE]\n\n`,
  ]);

  assert.ok(seen.includes("still works"));
  assert.equal(deltaText(output), "STILL WORKS");
});
