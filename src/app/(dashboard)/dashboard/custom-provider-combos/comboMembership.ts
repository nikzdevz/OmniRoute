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

export interface ComboSavePlan {
  comboId: string;
  /** Full step array to send: untouched steps + retargeted membership. */
  models: ComboStepEntry[];
  /** Models appended to this combo (for the success summary). */
  added: string[];
  /** Models removed from this combo (for the success summary). */
  removed: string[];
}

/**
 * Compute the step array each affected combo should end up with.
 *
 * A combo is only rewritten when at least one of the page's models actually changed
 * membership in it; every step the page does not manage is copied through untouched
 * (including legacy plain-string entries), which is what keeps hand-set weights,
 * connection pins and labels alive.
 */
export function planComboUpdates({
  combos,
  identities,
  dirty,
}: {
  combos: Array<{ id: string; models?: ComboStepEntry[] }>;
  identities: Map<string, ModelIdentity>;
  dirty: Record<string, boolean>;
}): ComboSavePlan[] {
  const plans: ComboSavePlan[] = [];

  for (const combo of combos) {
    const added: string[] = [];
    const removed: string[] = [];

    identities.forEach((identity, target) => {
      if (dirty[dirtyKey(combo.id, target)] !== true) return;
      const stored = (combo.models ?? []).some((step) => stepMatchesModel(step, identity));
      // The page only ever flips a pair, so "dirty" means the final state is the
      // opposite of the stored one.
      if (stored) removed.push(target);
      else added.push(target);
    });

    if (added.length === 0 && removed.length === 0) continue;

    // Drop exactly the steps for the models that were un-ticked; keep everything else,
    // including steps this page cannot identify (other providers, wildcards, refs).
    const untouched = (combo.models ?? []).filter((step) => {
      const isManaged = [...identities.values()].some((identity) => stepMatchesModel(step, identity));
      if (!isManaged) return true;
      return added.some((target) => stepMatchesModel(step, identities.get(target)!));
    });

    const staged: ComboStepEntry[] = [
      ...untouched,
      ...added.map((target) => {
        const identity = identities.get(target)!;
        return { kind: "model", model: target, providerId: identity.providerId, weight: 0 };
      }),
    ];

    plans.push({ comboId: combo.id, models: staged, added, removed });
  }

  return plans;
}

/**
 * Turn a rejected combo PUT into a message worth showing.
 *
 * `/api/combos/*` answers with `{ error: { code, message, details } }` and the
 * meaningful reason is usually in `details` (`firstMessage`, `reason`, a zod
 * `issues` list), not in the generic catalog message — so read it out of there.
 */
export async function describeComboError(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string" && error.trim().length > 0) {
    return `${response.status} ${error}`;
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const details = (record.details ?? {}) as Record<string, unknown>;
    const reason =
      (typeof details.firstMessage === "string" && details.firstMessage) ||
      (typeof details.reason === "string" && details.reason) ||
      (typeof details.field === "string" && details.field) ||
      firstIssueMessage(details.issues);
    const base = typeof record.message === "string" ? record.message : "Unknown error";
    return reason ? `${record.code ?? response.status}: ${reason} (${base})` : `${record.code ?? response.status}: ${base}`;
  }
  return `HTTP ${response.status}`;
}

/** The first field/message pair of a zod issues array, flattened. */
function firstIssueMessage(issues: unknown): string | null {
  if (!Array.isArray(issues)) return null;
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") continue;
    const record = issue as Record<string, unknown>;
    const field = Array.isArray(record.path) ? record.path.join(".") : (record.path as string);
    if (typeof record.message === "string") {
      return field ? `${field}: ${record.message}` : record.message;
    }
  }
  return null;
}

/** A fetch that never reached the server (offline, DNS, CORS, aborted). */
export function describeFetchError(error: unknown): string {
  if (error instanceof TypeError) return "network error — could not reach the server";
  if (error instanceof DOMException && error.name === "AbortError") return "request timed out";
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}