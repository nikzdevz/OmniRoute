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
import Collapsible from "@/shared/components/Collapsible";
import ComboMembershipSelect from "./ComboMembershipSelect";
import {
  buildComboMembership,
  buildModelIdentity,
  describeComboError,
  describeFetchError,
  dirtyKey,
  planComboUpdates,
  resolveSelectedComboIds,
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
      const plans = planComboUpdates({ combos, identities, dirty });
      if (plans.length === 0) {
        notify.error("Nothing to save");
        await loadAll();
        return;
      }

      let updatedCombos = 0;
      const failures: string[] = [];

      for (const plan of plans) {
        const combo = combos.find((candidate) => candidate.id === plan.comboId);
        try {
          const res = await fetch(`/api/combos/${encodeURIComponent(plan.comboId)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ models: plan.models, overrideAllowedProviders: true }),
          });
          if (res.ok) {
            updatedCombos += 1;
            continue;
          }
          failures.push(`${combo?.name ?? plan.comboId}: ${await describeComboError(res)}`);
        } catch (error) {
          failures.push(`${combo?.name ?? plan.comboId}: ${describeFetchError(error)}`);
        }
      }

      await loadAll();

      if (failures.length > 0) {
        notify.warning(
          `${failures.length} combo(s) not updated — ${failures.slice(0, 3).join(" · ")}`
        );
      }
      if (updatedCombos > 0) {
        const totalAdded = plans.reduce((sum, plan) => sum + plan.added.length, 0);
        const totalRemoved = plans.reduce((sum, plan) => sum + plan.removed.length, 0);
        const parts = [
          totalAdded > 0 ? `${totalAdded} model(s) added` : null,
          totalRemoved > 0 ? `${totalRemoved} model(s) removed` : null,
        ].filter(Boolean);
        notify.success(`Saved to ${updatedCombos} combo(s) — ${parts.join(", ")}`);
      }
    } catch (error) {
      notify.error(`Save failed — ${describeFetchError(error)}`);
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
            <Collapsible
              key={provider.providerId}
              icon="dns"
              title={provider.displayName}
              subtitle={`${provider.models.length} models · ${
                provider.prefix ?? provider.providerId
              }`}
            >
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
            </Collapsible>
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