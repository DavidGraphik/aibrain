import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { isCreateAdvancedArtifactInput } from "@/artifacts/contracts";
import { advancedArtifactErrorResponse } from "@/artifacts/http";
import { createAdvancedArtifact, listAdvancedArtifactsForSession } from "@/artifacts/server-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  try {
    return NextResponse.json({ items: await listAdvancedArtifactsForSession(session) }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return advancedArtifactErrorResponse(error, "Los artefactos no están disponibles.");
  }
}

export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (!isCreateAdvancedArtifactInput(body)) return NextResponse.json({ error: "Datos de artefacto no válidos." }, { status: 400 });
  try {
    return NextResponse.json(await createAdvancedArtifact(session, body), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return advancedArtifactErrorResponse(error, "No se ha podido crear el artefacto.");
  }
}
