import { NextResponse } from "next/server";
import { isUsageDashboardAuthorized } from "@/operations/usage-dashboard-auth";
import { operatorConversations } from "@/operations/conversations";
import { WorkbenchNotFoundError, WorkbenchValidationError } from "@/workbench/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  if (!isUsageDashboardAuthorized(request)) return NextResponse.json({ error: "Operator authentication required." }, { status: 401, headers });
  const params = new URL(request.url).searchParams;
  try {
    return NextResponse.json(await operatorConversations(request.headers.get("X-AiBrain-Operator-Id") ?? "", params.get("userId") ?? "", params.get("threadId") ?? undefined, params.get("cursor") ?? undefined, request.headers.get("X-AiBrain-Operator-Email") ?? undefined), { headers });
  } catch (error) {
    const status = error instanceof WorkbenchNotFoundError ? 404 : error instanceof WorkbenchValidationError ? 400 : 503;
    return NextResponse.json({ error: status === 503 ? "Conversation source unavailable." : (error as Error).message }, { status, headers });
  }
}
