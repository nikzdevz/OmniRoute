/**
 * Response Processor - rule compilation.
 *
 * Rules come from operator configuration and are compiled once per settings revision:
 * literal patterns are pre-lowercased, regexes are compiled behind a length cap and a
 * catastrophic-backtracking heuristic, and every rule declares the longest text it can
 * match so the streaming path knows how much text it must hold back. Nothing here is
 * stateful: a compiled processor is immutable and shared across requests.
 */
import type {
  ResponseProcessorAction,
  ResponseProcessorAnchor,
  ResponseProcessorCondition,
  ResponseProcessorRule,
} from "./types.ts";

/** Hard ceiling for a single pattern source (literal or regex). */
export const MAX_MATCH_SOURCE_LENGTH = 512;
/** Ceiling for a declared streaming holdback contribution. */
export const MAX_MATCH_LENGTH = 4096;
/** Default holdback contribution for a regex rule that did not declare one. */
const DEFAULT_REGEX_MATCH_LENGTH = 256;
/** Ceiling for the whole streaming holdback window (safety valve before a forced flush). */
export const MAX_HOLDBACK = 8192;

export interface CompiledCondition {
  type: ResponseProcessorCondition["type"];
  value: string;
  caseSensitive: boolean;
}

export interface CompiledRule {
  id: string;
  label: string;
  enabled: boolean;
  action: ResponseProcessorAction;
  anchor: ResponseProcessorAnchor;
  caseSensitive: boolean;
  /** Literal source as written (original casing). */
  literal?: string;
  /** Literal source folded for case-insensitive scanning. */
  literalFolded?: string;
  regex?: RegExp;
  replaceWith: string;
  maxMatchLength: number;
  conditions: CompiledCondition[];
  collapseWhitespace: boolean;
}

export interface CompiledResponseProcessor {
  enabled: boolean;
  rules: CompiledRule[];
  /**
   * Characters a streaming response must hold back before it can emit, so a match that
   * begins in the emitted region can never extend into the unemitted tail.
   */
  holdback: number;
  /** Whether any enabled rule anchors at the start of the text. */
  hasStartRules: boolean;
  /** Whether any enabled rule requires the whole response text. */
  hasWholeResponseRules: boolean;
}

export interface RuleCompileIssue {
  ruleId: string;
  message: string;
}

export interface CompileResult {
  processor: CompiledResponseProcessor;
  /** Rules dropped because they were unusable; surfaced by the dashboard test endpoint. */
  issues: RuleCompileIssue[];
}

