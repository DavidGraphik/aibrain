import { NextResponse } from "next/server";
import { documentPreviewResponse } from "@/documents/preview-http";
import { getSession } from "@/auth/session";
import { loadInstallationConfig } from "@/config/installation";
import { documentServicesForUser } from "@/documents/server-service";
import { versionPreviewFile } from "@/documents/version-http";
import { StorageError } from "@/storage";
import { isUuid } from "@/workbench/types";
import { libraryResourceErrorResponse } from "@/library/http";
import { resolveThreadLibraryResource } from "@/library/server-resource-access";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ threadId: string; uploadId: string; versionId: string; fileName: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  const { threadId, uploadId: documentId, versionId, fileName } = await context.params;
  if (!isUuid(threadId) || !isUuid(documentId) || !isUuid(versionId) ||
      !/^[a-z0-9][a-z0-9._-]{0,159}$/.test(fileName)) {
    return NextResponse.json({ error: "Vista previa no válida." }, { status: 400 });
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
    if (!version || versionPreviewFile(version) !== fileName) {
      return NextResponse.json({ error: "Vista previa no encontrada." }, { status: 404 });
    }
    const staged = await services.staging.readById(threadId, version.contentUploadId);
    if (staged.fileName !== version.fileName || staged.kind !== version.kind || staged.mediaType !== version.mediaType ||
        staged.size !== version.size || staged.sha256 !== version.sha256) {
      return NextResponse.json({ error: "La versión ya no coincide con su contenido inmutable." }, { status: 409 });
    }
    // Authorization and immutable source binding above must precede cache repair.
    await services.previews.create(staged, { signal: _request.signal });
    const data = await services.previews.readFile(threadId, version.contentUploadId, fileName);
    return documentPreviewResponse(data, fileName);
  } catch (error) {
    const resourceError = libraryResourceErrorResponse(error, "Vista previa no encontrada.");
    if (resourceError) return resourceError;
    if (error instanceof StorageError || (error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      return NextResponse.json({ error: "Vista previa no encontrada." }, { status: 404 });
    }
    return NextResponse.json({ error: "Vista previa no encontrada." }, { status: 404 });
  }
}
