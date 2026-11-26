// Response Processor — SSE transform and streaming-pipeline wiring.
//
// The transform rewrites banned text inside an SSE stream (OpenAI CC deltas, Claude content
// blocks, Responses events, Gemini candidates) and drains its holdback buffer at the end of the
// stream. The pipeline places it after the credential/PII redaction and before the heartbeat.
import test from "node:test";
import assert from "node:assert/strict";

const { compileResponseProcessor } = await import(
  "../../../open-sse/services/responseProcessor/compile.ts"
);
const { createResponseProcessorSseTransform } = await import(
  "../../../open-sse/services/responseProcessor/sseTransform.ts"
);

const processor = (rules: unknown[]) =>
  compileResponseProcessor({ enabled: true, rules }).processor;

const BAN_RULE = {
  id: "ban",
  enabled: true,
  match: "PECUTI",
  matchType: "literal",
  anchor: "anywhere",
  action: "replace",
  replaceWith: "Proxion",
};

async function runTransform(transform: TransformStream, inputChunks: string[]): Promise<string> {
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const writePromise = (async () => {
    for (const chunk of inputChunks) await writer.write(new TextEncoder().encode(chunk));
    await writer.close();
  })();
  const outputChunks: string[] = [];
  let res = await reader.read();
  while (!res.done) {
    outputChunks.push(new TextDecoder().decode(res.value));
    res = await reader.read();
  }
  await writePromise;
  return outputChunks.join("");
}

/**
 * Concatenate the answer text of every emitted frame. A holdback window splits one answer
 * across several deltas, so the assertion has to read the stream the way a client does.
 */
function streamedText(output: string): string {
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
    if (Array.isArray(json.choices)) {
      for (const choice of json.choices) {
        const delta = choice?.delta ?? {};
        if (typeof delta.content === "string") text += delta.content;
        if (typeof delta.reasoning_content === "string") text += delta.reasoning_content;
        if (typeof delta.thinking === "string") text += delta.thinking;
        if (typeof delta.text === "string") text += delta.text;
      }
    }
    if (Array.isArray(json.candidates)) {
      for (const candidate of json.candidates) {
        for (const part of candidate?.content?.parts ?? []) {
          if (typeof part?.text === "string") text += part.text;
        }
      }
    }
    // Anthropic content_block_delta / content_block_start frames.
    if (typeof json.delta === "object" && json.delta !== null) {
      if (typeof json.delta.text === "string") text += json.delta.text;
      if (typeof json.delta.thinking === "string") text += json.delta.thinking;
    }
    if (typeof json.content_block?.text === "string") text += json.content_block.text;
    if (typeof json.delta === "string") text += json.delta;
  }
  return text;
}

test("a disabled or rule-less processor produces no transform at all", () => {
  const disabled = compileResponseProcessor({ enabled: false, rules: [BAN_RULE] }).processor;
  assert.equal(createResponseProcessorSseTransform(disabled), null);

  const noRules = compileResponseProcessor({ enabled: true, rules: [] }).processor;
  assert.equal(createResponseProcessorSseTransform(noRules), null);
});

test("OpenAI chat-completion deltas are rewritten", async () => {
  const transform = createResponseProcessorSseTransform(processor([BAN_RULE]));
  assert.ok(transform);
  const output = await runTransform(transform, [
    `data: {"choices":[{"index":0,"delta":{"content":"PECUTI says hi"}}]}\n\n`,
  ]);
  // The holdback window may split one answer across frames: read them like a client does.
  assert.equal(streamedText(output), "Proxion says hi");
});

test("a match split across two SSE chunks is still rewritten", async () => {
  const transform = createResponseProcessorSseTransform(processor([BAN_RULE]));
  assert.ok(transform);
  const output = await runTransform(transform, [
    `data: {"choices":[{"index":0,"delta":{"content":"PECU"}}]}\n\n`,
    `data: {"choices":[{"index":0,"delta":{"content":"TI tail"}}]}\n\n`,
  ]);
  assert.equal(streamedText(output), "Proxion tail");
});

test("the held-back tail is flushed before the stream ends", async () => {
  const transform = createResponseProcessorSseTransform(processor([BAN_RULE]));
  assert.ok(transform);
  const output = await runTransform(transform, [
    `data: {"choices":[{"index":0,"delta":{"content":"plain text"}}]}\n\n`,
  ]);
  assert.equal(streamedText(output), "plain text");
});

test("Claude content-block deltas are rewritten", async () => {
  const transform = createResponseProcessorSseTransform(processor([BAN_RULE]));
  assert.ok(transform);
  const output = await runTransform(transform, [
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PECUTI claude"}}\n\n`,
  ]);
  assert.equal(streamedText(output), "Proxion claude");
});

