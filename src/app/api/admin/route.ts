import { NextResponse } from "next/server";
import { isWorkspaceAdminCommand } from "@/admin/contracts";
import {
  executeWorkspaceAdminCommand,
  WorkspaceAdminError,
  workspaceAdminSnapshot,
} from "@/admin/server-service";
import { isSameOriginMutation } from "@/auth/request-security";
import { getSession } from "@/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = Object.freeze({ "Cache-Control": "private, no-store" });

function errorResponse(error: unknown) {
  if (error instanceof WorkspaceAdminError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: HEADERS });
  }
  return NextResponse.json({ error: "No se ha podido completar la operación administrativa.", code: "ADMIN_UNAVAILABLE" }, { status: 503, headers: HEADERS });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado.", code: "AUTH_REQUIRED" }, { status: 401, headers: HEADERS });
  try {
    return NextResponse.json(await workspaceAdminSnapshot(session), { headers: HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autorizado.", code: "ORIGIN_NOT_ALLOWED" }, { status: 403, headers: HEADERS });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado.", code: "AUTH_REQUIRED" }, { status: 401, headers: HEADERS });
  const command: unknown = await request.json().catch(() => null);
  if (!isWorkspaceAdminCommand(command)) {
    return NextResponse.json({ error: "La operación administrativa no es válida.", code: "ADMIN_COMMAND_INVALID" }, { status: 400, headers: HEADERS });
  }
  try {
    return NextResponse.json(await executeWorkspaceAdminCommand(session, command), { headers: HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}
