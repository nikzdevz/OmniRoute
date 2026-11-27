"use client";

// Custom Provider Models → Combos
//
// Lists every model exposed by the operator's self-added providers (provider_nodes)
// and lets the operator tick, per model, which combos the model belongs to. The
// checklist reads the membership already stored in each combo, so un-ticking a box
// removes the step again instead of only ever adding.
//
// Data:
//   GET /api/combos/builder/options — custom providers + models (qualifiedModel
//     carries the node routing prefix) + connections.
//   GET /api/combos                 — full combo rows (needed for their step lists).
//   PUT /api/combos/{id}            — writes the merged step array back.
//
// Identity matching (why not plain string equality) lives in ./comboMembership.ts.

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Icon from "@/shared/components/Icon";
import Input from "@/shared/components/Input";
import { matchesSearch } from "@/shared/utils/turkishText";
import { useNotificationStore } from "@/store/notificationStore";
import ComboMembershipSelect from "./ComboMembershipSelect";
import {
  buildComboMembership,
  buildModelIdentity,
  dirtyKey,
  resolveSelectedComboIds,
  stepMatchesModel,
  type ComboStepEntry,
  type ModelIdentity,
} from "./comboMembership";

interface BuilderModel {
  id: string;
  name: string;
  qualifiedModel: string;
}

interface BuilderProvider {
  providerId: string;
  displayName: string;
  prefix?: string | null;
  alias?: string;
  source: string;
  models: BuilderModel[];
}

interface ComboRecord {
  id: string;
  name: string;
  models?: ComboStepEntry[];
}

