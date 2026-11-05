import { NextResponse } from "next/server";
import { isSameOriginMutation } from "@/auth/request-security";
import { getSession } from "@/auth/session";
import { workbenchErrorResponse } from "@/workbench/http";
import { getProject, updateProject } from "@/workbench/store";
import { isUpdateProjectInput } from "@/workbench/types";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const { projectId } = await context.params;
  try {
    const project = await getProject(session, projectId);
    return NextResponse.json(
      { project },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return workbenchErrorResponse(error, "No s’ha pogut carregar el projecte.");
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (!isUpdateProjectInput(body)) {
    return NextResponse.json({ error: "El canvi de projecte no és vàlid." }, { status: 400 });
  }
  const { projectId } = await context.params;
  try {
    const project = await updateProject(session, projectId, body);
    return NextResponse.json(
      { project },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return workbenchErrorResponse(error, "No s’ha pogut actualitzar el projecte.");
  }
}
