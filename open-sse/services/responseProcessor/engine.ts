/**
 * Response Processor - pure text engine.
 *
 * `processText` rewrites one string; `processResponseBody` walks the known text fields of a
 * parsed chat / Responses / Messages body. Both are pure: no I/O, no shared state, no
 * mutation of the input, so the same module serves the streaming rewriter and the API
 * preview endpoint.
 */
import type {
  CompiledResponseProcessor,
  CompiledRule,
  CompiledCondition,
} from "./compile.ts";

export interface RuleHit {
  ruleId: string;
  action: CompiledRule["action"];
  count: number;
}

export interface ProcessTextResult {
  text: string;
  changed: boolean;
  hits: RuleHit[];
}

export interface ProcessBodyResult {
  body: unknown;
  changed: boolean;
  hits: RuleHit[];
}

const EMPTY_RESULT: ProcessTextResult = { text: "", changed: false, hits: [] };

function conditionsPass(text: string, rule: CompiledRule): boolean {
  for (const condition of rule.conditions) {
    if (!conditionPasses(text, condition)) return false;
  }
  return true;
}

function conditionPasses(text: string, condition: CompiledCondition): boolean {
  const haystack = condition.caseSensitive ? text : text.toLowerCase();
  const needle = condition.caseSensitive ? condition.value : condition.value.toLowerCase();
  const present = haystack.includes(needle);
  return condition.type === "not-contains" ? !present : present;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The text a rule compares against, honouring `collapseWhitespace`. */
function prepared(text: string, rule: CompiledRule): string {
  return rule.collapseWhitespace ? normalizeWhitespace(text) : text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does the whole (prepared) text match this rule? Used by `whole-response` anchors. */
function isWholeMatch(subject: string, rule: CompiledRule): boolean {
  if (rule.regex) {
    const flags = rule.caseSensitive ? "" : "i";
    const anchored = new RegExp(`^(?:${rule.regex.source})$`, flags);
    return anchored.test(subject);
  }
  const source = rule.literal as string;
  return rule.caseSensitive ? subject === source : subject.toLowerCase() === source.toLowerCase();
}

/**
 * Collapse the blank-line runs a removed banner leaves behind, and drop the leading/trailing
 * empty lines it leaves at the edges so a removed banner does not leave the answer indented
 * by a blank paragraph.
 */
function tidyAfterRemoval(value: string): string {
  return value
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]*(?:\r?\n)+/, "")
    .replace(/(?:\r?\n)[ \t]*$/, "");
}

function applyRule(text: string, rule: CompiledRule, hits: RuleHit[]): string {
  if (!rule.enabled || !text) return text;
  if (!conditionsPass(text, rule)) return text;

  if (rule.anchor === "whole-response") {
    const subject = rule.collapseWhitespace ? normalizeWhitespace(text) : text.trim();
    if (!isWholeMatch(subject, rule)) return text;
    hits.push({ ruleId: rule.id, action: rule.action, count: 1 });
    return rule.action === "remove" ? "" : rule.replaceWith;
  }

  const subject = prepared(text, rule);

  if (rule.anchor === "start") {
    const matched = rule.regex
      ? anchoredStartMatch(subject, rule)
      : startLiteralMatch(subject, rule);
    if (!matched) return text;
    hits.push({ ruleId: rule.id, action: rule.action, count: 1 });
    const rest = subject.slice(matched.length);
    const replacement = rule.action === "remove" ? "" : rule.replaceWith;
    return tidyAfterRemoval(replacement + rest);
  }

  let count = 0;
  let next: string;
  if (rule.regex) {
    const replacement = rule.action === "remove" ? "" : rule.replaceWith;
    next = text.replace(rule.regex, () => {
      count += 1;
      return replacement;
    });
  } else {
    const terms = rule.caseSensitive
      ? [rule.literal as string]
      : Array.from(new Set([rule.literal as string, rule.literalFolded as string]));
    const pattern = new RegExp(terms.map(escapeRegExp).join("|"), rule.caseSensitive ? "g" : "gi");
    const replacement = rule.action === "remove" ? "" : rule.replaceWith;
    next = text.replace(pattern, () => {
      count += 1;
      return replacement;
    });
  }
  if (count === 0) return text;
  hits.push({ ruleId: rule.id, action: rule.action, count });
  return rule.action === "remove" ? tidyAfterRemoval(next) : next;
}

function startLiteralMatch(subject: string, rule: CompiledRule): string | null {
  const source = rule.literal as string;
  const head = subject.slice(0, source.length);
  const equal = rule.caseSensitive ? head === source : head.toLowerCase() === source.toLowerCase();
  return equal ? head : null;
}

