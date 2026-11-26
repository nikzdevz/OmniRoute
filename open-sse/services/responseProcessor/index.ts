/**
 * Response Processor - public entry point.
 *
 * One seam for the whole feature: settings normalization, rule compilation, non-streaming
 * body rewriting and the streaming rewriter. Call sites import only from this module.
 */
export * from "./types.ts";
export {
  compileResponseProcessor,
  validateResponseProcessorRules,
  EMPTY_PROCESSOR,
  MAX_HOLDBACK,
  MAX_MATCH_LENGTH,
  MAX_MATCH_SOURCE_LENGTH,
  MAX_EMPTY_FALLBACK_LENGTH,
  type CompileResult,
  type CompiledCondition,
  type CompiledResponseProcessor,
  type CompiledRule,
  type RuleCompileIssue,
} from "./compile.ts";
export {
  processResponseBody,
  processText,
  summarizeHits,
  type ProcessBodyResult,
  type ProcessTextOptions,
  type ProcessTextResult,
  type RuleHit,
} from "./engine.ts";
export {
  createStreamRewriter,
  StreamTextRewriter,
  type StreamPushResult,
} from "./stream.ts";
export {
  normalizeResponseProcessorConfig,
  compileConfig,
  getCachedResponseProcessor,
  getResponseProcessorConfig,
  setResponseProcessorConfig,
  invalidateResponseProcessorCache,
} from "./settings.ts";
export { DEFAULT_RULE_TEMPLATES, DEFAULT_RESPONSE_PROCESSOR_PACK } from "./defaultPack.ts";
export { DEFAULT_RESPONSE_PROCESSOR_CONFIG } from "./types.ts";
