import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { disconnectCompanyMail } from "@/connectors/company-mail-server-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie" };
export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  try { return NextResponse.json(await disconnectCompanyMail(session), { headers }); }
  catch { return NextResponse.json({ error: "No se ha podido desconectar el correo." }, { status: 409, headers }); }
}
