"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import Badge from "@/shared/components/Badge";
import Card from "@/shared/components/Card";
import SegmentedControl from "@/shared/components/SegmentedControl";
import type {
  SpeedAnalyticsModelEntry,
  SpeedAnalyticsRange,
  SpeedAnalyticsSummary,
} from "@/lib/combos/speedAnalytics";

/** Fused live ranking entry (`SpeedHealthEntry` from open-sse speedCombo.ts). */
type SpeedRankingEntry = {
  modelStr: string;
  provider: string;
  model: string;
  bucket: 0 | 1 | 2;
  score: number | null;
  probeLatencyMs: number | null;
  probeOk: boolean | null;
  operationalQuality: number;
  successEwma: number;
  trafficSamples: number;
  ttftEwmaMs: number | null;
  rateLimitedRatio: number;
  hardDemotionReason: "probe_failed" | "circuit_open" | "model_locked" | null;
};

type SpeedAnalyticsResponse = {
  comboName: string;
  strategy: string | null;
  range: SpeedAnalyticsRange;
  schedulerRunning: boolean;
  probeIntervalMs: number;
  summary: SpeedAnalyticsSummary;
  models: SpeedAnalyticsModelEntry[];
  ranking: SpeedRankingEntry[];
};

// Same cadence as the live-probe panel: a poll every 30s sees every fresh
// probe sample exactly once.
const SPEED_POLL_MS = 30_000;

const RANGE_OPTIONS: { value: SpeedAnalyticsRange; labelKey: "speedRangeLive" | null }[] = [
  { value: "live", labelKey: "speedRangeLive" },
  { value: "24h", labelKey: null },
  { value: "7d", labelKey: null },
  { value: "30d", labelKey: null },
];

function fmtPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}

function fmtMs(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? `${Math.round(value)}ms`
    : "—";
}

function fmtScore(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toString() : "—";
}

function probeToneClass(entry: SpeedRankingEntry): string {
  if (entry.hardDemotionReason !== null) return "text-error";
  if (entry.probeOk === true) return "text-success";
  if (entry.probeOk === false) return "text-error";
  return "text-text-muted";
}

/**
 * Speed Analytics card for the combo Control Center.
 *
 * One table per combo, two lenses merged:
 *  - the live fused ranking (what the speed machinery will try first: probe
 *    TTFB + real-traffic success + rate-limit signals), and
 *  - per-range usage stats from /api/combos/speed-analytics (most-used model,
 *    success rate, avg TTFT, fallbacks, RPM hits).
 */
