import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { gmailConnectorErrorCode, startGmailOAuth } from "@/connectors/gmail-server-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado.", code: "AUTH_REQUIRED" }, { status: 401 });
  try { return NextResponse.redirect(await startGmailOAuth(session), 302); }
  catch (error) { return NextResponse.json({ error: "No se ha podido iniciar la conexión con Gmail.", code: gmailConnectorErrorCode(error) }, { status: 503, headers: { "Cache-Control": "private, no-store" } }); }
}
