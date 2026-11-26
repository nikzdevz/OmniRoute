/**
 * Response Processor - streaming rewriter with a holdback window.
 *
 * A streaming response arrives in fragments, so a match can straddle two chunks. This module
 * keeps the tail of the undecided text inside a buffer of `holdback` characters: text is only
 * released once no enabled rule could still extend a match into the unreleased region.
 *
 * Characters are emitted exactly once and replacements stay stable across chunk boundaries.
 * `whole-response` rules are deliberately excluded here: they need the complete text, which a
 * stream cannot provide without buffering the whole response and destroying time-to-first-byte.
 * Those rules run on the non-streaming body path; a streamed banner is caught by an
 * `anywhere` literal rule, which yields the same visible result.
 */
import type { CompiledResponseProcessor, CompiledRule } from "./compile.ts";
import { MAX_HOLDBACK } from "./compile.ts";
import { processText, type RuleHit } from "./engine.ts";

/** How much of the beginning is held back while a start-anchored rule is undecided. */
const MAX_START_HOLD = 512;

export interface StreamPushResult {
  text: string;
  hits: RuleHit[];
}

const EMPTY: StreamPushResult = { text: "", hits: [] };

function replacementFor(rule: CompiledRule): string {
  return rule.action === "remove" ? "" : rule.replaceWith;
}

function findNextLiteral(
  text: string,
  rule: CompiledRule,
  from: number
): { start: number; length: number } | null {
  const source = rule.literal as string;
  if (rule.caseSensitive) {
    const start = text.indexOf(source, from);
    return start === -1 ? null : { start, length: source.length };
  }
  const start = text.toLowerCase().indexOf(rule.literalFolded as string, from);
  return start === -1 ? null : { start, length: source.length };
}

function findNextRegex(
  text: string,
  rule: CompiledRule,
  from: number
): { start: number; length: number } | null {
  const regex = rule.regex as RegExp;
  regex.lastIndex = from;
  const match = regex.exec(text);
  if (!match || match[0].length === 0) return null;
  return { start: match.index, length: match[0].length };
}

/**
 * Apply one rule to `text`, committing only matches that end at or before `boundary`.
 * Returns the rewritten text plus the boundary translated into the rewritten coordinates.
 * A match straddling the boundary moves the boundary back to the match start, so the raw
 * fragment stays buffered for the next chunk.
 */
function applyRuleToBoundary(
  text: string,
  rule: CompiledRule,
  boundary: number,
  hits: RuleHit[]
): { text: string; boundary: number } {
  if (boundary <= 0) return { text, boundary };
  const find = rule.regex ? findNextRegex : findNextLiteral;
  const replacement = replacementFor(rule);
  let prefix = "";
  let cursor = 0;
  let limit = boundary;
  let count = 0;

  for (;;) {
    const match = find(text, rule, cursor);
    if (!match || match.start >= limit) break;
    const end = match.start + match.length;
    if (end > limit) {
      limit = match.start;
      break;
    }
    prefix += text.slice(cursor, match.start) + replacement;
    cursor = end;
    count += 1;
  }

  if (count === 0 && limit === boundary) return { text, boundary };
  prefix += text.slice(cursor, limit);
  if (count > 0) hits.push({ ruleId: rule.id, action: rule.action, count });
  return { text: prefix + text.slice(limit), boundary: prefix.length };
}

function conditionsPass(text: string, rule: CompiledRule): boolean {
  for (const condition of rule.conditions) {
    const haystack = condition.caseSensitive ? text : text.toLowerCase();
    const needle = condition.caseSensitive ? condition.value : condition.value.toLowerCase();
    const present = haystack.includes(needle);
    if (condition.type === "not-contains" ? present : !present) return false;
  }
  return true;
}

export class StreamTextRewriter {
  private buffer = "";
  private emitted = false;
  /** True once any non-empty text was released: an emptied stream counts as empty. */
  private produced = false;
  /** True once any text arrived: a lane that never saw text must stay silent. */
  private sawInput = false;
  private startDecided: boolean;
  private readonly inlineRules: CompiledRule[];
  private readonly startRules: CompiledRule[];
  private readonly holdback: number;
  private readonly startHold: number;

