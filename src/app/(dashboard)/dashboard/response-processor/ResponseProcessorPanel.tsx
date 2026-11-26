"use client";

// Response Processor panel — universal banned-text rewriting for every provider/model/combo
// response. Persisted through GET/PUT /api/settings/response-processor; the engine that runs on
// live traffic is open-sse/services/responseProcessor (same compile path as this editor).

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Icon from "@/shared/components/Icon";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import Textarea from "@/shared/components/Textarea";
import Toggle from "@/shared/components/Toggle";

type MatchType = "literal" | "regex";
type Anchor = "anywhere" | "start" | "whole-response";
type Action = "replace" | "remove" | "replace-whole-response";

interface Condition {
  type: "contains" | "not-contains";
  value: string;
  caseSensitive?: boolean;
}

interface Rule {
  id: string;
  label?: string;
  enabled: boolean;
  match: string;
  matchType: MatchType;
  caseSensitive?: boolean;
  anchor: Anchor;
  action: Action;
  replaceWith?: string;
  conditions?: Condition[];
}

interface Hits {
  ruleId: string;
  count: number;
}

const REQUEST_TIMEOUT_MS = 15_000;

function newRule(index: number): Rule {
  return {
    id: `rule-${Date.now()}-${index}`,
    enabled: true,
    match: "",
    matchType: "literal",
    anchor: "anywhere",
    action: "replace",
    replaceWith: "",
  };
}

