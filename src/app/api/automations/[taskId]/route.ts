import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { parseAutomationPatch } from "@/automations/contracts";
import { AutomationAccessError, deleteAutomationTask, updateAutomationTask } from "@/automations/server-service";
import { getProject } from "@/workbench/store";
import { STANDALONE_PROJECT_SLUG } from "@/workbench/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "private, no-store" };

function responseError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "AUTOMATION_UNAVAILABLE";
  return NextResponse.json({ error: error instanceof Error ? error.message : "No se ha podido actualizar.", code }, {
    status: error instanceof AutomationAccessError
      ? error.status
      : code === "AUTOMATION_NOT_FOUND" ? 404 : code === "AUTOMATION_DATE_PAST" ? 400 : 503,
    headers: HEADERS,
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ taskId: string }> }) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403, headers: HEADERS });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers: HEADERS });
  const patch = parseAutomationPatch(await request.json().catch(() => null));
  if (!patch) return NextResponse.json({ error: "Cambios no válidos." }, { status: 400, headers: HEADERS });
  try {
    if (patch.projectId) {
      const project = await getProject(session, patch.projectId);
      patch.projectName = project.slug === STANDALONE_PROJECT_SLUG ? "Sin proyecto" : project.name;
    }
    const task = await updateAutomationTask(session, (await context.params).taskId, patch);
    return NextResponse.json({ schemaVersion: 1, task }, { headers: HEADERS });
  } catch (error) {
    return responseError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ taskId: string }> }) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403, headers: HEADERS });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers: HEADERS });
  try {
    await deleteAutomationTask(session, (await context.params).taskId);
    return NextResponse.json({ schemaVersion: 1, deleted: true }, { headers: HEADERS });
  } catch (error) {
    return responseError(error);
  }
}
