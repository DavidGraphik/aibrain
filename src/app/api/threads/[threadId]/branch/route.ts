import { NextResponse } from "next/server";
import { isSameOriginMutation } from "@/auth/request-security";
import { getSession } from "@/auth/session";
import { workbenchErrorResponse } from "@/workbench/http";
import { branchThread } from "@/workbench/store";
import { isBranchThreadInput } from "@/workbench/types";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (!isBranchThreadInput(body)) {
    return NextResponse.json({ error: "La branca no és vàlida." }, { status: 400 });
  }
  const { threadId } = await context.params;
  try {
    const result = await branchThread(session, threadId, body);
    return NextResponse.json(result, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return workbenchErrorResponse(error, "No s’ha pogut crear la branca.");
  }
}
