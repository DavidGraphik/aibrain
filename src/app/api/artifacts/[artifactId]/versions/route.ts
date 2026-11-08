import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { isCreateAdvancedArtifactVersionInput } from "@/artifacts/contracts";
import { advancedArtifactErrorResponse } from "@/artifacts/http";
import { createAdvancedArtifactVersion } from "@/artifacts/server-service";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ artifactId: string }> },
) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (!isCreateAdvancedArtifactVersionInput(body)) return NextResponse.json({ error: "Datos de versión no válidos." }, { status: 400 });
  try {
    const { artifactId } = await context.params;
    return NextResponse.json(await createAdvancedArtifactVersion(session, artifactId, body), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return advancedArtifactErrorResponse(error, "No se ha podido crear una nueva versión.");
  }
}
