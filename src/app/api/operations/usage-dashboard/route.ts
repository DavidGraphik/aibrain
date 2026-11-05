import { isUsageDashboardAuthorized } from "@/operations/usage-dashboard-auth";
import { NextResponse } from "next/server";
import { operatorUsageDashboard } from "@/usage/operator-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = Object.freeze({ "Cache-Control": "private, no-store" });

export async function GET(request: Request) {
  if (!isUsageDashboardAuthorized(request)) {
    return NextResponse.json(
      { error: "Operator authentication required.", code: "OPERATOR_AUTH_REQUIRED" },
      { status: 401, headers: { ...HEADERS, "WWW-Authenticate": "Bearer" } },
    );
  }
  try {
    return NextResponse.json(await operatorUsageDashboard(), { headers: HEADERS });
  } catch {
    return NextResponse.json(
      { error: "Usage dashboard is unavailable.", code: "USAGE_DASHBOARD_UNAVAILABLE" },
      { status: 503, headers: HEADERS },
    );
  }
}
