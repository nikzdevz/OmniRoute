// Combo membership identity for the Custom Provider Models → Combos page.
//
// A combo step can name the model's provider three ways — the node routing prefix
// (`myprefix/llama-3`), the raw node id (`openai-compatible-chat-<uuid>/llama-3`),
// or a bare model id plus `providerId` — so matching on the raw string alone misses
// membership (and then duplicates the step on save). Identity is therefore
// (provider identity, model id).

export interface StoredComboStep {
  kind?: string;
  model?: string;
  providerId?: string;
}

export type ComboStepEntry = StoredComboStep | string;

export interface ModelIdentity {
  /** The builder's routing-qualified target (`prefix/model-id`). */
  target: string;
  modelId: string;
  /** Every prefix spelling accepted for this model's provider. */
  prefixes: Set<string>;
  providerId: string;
}

export function splitTarget(value: string): { prefix: string; modelId: string } {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return { prefix: "", modelId: trimmed };
  return { prefix: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

/**
 * Build the identity for one model of one custom provider. `providerId` is the
 * node's internal id; `prefix`/`alias` are routing spellings that are all accepted.
 */
export function buildModelIdentity({
  providerId,
  prefix,
  alias,
  modelId,
  qualifiedModel,
}: {
  providerId: string;
  prefix?: string | null;
  alias?: string | null;
  modelId: string;
  qualifiedModel: string;
}): ModelIdentity {
  const prefixes = new Set<string>([providerId, splitTarget(qualifiedModel).prefix]);
  if (prefix) prefixes.add(prefix);
  if (alias) prefixes.add(alias);
  return { target: qualifiedModel, modelId, prefixes, providerId };
}

/**
 * Whether a stored step targets this specific model.
 *
 * A combo reference or a provider wildcard is a different step kind: reporting it as
 * "this model is a member" would make un-ticking delete a wildcard that serves the
 * whole provider, so those are never treated as the model itself.
 */
export function stepMatchesModel(step: ComboStepEntry | null | undefined, identity: ModelIdentity): boolean {
  const raw = typeof step === "string" ? step : step?.model;
  if (typeof raw !== "string" || raw.trim().length === 0) return false;
  if (typeof step !== "string" && (step?.kind === "combo-ref" || step?.kind === "provider-wildcard")) {
    return false;
  }

  const { prefix, modelId } = splitTarget(raw);
  if (modelId !== identity.modelId) return false;
  if (identity.prefixes.has(prefix)) return true;
  // A bare model id is unambiguous only when the step names its provider explicitly.
  return prefix.length === 0 && typeof step !== "string" && step?.providerId === identity.providerId;
}

/** The model targets each combo currently holds, across the page's models. */
export function buildComboMembership(
  combos: Array<{ id: string; models?: ComboStepEntry[] }>,
  identities: Iterable<[string, ModelIdentity]>
): Map<string, Set<string>> {
  const membership = new Map<string, Set<string>>();
  for (const combo of combos) {
    const steps = combo.models ?? [];
    for (const [target, identity] of identities) {
      if (!steps.some((step) => stepMatchesModel(step, identity))) continue;
      const current = membership.get(target);
      if (current) current.add(combo.id);
      else membership.set(target, new Set([combo.id]));
    }
  }
  return membership;
}

/** The dirty-map key for one (combo, model) pair. */
export function dirtyKey(comboId: string, target: string): string {
  return `${comboId}::${target}`;
}

/**
 * Resolve a model's ticked combos: stored membership with every pending change
 * applied. A dirty key means "the operator flipped this pair", so `stored.has(...)`
 * is inverted for it.
 */
export function resolveSelectedComboIds(
  comboIds: string[],
  target: string,
  stored: Set<string>,
  dirty: Record<string, boolean>
): string[] {
  return comboIds.filter((comboId) => {
    const flipped = dirty[dirtyKey(comboId, target)] === true;
    return flipped ? !stored.has(comboId) : stored.has(comboId);
  });
}