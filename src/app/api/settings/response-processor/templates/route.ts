import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { DEFAULT_RESPONSE_PROCESSOR_PACK } from "@omniroute/open-sse/services/responseProcessor/index.ts";

/**
 * Starter pack for the dashboard editor. Read-only and never persisted: the panel merges these
 * rules into its draft so an operator can review them and save only what they want.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  return NextResponse.json({
    enabled: DEFAULT_RESPONSE_PROCESSOR_PACK.enabled,
    rules: DEFAULT_RESPONSE_PROCESSOR_PACK.rules,
  });
}
