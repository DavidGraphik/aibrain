import { NextResponse } from "next/server";
import { documentPreviewResponse } from "@/documents/preview-http";
import { getSession } from "@/auth/session";
import { loadInstallationConfig } from "@/config/installation";
import { documentServicesForUser } from "@/documents/server-service";
import { StorageError } from "@/storage";
import { workbenchErrorResponse } from "@/workbench/http";
import { isUuid } from "@/workbench/types";
import { libraryResourceErrorResponse } from "@/library/http";
import { resolveThreadLibraryResource } from "@/library/server-resource-access";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ threadId: string; uploadId: string; fileName: string }>;
};

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export async function GET(_request: Request, context: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const { threadId, uploadId, fileName } = await context.params;
  if (!isUuid(threadId) || !isUuid(uploadId) ||
      !/^[a-z0-9][a-z0-9._-]{0,159}$/.test(fileName)) {
    return NextResponse.json({ error: "Preview no vàlid." }, { status: 400 });
  }
  try {
    const installation = await loadInstallationConfig();
    if (session.provider !== "local" || session.tenant.id !== installation.installationId) {
      return NextResponse.json({ error: "La sessió no pertany a aquesta instal·lació." }, { status: 403 });
    }
    const resource = await resolveThreadLibraryResource(session, {
      kind: "upload",
      resourceId: uploadId,
      threadId,
    });
    const services = await documentServicesForUser(installation, resource.location.storageOwnerId);
    const staged = await services.staging.readById(threadId, uploadId);
    if (staged.fileName !== resource.location.fileName || staged.mediaType !== resource.location.mediaType ||
        staged.size !== resource.location.size || staged.sha256 !== resource.location.sha256 ||
        staged.relativePath !== resource.location.relativePath) {
      return NextResponse.json({ error: "El preview ya no coincide con su registro." }, { status: 409 });
    }
    // Authorization and immutable source binding above must precede cache repair.
    await services.previews.create(staged, { signal: _request.signal });
    const data = await services.previews.readFile(threadId, uploadId, fileName);
    return documentPreviewResponse(data, fileName);
  } catch (error) {
    const resourceError = libraryResourceErrorResponse(error, "Preview no trobat.");
    if (resourceError) return resourceError;
    if ((error instanceof StorageError && error.code === "DOCUMENT_PREVIEW_FILE_NOT_FOUND") ||
        isNodeError(error, "ENOENT")) {
      return NextResponse.json({ error: "Preview no trobat." }, { status: 404 });
    }
    return workbenchErrorResponse(error, "No s’ha pogut llegir el preview.");
  }
}