export default function CustomProviderCombosPage() {
  const notify = useNotificationStore();
  const [providers, setProviders] = useState<BuilderProvider[]>([]);
  const [combos, setCombos] = useState<ComboRecord[]>([]);
  /** `${comboId}::${target}` -> the operator flipped this pair's membership. */
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [optionsRes, combosRes] = await Promise.all([
        fetch("/api/combos/builder/options", { cache: "no-store" }),
        fetch("/api/combos?limit=200", { cache: "no-store" }),
      ]);

      if (!optionsRes.ok) throw new Error(`builder options: ${optionsRes.status}`);
      const optionsData = await optionsRes.json();
      const allProviders: BuilderProvider[] = Array.isArray(optionsData.providers)
        ? optionsData.providers
        : [];
      setProviders(allProviders.filter((provider) => provider.source === "provider-node"));

      if (!combosRes.ok) throw new Error(`combos: ${combosRes.status}`);
      const combosData = await combosRes.json();
      setCombos(Array.isArray(combosData.combos) ? combosData.combos : []);
      setDirty({});
    } catch (error) {
      console.error(error);
      notify.error("Failed to load custom providers and combos");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll();
  }, [loadAll]);

  /** model target -> its identity, so steps can be compared provider-prefix-tolerantly. */
  const identities = useMemo(() => {
    const map = new Map<string, ModelIdentity>();
    providers.forEach((provider) => {
      provider.models.forEach((model) => {
        map.set(
          model.qualifiedModel,
          buildModelIdentity({
            providerId: provider.providerId,
            prefix: provider.prefix,
            alias: provider.alias,
            modelId: model.id,
            qualifiedModel: model.qualifiedModel,
          })
        );
      });
    });
    return map;
  }, [providers]);

  const membership = useMemo(
    () => buildComboMembership(combos, identities),
    [combos, identities]
  );

  const comboIds = useMemo(() => combos.map((combo) => combo.id), [combos]);

  /** Ticked combo ids for one model: stored membership with the pending edits applied. */
  const selectedComboIds = useCallback(
    (target: string) =>
      resolveSelectedComboIds(comboIds, target, membership.get(target) ?? new Set<string>(), dirty),
    [comboIds, membership, dirty]
  );

  const setModelCombos = useCallback(
    (target: string, nextIds: string[]) => {
      const stored = membership.get(target);
      const nextSet = new Set(nextIds);
      setDirty((current) => {
        const updated = { ...current };
        comboIds.forEach((comboId) => {
          const key = dirtyKey(comboId, target);
          if (nextSet.has(comboId) === Boolean(stored?.has(comboId))) delete updated[key];
          else updated[key] = true;
        });
        return updated;
      });
    },
    [comboIds, membership]
  );

  const dirtyCount = Object.keys(dirty).length;

  const save = async () => {
    if (dirtyCount === 0) return;
    setSaving(true);
    try {
      let updatedCombos = 0;
      const failures: string[] = [];

      for (const combo of combos) {
        let changed = false;
        const nextIdentities: ModelIdentity[] = [];

        identities.forEach((identity, target) => {
          if (dirty[dirtyKey(combo.id, target)] !== true) return;
          const shouldBeIn = selectedComboIds(target).includes(combo.id);
          if (shouldBeIn) nextIdentities.push(identity);
          else changed = true;
        });

        if (!changed && nextIdentities.length === 0) continue;

        // Keep every step this page does not manage, drop the models it was un-ticked
        // for, then append the newly ticked ones as prefixed model steps.
        const currentSteps = combo.models ?? [];
        const retained = currentSteps.filter(
          (step) =>
            !identities.some((identity) => stepMatchesModel(step, identity)) ||
            nextIdentities.some((identity) => stepMatchesModel(step, identity))
        );
        const staged =
          changed || nextIdentities.length > 0
            ? [
                ...retained,
                ...nextIdentities.map((identity) => ({
                  kind: "model",
                  model: identity.target,
                  providerId: identity.providerId,
                  weight: 0,
                })),
              ]
            : retained;

        if (!changed && staged.length === retained.length) continue;

        const res = await fetch(`/api/combos/${encodeURIComponent(combo.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ models: staged, overrideAllowedProviders: true }),
        });
        if (res.ok) {
          updatedCombos += 1;
          continue;
        }
        const body = await res.json().catch(() => null);
        failures.push(
          `${combo.name}: ${
            typeof body?.error === "string" ? body.error : (body?.firstMessage ?? `HTTP ${res.status}`)
          }`
        );
      }

      if (failures.length > 0) {
        notify.warning(`Some combos were not updated — ${failures.join(" · ")}`);
      }
      if (updatedCombos > 0) notify.success(`Saved to ${updatedCombos} combo(s)`);
      else if (failures.length === 0) notify.error("Save failed");
      await loadAll();
    } catch {
      notify.error("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const comboOptions = useMemo(
    () => combos.map((combo) => ({ id: combo.id, name: combo.name })),
    [combos]
  );

  const filteredProviders = useMemo(
    () =>
      providers
        .map((provider) => {
          const providerMatches = query
            ? matchesSearch(`${provider.displayName} ${provider.providerId}`, query)
            : true;
          const models = providerMatches
            ? provider.models
            : provider.models.filter((model) =>
                matchesSearch(`${model.name} ${model.id} ${model.qualifiedModel}`, query)
              );
          return { ...provider, models };
        })
        .filter((provider) => provider.models.length > 0),
    [providers, query]
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader compact title="Custom Provider Models → Combos" />

      <Card
        title="Models & combos"
        subtitle="Tick the combos each self-added provider model should serve, then save."
        icon="layers"
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-60 flex-1"
              placeholder="Search models or providers…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search models or providers"
            />
            <Button variant="outline" onClick={loadAll} disabled={loading || saving}>
              <Icon name="refresh" size={14} /> Refresh
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={loading || dirtyCount === 0}
              onClick={save}
            >
              Save assignments
            </Button>
          </div>

          {loading && <p className="text-xs text-text-muted">Loading providers and models…</p>}

          {!loading && filteredProviders.length === 0 && (
            <p className="text-xs text-text-muted">
              No custom providers with models found. Add one under Providers → Add custom provider.
            </p>
          )}

          {filteredProviders.map((provider) => (
            <section
              key={provider.providerId}
              className="overflow-hidden rounded-md border border-border"
            >
              <header className="flex flex-wrap items-center justify-between gap-2 bg-bg-subtle px-3 py-2">
                <span className="text-sm font-medium">{provider.displayName}</span>
                <span className="text-xs text-text-muted">
                  {provider.models.length} models · {provider.prefix ?? provider.providerId}
                </span>
              </header>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-text-muted">
                    <th className="px-3 py-2 text-left font-medium">Model</th>
                    <th className="w-64 px-3 py-2 text-left font-medium">Combos</th>
                  </tr>
                </thead>
                <tbody>
                  {provider.models.map((model) => (
                    <tr key={model.qualifiedModel} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs">{model.id}</span>
                        {model.name !== model.id && (
                          <span className="ml-2 text-xs text-text-muted">{model.name}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <ComboMembershipSelect
                          options={comboOptions}
                          selectedIds={selectedComboIds(model.qualifiedModel)}
                          onChange={(next) => setModelCombos(model.qualifiedModel, next)}
                          disabled={saving}
                          ariaLabel={`Combos for ${model.qualifiedModel}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}

          {(dirtyCount > 0 || saving) && (
            <div className="sticky bottom-0 z-10 flex items-center justify-end gap-3 rounded-md border border-border bg-surface/95 px-3 py-2 backdrop-blur-sm">
              <span className="text-xs text-text-muted">
                {dirtyCount} unsaved change{dirtyCount === 1 ? "" : "s"}
              </span>
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => setDirty({})}>
                Discard
              </Button>
              <Button variant="primary" size="sm" loading={saving} onClick={save}>
                Save assignments
              </Button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}