export default function ResponseProcessorPanel() {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState(false);
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"" | "saved" | "error">("");
  const [issues, setIssues] = useState<{ ruleId: string; message: string }[]>([]);
  const [sample, setSample] = useState("");
  const [preview, setPreview] = useState<{ text: string; hits: Hits[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    fetch("/api/settings/response-processor", { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .then(async (r) => {
        const data: { enabled?: unknown; rules?: unknown; issues?: unknown } | null = r.ok
          ? await r.json()
          : null;
        if (!data) {
          setLoadError(String(r.status));
          return;
        }
        setEnabled(data.enabled === true);
        if (Array.isArray(data.rules)) setRules(data.rules as Rule[]);
        if (Array.isArray(data.issues)) {
          setIssues(data.issues as { ruleId: string; message: string }[]);
        }
      })
      .catch(() => setLoadError(""))
      .finally(() => setLoading(false));
  }, []);

  const patchRule = useCallback((id: string, patch: Partial<Rule>) => {
    setRules((current) => current.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  }, []);

  const removeRule = useCallback((id: string) => {
    setRules((current) => current.filter((rule) => rule.id !== id));
  }, []);

  const locked = loading || saving || loadError !== null;

  const importStarterPack = async () => {
    try {
      const res = await fetch("/api/settings/response-processor/templates", {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as { rules?: Rule[] } | null;
      const incoming = Array.isArray(data?.rules) ? data.rules : [];
      setRules((current) => {
        const seen = new Set(current.map((rule) => rule.id));
        const merged = [...current];
        for (const rule of incoming) {
          if (seen.has(rule.id)) continue;
          seen.add(rule.id);
          merged.push(rule);
        }
        return merged;
      });
    } catch {
      setStatus("error");
    }
  };

  const save = async () => {
    clearTimeout(savedTimer.current);
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch("/api/settings/response-processor", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, rules }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => null)) as
        | { issues?: { ruleId: string; message: string }[] }
        | null;
      setStatus(res.ok ? "saved" : "error");
      setIssues(res.ok && Array.isArray(data?.issues) ? data.issues : []);
      if (res.ok) savedTimer.current = setTimeout(() => setStatus(""), 2000);
    } catch {
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    setPreviewing(true);
    try {
      const res = await fetch("/api/settings/response-processor/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sample, rules }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => null)) as
        | { text?: string; hits?: Hits[] }
        | null;
      setPreview(res.ok && typeof data?.text === "string" ? { text: data.text, hits: data.hits ?? [] } : null);
    } catch {
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  };

  const ACTION_OPTIONS = [
    { value: "replace", label: t("responseProcessorActionReplace") },
    { value: "remove", label: t("responseProcessorActionRemove") },
    { value: "replace-whole-response", label: t("responseProcessorActionWhole") },
  ];
  const ANCHOR_OPTIONS = [
    { value: "anywhere", label: t("responseProcessorAnchorAnywhere") },
    { value: "start", label: t("responseProcessorAnchorStart") },
    { value: "whole-response", label: t("responseProcessorAnchorWhole") },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title={t("responseProcessorTitle")}
        subtitle={t("responseProcessorDesc")}
        icon="shield"
        data-testid="response-processor-panel"
      >
        <div className="flex flex-col gap-4">
          {loadError !== null && (
            <p role="alert" className="flex items-center gap-1 text-xs font-medium text-error">
              <Icon name="error" size={14} />
              {t("responseProcessorLoadFailed")} {loadError && `(${loadError})`}
            </p>
          )}
          <Toggle
            checked={enabled}
            disabled={locked}
            onChange={setEnabled}
            label={t("responseProcessorEnabled")}
            description={enabled ? undefined : t("responseProcessorDisabled")}
            data-testid="response-processor-enabled"
          />

          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-medium">{t("responseProcessorRulesHeading")}</h4>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={locked}
                onClick={importStarterPack}
                data-testid="response-processor-import-pack"
              >
                {t("responseProcessorImportPack")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={locked}
                onClick={() => setRules((current) => [...current, newRule(current.length)])}
                data-testid="response-processor-add-rule"
              >
                <Icon name="add" size={14} /> {t("responseProcessorAddRule")}
              </Button>
            </div>
          </div>

          {rules.length === 0 && (
            <p className="text-xs text-text-muted">{t("responseProcessorNoRules")}</p>
          )}

          <ul className="flex flex-col gap-3">
            {rules.map((rule) => (
              <li key={rule.id} className="rounded-md border p-3">
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-end gap-2">
                    <Input
                      className="flex-1 min-w-45"
                      label={t("responseProcessorMatch")}
                      value={rule.match}
                      disabled={locked}
                      onChange={(e) => patchRule(rule.id, { match: e.target.value })}
                      data-testid="response-processor-rule-match"
                    />
                    <Select
                      label={t("responseProcessorMatchType")}
                      value={rule.matchType}
                      disabled={locked}
                      onChange={(e) =>
                        patchRule(rule.id, { matchType: e.target.value as MatchType })
                      }
                      options={[
                        { value: "literal", label: t("responseProcessorLiteral") },
                        { value: "regex", label: t("responseProcessorRegex") },
                      ]}
                    />
                    <Select
                      label={t("responseProcessorAction")}
                      value={rule.action}
                      disabled={locked}
                      onChange={(e) => patchRule(rule.id, { action: e.target.value as Action })}
                      options={ACTION_OPTIONS}
                    />
                    <Select
                      label={t("responseProcessorAnchor")}
                      value={rule.anchor}
                      disabled={locked}
                      onChange={(e) => patchRule(rule.id, { anchor: e.target.value as Anchor })}
                      options={ANCHOR_OPTIONS}
                    />
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <Input
                      className="flex-1 min-w-45"
                      label={t("responseProcessorReplaceWith")}
                      value={rule.replaceWith ?? ""}
                      disabled={locked || rule.action === "remove"}
                      onChange={(e) => patchRule(rule.id, { replaceWith: e.target.value })}
                    />
                    <Toggle
                      size="sm"
                      checked={rule.caseSensitive === true}
                      disabled={locked}
                      onChange={(checked) => patchRule(rule.id, { caseSensitive: checked })}
                      label={t("responseProcessorCaseSensitive")}
                    />
                    <Toggle
                      size="sm"
                      checked={rule.enabled}
                      disabled={locked}
                      onChange={(checked) => patchRule(rule.id, { enabled: checked })}
                      label={t("responseProcessorRuleEnable")}
                    />
                    <Button
                      size="icon-sm"
                      variant="destructive-ghost"
                      disabled={locked}
                      aria-label={t("responseProcessorDelete")}
                      onClick={() => removeRule(rule.id)}
                    >
                      <Icon name="delete" size={16} />
                    </Button>
                  </div>
                  {issues.some((issue) => issue.ruleId === rule.id) && (
                    <p role="alert" className="text-xs font-medium text-error">
                      {issues
                        .filter((issue) => issue.ruleId === rule.id)
                        .map((issue) => issue.message)
                        .join("; ")}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-end gap-2">
            <span role="status" className="text-xs text-success">
              {status === "saved" && t("responseProcessorSaved")}
            </span>
            {status === "error" && (
              <span role="alert" className="flex items-center gap-1 text-xs font-medium text-error">
                <Icon name="error" size={14} />
                {t("responseProcessorSaveFailed")}
              </span>
            )}
            <Button
              size="sm"
              variant="primary"
              loading={saving}
              disabled={locked}
              onClick={save}
              data-testid="response-processor-save"
            >
              {t("responseProcessorSave")}
            </Button>
          </div>
        </div>
      </Card>

      <Card title={t("responseProcessorPreviewHeading")} icon="visibility">
        <div className="flex flex-col gap-3">
          <Textarea
            rows={6}
            value={sample}
            placeholder={t("responseProcessorPreviewInput")}
            aria-label={t("responseProcessorPreviewInput")}
            onChange={(e) => setSample(e.target.value)}
            data-testid="response-processor-preview-input"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              loading={previewing}
              disabled={loading || sample.trim().length === 0}
              onClick={runPreview}
              data-testid="response-processor-preview-run"
            >
              {t("responseProcessorPreviewRun")}
            </Button>
            {preview && preview.hits.length > 0 && (
              <span className="text-xs text-text-muted">
                {t("responseProcessorPreviewHits")}:{" "}
                {preview.hits.map((hit) => `${hit.ruleId}×${hit.count}`).join(", ")}
              </span>
            )}
            {preview && preview.hits.length === 0 && (
              <span className="text-xs text-text-muted">
                {t("responseProcessorPreviewUnchanged")}
              </span>
            )}
          </div>
          {preview && (
            <div className="flex flex-col gap-1">
              <h5 className="text-xs font-medium text-text-muted">
                {t("responseProcessorPreviewOutput")}
              </h5>
              <pre
                className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-bg-subtle p-3 font-mono text-xs text-text-main"
                data-testid="response-processor-preview-output"
              >
                {preview.text}
              </pre>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
