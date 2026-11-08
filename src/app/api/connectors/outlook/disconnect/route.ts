import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { disconnectOutlook, outlookConnectorErrorCode } from "@/connectors/outlook-server-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado.", code: "ORIGIN_REQUIRED" }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado.", code: "AUTH_REQUIRED" }, { status: 401, headers });
  try { return NextResponse.json(await disconnectOutlook(session), { headers }); }
  catch (error) { return NextResponse.json({ error: "No se ha podido desconectar Outlook.", code: outlookConnectorErrorCode(error) }, { status: 409, headers }); }
}
