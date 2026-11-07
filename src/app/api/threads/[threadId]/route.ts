import { NextResponse } from "next/server";
import { isSameOriginMutation } from "@/auth/request-security";
import { getSession } from "@/auth/session";
import { workbenchErrorResponse } from "@/workbench/http";
import { getThread, updateThread } from "@/workbench/store";
import { isUpdateThreadInput } from "@/workbench/types";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const { threadId } = await context.params;
  try {
    const thread = await getThread(session, threadId);
    return NextResponse.json(
      { thread },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return workbenchErrorResponse(error, "No s’ha pogut carregar el fil.");
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (!isUpdateThreadInput(body)) {
    return NextResponse.json({ error: "El canvi de fil no és vàlid." }, { status: 400 });
  }
  const { threadId } = await context.params;
  try {
    const thread = await updateThread(session, threadId, body);
    return NextResponse.json(
      { thread },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return workbenchErrorResponse(error, "No s’ha pogut actualitzar el fil.");
  }
}