function anchoredStartMatch(subject: string, rule: CompiledRule): string | null {
  const flags = rule.caseSensitive ? "" : "i";
  const anchored = new RegExp(`^(?:${rule.regex?.source ?? ""})`, flags);
  const match = anchored.exec(subject);
  return match ? match[0] : null;
}

/**
 * Apply every enabled rule, in order, to one string. Later rules see the output of earlier
 * ones, so chained conditions behave as an ordered pipeline.
 */
export function processText(text: string, processor: CompiledResponseProcessor): ProcessTextResult {
  if (!processor.enabled || processor.rules.length === 0 || !text) {
    return { text, changed: false, hits: [] };
  }
  const hits: RuleHit[] = [];
  let current = text;
  for (const rule of processor.rules) {
    const next = applyRule(current, rule, hits);
    if (next !== current) current = next;
  }
  return { text: current, changed: current !== text, hits };
}

/* ------------------------------------------------------------------ *
 * Response body traversal
 * ------------------------------------------------------------------ */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface WalkContext {
  processor: CompiledResponseProcessor;
  hits: RuleHit[];
}

/** Rewrite one string field; returns the same reference when nothing changed. */
function rewriteString(value: unknown, ctx: WalkContext): unknown {
  if (typeof value !== "string" || !value) return value;
  const result = processText(value, ctx.processor);
  if (!result.changed) return value;
  ctx.hits.push(...result.hits);
  return result.text;
}

/** `content` may be a string or an array of typed parts. */
function rewriteContentValue(value: unknown, ctx: WalkContext): unknown {
  if (typeof value === "string") return rewriteString(value, ctx);
  if (!Array.isArray(value)) return value;
  let changed = false;
  const parts = value.map((part) => {
    if (typeof part === "string") {
      const next = rewriteString(part, ctx);
      if (next !== part) changed = true;
      return next;
    }
    if (!isRecord(part)) return part;
    const next = rewritePart(part, ctx);
    if (next !== part) changed = true;
    return next;
  });
  return changed ? parts : value;
}

/** A typed content part (`{type:"text", text}`) or a Claude/Responses item. */
function rewritePart(part: JsonRecord, ctx: WalkContext): JsonRecord {
  let next: JsonRecord | null = null;
  const type = typeof part.type === "string" ? part.type : "";
  // Only textual parts carry answer text; tool_use / image parts are opaque.
  const isTextual =
    type === "" ||
    type === "text" ||
    type === "output_text" ||
    type === "input_text" ||
    type === "summary_text" ||
    type === "reasoning_text" ||
    type === "refusal";
  if (isTextual && typeof part.text === "string") {
    const text = rewriteString(part.text, ctx);
    if (text !== part.text) next = { ...(next ?? part), text };
  }
  if (typeof part.content === "string" || Array.isArray(part.content)) {
    const content = rewriteContentValue(part.content, ctx);
    if (content !== part.content) next = { ...(next ?? part), content };
  }
  if (typeof part.summary_text === "string") {
    const summary = rewriteString(part.summary_text, ctx);
    if (summary !== part.summary_text) next = { ...(next ?? part), summary_text: summary };
  }
  if (Array.isArray(part.summary)) {
    const current = part.summary as unknown[];
    const summary = current.map((entry) => (isRecord(entry) ? rewritePart(entry, ctx) : entry));
    if (summary.some((entry, i) => entry !== current[i])) {
      next = { ...(next ?? part), summary };
    }
  }
  if (typeof part.output_text === "string") {
    const outputText = rewriteString(part.output_text, ctx);
    if (outputText !== part.output_text) next = { ...(next ?? part), output_text: outputText };
  }
  return next ?? part;
}

function rewriteMessage(message: JsonRecord, ctx: WalkContext): JsonRecord {
  let next: JsonRecord | null = null;
  if (message.content !== undefined) {
    const content = rewriteContentValue(message.content, ctx);
    if (content !== message.content) next = { ...(next ?? message), content };
  }
  for (const key of ["reasoning_content", "reasoning", "reasoning_text", "refusal"] as const) {
    const value = message[key];
    if (typeof value !== "string") continue;
    const rewritten = rewriteString(value, ctx);
    if (rewritten !== value) next = { ...(next ?? message), [key]: rewritten };
  }
  // Anthropic tool_result content and nested assistant messages.
  if (Array.isArray(message.tool_calls)) {
    // Tool arguments stay untouched; only textual tool output is rewritten.
    void message.tool_calls;
  }
  return next ?? message;
}

