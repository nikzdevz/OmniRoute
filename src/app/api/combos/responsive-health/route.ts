import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getComboByName, getCombos } from "@/lib/db/combos";
import {
  getLatencyHealth,
  isResponsivePrioritySchedulerRunning,
  LATENCY_TTL_MS,
  orderByLatencyHealth,
  PROBE_INTERVAL_MS,
  RESPONSIVE_PRIORITY_STRATEGY,
} from "@omniroute/open-sse/services/responsivePriority.ts";
import { getComboMetrics } from "@omniroute/open-sse/services/comboMetrics.ts";
import { resolveNestedComboModels } from "@omniroute/open-sse/services/combo.ts";
import type { ComboLike } from "@omniroute/open-sse/services/combo/types.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/combos/responsive-health?name=<comboName>
 *
 * Live control-center data for one combo:
 *  - the effective target order under the responsive-priority strategy
 *    (probe-ranked; falls back to the operator-declared order when no fresh
 *    samples exist),
 *  - per-model probe ping (latency, ok, probedAt, freshness),
 *  - per-model real-traffic usage from the in-memory combo metrics.
 *
 * The probe store and the combo metrics are both in-memory in this server
 * process, so this route reads them directly — no extra hop.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const name = searchParams.get("name")?.trim();
    if (!name) {
      return NextResponse.json({ error: "Missing combo name" }, { status: 400 });
    }

    const combo = await getComboByName(name);
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    const allCombos = (await getCombos()) as unknown as ComboLike[];
    const flatModels = resolveNestedComboModels(combo as ComboLike, allCombos);

    // Effective order: probe-ranked when fresh samples exist, otherwise the
    // declared order (orderByLatencyHealth is a stable permutation).
    const effectiveOrder = orderByLatencyHealth(flatModels);
    const rankByModel = new Map<string, number>();
    effectiveOrder.forEach((modelStr, index) => rankByModel.set(modelStr, index + 1));

    const metrics = getComboMetrics(name);

    const models = effectiveOrder.map((modelStr) => {
      const sample = getLatencyHealth(modelStr);
      const modelMetrics = metrics?.byModel?.[modelStr] ?? null;
      const provider = modelStr.includes("/") ? modelStr.split("/")[0] : null;
      return {
        modelStr,
        provider,
        rank: rankByModel.get(modelStr) ?? null,
        ping: sample
          ? {
              latencyMs: sample.latencyMs,
              ok: sample.ok,
              probedAt: new Date(sample.probedAt).toISOString(),
              fresh: Date.now() - sample.probedAt <= LATENCY_TTL_MS,
            }
          : null,
        usage: modelMetrics
          ? {
              requests: modelMetrics.requests,
              successes: modelMetrics.successes,
              failures: modelMetrics.failures,
              avgLatencyMs:
                modelMetrics.requests > 0
                  ? Math.round(modelMetrics.totalLatencyMs / modelMetrics.requests)
                  : null,
              lastStatus: modelMetrics.lastStatus,
              lastUsedAt: modelMetrics.lastUsedAt,
            }
          : null,
      };
    });

    // The model the strategy will try on the next request, and the model that
    // actually served last (from real traffic metrics).
    const lastUsedEntry = Object.entries(metrics?.byModel ?? {})
      .filter(([, m]) => m.lastUsedAt)
      .sort((a, b) => (a[1].lastUsedAt! < b[1].lastUsedAt! ? 1 : -1))[0];

    return NextResponse.json({
      comboName: name,
      strategy: combo.strategy ?? null,
      isResponsivePriority: (combo.strategy ?? "") === RESPONSIVE_PRIORITY_STRATEGY,
      schedulerRunning: isResponsivePrioritySchedulerRunning(),
      probeIntervalMs: PROBE_INTERVAL_MS,
      ttlMs: LATENCY_TTL_MS,
      effectiveFirst: effectiveOrder[0] ?? null,
      lastUsed: lastUsedEntry
        ? { modelStr: lastUsedEntry[0], lastUsedAt: lastUsedEntry[1].lastUsedAt }
        : null,
      models,
    });
  } catch (error) {
    console.log("Error fetching responsive-priority health:", error);
    return NextResponse.json({ error: "Failed to fetch responsive health" }, { status: 500 });
  }
}
