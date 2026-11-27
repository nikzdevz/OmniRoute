"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Icon from "@/shared/components/Icon";
import Input from "@/shared/components/Input";
import { matchesSearch } from "@/shared/utils/turkishText";
import { useNotificationStore } from "@/store/notificationStore";

interface ProviderOption {
  providerId: string;
  displayName: string;
  prefix?: string | null;
  source: string;
  models: Array<{
    id: string;
    name: string;
    qualifiedModel: string;
  }>;
}

interface ComboOption {
  id: string;
  name: string;
}

export default function CustomProviderCombosPage() {
  const notify = useNotificationStore();
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [combos, setCombos] = useState<ComboOption[]>([]);
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/combos/builder/options");
      if (!res.ok) throw new Error("Failed to fetch builder options");
      const data = await res.json();
      
      const allProviders: ProviderOption[] = data.providers || [];
      // Filter for custom providers (provider-node source)
      const customOnes = allProviders.filter(
        (p) => p.source === "provider-node" || p.providerId.includes("compatible")
      );
      setProviders(customOnes);

      const allCombos: ComboOption[] = (data.comboRefs || []).map((c: any) => ({
        id: c.id,
        name: c.name,
      }));
      setCombos(allCombos);
    } catch (e) {
      console.error(e);
      notify.error("Failed to load custom providers and combos");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  const save = async () => {
    setSaving(true);
    try {
      // Map combo -> qualified models
      const byCombo: Record<string, string[]> = {};
      Object.entries(selection).forEach(([qualified, targetCombos]) => {
        targetCombos.forEach((c) => {
          if (!byCombo[c]) byCombo[c] = [];
          byCombo[c].push(qualified);
        });
      });

      let updatedCount = 0;
      for (const [comboName, modelQuals] of Object.entries(byCombo)) {
        if (!modelQuals.length) continue;
        const combo = combos.find((c) => c.name === comboName);
        if (!combo) continue;

        // Fetch current combo to merge models
        const res = await fetch(`/api/combos/${encodeURIComponent(combo.id)}`);
        if (!res.ok) continue;
        const currentData = await res.json();
        const existingSteps = currentData.models || [];
        const existingQuals = new Set(
          existingSteps.map((s: any) => (typeof s === "string" ? s : s.model))
        );

        const newSteps = [...existingSteps];
        for (const q of modelQuals) {
          if (!existingQuals.has(q)) {
            newSteps.push({
              kind: "model",
              model: q,
              weight: 0,
            });
            existingQuals.add(q);
          }
        }

        const updateRes = await fetch(`/api/combos/${encodeURIComponent(combo.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ models: newSteps }),
        });

        if (updateRes.ok) {
          updatedCount++;
        }
      }

      notify.success(`Assignments saved to ${updatedCount} combo(s)`);
      setSelection({});
    } catch {
      notify.error("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const filteredProviders = providers
    .map((p) => {
      const matchesProvider = query ? matchesSearch(p.displayName + " " + p.providerId, query) : true;
      const matchedModels = p.models.filter((m) =>
        query ? matchesProvider || matchesSearch(m.name + " " + m.id, query) : true
      );
      return { ...p, models: matchedModels };
    })
    .filter((p) => p.models.length > 0);

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader compact title="Custom Provider Models → Combos" />
      <Card title="Fetch & Assign" subtitle="Add models from your custom providers into combos">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Input
              placeholder="Search models or providers…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button variant="outline" onClick={fetchData} disabled={loading}>
              <Icon name="refresh" size={14} /> Refresh
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Save assignments
            </Button>
          </div>

          {loading && <p className="text-xs text-text-muted">Loading providers and models…</p>}

          {!loading && filteredProviders.length === 0 && (
            <p className="text-xs text-text-muted">
              No custom providers with models found. Check /dashboard/providers to add custom endpoints.
            </p>
          )}

          {filteredProviders.map((p) => (
            <div key={p.providerId} className="rounded-md border">
              <div className="flex items-center justify-between bg-bg-subtle px-3 py-2">
                <span className="font-medium text-sm">{p.displayName}</span>
                <span className="text-xs text-text-muted">{p.models.length} models</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-text-muted">
                    <th className="px-3 py-2 text-left">Model</th>
                    <th className="px-3 py-2 text-left">Combos</th>
                  </tr>
                </thead>
                <tbody>
                  {p.models.map((m) => (
                    <tr key={m.qualifiedModel} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 font-mono text-xs">
                        {m.name !== m.id ? `${m.name} (${m.id})` : m.id}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          multiple
                          value={selection[m.qualifiedModel] || []}
                          onChange={(e) => {
                            const opts = Array.from(e.target.selectedOptions).map((o) => o.value);
                            setSelection((prev) => ({ ...prev, [m.qualifiedModel]: opts }));
                          }}
                          className="min-w-45 rounded-md border border-border bg-bg-subtle px-2 py-1 text-xs"
                        >
                          {combos.map((c) => (
                            <option key={c.id} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
