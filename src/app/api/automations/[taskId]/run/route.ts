import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { AutomationAccessError, runAutomationTaskNow } from "@/automations/server-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403, headers: HEADERS });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers: HEADERS });
  const body: unknown = await request.json().catch(() => null);
  const clientRequestId = body && typeof body === "object" && !Array.isArray(body) &&
    Object.keys(body).length === 1 && "clientRequestId" in body && typeof body.clientRequestId === "string"
    ? body.clientRequestId : null;
  if (!clientRequestId || !UUID.test(clientRequestId)) {
    return NextResponse.json({ error: "La solicitud de ejecución no es válida." }, { status: 400, headers: HEADERS });
  }
  try {
    const task = await runAutomationTaskNow(session, (await context.params).taskId, clientRequestId);
    return NextResponse.json({ schemaVersion: 1, task, queued: true }, { status: 202, headers: HEADERS });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "AUTOMATION_UNAVAILABLE";
    return NextResponse.json({ error: error instanceof Error ? error.message : "No se ha podido ejecutar ahora.", code }, {
      status: error instanceof AutomationAccessError ? error.status
        : code === "AUTOMATION_RUN_PENDING" ? 409 : code === "AUTOMATION_NOT_FOUND" ? 404 : 503,
      headers: HEADERS,
    });
  }
}
