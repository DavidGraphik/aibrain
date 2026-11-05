import JSZip from "jszip";
import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { advancedArtifactErrorResponse } from "@/artifacts/http";
import { renderArtifactHtml } from "@/artifacts/rendering";
import { getAdvancedArtifactForSession } from "@/artifacts/server-service";
import { contentDisposition } from "@/library/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function exportName(title: string) {
  return title.normalize("NFKD").replace(/[^A-Za-z0-9 -]/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "artefacto-aibrain";
}

export async function GET(
  request: Request,
  context: { params: Promise<{ artifactId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== "format" && key !== "version") ||
      params.getAll("format").length !== 1 || params.getAll("version").length > 1) {
    return NextResponse.json({ error: "Consulta no válida." }, { status: 400 });
  }
  const format = params.get("format");
  const rawVersion = params.get("version");
  const version = rawVersion === null ? undefined : Number(rawVersion);
  if (!(format === "html" || format === "zip") ||
      (version !== undefined && (!Number.isSafeInteger(version) || version < 1))) {
    return NextResponse.json({ error: "Formato o versión no válidos." }, { status: 400 });
  }
  try {
    const { artifactId } = await context.params;
    const { summary, snapshot } = await getAdvancedArtifactForSession(session, artifactId, version);
    const html = renderArtifactHtml(snapshot);
    const name = exportName(summary.title);
    if (format === "html") {
      return new NextResponse(html, { headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": contentDisposition(`${name}-v${snapshot.version}.html`, "attachment"),
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      } });
    }
    const archive = new JSZip();
    archive.file("index.html", html);
    archive.file("aibrain-artifact.json", `${JSON.stringify({
      schemaVersion: 1,
      artifactId: snapshot.artifactId,
      version: snapshot.version,
      kind: snapshot.content.kind,
      title: snapshot.title,
      source: snapshot.source,
      createdAt: snapshot.createdAt,
      contentSha256: snapshot.contentSha256,
    }, null, 2)}\n`);
    const bytes = await archive.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
    return new NextResponse(Uint8Array.from(bytes).buffer, { headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": contentDisposition(`${name}-v${snapshot.version}.zip`, "attachment"),
      "Content-Type": "application/zip",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    return advancedArtifactErrorResponse(error, "No se ha podido exportar el artefacto.");
  }
}
