import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isMemoryProjectId } from "@/memory/http-contract";
import { memoryProposalServiceForSession } from "@/memory/server-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!isMemoryProjectId(projectId)) return NextResponse.json({ error: "Proyecto no válido." }, { status: 400, headers });
  try {
    const { store, context, allowCompanyScope } = await memoryProposalServiceForSession(session, projectId);
    const [proposals, memories, audit] = await Promise.all([store.listProposals(context, "all"), store.listRecords(context, true, allowCompanyScope), store.auditLog(context, 100)]);
    return NextResponse.json({ schemaVersion: 1, proposals, memories, audit, allowCompanyScope }, { headers });
  } catch { return NextResponse.json({ error: "La memoria propuesta no está disponible." }, { status: 503, headers }); }
}
