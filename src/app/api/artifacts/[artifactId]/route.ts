import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { advancedArtifactErrorResponse } from "@/artifacts/http";
import { getAdvancedArtifactForSession } from "@/artifacts/server-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ artifactId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => key !== "version") || url.searchParams.getAll("version").length > 1) {
    return NextResponse.json({ error: "Consulta no válida." }, { status: 400 });
  }
  const rawVersion = url.searchParams.get("version");
  const version = rawVersion === null ? undefined : Number(rawVersion);
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
    return NextResponse.json({ error: "Versión no válida." }, { status: 400 });
  }
  try {
    const { artifactId } = await context.params;
    return NextResponse.json(await getAdvancedArtifactForSession(session, artifactId, version), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return advancedArtifactErrorResponse(error, "No se ha podido abrir el artefacto.");
  }
}
