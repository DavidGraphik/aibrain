import { createHash } from "node:crypto";
import type { documentServicesForUser } from "@/documents/server-service";
import { validateUploadedDocument } from "@/documents/upload-validation";
import { StorageError } from "@/storage";

type DocumentServices = Awaited<ReturnType<typeof documentServicesForUser>>;

function deterministicUuid(value: string) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function prepareWorkspaceDocumentPreview(input: {
  services: DocumentServices;
  projectId: string;
  relativePath: string;
  fileName: string;
  declaredMimeType: string;
  data: Buffer;
  signal?: AbortSignal;
}) {
  const validated = validateUploadedDocument({
    fileName: input.fileName,
    declaredMimeType: input.declaredMimeType,
    data: input.data,
  });
  if (validated.kind !== "docx" && validated.kind !== "xlsx" && validated.kind !== "xls" && validated.kind !== "pptx" && validated.kind !== "pdf") {
    throw new StorageError("WORKSPACE_DOCUMENT_TYPE_INVALID", "Workspace document is not an Office or PDF file.");
  }
  const threadId = deterministicUuid(`workspace-preview-thread\0${input.projectId}`);
  const uploadId = deterministicUuid(
    `workspace-preview-upload\0${input.projectId}\0${input.relativePath}\0${validated.sha256}${validated.kind === "xlsx" ? "\0whole-sheet-v1" : ""}`,
  );
  const staged = await input.services.staging.stage({
    threadId,
    uploadId,
    validated,
    data: input.data,
  });
  const preview = await input.services.previews.create(staged, { signal: input.signal });
  if (!preview.files.includes("document.pdf")) {
    throw new StorageError("WORKSPACE_DOCUMENT_PREVIEW_INVALID", "Workspace document did not produce a PDF representation.");
  }
  return {
    validated,
    data: await input.services.previews.readFile(threadId, uploadId, "document.pdf"),
    pages: preview.pages,
    threadId,
    uploadId,
  };
}

export async function prepareWorkspaceDocumentPage(input: {
  services: DocumentServices;
  projectId: string;
  relativePath: string;
  fileName: string;
  declaredMimeType: string;
  data: Buffer;
  page: number;
  signal?: AbortSignal;
}) {
  const preview = await prepareWorkspaceDocumentPreview(input);
  if (preview.pages === null || input.page > preview.pages) {
    throw new StorageError("DOCUMENT_PREVIEW_PAGE_INVALID", "Workspace document page does not exist.");
  }
  return {
    data: await input.services.previews.renderPage(preview.threadId, preview.uploadId, input.page, { signal: input.signal }),
    pages: preview.pages,
  };
}