export default function SpeedAnalyticsCard({ comboName }: { comboName: string }) {
  const t = useTranslations("comboControl");
  const [range, setRange] = useState<SpeedAnalyticsRange>("live");
  const [data, setData] = useState<SpeedAnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/combos/speed-analytics?combo=${encodeURIComponent(comboName)}&range=${range}`,
        { cache: "no-store" }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof json?.error === "string" ? json.error : `HTTP ${res.status}`
        );
      }
      setData(json as SpeedAnalyticsResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [comboName, range, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => {
      void load();
    }, SPEED_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const summary = data?.summary ?? null;
  const ranking = data?.ranking ?? [];
  const models = data?.models ?? [];

  // Merge: fused-ranking order first (what the strategy tries first), then any
  // range-stat rows whose model no longer appears in the ranking (history for
  // removed/renamed steps still matters).
  const statsByModel = new Map(models.map((m) => [m.modelStr, m]));
  const seen = new Set<string>();
  const rows: Array<{ rank: number | null; ranking: SpeedRankingEntry | null; stats: SpeedAnalyticsModelEntry | null }> = [];
  ranking.forEach((entry, index) => {
    seen.add(entry.modelStr);
    rows.push({ rank: index + 1, ranking: entry, stats: statsByModel.get(entry.modelStr) ?? null });
  });
  for (const stats of models) {
    if (!seen.has(stats.modelStr)) {
      rows.push({ rank: null, ranking: null, stats });
    }
  }

  const fallbackRateLabel =
    summary && summary.fallbackRate !== null ? fmtPercent(summary.fallbackRate) : "—";

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg text-text-main">{t("speedAnalyticsTitle")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-text-muted">
            {t("speedAnalyticsDescription")}
          </p>
        </div>
        <SegmentedControl
          semantics="radio"
          size="sm"
          aria-label={t("timeRange")}
          value={range}
          onChange={(item) => setRange(item as SpeedAnalyticsRange)}
          options={RANGE_OPTIONS.map((option) => ({
            value: option.value,
            label: option.labelKey ? t(option.labelKey) : option.value,
          }))}
        />
      </div>

      {summary && (
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-border bg-bg-subtle p-3">
            <p className="text-xs uppercase tracking-wide text-text-muted">
              {t("speedMostUsed")}
            </p>
            <p className="mt-1 truncate font-mono text-sm font-semibold text-text-main">
              {summary.mostUsedModel ?? "—"}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-bg-subtle p-3">
            <p className="text-xs uppercase tracking-wide text-text-muted">
              {t("speedMostSuccessful")}
            </p>
            <p className="mt-1 truncate font-mono text-sm font-semibold text-text-main">
              {summary.mostSuccessfulModel ?? "—"}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-bg-subtle p-3">
            <p className="text-xs uppercase tracking-wide text-text-muted">
              {t("speedFallbacks")}
            </p>
            <p className="mt-1 text-xl font-semibold text-text-main">
              {summary.fallbackEvents}
            </p>
            <p className="mt-1 text-xs text-text-muted">
              {t("speedFallbacksHint", { rate: fallbackRateLabel })}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-bg-subtle p-3">
            <p className="text-xs uppercase tracking-wide text-text-muted">
              {t("speedRpmHits")}
            </p>
            <p className="mt-1 text-xl font-semibold text-text-main">
              {summary.rpmLimitHits ?? "—"}
            </p>
            <p className="mt-1 text-xs text-text-muted">{t("speedRpmHitsHint")}</p>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-4 text-sm text-error">{error}</p>
      )}

      <div className="mt-4 overflow-x-auto">
        {loading && !data ? (
          <p className="text-sm text-text-muted">…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-text-muted">{t("speedEmpty")}</p>
        ) : (
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-text-muted">
                <th className="py-2 pr-3 font-medium">{t("rankColumn")}</th>
                <th className="py-2 pr-3 font-medium">{t("modelColumn")}</th>
                <th className="py-2 pr-3 font-medium">{t("pingColumn")}</th>
                <th className="py-2 pr-3 font-medium">{t("speedScoreColumn")}</th>
                <th className="py-2 pr-3 font-medium">{t("speedShareColumn")}</th>
                <th className="py-2 pr-3 font-medium">{t("requests")}</th>
                <th className="py-2 pr-3 font-medium">{t("success")}</th>
                <th className="py-2 pr-3 font-medium">{t("speedTtftColumn")}</th>
                <th className="py-2 font-medium">{t("lastUsedColumn")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const ranking = row.ranking;
                const stats = row.stats;
                const demoted = ranking?.hardDemotionReason ?? null;
                return (
                  <tr
                    key={(ranking?.modelStr ?? stats?.modelStr) + String(row.rank)}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="py-2 pr-3 text-text-muted">
                      {row.rank !== null ? `#${row.rank}` : "—"}
                    </td>
                    <td className="py-2 pr-3">
                      <code className="font-mono text-xs text-text-main">
                        {ranking?.modelStr ?? stats?.modelStr}
                      </code>
                      {demoted && (
                        <Badge variant="error" size="sm" className="ml-2">
                          {t(`speedDemote.${demoted}`)}
                        </Badge>
                      )}
                      {!demoted && ranking?.bucket === 1 && (
                        <span className="ml-2 text-[10px] text-text-muted">
                          {t("speedWarming")}
                        </span>
                      )}
                    </td>
                    <td className={`py-2 pr-3 font-mono text-xs ${ranking ? probeToneClass(ranking) : "text-text-muted"}`}>
                      {ranking?.probeLatencyMs != null && ranking.probeLatencyMs > 0
                        ? fmtMs(ranking.probeLatencyMs)
                        : "—"}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-text-main">
                      {fmtScore(ranking?.score)}
                    </td>
                    <td className="py-2 pr-3 text-xs text-text-main">
                      {stats ? fmtPercent(stats.share) : "—"}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-text-main">
                      {stats?.requests ?? 0}
                    </td>
                    <td className="py-2 pr-3 text-xs text-text-main">
                      {stats?.successRate != null ? fmtPercent(stats.successRate) : "—"}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-text-main">
                      {stats?.avgTtftMs != null ? fmtMs(stats.avgTtftMs) : "—"}
                    </td>
                    <td className="py-2 text-xs text-text-muted">
                      {stats?.lastUsedAt ? new Date(stats.lastUsedAt).toLocaleString() : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-3 text-xs text-text-muted">
        {data?.schedulerRunning
          ? t("speedSchedulerHint", { seconds: Math.round((data.probeIntervalMs || 30000) / 1000) })
          : t("probeSchedulerStopped")}
      </p>
    </Card>
  );
}