const EMPTY_PROCESSOR: CompiledResponseProcessor = {
  enabled: false,
  rules: [],
  holdback: 0,
  hasStartRules: false,
  hasWholeResponseRules: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Nested-quantifier heuristic: `(a+)+`, `(a*)*`, `(\w+)*` compile fine but can backtrack
 * exponentially. Rejecting the obvious shapes is cheap and keeps operator-supplied regexes
 * from stalling the response path. Longer, subtler cases are bounded by the source-length cap.
 */
function looksCatastrophic(source: string): boolean {
  return /\((?:\\.|[^()\\])*[+*]\)[+*{]/.test(source) || /\((?:\\.|[^()\\])*\|(?:\\.|[^()\\])*\)[+*]{2}/.test(source);
}

function compileConditions(value: unknown): CompiledCondition[] {
  if (!Array.isArray(value)) return [];
  const out: CompiledCondition[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const type = entry.type === "not-contains" ? "not-contains" : "contains";
    const text = toStringValue(entry.value);
    if (!text) continue;
    out.push({ type, value: text, caseSensitive: entry.caseSensitive === true });
  }
  return out;
}

function compileRule(rule: ResponseProcessorRule): CompiledRule | RuleCompileIssue {
  const id = toStringValue(rule?.id) || "unnamed";
  const match = toStringValue(rule?.match);
  if (!match) return { ruleId: id, message: "match is empty" };
  if (match.length > MAX_MATCH_SOURCE_LENGTH) {
    return { ruleId: id, message: `match exceeds ${MAX_MATCH_SOURCE_LENGTH} characters` };
  }

  const action: ResponseProcessorAction =
    rule.action === "remove" || rule.action === "replace-whole-response" ? rule.action : "replace";
  const anchor: ResponseProcessorAnchor =
    rule.anchor === "start" || rule.anchor === "whole-response" ? rule.anchor : "anywhere";
  const caseSensitive = rule.caseSensitive === true;
  const effectiveAnchor: ResponseProcessorAnchor =
    action === "replace-whole-response" ? "whole-response" : anchor;

  const compiled: CompiledRule = {
    id,
    label: toStringValue(rule.label) || match.slice(0, 60),
    enabled: rule.enabled !== false,
    action,
    anchor: effectiveAnchor,
    caseSensitive,
    replaceWith: action === "remove" ? "" : toStringValue(rule.replaceWith),
    maxMatchLength: 0,
    conditions: compileConditions(rule.conditions),
    collapseWhitespace: rule.collapseWhitespace === true,
  };

  if (rule.matchType === "regex") {
    if (looksCatastrophic(match)) {
      return { ruleId: id, message: "regex is rejected as a catastrophic-backtracking risk" };
    }
    try {
      compiled.regex = new RegExp(match, caseSensitive ? "g" : "gi");
    } catch (error) {
      return {
        ruleId: id,
        message: `invalid regex: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const declared = Number(rule.maxMatchLength);
    compiled.maxMatchLength =
      Number.isFinite(declared) && declared > 0
        ? Math.min(Math.floor(declared), MAX_MATCH_LENGTH)
        : DEFAULT_REGEX_MATCH_LENGTH;
  } else {
    compiled.literal = match;
    compiled.literalFolded = caseSensitive ? match : match.toLowerCase();
    compiled.maxMatchLength = match.length;
  }

  if (effectiveAnchor === "start" || effectiveAnchor === "whole-response") {
    // Anchored rules can never match more than the anchored source itself.
    compiled.maxMatchLength = Math.max(compiled.maxMatchLength, match.length);
  }

  return compiled;
}

/**
 * Compile operator configuration into an immutable processor. Invalid rules are dropped and
 * reported instead of failing the whole configuration: one bad regex must not disable the
 * layer for every provider.
 */
export function compileResponseProcessor(config: unknown): CompileResult {
  if (!isRecord(config)) return { processor: EMPTY_PROCESSOR, issues: [] };
  const rawRules = Array.isArray(config.rules) ? (config.rules as ResponseProcessorRule[]) : [];
  const issues: RuleCompileIssue[] = [];
  const rules: CompiledRule[] = [];

  for (const rawRule of rawRules) {
    if (!isRecord(rawRule)) continue;
    const compiled = compileRule(rawRule as ResponseProcessorRule);
    if ("message" in compiled) {
      issues.push(compiled);
      continue;
    }
    if (!compiled.enabled) continue;
    rules.push(compiled);
  }

  if (rules.length === 0) {
    return { processor: EMPTY_PROCESSOR, issues };
  }

  let holdback = 0;
  for (const rule of rules) {
    if (rule.anchor === "whole-response") continue;
    holdback = Math.max(holdback, rule.maxMatchLength);
  }
  // A match that starts at the last emitted position may extend `maxMatchLength` forward,
  // so the emitted prefix must stop one character before the longest possible match end.
  holdback = holdback > 0 ? Math.min(holdback, MAX_HOLDBACK) : 0;

  const processor: CompiledResponseProcessor = {
    enabled: config.enabled !== false,
    rules,
    holdback,
    hasStartRules: rules.some((rule) => rule.anchor === "start"),
    hasWholeResponseRules: rules.some((rule) => rule.anchor === "whole-response"),
  };
  return { processor, issues };
}

/**
 * Validate rules without producing a processor. Used by the settings API so a bad regex is
 * rejected at save time instead of being silently dropped at runtime.
 */
export function validateResponseProcessorRules(rules: unknown): RuleCompileIssue[] {
  if (!Array.isArray(rules)) return [];
  const issues: RuleCompileIssue[] = [];
  for (const rawRule of rules) {
    if (!isRecord(rawRule)) continue;
    const compiled = compileRule(rawRule as unknown as ResponseProcessorRule);
    if ("message" in compiled) issues.push(compiled);
  }
  return issues;
}

export { EMPTY_PROCESSOR };
