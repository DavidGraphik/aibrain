import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { isRejectMemoryProposalRequest } from "@/memory/http-contract";
import { memoryProposalServiceForSession } from "@/memory/server-service";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ proposalId: string }> };
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request, route: RouteContext) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403, headers });
  const session = await getSession(); if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  const body: unknown = await request.json().catch(() => null); if (!isRejectMemoryProposalRequest(body)) return NextResponse.json({ error: "El rechazo no es válido." }, { status: 400, headers });
  try { const { proposalId } = await route.params; const { store, context } = await memoryProposalServiceForSession(session, body.projectId); return NextResponse.json(await store.reject(context, { proposalId, explicit: true, reason: body.reason }), { headers }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "No se ha podido rechazar." }, { status: 409, headers }); }
}