function rewriteChoice(choice: unknown, ctx: WalkContext): unknown {
  if (!isRecord(choice)) return choice;
  let next: JsonRecord | null = null;
  if (isRecord(choice.message)) {
    const message = rewriteMessage(choice.message, ctx);
    if (message !== choice.message) next = { ...(next ?? choice), message };
  }
  if (isRecord(choice.delta)) {
    const delta = rewriteMessage(choice.delta, ctx);
    if (delta !== choice.delta) next = { ...(next ?? choice), delta };
  }
  if (typeof choice.text === "string") {
    const text = rewriteString(choice.text, ctx);
    if (text !== choice.text) next = { ...(next ?? choice), text };
  }
  return next ?? choice;
}

function rewriteOutputItem(item: unknown, ctx: WalkContext): unknown {
  if (!isRecord(item)) return item;
  const rewritten = rewritePart(item, ctx);
  return rewritten;
}

function rewriteErrorField(body: JsonRecord, ctx: WalkContext): JsonRecord {
  const error = body.error;
  if (isRecord(error)) {
    let next: JsonRecord | null = null;
    for (const key of ["message", "detail"] as const) {
      const value = error[key];
      if (typeof value !== "string") continue;
      const rewritten = rewriteString(value, ctx);
      if (rewritten !== value) next = { ...(next ?? error), [key]: rewritten };
    }
    return next ? { ...body, error: next } : body;
  }
  if (typeof error === "string") {
    const rewritten = rewriteString(error, ctx);
    if (rewritten !== error) return { ...body, error: rewritten };
  }
  return body;
}

/**
 * Rewrite every answer-bearing text field of a parsed response body.
 *
 * Covered shapes: OpenAI Chat Completions (`choices[].message` / `.delta` / `.text`),
 * Anthropic Messages (`content[]` parts), OpenAI Responses (`output[].content[]` /
 * `output[].summary[]`, `output_text`), and error envelopes (`error.message`). Tool
 * arguments, ids, usage and every other metadata field are left untouched.
 */
export function processResponseBody(
  body: unknown,
  processor: CompiledResponseProcessor
): ProcessBodyResult {
  if (!processor.enabled || processor.rules.length === 0 || !isRecord(body)) {
    return { body, changed: false, hits: [] };
  }
  const ctx: WalkContext = { processor, hits: [] };
  let next: JsonRecord = body;

  const bodyChoices = body.choices;
  if (Array.isArray(bodyChoices)) {
    const choices = bodyChoices.map((choice) => rewriteChoice(choice, ctx));
    if (choices.some((choice, i) => choice !== bodyChoices[i])) {
      next = { ...next, choices };
    }
  }

  const bodyOutput = body.output;
  if (Array.isArray(bodyOutput)) {
    const output = bodyOutput.map((item) => rewriteOutputItem(item, ctx));
    if (output.some((item, i) => item !== bodyOutput[i])) next = { ...next, output };
  }

  if (Array.isArray(body.content)) {
    const content = rewriteContentValue(body.content, ctx);
    if (content !== body.content) next = { ...next, content };
  }

  if (typeof body.output_text === "string") {
    const outputText = rewriteString(body.output_text, ctx);
    if (outputText !== body.output_text) next = { ...next, output_text: outputText };
  }

  if (typeof body.summary_text === "string") {
    const summary = rewriteString(body.summary_text, ctx);
    if (summary !== body.summary_text) next = { ...next, summary_text: summary };
  }

  if (typeof body.detail === "string") {
    const detail = rewriteString(body.detail, ctx);
    if (detail !== body.detail) next = { ...next, detail };
  }

  // Bare `{message: "..."}` provider error shape (no answer fields at all).
  if (
    typeof body.message === "string" &&
    body.choices === undefined &&
    body.output === undefined &&
    body.content === undefined
  ) {
    const message = rewriteString(body.message, ctx);
    if (message !== body.message) next = { ...next, message };
  }

  next = rewriteErrorField(next, ctx);

  return { body: next, changed: next !== body, hits: ctx.hits };
}

/** Merge per-rule hit counters for logging. */
export function summarizeHits(hits: RuleHit[]): Array<{ ruleId: string; count: number }> {
  const totals = new Map<string, number>();
  for (const hit of hits) totals.set(hit.ruleId, (totals.get(hit.ruleId) ?? 0) + hit.count);
  return Array.from(totals, ([ruleId, count]) => ({ ruleId, count }));
}

export { EMPTY_RESULT };
