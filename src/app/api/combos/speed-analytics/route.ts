import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getComboByName, getCombos } from "@/lib/db/combos";
import {
  getComboFallbackStatsSince,
  getComboSpeedStatsSince,
} from "@/lib/db/comboSpeedStats";
import {
  computeSpeedAnalyticsSummary,
  normalizeSpeedAnalyticsRange,
  SPEED_ANALYTICS_RANGES,
  type SpeedAnalyticsModelEntry,
  type SpeedAnalyticsRange,
} from "@/lib/combos/speedAnalytics";
import { getComboMetrics } from "@omniroute/open-sse/services/comboMetrics.ts";
import { resolveNestedComboModels } from "@omniroute/open-sse/services/combo.ts";
import { getSpeedHealthSnapshot } from "@omniroute/open-sse/services/speedCombo.ts";
import {
  isResponsivePrioritySchedulerRunning,
  PROBE_INTERVAL_MS,
} from "@omniroute/open-sse/services/responsivePriority.ts";
import type {
  ComboLike,
  ResolvedComboTarget,
} from "@omniroute/open-sse/services/combo/types.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/combos/speed-analytics?combo=<name>&range=live|24h|7d|30d
 *
 * Per-combo speed analytics for the Control Center card:
 *  - `summary`: most-used model, most-successful model, success rate, avg
 *    TTFT, fallback counters and RPM-limit (429) hits for the range;
 *  - `models`: per-model request/success/TTFT/429 rows for the range
 *    (`live` reads the in-memory combo metrics; hour rollups back 24h/7d/30d);
 *  - `ranking`: the fused live ranking (probe TTFB + traffic EWMA +
 *    reliability/RPM demotion, services/speedCombo.ts) for the combo's
 *    models, so the card can show what the strategy will try first.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const comboName = searchParams.get("combo")?.trim() ?? searchParams.get("name")?.trim();
    if (!comboName) {
      return NextResponse.json({ error: "Missing combo name" }, { status: 400 });
    }
    const range: SpeedAnalyticsRange = normalizeSpeedAnalyticsRange(
      searchParams.get("range")?.trim()
    );

    const combo = await getComboByName(comboName);
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // Live fused ranking across the combo's flat model list (provider-scoped:
    // connection pinning is not part of this view).
    const allCombos = (await getCombos()) as unknown as ComboLike[];
    const flatModels = resolveNestedComboModels(combo as ComboLike, allCombos);
    const rankingTargets = flatModels.map((modelStr) => ({
      modelStr,
      provider: modelStr.includes("/") ? modelStr.split("/")[0] : null,
      connectionId: null,
    })) as unknown as ResolvedComboTarget[];
    const ranking = getSpeedHealthSnapshot(rankingTargets);
    const ttftByModel = new Map(ranking.map((entry) => [entry.modelStr, entry.ttftEwmaMs]));

    let models: SpeedAnalyticsModelEntry[] = [];
    let fallback = { fallbackEvents: 0, requestsWithFallback: 0 };

    if (range === "live") {
      const metrics = getComboMetrics(comboName);
      const byModel = metrics?.byModel ?? {};
      const totalRequests = Object.values(byModel).reduce((sum, m) => sum + m.requests, 0);
      models = Object.entries(byModel)
        .map(([modelStr, m]) => {
          const lastUsedMs = m.lastUsedAt ? Date.parse(m.lastUsedAt) : NaN;
          return {
            modelStr,
            provider: modelStr.includes("/") ? modelStr.split("/")[0] : null,
            requests: m.requests,
            share: totalRequests > 0 ? m.requests / totalRequests : 0,
            successes: m.successes,
            failures: m.failures,
            successRate: m.requests > 0 ? m.successRate : null,
            // The in-memory view keeps no 429 counter; the EWMA ratio in
            // `ranking` carries the live rate-limit signal instead.
            rateLimitedCount: null,
            ttftCount: m.requests,
            avgTtftMs: ttftByModel.get(modelStr) ?? null,
            avgDurationMs: m.requests > 0 ? m.avgLatencyMs : null,
            lastUsedAt: Number.isFinite(lastUsedMs) ? lastUsedMs : null,
            lastStatus: m.lastStatus ?? null,
          } satisfies SpeedAnalyticsModelEntry;
        })
        .sort((a, b) => b.requests - a.requests);
      fallback = {
        fallbackEvents: metrics?.totalFallbacks ?? 0,
        requestsWithFallback: metrics?.requestsWithFallback ?? 0,
      };
    } else {
      const since = Date.now() - SPEED_ANALYTICS_RANGES[range];
      const rows = getComboSpeedStatsSince(comboName, since);
      fallback = getComboFallbackStatsSince(comboName, since);

      const grouped = new Map<
        string,
        {
          modelStr: string;
          provider: string | null;
          requests: number;
          successes: number;
          failures: number;
          rateLimitedCount: number;
          ttftCount: number;
          sumTtftMs: number;
          sumDurationMs: number;
          lastUsedAt: number | null;
        }
      >();
      for (const row of rows) {
        const modelStr = row.provider ? `${row.provider}/${row.model}` : row.model;
        const entry = grouped.get(modelStr) ?? {
          modelStr,
          provider: row.provider,
          requests: 0,
          successes: 0,
          failures: 0,
          rateLimitedCount: 0,
          ttftCount: 0,
          sumTtftMs: 0,
          sumDurationMs: 0,
          lastUsedAt: null,
        };
        entry.requests += row.requests;
        entry.successes += row.successes;
        entry.failures += row.failures;
        entry.rateLimitedCount += row.rateLimitedCount;
        entry.ttftCount += row.ttftCount;
        entry.sumTtftMs += row.sumTtftMs;
        entry.sumDurationMs += row.sumDurationMs;
        if (row.lastUsedAt !== null && (entry.lastUsedAt === null || row.lastUsedAt > entry.lastUsedAt)) {
          entry.lastUsedAt = row.lastUsedAt;
        }
        grouped.set(modelStr, entry);
      }

      const totalRequests = [...grouped.values()].reduce((sum, m) => sum + m.requests, 0);
      models = [...grouped.values()]
        .map((entry) => ({
          modelStr: entry.modelStr,
          provider: entry.provider,
          requests: entry.requests,
          share: totalRequests > 0 ? entry.requests / totalRequests : 0,
          successes: entry.successes,
          failures: entry.failures,
          successRate: entry.requests > 0 ? entry.successes / entry.requests : null,
          rateLimitedCount: entry.rateLimitedCount,
          ttftCount: entry.ttftCount,
          avgTtftMs: entry.ttftCount > 0 ? entry.sumTtftMs / entry.ttftCount : null,
          avgDurationMs: entry.requests > 0 ? entry.sumDurationMs / entry.requests : null,
          lastUsedAt: entry.lastUsedAt,
        }))
        .sort((a, b) => b.requests - a.requests);
    }

    const summary = computeSpeedAnalyticsSummary(models, fallback);

    return NextResponse.json({
      comboName,
      strategy: combo.strategy ?? null,
      range,
      schedulerRunning: isResponsivePrioritySchedulerRunning(),
      probeIntervalMs: PROBE_INTERVAL_MS,
      summary,
      models,
      ranking,
    });
  } catch (error) {
    console.log("Error fetching combo speed analytics:", error);
    return NextResponse.json({ error: "Failed to fetch speed analytics" }, { status: 500 });
  }
}
