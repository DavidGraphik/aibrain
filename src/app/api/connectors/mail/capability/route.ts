import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { mailCapabilityForSession } from "@/connectors/mail-server-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: "AUTH_REQUIRED" }, { status: 401, headers });
  try { return NextResponse.json(await mailCapabilityForSession(session), { headers }); }
  catch { return NextResponse.json({ code: "MAIL_REQUEST_FAILED" }, { status: 503, headers }); }
}
