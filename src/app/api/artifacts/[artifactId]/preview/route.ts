import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { advancedArtifactErrorResponse } from "@/artifacts/http";
import { ARTIFACT_PREVIEW_CSP, renderArtifactHtml } from "@/artifacts/rendering";
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
    const { snapshot } = await getAdvancedArtifactForSession(session, artifactId, version);
    return new NextResponse(renderArtifactHtml(snapshot), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": ARTIFACT_PREVIEW_CSP,
        "Content-Type": "text/html; charset=utf-8",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return advancedArtifactErrorResponse(error, "No se ha podido generar la vista previa.");
  }
}
