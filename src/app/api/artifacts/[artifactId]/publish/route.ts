import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { advancedArtifactErrorResponse } from "@/artifacts/http";
import { publishAdvancedArtifactForSession } from "@/artifacts/server-service";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ artifactId: string }> },
) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  if (request.headers.get("content-length") && request.headers.get("content-length") !== "0") {
    return NextResponse.json({ error: "Esta acción no acepta contenido." }, { status: 400 });
  }
  try {
    const { artifactId } = await context.params;
    return NextResponse.json(await publishAdvancedArtifactForSession(session, artifactId), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return advancedArtifactErrorResponse(error, "No se ha podido publicar el sitio interno.");
  }
}
