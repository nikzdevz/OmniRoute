import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  getResponseProcessorConfig,
  setResponseProcessorConfig,
  validateResponseProcessorRules,
} from "@omniroute/open-sse/services/responseProcessor/index.ts";
import { validateBody, isValidationFailure } from "@/shared/validation/helpers";
import { updateResponseProcessorSchema } from "@/shared/validation/schemas";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { config, issues } = getResponseProcessorConfig();
    return NextResponse.json({ ...config, issues });
  } catch (error) {
    console.error("Error reading response processor config:", error);
    return NextResponse.json({ error: "Failed to read response processor config" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
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
    const validation = validateBody(updateResponseProcessorSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Compile before persisting: an unusable regex is a save-time error, not a silent drop
    // later on a live response.
    const issues = validateResponseProcessorRules(validation.data.rules ?? []);
    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: {
            message: "Invalid response processor rules",
            details: issues.map((issue) => ({ field: issue.ruleId, message: issue.message })),
          },
        },
        { status: 400 }
      );
    }

    const { config, issues: compileIssues } = await setResponseProcessorConfig({
      enabled: validation.data.enabled,
      rules: validation.data.rules,
      emptyFallback: validation.data.emptyFallback,
    });
    return NextResponse.json({ ...config, issues: compileIssues });
  } catch (error) {
    console.error("Error updating response processor config:", error);
    return NextResponse.json(
      { error: "Failed to update response processor config" },
      { status: 500 }
    );
  }
}
