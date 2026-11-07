import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { createSupportRequest, listSupportRequests } from "@/support/server-service";
import { parseSupportRequestInput } from "@/support/contracts";
import { readSupportJson, supportError, SUPPORT_HEADERS as headers } from "@/support/http";
export const runtime = "nodejs";
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  try { return NextResponse.json({ schemaVersion: 1, requests: await listSupportRequests(session) }, { headers }); } catch (error) { return supportError(error); }
}
export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  try {
    const input = parseSupportRequestInput(await readSupportJson(request));
    if (!input) return NextResponse.json({ error: "Revisa el tipo, la descripción y el contexto." }, { status: 400, headers });
    return NextResponse.json({ schemaVersion: 1, request: await createSupportRequest(session, input) }, { status: 201, headers });
  } catch (error) { return supportError(error); }
}
