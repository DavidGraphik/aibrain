import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { isAutomationAudience } from "@/automations/contracts";
import { isHostJob, UUID } from "@/automations/host-analysis/contracts";
import { authorizeHostJob, hostBindingsForSession, revokeHostJob } from "@/automations/host-analysis/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET() {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  try { return NextResponse.json({ bindings: await hostBindingsForSession(session) }, { headers }); }
  catch { return NextResponse.json({ error: "No autorizado para estos análisis." }, { status: 403, headers }); }
}
export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403, headers });
  const session = await getSession(); if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  const v = await request.json().catch(() => null);
  if (!v || Object.keys(v).sort().join() !== "audience,job,projectId" || !isHostJob(v.job) || typeof v.projectId !== "string" || !UUID.test(v.projectId) || !isAutomationAudience(v.audience)) return NextResponse.json({ error: "Registro no válido." }, { status: 400, headers });
  try { return NextResponse.json({ binding: await authorizeHostJob(session, v) }, { status: 201, headers }); }
  catch { return NextResponse.json({ error: "No se ha autorizado el análisis. Revisa proyecto y audiencia." }, { status: 403, headers }); }
}
export async function DELETE(request: Request) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403, headers });
  const session = await getSession(); if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401, headers });
  const v = await request.json().catch(() => null);
  if (!v || Object.keys(v).join() !== "job" || !isHostJob(v.job)) return NextResponse.json({ error: "Registro no válido." }, { status: 400, headers });
  try { await revokeHostJob(session, v.job); return NextResponse.json({ revoked: true }, { headers }); }
  catch { return NextResponse.json({ error: "No se ha podido revocar este análisis." }, { status: 403, headers }); }
}
