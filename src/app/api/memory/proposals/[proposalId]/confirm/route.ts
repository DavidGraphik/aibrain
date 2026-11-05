import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { isConfirmMemoryProposalRequest } from "@/memory/http-contract";
import { MemoryProposalError } from "@/memory/proposal-store";
import { memoryProposalServiceForSession } from "@/memory/server-service";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ proposalId: string }> };
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request, route: RouteContext) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403, headers });
  const session = await getSession(); if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  const body: unknown = await request.json().catch(() => null); if (!isConfirmMemoryProposalRequest(body)) return NextResponse.json({ error: "La confirmación no es válida." }, { status: 400, headers });
  try { const { proposalId } = await route.params; const { store, context, allowCompanyScope } = await memoryProposalServiceForSession(session, body.projectId); return NextResponse.json(await store.confirm(context, { proposalId, explicit: true, content: body.content, scope: body.scope, allowCompanyScope }), { headers }); }
  catch (error) { const status = error instanceof MemoryProposalError && error.code === "MEMORY_COMPANY_SCOPE_FORBIDDEN" ? 403 : error instanceof MemoryProposalError && error.code.endsWith("NOT_FOUND") ? 404 : 409; return NextResponse.json({ error: error instanceof Error ? error.message : "No se ha podido confirmar." }, { status, headers }); }
}
