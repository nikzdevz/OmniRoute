import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  compileConfig,
  getResponseProcessorConfig,
  processResponseBody,
  processText,
} from "@omniroute/open-sse/services/responseProcessor/index.ts";
import { validateBody, isValidationFailure } from "@/shared/validation/helpers";
import { previewResponseProcessorSchema } from "@/shared/validation/schemas";

/**
 * Preview endpoint: runs the SAVED rules against a sample text or body so an operator can see
 * exactly what the client would receive. Read-only - it never persists and never calls a
 * provider.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBody(previewResponseProcessorSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const { config } = getResponseProcessorConfig();
    // Preview may run unsaved rules from the editor; otherwise the saved set.
    const rules = validation.data.rules ?? config.rules;
    const compiled = compileConfig({ enabled: true, rules }).compiled;

    if (!compiled.enabled || compiled.rules.length === 0) {
      return NextResponse.json({
        enabled: false,
        changed: false,
        text: validation.data.text ?? null,
        body: validation.data.body ?? null,
        hits: [],
      });
    }

    if (validation.data.text !== undefined) {
      const result = processText(validation.data.text, compiled);
      return NextResponse.json({
        enabled: true,
        changed: result.changed,
        text: result.text,
        hits: result.hits,
      });
    }

    const result = processResponseBody(validation.data.body, compiled);
    return NextResponse.json({
      enabled: true,
      changed: result.changed,
      body: result.body,
      hits: result.hits,
    });
  } catch (error) {
    console.error("Error previewing response processor rules:", error);
    return NextResponse.json({ error: "Failed to preview rules" }, { status: 500 });
  }
}