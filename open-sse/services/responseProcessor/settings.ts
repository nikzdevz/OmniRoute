/**
 * Response Processor - settings storage and hot-path cache.
 *
 * The read path runs once per response, so it is served from a 5-second TTL cache that is
 * busted on save, mirroring `src/lib/db/compression.ts`. Configuration is stored through the
 * shared `updateSettings` write, which already owns the DB backup, revision bump and cache
 * invalidation, so there is no second persistence path to keep in sync.
 */
import { getDbInstance } from "@/lib/db/core";
import { updateSettings } from "@/lib/db/settings";
import { compileResponseProcessor, type CompiledResponseProcessor } from "./compile.ts";
import { MAX_EMPTY_FALLBACK_LENGTH } from "./compile.ts";
import { DEFAULT_RESPONSE_PROCESSOR_CONFIG } from "./types.ts";
import type {
  ResponseProcessorAction,
  ResponseProcessorAnchor,
  ResponseProcessorCondition,
  ResponseProcessorConfig,
  ResponseProcessorRule,
} from "./types.ts";

const SETTINGS_KEY = "responseProcessor";
const TTL_MS = 5000;
const MAX_RULES = 500;
const MAX_MATCH_SOURCE = 512;
const MAX_REPLACEMENT_LENGTH = 8192;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

const ACTIONS = new Set<ResponseProcessorAction>(["replace", "remove", "replace-whole-response"]);
const ANCHORS = new Set<ResponseProcessorAnchor>(["anywhere", "start", "whole-response"]);

function normalizeConditions(value: unknown): ResponseProcessorCondition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ResponseProcessorCondition[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const text = toStringValue(entry.value).trim();
    if (!text) continue;
    out.push({
      type: entry.type === "not-contains" ? "not-contains" : "contains",
      value: text.slice(0, MAX_MATCH_SOURCE),
      ...(entry.caseSensitive === true ? { caseSensitive: true } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeRule(value: unknown, index: number): ResponseProcessorRule | null {
  if (!isRecord(value)) return null;
  const match = toStringValue(value.match);
  if (!match) return null;
  const action = ACTIONS.has(value.action as ResponseProcessorAction)
    ? (value.action as ResponseProcessorAction)
    : "replace";
  const anchor = ANCHORS.has(value.anchor as ResponseProcessorAnchor)
    ? (value.anchor as ResponseProcessorAnchor)
    : "anywhere";
  const id = toStringValue(value.id).trim() || `rule-${index + 1}`;
  const rule: ResponseProcessorRule = {
    id,
    enabled: value.enabled !== false,
    match: match.slice(0, MAX_MATCH_SOURCE),
    matchType: value.matchType === "regex" ? "regex" : "literal",
    action,
    anchor,
  };
  const label = toStringValue(value.label).trim();
  if (label) rule.label = label.slice(0, 120);
  if (typeof value.replaceWith === "string") {
    rule.replaceWith = value.replaceWith.slice(0, MAX_REPLACEMENT_LENGTH);
  }
  if (value.caseSensitive === true) rule.caseSensitive = true;
  if (value.collapseWhitespace === true) rule.collapseWhitespace = true;
  if (typeof value.maxMatchLength === "number" && Number.isFinite(value.maxMatchLength)) {
    rule.maxMatchLength = value.maxMatchLength;
  }
  const conditions = normalizeConditions(value.conditions);
  if (conditions) rule.conditions = conditions;
  return rule;
}

/** Coerce any stored or supplied value into a valid configuration. Never throws. */
export function normalizeResponseProcessorConfig(value: unknown): ResponseProcessorConfig {
  if (!isRecord(value)) return { ...DEFAULT_RESPONSE_PROCESSOR_CONFIG, rules: [] };
  const rawRules = Array.isArray(value.rules) ? value.rules : [];
  const rules: ResponseProcessorRule[] = [];
  rawRules.slice(0, MAX_RULES).forEach((entry, index) => {
    const rule = normalizeRule(entry, index);
    if (rule) rules.push(rule);
  });
  const rawFallback = toStringValue(value.emptyFallback);
  return {
    enabled: value.enabled === true,
    rules,
    emptyFallback: rawFallback ? rawFallback.slice(0, MAX_EMPTY_FALLBACK_LENGTH) : "",
  };
}

/* ------------------------------------------------------------------ *
 * Read path
 * ------------------------------------------------------------------ */

interface CacheEntry {
  config: ResponseProcessorConfig;
  compiled: CompiledResponseProcessor;
  expiresAt: number;
  dbRef: WeakRef<object>;
}

let cache: CacheEntry | null = null;

/** Bust the hot-path cache. Called after every save. */
export function invalidateResponseProcessorCache(): void {
  cache = null;
}

function readStoredConfig(): ResponseProcessorConfig {
  try {
    const db = getDbInstance();
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = ?")
      .get(SETTINGS_KEY) as { value?: unknown } | undefined;
    if (!row || typeof row.value !== "string") return normalizeResponseProcessorConfig(undefined);
    return normalizeResponseProcessorConfig(JSON.parse(row.value));
  } catch {
    return normalizeResponseProcessorConfig(undefined);
  }
}

/**
 * The compiled processor for this response, cached for 5 seconds. Always returns a
 * processor (disabled when nothing is configured) so call sites stay branch-free.
 */
export function getCachedResponseProcessor(): CompiledResponseProcessor {
  const db = getDbInstance();
  if (cache && Date.now() < cache.expiresAt && cache.dbRef.deref() === db) {
    return cache.compiled;
  }
  const config = readStoredConfig();
  const compiled = compileResponseProcessor(config).processor;
  cache = { config, compiled, expiresAt: Date.now() + TTL_MS, dbRef: new WeakRef(db) };
  return compiled;
}

/** Configuration plus compile issues, for the dashboard and the preview endpoint. */
export function getResponseProcessorConfig(): {
  config: ResponseProcessorConfig;
  issues: ReturnType<typeof compileResponseProcessor>["issues"];
} {
  const config = readStoredConfig();
  return { config, issues: compileResponseProcessor(config).issues };
}

/** Configuration plus compiled processor in one read (dashboard save echo). */
export function compileConfig(value: unknown): {
  config: ResponseProcessorConfig;
  compiled: CompiledResponseProcessor;
  issues: ReturnType<typeof compileResponseProcessor>["issues"];
} {
  const config = normalizeResponseProcessorConfig(value);
  const { processor, issues } = compileResponseProcessor(config);
  return { config, compiled: processor, issues };
}

/* ------------------------------------------------------------------ *
 * Write path
 * ------------------------------------------------------------------ */

/**
 * Persist a configuration. Uses the shared settings write so the pre-write DB backup,
 * revision bump and settings-cache invalidation stay in one place.
 */
export async function setResponseProcessorConfig(value: unknown): Promise<{
  config: ResponseProcessorConfig;
  issues: ReturnType<typeof compileResponseProcessor>["issues"];
}> {
  const { config, issues } = compileConfig(value);
  await updateSettings({ [SETTINGS_KEY]: config });
  invalidateResponseProcessorCache();
  return { config, issues };
}
