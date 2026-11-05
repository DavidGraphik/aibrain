import { NextResponse } from "next/server";
import { isSameOriginMutation } from "@/auth/request-security";
import { getSession } from "@/auth/session";
import { workbenchErrorResponse } from "@/workbench/http";
import { createProject, listProjects } from "@/workbench/store";
import { isCreateProjectInput, parseWorkbenchListQuery } from "@/workbench/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const query = parseWorkbenchListQuery(new URL(request.url).searchParams);
  if (!query) {
    return NextResponse.json({ error: "La consulta de projectes no és vàlida." }, { status: 400 });
  }
  try {
    const page = await listProjects(session, query);
    return NextResponse.json(
      { projects: page.items, nextCursor: page.nextCursor },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return workbenchErrorResponse(error, "No s’han pogut carregar els projectes.");
  }
}

export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (!isCreateProjectInput(body)) {
    return NextResponse.json({ error: "El nom del projecte no és vàlid." }, { status: 400 });
  }
  try {
    const project = await createProject(session, body.name);
    return NextResponse.json(
      { project },
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return workbenchErrorResponse(error, "No s’ha pogut crear el projecte.");
  }
}
