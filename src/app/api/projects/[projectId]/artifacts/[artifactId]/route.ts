import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { readRegularFileWithin } from "@/security/safe-file";
import { isUuid } from "@/workbench/types";
import { contentDisposition, libraryResourceErrorResponse } from "@/library/http";
import { resolveProjectLibraryResource } from "@/library/server-resource-access";
import { isPng } from "@/runtime/generated-image-artifacts";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; artifactId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const { projectId, artifactId } = await context.params;
  if (!isUuid(projectId) || !isUuid(artifactId)) {
    return NextResponse.json({ error: "Artefacte no vàlid." }, { status: 400 });
  }
  const searchParams = new URL(request.url).searchParams;
  if ([...searchParams.keys()].some((key) => key !== "download") ||
      searchParams.getAll("download").length > 1 ||
      (searchParams.has("download") && searchParams.get("download") !== "1")) {
    return NextResponse.json({ error: "Consulta no vàlida." }, { status: 400 });
  }
  try {
    const resource = await resolveProjectLibraryResource(session, {
      kind: "generated-image",
      resourceId: artifactId,
      projectId,
    });
    const expectedPath = `generated-image-artifacts/${artifactId}.png`;
    if (resource.location.relativePath !== expectedPath || resource.location.mediaType !== "image/png" ||
        !/^[^/\\\u0000-\u001f\u007f]+\.png$/u.test(resource.location.fileName)) {
      return NextResponse.json({ error: "Artefacte no trobat." }, { status: 404 });
    }
    const contents = await readRegularFileWithin(
      resource.installation.paths.dataRoot,
      expectedPath,
      20_000_000,
    );
    if (contents.byteLength !== resource.location.size ||
        createHash("sha256").update(contents).digest("hex") !== resource.location.sha256 ||
        !isPng(contents)) {
      return NextResponse.json({ error: "El artefacto ya no coincide con su registro." }, { status: 409 });
    }
    const fileName = resource.location.fileName;
    return new Response(contents, {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(contents.byteLength),
        "Cache-Control": "private, no-store",
        "Content-Disposition": contentDisposition(
          fileName,
          searchParams.get("download") === "1" ? "attachment" : "inline",
        ),
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const resourceError = libraryResourceErrorResponse(error, "Artefacte no trobat.");
    if (resourceError) return resourceError;
    return NextResponse.json({ error: "Artefacte no trobat." }, { status: 404 });
  }
}
