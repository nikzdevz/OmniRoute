"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Icon from "@/shared/components/Icon";
import Input from "@/shared/components/Input";
import { matchesSearch } from "@/shared/utils/turkishText";

interface ProviderNode {
  id: string;
  name?: string;
  prefix?: string;
  type?: string;
}

interface Combo {
  id: string;
  name: string;
  models?: any[];
}

interface ModelRow {
  providerId: string;
  providerName: string;
  modelId: string;
  qualified: string;
}

export default function CustomProviderCombosPage() {
  const notify = useNotificationStore();
  const [nodes, setNodes] = useState<ProviderNode[]>([]);
  const [combos, setCombos] = useState<Combo[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [nodesRes, combosRes] = await Promise.all([
        fetch("/api/provider-nodes"),
        fetch("/api/combos"),
      ]);
      const nodesData = nodesRes.ok ? await nodesRes.json() : { nodes: [] };
      const combosData = combosRes.ok ? await combosRes.json() : { combos: [] };
      const fetchedNodes: ProviderNode[] = nodesData.nodes || nodesData || [];
      setNodes(fetchedNodes);
      const fetchedCombos: Combo[] = combosData.combos || combosData || [];
      setCombos(fetchedCombos);

      // fetch models for each node
      const allModels: ModelRow[] = [];
      await Promise.all(
        fetchedNodes.map(async (node) => {
          try {
            const res = await fetch(`/api/providers/${node.id}/models`);
            if (!res.ok) return;
            const data = await res.json();
            const list = Array.isArray(data) ? data : data.models || data.data || [];
            list.forEach((m: any) => {
              const id = m.id || m.name || m.model;
              if (!id) return;
              allModels.push({
                providerId: node.id,
                providerName: node.name || node.prefix || node.id,
                modelId: id,
                qualified: `${node.prefix || node.id}/${id}`,
              });
            });
          } catch {
            // ignore
          }
        })
      );
      setModels(allModels);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  const save = async () => {
    setSaving(true);
    try {
      // group selected by combo
      const byCombo: Record<string, string[]> = {};
      Object.entries(selection).forEach(([qualified, combos]) => {
        combos.forEach((c) => {
          if (!byCombo[c]) byCombo[c] = [];
          byCombo[c].push(qualified);
        });
      });
      for (const [comboName, modelQuals] of Object.entries(byCombo)) {
        const combo = combos.find((c) => c.name === comboName);
        if (!combo) continue;
        const existing = (combo.models || []).map((m: any) =>
          typeof m === "string" ? m : m.model || m
        );
        const merged = Array.from(new Set([...existing, ...modelQuals]));
        await fetch(`/api/combos/${combo.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ models: merged.map((m) => ({ model: m, weight: 0 })) }),
        });
      }
      notify.success("Assignments saved");
    } catch {
      notify.error("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const filtered = models.filter((m) =>
    query ? matchesSearch(m.modelId + " " + m.providerName, query) : true
  );

  // group by provider
  const groups: Record<string, ModelRow[]> = {};
  filtered.forEach((m) => {
    if (!groups[m.providerId]) groups[m.providerId] = [];
    groups[m.providerId].push(m);
  });

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader compact title="Custom Provider Models → Combos" />
      <Card title="Fetch & assign" subtitle="Pick combos per model from your self-added providers">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Input
              placeholder="Search models or providers…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button variant="outline" onClick={fetchData} disabled={loading}>
              <Icon name="refresh" size={14} /> Fetch all models
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Save assignments
            </Button>
          </div>

          {loading && <p className="text-xs text-text-muted">Loading…</p>}

          {Object.entries(groups).map(([pid, rows]) => {
            const node = nodes.find((n) => n.id === pid);
            return (
              <div key={pid} className="rounded-md border">
                <div className="flex items-center justify-between bg-bg-subtle px-3 py-2">
                  <span className="font-medium text-sm">{node?.name || pid}</span>
                  <span className="text-xs text-text-muted">{rows.length} models</span>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-text-muted">
                      <th className="px-3 py-2 text-left">Model</th>
                      <th className="px-3 py-2 text-left">Combos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr key={m.qualified} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{m.modelId}</td>
                        <td className="px-3 py-2">
<select
                            multiple
                            value={selection[m.qualified] || []}
                            onChange={(e) => {
                              const opts = Array.from(e.target.selectedOptions).map(
                                (o) => o.value
                              );
                              setSelection((prev) => ({ ...prev, [m.qualified]: opts }));
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
            );
          })}

          {!loading && filtered.length === 0 && (
            <p className="text-xs text-text-muted">No models found. Fetch from your providers.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
