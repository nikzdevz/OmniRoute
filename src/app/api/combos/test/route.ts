import { NextResponse } from "next/server";
import { testComboModel } from "@/lib/combos/testHealth";
import { getComboByName } from "@/lib/localDb";
import { testComboSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

/**
 * POST /api/combos/test - Quick test a combo
 * Sends a real chat completion request through each model in the combo
 * and only reports success when the model returns usable text content.
 */
export async function POST(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const validation = validateBody(testComboSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { comboName } = validation.data;

    const combo = await getComboByName(comboName);
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    const models = (combo.models || []).map((m) => (typeof m === "string" ? m : m.model));

    if (models.length === 0) {
      return NextResponse.json({ error: "Combo has no models" }, { status: 400 });
    }

    const internalUrl = `${getBaseUrl(request)}/v1/chat/completions`;
    const results = await Promise.all(
      models.map((modelStr) => testComboModel(modelStr, internalUrl))
    );
    const resolvedBy = results.find((result) => result.status === "ok")?.model || null;

    return NextResponse.json({
      comboName,
      strategy: combo.strategy || "priority",
      resolvedBy,
      results,
      testedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.log("Error testing combo:", error);
    return NextResponse.json({ error: "Failed to test combo" }, { status: 500 });
  }
}

/**
 * Get the base URL for internal requests (VPS-safe: respects reverse proxy headers)
 */
function getBaseUrl(request) {
  const fwdHost = request.headers.get("x-forwarded-host");
  const fwdProto = request.headers.get("x-forwarded-proto") || "https";
  if (fwdHost) return `${fwdProto}://${fwdHost}`;
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
