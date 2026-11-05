import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { completeGmailOAuth, gmailConnectorErrorCode } from "@/connectors/gmail-server-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function home(request: Request, status: string, code?: string) {
  const url = new URL("/", request.url);
  url.searchParams.set("settings", "connectors");
  url.searchParams.set("gmail", status);
  if (code) url.searchParams.set("code", code);
  return NextResponse.redirect(url, 303);
}

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/login", request.url), 303);
  const url = new URL(request.url);
  if (url.searchParams.has("error")) return home(request, "denied");
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) return home(request, "failed", "GMAIL_OAUTH_CALLBACK_INVALID");
  try { await completeGmailOAuth(session, { state, code }); return home(request, "connected"); }
  catch (error) { return home(request, "failed", gmailConnectorErrorCode(error)); }
}
