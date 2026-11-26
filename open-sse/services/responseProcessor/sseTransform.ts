/**
 * Response Processor - SSE transform.
 *
 * Reuses `createSseTextTransform` (the same fragment-aware SSE walker the PII transform uses)
 * so every wire shape is covered by one implementation: OpenAI Chat Completions deltas,
 * Anthropic Messages blocks, OpenAI Responses events and Gemini candidates. The walker already
 * classifies text fields (tool arguments and protocol metadata never reach the buffers), and
 * drains buffered text before a stop event or EOF - exactly what a holdback window needs.
 *
 * Each (lane, category) pair keeps its own rewriter, so parallel choices never share a
 * holdback buffer and a reasoning stream can never splice into the answer text. On a stop
 * event or EOF the held-back tails are re-emitted in the format the client speaks.
 *
 * When the layer is off the function returns `null`, so nothing is piped at all.
 */
import { createSseTextTransform, classifyField, type FieldCategory } from "@/lib/sseTextTransform";
import { StreamTextRewriter } from "./stream.ts";
import type { CompiledResponseProcessor } from "./compile.ts";
import type { RuleHit } from "./engine.ts";

export interface ResponseProcessorSseOptions {
  /** Called once per chunk that changed anything, for call-log telemetry. */
  onRewrite?: (hits: RuleHit[]) => void;
}

type Lane = {
  rewriter: StreamTextRewriter;
  category: FieldCategory;
  /** Choice / content-block index, used to rebuild the flush envelope. */
  index: number;
};

const REASONING_FIELDS = new Set(["reasoning", "reasoning_content", "reasoning_text", "thinking"]);

function laneCategory(field: FieldCategory, fieldName?: string): FieldCategory {
  if (field === "reasoning" && fieldName && REASONING_FIELDS.has(fieldName)) return "reasoning";
  return field;
}

/**
 * Build the processor callback for `createSseTextTransform`. Returns rewritten text to emit
 * now; held-back tails come out of `flushLanes`.
 */
function createProcessor(
  compiled: CompiledResponseProcessor,
  lanes: Map<string, Lane>,
  options: ResponseProcessorSseOptions
) {
  return (
    text: string,
    field: FieldCategory,
    isStopSignal = false,
    index: string | number = "0_0",
    isSnapshot = false,
    fieldName?: string
  ): string => {
    if (isStopSignal || isSnapshot) return text;
    const category = laneCategory(field, fieldName);
    const key = `${String(index)}:${category}`;
    let lane = lanes.get(key);
    if (!lane) {
      lane = {
        // Only the answer lane may substitute the empty-response reply: an emptied reasoning
        // lane must stay empty rather than turn into an answer.
        rewriter: new StreamTextRewriter(compiled, category !== "reasoning"),
        category,
        index: Number(String(index).split("_")[0] || "0"),
      };
      lanes.set(key, lane);
    }
    const result = lane.rewriter.push(text);
    if (result.hits.length > 0) options.onRewrite?.(result.hits);
    return result.text;
  };
}

/** Emit one `{choices[].delta}` chunk carrying only the given field. */
function openAiDelta(index: number, category: FieldCategory, text: string): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  if (category === "reasoning") delta.reasoning_content = text;
  else delta.content = text;
  return { choices: [{ index, delta }] };
}

/**
 * Drain every lane and rebuild flush envelopes for the wire format seen in `lastJson`.
 * Returns `null` when nothing was buffered, which the walker reads as "no synthetic event".
 */
function flushLanes(lanes: Map<string, Lane>, lastJson: unknown): unknown {
  if (lanes.size === 0) return null;
  const drained = new Map<string, string>();
  for (const [key, lane] of lanes) {
    const flushed = lane.rewriter.flush();
    if (flushed.text) drained.set(key, flushed.text);
  }
  if (drained.size === 0) return null;

  const json = (lastJson ?? {}) as Record<string, unknown>;
  const type = typeof json.type === "string" ? json.type : "";

  // Anthropic Messages: one correctly typed delta per block, so the SDKs keep rendering.
  if (
    type.startsWith("message") ||
    type.startsWith("content_block") ||
    type === "ping"
  ) {
    const frames: Record<string, unknown>[] = [];
    for (const [key, text] of drained) {
      const lane = lanes.get(key);
      if (!lane) continue;
      if (lane.category === "reasoning") {
        frames.push({
          type: "content_block_delta",
          index: lane.index,
          delta: { type: "thinking_delta", thinking: text },
        });
      } else if (lane.category === "partialJson" || lane.category === "toolArgs") {
        frames.push({
          type: "content_block_delta",
          index: lane.index,
          delta: { type: "input_json_delta", partial_json: text },
        });
      } else {
        frames.push({
          type: "content_block_delta",
          index: lane.index,
          delta: { type: "text_delta", text },
        });
      }
    }
    lanes.clear();
    if (frames.length === 0) return null;
    return frames.length === 1 ? frames[0] : frames;
  }

  // OpenAI Responses: a fresh delta event rather than a clone of a terminal event, which
  // would replay it with the same sequence number.
  if (type.startsWith("response.")) {
    const events: Record<string, unknown>[] = [];
    for (const [key, text] of drained) {
      const lane = lanes.get(key);
      if (!lane) continue;
      events.push({
        type:
          lane.category === "reasoning"
            ? "response.reasoning_text.delta"
            : "response.output_text.delta",
        output_index: lane.index,
        delta: text,
      });
    }
    lanes.clear();
    if (events.length === 0) return null;
    return events.length === 1 ? events[0] : events;
  }

  // Gemini: candidates[].content.parts[].text
  if (Array.isArray(json.candidates)) {
    const parts: Array<{ text: string }> = [];
    for (const text of drained.values()) parts.push({ text });
    lanes.clear();
    if (parts.length === 0) return null;
    const index = (json.candidates[0] as Record<string, unknown> | undefined)?.index;
    return {
      candidates: [
        {
          ...(typeof index === "number" ? { index } : {}),
          content: { parts, role: "model" },
        },
      ],
    };
  }

  // OpenAI Chat Completions and any unrecognized shape: one delta per lane.
  const choices: Record<string, unknown>[] = [];
  for (const [key, text] of drained) {
    const lane = lanes.get(key);
    if (!lane) continue;
    const chunk = openAiDelta(lane.index, lane.category, text) as {
      choices: Array<Record<string, unknown>>;
    };
    choices.push(chunk.choices[0]);
  }
  lanes.clear();
  if (choices.length === 0) return null;
  return { choices };
}

/**
 * SSE transform that rewrites banned text on its way to the client.
 *
 * Returns `null` when the layer is disabled or has no rules, so an off feature adds no pass
 * over the stream.
 */
export function createResponseProcessorSseTransform(
  compiled: CompiledResponseProcessor,
  options: ResponseProcessorSseOptions = {}
): TransformStream<Uint8Array, Uint8Array> | null {
  if (!compiled.enabled || compiled.rules.length === 0) return null;

  const lanes = new Map<string, Lane>();
  const processor = createProcessor(compiled, lanes, options);
  return createSseTextTransform(processor, (lastJson: unknown) => flushLanes(lanes, lastJson));
}

export { classifyField };
