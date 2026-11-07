import { StorageError } from "@/storage";
import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { loadInstallationConfig } from "@/config/installation";
import { resolveProjectAccess } from "@/workbench/shared-access";
import { workbenchErrorResponse } from "@/workbench/http";
import { isUuid, type ProjectSource } from "@/workbench/types";
import { parseStreamingDocumentUpload } from "@/documents/multipart-upload";
import { validateUploadedDocumentFile, UploadValidationError } from "@/documents/upload-validation";
import { documentServicesForUser } from "@/documents/server-service";
import { stageMacroExcelUpload } from "@/documents/macro-excel-upload";
import { projectSourceStore } from "@/documents/project-sources";
import { DocumentStorageFullError, FileDocumentStorageGate } from "@/documents/storage-gate";
import path from "node:path";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  if (!await isSameOriginMutation(request)) return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const { projectId } = await context.params;
  if (!isUuid(projectId)) return NextResponse.json({ error: "Projecte no vàlid." }, { status: 400 });
  try {
    const access = await resolveProjectAccess(session, projectId);
    if (access.role === "viewer") return NextResponse.json({ error: "No puedes editar las referencias de este proyecto." }, { status: 403 });
    const config = await loadInstallationConfig();
    const { staging, locks } = projectSourceStore(config, access.ownerUserId);
    const gate = new FileDocumentStorageGate({ rootDirectory: path.join(config.paths.dataRoot, "locks", "document-storage"),
      capacityDirectories: [staging.rootDirectory, path.join(config.paths.dataRoot, "server", "legacy-excel-originals", access.ownerUserId)], });
    return await gate.run(async () => {
      const upload = await parseStreamingDocumentUpload(request, staging.rootDirectory, locks);
      try {
        if (!isUuid(upload.uploadId) || upload.size > 20_000_000) throw new UploadValidationError("UPLOAD_SIZE_INVALID", "Archivo demasiado grande.");
        const services = path.extname(upload.fileName).toLowerCase() === ".xlsm" ? await documentServicesForUser(config, access.ownerUserId) : null;
        const macro = path.extname(upload.fileName).toLowerCase() === ".xlsm"
          ? await stageMacroExcelUpload({ filePath: upload.temporaryPath, fileName: upload.fileName, declaredMimeType: upload.declaredMimeType, size: upload.size, threadId: projectId, uploadId: upload.uploadId }, { conversionGate: services!.conversionGate, staging, originals: services!.legacyOriginals, locks, signal: request.signal })
          : null;
        const validated = macro ? null : await validateUploadedDocumentFile({ filePath: upload.temporaryPath, fileName: upload.fileName, declaredMimeType: upload.declaredMimeType });
        if (!["xlsx", "pdf", "docx", "pptx", "text"].includes((macro ?? validated)!.kind)) {
          return NextResponse.json({ error: "Usa XLSX, PDF, DOCX, PPTX o un archivo de texto para las referencias." }, { status: 400 });
        }
        const doc = macro ?? await staging.stageFile({ threadId: projectId, uploadId: upload.uploadId, validated: validated!, sourcePath: upload.temporaryPath });
        const source: ProjectSource = { id: doc.uploadId, kind: "file", name: doc.fileName, url: null,
          mimeType: doc.mediaType, size: doc.size, excerpt: null, status: "ready", createdAt: doc.createdAt };
        return NextResponse.json({ source }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
      } finally { await upload.dispose(); }
    });
  } catch (error) {
    if (error instanceof StorageError && error.code === "DOCUMENT_STORAGE_CAPACITY_UNAVAILABLE") return NextResponse.json({ error: "No se ha podido medir el espacio para guardar el archivo. La carga no ha comenzado.", code: error.code }, { status: 503 });
    if (error instanceof StorageError && error.code === "DOCUMENT_STORAGE_CAPACITY_LOW") return NextResponse.json({ error: "Se necesita al menos 1 GB libre para admitir adjuntos. La carga no ha comenzado.", code: error.code }, { status: 507 });
    if (error instanceof DocumentStorageFullError) return NextResponse.json({ error: "El disco no ha podido guardar el archivo porque no tiene espacio disponible. La carga no se ha completado.", code: error.code }, { status: 507 });
    if (error instanceof UploadValidationError) return NextResponse.json({ error: "No se ha podido guardar el archivo. Comprueba el formato y el límite de 20 MB.", code: error.code }, { status: 400 });
    return workbenchErrorResponse(error, "No se ha podido guardar la referencia.");
  }
}
