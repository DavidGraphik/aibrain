import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { disconnectMail } from "@/connectors/mail-server-service";
import { MailConnectorError, mailErrorCode } from "@/connectors/mail-contracts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ code: "ORIGIN_REQUIRED" }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ code: "AUTH_REQUIRED" }, { status: 401, headers });
  try { return NextResponse.json(await disconnectMail(session), { headers }); }
  catch (error) { return NextResponse.json({ error: "No se ha podido desconectar el correo.", code: mailErrorCode(error) }, { status: error instanceof MailConnectorError ? error.status : 409, headers }); }
}
