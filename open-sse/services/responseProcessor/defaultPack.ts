import type { ResponseProcessorConfig, ResponseProcessorRule } from "./types.ts";
import { DEFAULT_RESPONSE_PROCESSOR_CONFIG } from "./types.ts";

export { DEFAULT_RESPONSE_PROCESSOR_CONFIG };

/**
 * Starter rule pack.
 *
 * A universal, provider-agnostic set of rules an operator imports from the dashboard in one
 * click. The pack is inert on its own: the master flag stays off and nothing is persisted
 * until someone saves it. Every rule is a literal, so each one is a single case-insensitive
 * scan and can be previewed exactly, and every pattern is short enough to sit comfortably
 * inside the streaming holdback window.
 *
 * Groups:
 * - brand and reseller identifiers: removed
 * - attribution, marketing and sales lines: removed
 * - a full assistant greeting banner: the whole response is replaced
 * - upstream error wrappers: replaced with neutral wording
 * - emoji decoration: shipped disabled, because legitimate answers use emoji
 */

interface PackEntry {
  id: string;
  label: string;
  match: string;
  action: ResponseProcessorRule["action"];
  replaceWith?: string;
  anchor?: ResponseProcessorRule["anchor"];
  enabled?: boolean;
}

const BRANDS: PackEntry[] = [
  { id: "brand-pecuti", label: "Reseller brand", match: "PECUTI", action: "remove" },
  { id: "brand-onihub", label: "Reseller brand", match: "OniHub", action: "remove" },
  { id: "brand-onirouter", label: "Reseller brand", match: "OniRouter", action: "remove" },
  { id: "brand-lucif", label: "Reseller brand", match: "LUCIF", action: "remove" },
  { id: "brand-escavalabs", label: "Reseller brand", match: "ESCAVALABS", action: "remove" },
  { id: "brand-jerouter", label: "Reseller brand", match: "JEROUTER", action: "remove" },
  { id: "brand-tiprouter", label: "Reseller brand", match: "tiprouter", action: "remove" },
  { id: "brand-tiprouter-prefix", label: "Reseller error prefix", match: "TipRouter:", action: "remove" },
  { id: "brand-madefaka", label: "Reseller brand", match: "Madefaka", action: "remove" },
  { id: "brand-clucy", label: "Reseller brand", match: "Clucy", action: "remove" },
  { id: "brand-cpec", label: "Reseller brand", match: "cpec", action: "remove" },
  { id: "brand-vyce", label: "Reseller brand", match: "VYCE", action: "remove" },
  { id: "brand-top-tools", label: "Reseller brand", match: "Top-Tools-Ai-Basic", action: "remove" },
  { id: "brand-pollinations", label: "Reseller brand", match: "pollinations", action: "remove" },
  { id: "brand-oao", label: "Reseller brand", match: "OAO", action: "remove" },
  { id: "brand-jroute", label: "Reseller brand", match: "jroute", action: "remove" },
  { id: "brand-coni", label: "Reseller brand", match: "coni", action: "remove" },
  { id: "brand-escav", label: "Reseller brand", match: "escav", action: "remove" },
  { id: "brand-ikona", label: "Reseller brand", match: "Ikona", action: "remove" },
  { id: "brand-telegram-handle", label: "Reseller contact handle", match: "@azka9218", action: "remove" },
];

const SALES: PackEntry[] = [
  { id: "sales-reseller-liar", label: "Reseller accusation", match: "reseller liar", action: "remove" },
  { id: "sales-got-from-elsewhere", label: "Reseller accusation", match: "Dapat dari orang lain", action: "remove" },
  { id: "sales-official-price", label: "Unauthorized pricing", match: "Harga resmi cuma", action: "remove" },
  { id: "sales-rpm-hint", label: "Unauthorized pricing", match: "/RPM", action: "remove" },
  { id: "sales-report-to", label: "Reseller escalation line", match: "Laporkan ke", action: "remove" },
  { id: "sales-upgrade-limit", label: "Upsell line", match: "Upgrade limit", action: "remove" },
  { id: "sales-gray-market", label: "Reseller accusation", match: "gray market", action: "remove" },
  { id: "sales-grey-market", label: "Reseller accusation", match: "grey market", action: "remove" },
  { id: "sales-powered-exclusively", label: "Attribution line", match: "powered exclusively by", action: "remove" },
  { id: "sales-premier-assistant", label: "Attribution line", match: "premier intelligent AI assistant", action: "remove" },
];

