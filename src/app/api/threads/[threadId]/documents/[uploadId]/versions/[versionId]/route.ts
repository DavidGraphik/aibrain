import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { loadInstallationConfig } from "@/config/installation";
import { documentServicesForUser } from "@/documents/server-service";
import { contentDisposition, libraryResourceErrorResponse } from "@/library/http";
import { resolveThreadLibraryResource } from "@/library/server-resource-access";
import { readRegularFileWithin } from "@/security/safe-file";
import { StorageError } from "@/storage";
import { isUuid } from "@/workbench/types";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ threadId: string; uploadId: string; versionId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  const { threadId, uploadId: documentId, versionId } = await context.params;
  if (!isUuid(threadId) || !isUuid(documentId) || !isUuid(versionId)) {
    return NextResponse.json({ error: "Versión no válida." }, { status: 400 });
  }
  try {
    const installation = await loadInstallationConfig();
    if (session.provider !== "local" || session.tenant.id !== installation.installationId) {
      return NextResponse.json({ error: "La sesión no pertenece a esta instalación." }, { status: 403 });
    }
    const resource = await resolveThreadLibraryResource(session, {
      kind: "upload",
      resourceId: documentId,
      threadId,
    });
    const services = await documentServicesForUser(installation, resource.location.storageOwnerId);
    const history = await services.versions.read(threadId, documentId);
    const version = history.versions.find((candidate) => candidate.versionId === versionId);
    if (!version) return NextResponse.json({ error: "Versión no encontrada." }, { status: 404 });
    const resolved = await services.staging.resolveContentById(threadId, version.contentUploadId);
    if (resolved.document.fileName !== version.fileName || resolved.document.kind !== version.kind ||
        resolved.document.mediaType !== version.mediaType || resolved.document.size !== version.size ||
        resolved.document.sha256 !== version.sha256) {
      return NextResponse.json({ error: "La versión ya no coincide con su contenido inmutable." }, { status: 409 });
    }
    const contents = await readRegularFileWithin(services.staging.rootDirectory, resolved.document.relativePath, 50 * 1024 * 1024);
    if (contents.byteLength !== version.size || createHash("sha256").update(contents).digest("hex") !== version.sha256) {
      return NextResponse.json({ error: "La versión ya no coincide con su contenido inmutable." }, { status: 409 });
    }
    return new Response(new Uint8Array(contents), {
      headers: {
        "Content-Type": version.mediaType,
        "Content-Length": String(contents.byteLength),
        "Content-Disposition": contentDisposition(version.fileName, "attachment"),
        "Cache-Control": "private, no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const resourceError = libraryResourceErrorResponse(error, "Versión no encontrada.");
    if (resourceError) return resourceError;
    if (error instanceof StorageError || (error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      return NextResponse.json({ error: "Versión no encontrada." }, { status: 404 });
    }
    return NextResponse.json({ error: "Versión no encontrada." }, { status: 404 });
  }
}
