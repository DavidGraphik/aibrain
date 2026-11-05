import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { replySupportRequest } from "@/support/server-service";
import { parseSupportReplyInput } from "@/support/contracts";
import { readSupportJson, supportError, SUPPORT_HEADERS as headers } from "@/support/http";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  try {
    const input = parseSupportReplyInput(await readSupportJson(request, 64 * 1024));
    if (!input) return NextResponse.json({ error: "Revisa la respuesta." }, { status: 400, headers });
    return NextResponse.json({ request: await replySupportRequest(session, (await context.params).id, input) }, { headers });
  } catch (error) { return supportError(error); }
}