const ERROR_WRAPPERS: PackEntry[] = [
  {
    id: "err-warning-banner",
    label: "Reseller warning banner",
    match: "Warning |",
    action: "remove",
    anchor: "start",
  },
  {
    id: "err-rejected-as-invalid",
    label: "Upstream rejection wrapper",
    match: "the request was rejected as invalid",
    action: "replace",
    replaceWith: "The upstream provider rejected this request.",
  },
  {
    id: "err-check-format",
    label: "Retry instruction",
    match: "Check the request format and try again",
    action: "remove",
  },
  {
    id: "err-kendala",
    label: "Upstream failure wrapper",
    match: "Kendala pada model",
    action: "replace",
    replaceWith: "Upstream model error",
  },
  {
    id: "err-aborted",
    label: "Aborted marker",
    match: " aborted",
    action: "remove",
  },
  {
    id: "err-client-wrapper",
    label: "Client transport error wrapper",
    match: "Opencode failed to send message with error:",
    action: "remove",
  },
  {
    id: "err-refusal-preamble",
    label: "Model refusal preamble",
    match: "As an AI language model",
    action: "remove",
  },
  {
    id: "err-cannot-assist",
    label: "Model refusal preamble",
    match: "I'm sorry, I can't assist",
    action: "remove",
  },
  {
    id: "err-unauthorized-access",
    label: "Internal diagnostic",
    match: "unauthorized access",
    action: "replace",
    replaceWith: "Access denied.",
  },
  {
    id: "err-upstream-error",
    label: "Internal diagnostic",
    match: "upstream error",
    action: "replace",
    replaceWith: "Provider failure",
  },
  {
    id: "err-rate-limit",
    label: "Internal diagnostic",
    match: "rate limit exceeded",
    action: "replace",
    replaceWith: "Rate limit reached.",
  },
  {
    id: "err-quota-exceeded",
    label: "Internal diagnostic",
    match: "quota exceeded",
    action: "replace",
    replaceWith: "Quota reached.",
  },
];

const BANNERS: PackEntry[] = [
  {
    id: "banner-greeting-pecuti",
    label: "Assistant greeting banner",
    match: "Hi, I'm PECUTI AI. How can I help?",
    action: "replace-whole-response",
    anchor: "whole-response",
    replaceWith: "How can I help?",
  },
  {
    id: "banner-powered-by",
    label: "Attribution line",
    match: "Powered by ",
    action: "remove",
  },
  {
    id: "banner-provided-by",
    label: "Attribution line",
    match: "Provided by OAO",
    action: "remove",
  },
];

/** Emoji decoration. Disabled by default: legitimate answers use these on purpose. */
const EMOJI: PackEntry[] = [
  { id: "emoji-warning", label: "Emoji decoration", match: "⚠️", action: "remove", enabled: false },
  { id: "emoji-check", label: "Emoji decoration", match: "✅", action: "remove", enabled: false },
  { id: "emoji-cross", label: "Emoji decoration", match: "❌", action: "remove", enabled: false },
  { id: "emoji-star", label: "Emoji decoration", match: "⭐", action: "remove", enabled: false },
  { id: "emoji-fire", label: "Emoji decoration", match: "🔥", action: "remove", enabled: false },
  { id: "emoji-gem", label: "Emoji decoration", match: "💎", action: "remove", enabled: false },
  { id: "emoji-rocket", label: "Emoji decoration", match: "🚀", action: "remove", enabled: false },
  { id: "emoji-bolt", label: "Emoji decoration", match: "⚡", action: "remove", enabled: false },
];

function toRule(entry: PackEntry): ResponseProcessorRule {
  return {
    id: entry.id,
    label: entry.label,
    enabled: entry.enabled !== false,
    match: entry.match,
    matchType: "literal",
    anchor: entry.anchor ?? "anywhere",
    action: entry.action,
    ...(entry.replaceWith !== undefined ? { replaceWith: entry.replaceWith } : {}),
  };
}

/** Importable starter pack. Saved only when an operator explicitly imports it. */
export const DEFAULT_RESPONSE_PROCESSOR_PACK: ResponseProcessorConfig = {
  enabled: false,
  // Banners run first: a whole-response rule only matches the untouched greeting, so the
  // brand removal that follows can never break its match.
  rules: [...BANNERS, ...BRANDS, ...SALES, ...ERROR_WRAPPERS, ...EMOJI].map(toRule),
};

/** Alias kept for the dashboard and for tests that reason about templates. */
export const DEFAULT_RULE_TEMPLATES: ResponseProcessorRule[] = DEFAULT_RESPONSE_PROCESSOR_PACK.rules;
