import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { isRestoreGovernedMemoryRequest } from "@/memory/http-contract";
import { memoryProposalServiceForSession } from "@/memory/server-service";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ memoryId: string }> };
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request, route: RouteContext) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  const body: unknown = await request.json().catch(() => null);
  if (!isRestoreGovernedMemoryRequest(body)) return NextResponse.json({ error: "La restauración no es válida." }, { status: 400, headers });
  try {
    const { memoryId } = await route.params;
    const { store, context, allowCompanyScope } = await memoryProposalServiceForSession(session, body.projectId);
    return NextResponse.json({
      memory: await store.restore(context, {
        memoryId,
        explicit: true,
        expectedRevision: body.expectedRevision,
        allowCompanyScope,
      }),
    }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "No se ha podido restaurar." }, { status: 409, headers });
  }
}
