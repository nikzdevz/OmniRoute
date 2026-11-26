/**
 * Response Processor - call-site helpers.
 *
 * Thin, total (never-throwing) wrappers so each integration point reads as one line and a
 * failure in the processor can never break a response. The compiled processor comes from the
 * cached read path, so the cost on a request is one flag check.
 */
import { getCachedResponseProcessor } from "./settings.ts";
import { processResponseBody, processText, summarizeHits } from "./engine.ts";
import type { CompiledResponseProcessor } from "./compile.ts";
import type { RuleHit } from "./engine.ts";

export interface AppliedResponseResult<T> {
  value: T;
  changed: boolean;
  hits: RuleHit[];
}

function safeProcessor(): CompiledResponseProcessor | null {
  try {
    const compiled = getCachedResponseProcessor();
    return compiled.enabled && compiled.rules.length > 0 ? compiled : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite a parsed non-streaming response body in place semantically (returns a new object
 * when anything changed). Tool calls, ids and usage are never touched.
 */
export function applyResponseProcessorToBody<T>(body: T): AppliedResponseResult<T> {
  const compiled = safeProcessor();
  if (!compiled) return { value: body, changed: false, hits: [] };
  try {
    const result = processResponseBody(body, compiled);
    return { value: result.body as T, changed: result.changed, hits: result.hits };
  } catch {
    return { value: body, changed: false, hits: [] };
  }
}

/** Rewrite one free-form string: an error message, a wrapped banner, a log line. */
export function applyResponseProcessorToText(text: string): AppliedResponseResult<string> {
  if (!text) return { value: text, changed: false, hits: [] };
  const compiled = safeProcessor();
  if (!compiled) return { value: text, changed: false, hits: [] };
  try {
    const result = processText(text, compiled);
    return { value: result.text, changed: result.changed, hits: result.hits };
  } catch {
    return { value: text, changed: false, hits: [] };
  }
}

/** Compact `rule:count` summary for a call log, or `null` when nothing matched. */
export function describeHits(hits: RuleHit[]): string | null {
  if (hits.length === 0) return null;
  return summarizeHits(hits)
    .map((entry) => `${entry.ruleId}:${entry.count}`)
    .join(",");
}

export { safeProcessor };
