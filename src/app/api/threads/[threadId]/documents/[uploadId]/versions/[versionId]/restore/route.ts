import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { loadInstallationConfig } from "@/config/installation";
import { documentServicesForUser } from "@/documents/server-service";
import { documentVersionJson } from "@/documents/version-http";
import { parseIfMatch, quotedDocumentEtag } from "@/documents/version-store";
import { libraryResourceErrorResponse } from "@/library/http";
import {
  assertLibraryResourceWritable,
  resolveThreadLibraryResource,
} from "@/library/server-resource-access";
import { StorageError } from "@/storage";
import { isUuid } from "@/workbench/types";

export const runtime = "nodejs";

async function boundedJson(request: Request) {
  if (!request.body) return null;
  const declared = request.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 2_048)) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 2_048) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ threadId: string; uploadId: string; versionId: string }> },
) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autorizado." }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  const { threadId, uploadId: documentId, versionId: sourceVersionId } = await context.params;
  if (!isUuid(threadId) || !isUuid(documentId) || !isUuid(sourceVersionId)) {
    return NextResponse.json({ error: "Versión no válida." }, { status: 400 });
  }
  const baseEtag = parseIfMatch(request.headers.get("If-Match"));
  if (!baseEtag) {
    return NextResponse.json({ error: "Debes indicar la versión base antes de restaurar.", code: "DOCUMENT_VERSION_BASE_REQUIRED" }, { status: 428 });
  }
  const body = await boundedJson(request);
  const restoreVersionId = body && typeof body === "object" && !Array.isArray(body) &&
    Object.keys(body).length === 1 && "restoreVersionId" in body && typeof body.restoreVersionId === "string"
    ? body.restoreVersionId : null;
  if (!restoreVersionId || !isUuid(restoreVersionId)) {
    return NextResponse.json({ error: "Petición de restauración no válida." }, { status: 400 });
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
    assertLibraryResourceWritable(resource.access);
    const services = await documentServicesForUser(installation, resource.location.storageOwnerId);
    const current = await services.versions.read(threadId, documentId);
    const currentEtag = current.versions.at(-1)!.etag;
    if (currentEtag !== baseEtag) {
      return NextResponse.json({
        error: "El documento ha cambiado. Recarga el historial antes de restaurar.",
        code: "DOCUMENT_VERSION_CONFLICT",
      }, { status: 409, headers: { ETag: quotedDocumentEtag(currentEtag), "Cache-Control": "private, no-store" } });
    }
    const updated = await services.versions.restore({
      threadId,
      documentId,
      sourceVersionId,
      restoreVersionId,
      baseEtag,
      author: { userId: session.user.id, name: session.user.name },
    });
    return documentVersionJson(updated, 201);
  } catch (error) {
    const resourceError = libraryResourceErrorResponse(error, "Versión no encontrada.");
    if (resourceError) return resourceError;
    if (error instanceof StorageError && error.code === "DOCUMENT_VERSION_CONFLICT") {
      return NextResponse.json({ error: "El documento ha cambiado. Recarga el historial antes de restaurar.", code: error.code }, { status: 409 });
    }
    if (error instanceof StorageError && error.code === "DOCUMENT_VERSION_NOT_FOUND") {
      return NextResponse.json({ error: "Versión no encontrada." }, { status: 404 });
    }
    return NextResponse.json({ error: "No se ha podido restaurar la versión." }, { status: 404 });
  }
}
