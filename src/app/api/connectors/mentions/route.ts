import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { connectorMentionsForSession } from "@/connectors/mentions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado.", code: "AUTH_REQUIRED" }, { status: 401 });
  try {
    return NextResponse.json(await connectorMentionsForSession(session), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: "No se ha podido cargar el catálogo de conectores.", code: "CONNECTOR_MENTIONS_UNAVAILABLE" }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