test("Gemini candidate parts are rewritten", async () => {
  const transform = createResponseProcessorSseTransform(processor([BAN_RULE]));
  assert.ok(transform);
  const output = await runTransform(transform, [
    `data: {"candidates":[{"content":{"parts":[{"text":"PECUTI gemini"}]}}]}\n\n`,
  ]);
  assert.equal(streamedText(output), "Proxion gemini");
});

test("tool call arguments are never rewritten", async () => {
  const transform = createResponseProcessorSseTransform(processor([BAN_RULE]));
  assert.ok(transform);
  const output = await runTransform(transform, [
    `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"{\\"q\\":\\"PECUTI\\"}"}}]}}]}\n\n`,
  ]);
  assert.equal(streamedText(output), "", "tool arguments must not enter the answer lanes");
  assert.ok(output.includes('\\"PECUTI\\"'), output);
});

test("reasoning text is rewritten on its own lane", async () => {
  const transform = createResponseProcessorSseTransform(processor([BAN_RULE]));
  assert.ok(transform);
  const output = await runTransform(transform, [
    `data: {"choices":[{"index":0,"delta":{"reasoning_content":"PECUTI thought"}}]}\n\n`,
  ]);
  assert.equal(streamedText(output), "Proxion thought");
});

/* -- pipeline wiring ---------------------------------------------------- */

test("the pipeline pipes the processor transform after PII and before the heartbeat", async () => {
  const { assembleStreamingPipeline } = await import(
    "../../../open-sse/handlers/chatCore/streamingPipeline.ts"
  );
  const log: string[] = [];
  const fakeStream = {
    pipeThrough(transform: { __tag: string }) {
      log.push(transform.__tag);
      return fakeStream;
    },
  };
  const deps = {
    wantsProgress: () => false,
    pipeWithDisconnect: () => fakeStream,
    isFeatureFlagEnabled: () => false,
    createPiiSseTransform: () => ({ __tag: "pii-flag" }),
    createCredentialSseTransform: () => ({ __tag: "credential-flag" }),
    createProgressTransform: () => ({ __tag: "progress" }),
    createSseHeartbeatTransform: () => ({ __tag: "heartbeat" }),
    shapeForClientFormat: (format: unknown) => format,
    createModelEchoTransform: () => ({ __tag: "echo" }),
    getResponseProcessor: () => processor([BAN_RULE]),
    createResponseProcessorSseTransform: () => ({ __tag: "response-processor" }),
  } as unknown as Parameters<typeof assembleStreamingPipeline>[1];

  assembleStreamingPipeline(
    {
      providerResponse: {},
      transformStream: {},
      streamController: { signal: {} as AbortSignal },
      createPiiTransform: undefined,
      clientRawRequestHeaders: null,
      clientResponseFormat: "openai",
      echoModel: null,
      responseHeaders: {},
    } as Parameters<typeof assembleStreamingPipeline>[0],
    deps
  );

  assert.deepEqual(log, ["response-processor", "heartbeat"]);
});

test("a disabled processor adds no transform to the pipeline", async () => {
  const { assembleStreamingPipeline } = await import(
    "../../../open-sse/handlers/chatCore/streamingPipeline.ts"
  );
  const log: string[] = [];
  const fakeStream = {
    pipeThrough(transform: { __tag: string }) {
      log.push(transform.__tag);
      return fakeStream;
    },
  };
  const deps = {
    wantsProgress: () => false,
    pipeWithDisconnect: () => fakeStream,
    isFeatureFlagEnabled: () => false,
    createPiiSseTransform: () => ({ __tag: "pii-flag" }),
    createCredentialSseTransform: () => ({ __tag: "credential-flag" }),
    createProgressTransform: () => ({ __tag: "progress" }),
    createSseHeartbeatTransform: () => ({ __tag: "heartbeat" }),
    shapeForClientFormat: (format: unknown) => format,
    createModelEchoTransform: () => ({ __tag: "echo" }),
    getResponseProcessor: () => compileResponseProcessor({ enabled: false, rules: [] }).processor,
    createResponseProcessorSseTransform,
  } as unknown as Parameters<typeof assembleStreamingPipeline>[1];

  assembleStreamingPipeline(
    {
      providerResponse: {},
      transformStream: {},
      streamController: { signal: {} as AbortSignal },
      createPiiTransform: undefined,
      clientRawRequestHeaders: null,
      clientResponseFormat: "openai",
      echoModel: null,
      responseHeaders: {},
    } as Parameters<typeof assembleStreamingPipeline>[0],
    deps
  );

  assert.deepEqual(log, ["heartbeat"]);
});
