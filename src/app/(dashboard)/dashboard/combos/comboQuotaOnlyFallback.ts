import type { ComboStep } from "@/lib/combos/steps";

export function setQuotaOnlyFallback(
  entries: ComboStep[],
  index: number,
  enabled: boolean
): ComboStep[] {
  const selected = entries[index];
  if (!selected || (selected.kind !== "model" && selected.kind !== "combo-ref")) return entries;
  const next = [...entries];
  const { fallbackOnlyOnQuotaExhaustion: _removed, ...entry } = selected;
  next[index] = enabled ? { ...entry, fallbackOnlyOnQuotaExhaustion: true } : entry;
  return next;
}

export function requiresExecuteMode(strategy: string, entries: ComboStep[]): boolean {
  // Speed-combo chains fallback combos: a combo-ref step must run as a unit
  // (its own strategy, its own retries) so the series-of-models → series-of-
  // combos cascade keeps working when the builder saves the combo.
  if (strategy === "speed-combo" && entries.some((entry) => entry.kind === "combo-ref")) {
    return true;
  }
  return (
    strategy === "priority" &&
    entries.some(
      (entry) => entry.kind === "combo-ref" && entry.fallbackOnlyOnQuotaExhaustion === true
    )
  );
}

export function applyQuotaOnlyFallbackConfig(
  strategy: string,
  entries: ComboStep[],
  config: Record<string, unknown>
): Record<string, unknown> {
  return requiresExecuteMode(strategy, entries)
    ? { ...config, nestedComboMode: "execute" }
    : config;
}
