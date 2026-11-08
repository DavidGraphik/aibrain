import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { disconnectComposio } from "@/connectors/composio-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function POST(request: Request, context: { params: Promise<{ toolkit: string }> }) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Inicia sesión." }, { status: 401, headers });
  try { return NextResponse.json(await disconnectComposio(session, (await context.params).toolkit), { headers }); }
  catch { return NextResponse.json({ error: "No se pudo desconectar. Reintenta la operación." }, { status: 409, headers }); }
}
