import { NextResponse } from "next/server";
import path from "node:path";
import { stageMacroExcelUpload } from "@/documents/macro-excel-upload";
import { stageLegacyExcelUpload } from "@/documents/legacy-excel-upload";
import { DocumentStorageBackpressureError } from "@/documents/storage-gate";
import { operationalLogger } from "@/operations/server-logger";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { loadInstallationConfig } from "@/config/installation";
import { parseStreamingDocumentUpload, type ParsedDocumentUpload } from "@/documents/multipart-upload";
import { documentServicesForUser } from "@/documents/server-service";
import { UploadValidationError, validateUploadedDocumentFile } from "@/documents/upload-validation";
import { documentVersionJson } from "@/documents/version-http";
import { parseIfMatch, quotedDocumentEtag } from "@/documents/version-store";
import { StorageError } from "@/storage";
import { workbenchErrorResponse } from "@/workbench/http";
import { isUuid } from "@/workbench/types";
import {
  assertLibraryResourceWritable,
  resolveThreadLibraryResource,
  resourceLocationIndexForInstallation,
} from "@/library/server-resource-access";
import { libraryResourceErrorResponse } from "@/library/http";
import { resolveThreadAccess } from "@/workbench/shared-access";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ threadId: string }> };

function documentErrorResponse(error: unknown) {
  const code = error instanceof UploadValidationError || error instanceof StorageError
    ? error.code
    : "DOCUMENT_UPLOAD_FAILED";
  operationalLogger.warn("document.upload_rejected", {
    code,
    ...(error instanceof DocumentStorageBackpressureError ? {
      reason: error.reason,
    } : {}),
  });
  if (code === "DOCUMENT_STORAGE_CAPACITY_UNAVAILABLE") {
    return NextResponse.json({ error: "No s’ha pogut mesurar l’espai per desar el document. La càrrega no ha començat.", code }, { status: 503 });
  }
  if (code === "DOCUMENT_STORAGE_CAPACITY_LOW") {
    return NextResponse.json({ error: "Cal almenys 1 GB lliure per admetre adjunts. La càrrega no ha començat.", code }, { status: 507 });
  }
  if (code === "DOCUMENT_STORAGE_FULL") {
    return NextResponse.json({
      error: "El disc no ha pogut desar el document perquè no té espai disponible. La càrrega no s’ha completat. Torna-ho a provar després d’alliberar espai.",
      code,
    }, { status: 507 });
  }
  if (code === "DOCUMENT_AUDIO_UNAVAILABLE") {
    return NextResponse.json({ error: "La transcripció d’àudio no està disponible en aquesta instal·lació.", code }, { status: 503 });
  }
  if (code === "DOCUMENT_AUDIO_EMPTY" || code === "DOCUMENT_AUDIO_INVALID") {
    return NextResponse.json({ error: "No s’ha pogut llegir una nota de veu vàlida. No s’ha creat cap transcripció.", code }, { status: 400 });
  }
  if (code === "UPLOAD_SIZE_INVALID") {
    return NextResponse.json({ error: "El document supera el límit de seguretat." }, { status: 413 });
  }
  if (code === "UPLOAD_MACROS_REJECTED") {
    return NextResponse.json({
      error: "El document inclou contingut actiu o elements d’Excel no admesos per seguretat. Puja una còpia .xlsx sense macros, enllaços ni objectes incrustats.",
      code,
    }, { status: 400 });
  }
  if (code.startsWith("UPLOAD_PASSIVE_XLS_")) {
    return NextResponse.json({
      error: "No s’han pogut extreure dades guardades d’aquest XLS de manera segura. No s’ha executat cap macro ni s’han actualitzat enllaços.", code,
    }, { status: 400 });
  }
  if (code === "DOCUMENT_VERSION_TYPE_MISMATCH") {
    return NextResponse.json({ error: "La nova versió ha de conservar el format original del document." }, { status: 400 });
  }
  if (code === "DOCUMENT_VERSION_CONFLICT") {
    return NextResponse.json({
      error: "El document ha canviat. Recarrega l’historial abans de pujar una altra versió.",
      code: "DOCUMENT_VERSION_CONFLICT",
    }, { status: 409 });
  }
  if (code === "STORAGE_STAGING_ID_CONFLICT" || code === "DOCUMENT_PREVIEW_CONFLICT") {
    return NextResponse.json({ error: "Aquest uploadId ja identifica un altre document." }, { status: 409 });
  }
  if (code === "DOCUMENT_CONVERSION_BACKPRESSURE" || code === "DOCUMENT_STORAGE_BACKPRESSURE") {
    const retryAfterMs = error && typeof error === "object" && "retryAfterMs" in error &&
      typeof error.retryAfterMs === "number" ? error.retryAfterMs : 1_000;
    return NextResponse.json(
      {
        error: code === "DOCUMENT_STORAGE_BACKPRESSURE"
          ? "Hi ha altres documents carregant-se. Torna-ho a provar d’aquí a uns segons."
          : "La conversió de documents està ocupada. Torna-ho a provar.",
        code,
        ...(error instanceof DocumentStorageBackpressureError ? { reason: error.reason } : {}),
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))) },
      },
    );
  }
  if (code.startsWith("UPLOAD_") || code === "STORAGE_STAGING_ID_INVALID") {
    return NextResponse.json({ error: "El document no supera la validació de seguretat." }, { status: 400 });
  }
  return NextResponse.json({ error: "No s’ha pogut preparar el document." }, { status: 503 });
}