  constructor(
    private readonly processor: CompiledResponseProcessor,
    /**
     * Whether this lane may emit `emptyFallback` when rules consume its whole text. Only the
     * answer lane may: an emptied reasoning lane, or a stream that never carried text at all,
     * must stay empty rather than gain a reply.
     */
    private readonly allowEmptyFallback = true
  ) {
    this.inlineRules = processor.rules.filter(
      (rule) => rule.anchor === "anywhere" && rule.enabled
    );
    this.startRules = processor.rules.filter((rule) => rule.anchor === "start" && rule.enabled);
    this.startDecided = this.startRules.length === 0;
    this.startHold = Math.min(
      MAX_START_HOLD,
      this.startRules.reduce((max, rule) => Math.max(max, rule.maxMatchLength), 0)
    );
    const longest = this.inlineRules.reduce((max, rule) => Math.max(max, rule.maxMatchLength), 0);
    // Hold back one character less than the longest possible match: a match beginning at the
    // last released character then still has its full length available in the buffer.
    this.holdback = Math.min(MAX_HOLDBACK, Math.max(0, longest - 1));
  }

  /** Feed the next fragment; returns the text that is now safe to emit. */
  push(chunk: string): StreamPushResult {
    if (!chunk) return EMPTY;
    this.sawInput = true;
    this.buffer += chunk;
    if (!this.processor.enabled || (this.inlineRules.length === 0 && this.startRules.length === 0)) {
      return this.release(this.buffer);
    }
    return this.drain();
  }

  /** Final flush: apply every remaining rule to the held-back tail. */
  flush(): StreamPushResult {
    if (!this.buffer) return this.produced ? EMPTY : this.emptyFallbackResult([]);
    if (!this.processor.enabled) return this.release(this.buffer);
    const text = this.buffer;
    this.buffer = "";
    // A start rule that never got enough characters is applied now, to the complete text.
    const rules = this.startDecided
      ? this.inlineRules
      : [...this.startRules, ...this.inlineRules];
    if (rules.length === 0) {
      if (text) this.produced = true;
      return { text, hits: [] };
    }
    const result = processText(
      text,
      {
        ...this.processor,
        rules,
        hasStartRules: false,
        hasWholeResponseRules: false,
      },
      { applyEmptyFallback: false }
    );
    this.startDecided = true;
    if (result.text) {
      this.produced = true;
      return { text: result.text, hits: result.hits };
    }
    // The rules consumed the whole answer: substitute the configured reply so the client
    // never receives an empty completion for a request that produced text.
    return this.emptyFallbackResult(result.hits);
  }

  /**
   * The configured reply for a stream whose text was entirely removed, as a single hitless
   * emission. Empty when no fallback is configured, which keeps the previous behaviour, and
   * empty for a lane that never received text at all (a tool-only or usage-only lane must not
   * gain a reply).
   */
  private emptyFallbackResult(hits: RuleHit[]): StreamPushResult {
    this.emitted = true;
    if (!this.sawInput || !this.allowEmptyFallback) return { text: "", hits };
    const text = this.processor.emptyFallback;
    if (!text) return { text: "", hits };
    this.produced = true;
    return { text, hits };
  }

  private release(text: string): StreamPushResult {
    this.buffer = "";
    this.emitted = true;
    if (text) this.produced = true;
    return { text, hits: [] };
  }

  private drain(): StreamPushResult {
    const hits: RuleHit[] = [];

    if (!this.startDecided) {
      if (this.buffer.length <= this.startHold) return EMPTY;
      // The head is long enough to decide every start-anchored rule.
      for (const rule of this.startRules) {
        if (!conditionsPass(this.buffer, rule)) continue;
        const result = processText(
          this.buffer,
          {
            ...this.processor,
            rules: [{ ...rule, anchor: "start" }],
            hasStartRules: false,
            hasWholeResponseRules: false,
          },
          // A start rule that empties the head must not inject the reply mid-stream; the
          // final flush decides whether the whole answer ended up empty.
          { applyEmptyFallback: false }
        );
        if (result.changed) {
          this.buffer = result.text;
          hits.push(...result.hits);
          break;
        }
      }
      this.startDecided = true;
    }

    let boundary = Math.max(0, this.buffer.length - this.holdback);
    if (boundary === 0) return { text: "", hits };

    let work = this.buffer;
    for (const rule of this.inlineRules) {
      if (!conditionsPass(work, rule)) continue;
      const applied = applyRuleToBoundary(work, rule, boundary, hits);
      work = applied.text;
      boundary = Math.min(boundary, applied.boundary);
      if (boundary <= 0) return { text: "", hits };
    }

    const emitted = work.slice(0, boundary);
    this.buffer = work.slice(boundary);
    this.emitted = true;
    if (emitted) this.produced = true;
    return { text: emitted, hits };
  }
}

/** Convenience factory mirroring the engine's entry points. */
export function createStreamRewriter(
  processor: CompiledResponseProcessor,
  allowEmptyFallback = true
): StreamTextRewriter {
  return new StreamTextRewriter(processor, allowEmptyFallback);
}

/** Cap used by callers that must bound a single buffered field. */
export { MAX_HOLDBACK };
