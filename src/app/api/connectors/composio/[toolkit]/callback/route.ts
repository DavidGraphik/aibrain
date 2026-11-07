import { NextResponse } from "next/server";
import { loadInstallationConfig } from "@/config/installation";
import { getSession } from "@/auth/session";
import { completeComposio } from "@/connectors/composio-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request, context: { params: Promise<{ toolkit: string }> }) {
  const { publicUrl } = await loadInstallationConfig();
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/login", publicUrl), 303);
  const url = new URL(request.url);
  const home = new URL("/?settings=connectors", publicUrl);
  try {
    await completeComposio(session, (await context.params).toolkit, { state: url.searchParams.get("state") ?? "", status: url.searchParams.get("status") ?? "", accountId: url.searchParams.get("connected_account_id") ?? "" });
    home.searchParams.set("connection", "verified");
  } catch { home.searchParams.set("connection", "failed"); }
  return NextResponse.redirect(home, { status: 303, headers });
}