export async function POST(request: Request, context: RouteContext) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const { threadId } = await context.params;
  if (!isUuid(threadId)) return NextResponse.json({ error: "Fil no vàlid." }, { status: 400 });
  const roundtripDocumentId = request.headers.get("X-AiBrain-Document-Id");
  if (roundtripDocumentId !== null && !isUuid(roundtripDocumentId)) {
    return NextResponse.json({ error: "Document no vàlid." }, { status: 400 });
  }
  const roundtripBaseEtag = roundtripDocumentId ? parseIfMatch(request.headers.get("If-Match")) : null;
  if (roundtripDocumentId && !roundtripBaseEtag) {
    return NextResponse.json({ error: "Cal indicar la versió base abans de desar.", code: "DOCUMENT_VERSION_BASE_REQUIRED" }, { status: 428 });
  }

  try {
    const installation = await loadInstallationConfig();
    if (session.provider !== "local" || session.tenant.id !== installation.installationId) {
      return NextResponse.json({ error: "La sessió no pertany a aquesta instal·lació." }, { status: 403 });
    }
    const existingResource = roundtripDocumentId
      ? await resolveThreadLibraryResource(session, {
          kind: "upload",
          resourceId: roundtripDocumentId,
          threadId,
        })
      : null;
    const threadAccess = existingResource?.access ?? await resolveThreadAccess(session, threadId);
    assertLibraryResourceWritable(threadAccess);
    const runtimeContext = { projectId: threadAccess.project.id };
    const storageOwnerId = existingResource?.location.storageOwnerId ?? session.user.id;
    const services = await documentServicesForUser(installation, storageOwnerId);
    if (roundtripDocumentId && roundtripBaseEtag) {
      const current = await services.versions.read(threadId, roundtripDocumentId);
      const currentEtag = current.versions.at(-1)!.etag;
      if (currentEtag !== roundtripBaseEtag) {
        return NextResponse.json({
          error: "El document ha canviat. Recarrega l’historial abans de pujar una altra versió.",
          code: "DOCUMENT_VERSION_CONFLICT",
        }, { status: 409, headers: { ETag: quotedDocumentEtag(currentEtag), "Cache-Control": "private, no-store" } });
      }
    }
    return await services.storageGate.run(async () => {
      let parsedUpload: ParsedDocumentUpload | null = null;
      try {
        parsedUpload = await parseStreamingDocumentUpload(
          request,
          services.staging.rootDirectory,
          services.locks,
        );
        if (!isUuid(parsedUpload.uploadId)) {
          throw new UploadValidationError("UPLOAD_MULTIPART_CONTRACT_INVALID", "uploadId must be a UUID.");
        }
        const uploadId = parsedUpload.uploadId;
        const uploadSource = {
          fileName: parsedUpload.fileName,
          declaredMimeType: parsedUpload.declaredMimeType,
          filePath: parsedUpload.temporaryPath,
        };
        const legacy = path.extname(parsedUpload.fileName).toLowerCase() === ".xlsm"
          ? await stageMacroExcelUpload({ ...uploadSource, threadId, uploadId, size: parsedUpload.size }, {
              conversionGate: services.conversionGate, signal: request.signal, locks: services.locks, staging: services.staging, originals: services.legacyOriginals,
            })
          : path.extname(parsedUpload.fileName).toLowerCase() === ".xls"
          ? await stageLegacyExcelUpload({ ...uploadSource, threadId, uploadId, size: parsedUpload.size }, {
              reader: services.passiveXlsReader, soffice: services.toolchain.soffice,
              conversionGate: services.conversionGate, signal: request.signal,
              locks: services.locks, staging: services.staging, originals: services.legacyOriginals,
            })
          : null;
        const validated = legacy ? null : await validateUploadedDocumentFile(uploadSource);
        if (validated && validated.size !== parsedUpload.size) {
          throw new UploadValidationError("UPLOAD_SOURCE_CHANGED", "Upload size changed before validation.");
        }
        const document = legacy ?? await services.staging.stageFile({
          threadId,
          uploadId,
          validated: validated!,
          sourcePath: parsedUpload.temporaryPath,
        });
        if (document.storedLegacyExcel) operationalLogger.warn("document.xls_processing_unavailable", { status: "original_stored" });
        let preview: Awaited<ReturnType<typeof services.previews.create>> | null = null;
        try {
          preview = await services.previews.create(document, { signal: request.signal });
        } catch (error) {
          // A rendering failure does not undo an accepted XLS. Preserve identity,
          // cancellation and integrity errors; report optional preview availability.
          if (!legacy || request.signal.aborted || (error instanceof StorageError &&
              !["DOCUMENT_PREVIEW_TOO_LARGE", "DOCUMENT_PDF_UNSAFE", "DOCUMENT_CONVERSION_BACKPRESSURE"].includes(error.code))) throw error;
          operationalLogger.warn("document.xls_preview_unavailable", { status: "original_stored" });
        }
        if (roundtripDocumentId && roundtripBaseEtag) {
          return documentVersionJson(await services.versions.appendUpload({
            threadId,
            documentId: roundtripDocumentId,
            versionId: uploadId,
            baseEtag: roundtripBaseEtag,
            document,
            author: { userId: session.user.id, name: session.user.name },
          }), 201);
        }
        await services.versions.create({
          threadId,
          documentId: uploadId,
          document,
          author: { userId: session.user.id, name: session.user.name },
          scope: { kind: "project", id: runtimeContext.projectId },
        });
        await resourceLocationIndexForInstallation(installation).register({
          kind: "upload",
          resourceId: uploadId,
          projectId: runtimeContext.projectId,
          threadId,
          messageId: null,
          storageOwnerId,
          relativePath: document.relativePath,
          fileName: document.fileName,
          mediaType: document.mediaType,
          size: document.size,
          sha256: document.sha256,
        });
        return NextResponse.json({
          document,
          ...(legacy ? { originalStored: true } : {}),
          preview: preview ? {
            ...preview,
            files: preview.files.map((name) => ({
              name,
              url: `/api/threads/${threadId}/documents/${uploadId}/preview/${encodeURIComponent(name)}`,
            })),
          } : {
            schemaVersion: 2, uploadId, threadId, sourceSha256: document.sha256,
            status: "unavailable", kind: document.kind, files: [], artifacts: [], pages: null, createdAt: document.createdAt,
          },
        }, { status: 201 });
      } finally {
        await parsedUpload?.dispose();
      }
    }, { signal: request.signal });
  } catch (error) {
    if (!(error instanceof UploadValidationError) && !(error instanceof StorageError)) {
      const resourceError = libraryResourceErrorResponse(error, "Documento no encontrado.");
      if (resourceError) return resourceError;
      return workbenchErrorResponse(error, "No s’ha pogut verificar el fil del document.");
    }
    return documentErrorResponse(error);
  }
}
