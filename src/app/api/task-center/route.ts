import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import {
  isTaskCenterId,
  isTaskNotificationPreferences,
} from "@/task-center/contracts";
import { getTaskCenter, updateTaskCenter } from "@/task-center/server-service";
import { workbenchErrorResponse } from "@/workbench/http";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  try {
    return NextResponse.json(await getTaskCenter(session), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return workbenchErrorResponse(error, "No se ha podido cargar el centro de tareas.");
  }
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "El cuerpo no es JSON válido." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "La actualización no es válida." }, { status: 400 });
  }
  const keys = Object.keys(body);
  let update: Parameters<typeof updateTaskCenter>[1] | null = null;
  if (keys.length === 2 && keys.includes("action") && keys.includes("taskIds") &&
    "action" in body && body.action === "mark_read" && "taskIds" in body &&
    Array.isArray(body.taskIds) && body.taskIds.length <= 5_000 && body.taskIds.every(isTaskCenterId)) {
    update = { markRead: [...new Set(body.taskIds)] };
  } else if (keys.length === 2 && keys.includes("action") && keys.includes("preferences") &&
    "action" in body && body.action === "preferences" && "preferences" in body &&
    isTaskNotificationPreferences(body.preferences)) {
    update = { preferences: body.preferences };
  }
  if (!update) {
    return NextResponse.json({ error: "La actualización no es válida." }, { status: 400 });
  }
  try {
    return NextResponse.json(await updateTaskCenter(session, update), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return workbenchErrorResponse(error, "No se ha podido guardar el centro de tareas.");
  }
}
