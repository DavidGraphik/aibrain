import type { ChatAttachment } from "@/lib/chat-contract";
import { parseLegacyExcelProvenance, parseStoredLegacyExcelReceipt, type LegacyExcelProvenance, type StoredLegacyExcelReceipt } from "@/documents/legacy-excel-policy";

export type DocumentUploadKind = "docx" | "xlsx" | "xls" | "pptx" | "pdf" | "text" | "image" | "audio";

export type StagedComposerDocument = ChatAttachment & {
  uploadId: string;
  threadId: string;
  kind: DocumentUploadKind;
  previewFiles: Array<{ name: string; url: string }>;
  pages: number | null;
  status: "uploading" | "ready" | "error";
  error: string | null;
  passive?: boolean;
  processingUnavailable?: boolean;
  previewUnavailable?: boolean;
};

type DocumentUploadResponse = {
  originalStored?: true;
  document: {
    uploadId: string;
    threadId: string;
    fileName: string;
    kind: DocumentUploadKind;
    mediaType: string;
    size: number;
    status: "staged";
    legacyExcel?: LegacyExcelProvenance;
    storedLegacyExcel?: StoredLegacyExcelReceipt;
  };
  preview: {
    uploadId: string;
    threadId: string;
    status: "ready" | "unavailable";
    kind: DocumentUploadKind;
    files: Array<{ name: string; url: string }>;
    pages: number | null;
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS = new Set<DocumentUploadKind>(["docx", "xlsx", "xls", "pptx", "pdf", "text", "image", "audio"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isDocumentUploadKind(value: unknown): value is DocumentUploadKind {
  return typeof value === "string" && KINDS.has(value as DocumentUploadKind);
}

export function parseDocumentUploadResponse(value: unknown): DocumentUploadResponse | null {
  const root = record(value);
  const document = record(root?.document);
  const preview = record(root?.preview);
  const unavailable = root?.originalStored === true && preview?.status === "unavailable";
  if (!document || !preview || !UUID.test(String(document.uploadId)) ||
      document.uploadId !== preview.uploadId || document.threadId !== preview.threadId ||
      typeof document.threadId !== "string" || !UUID.test(document.threadId) ||
      typeof document.fileName !== "string" || document.fileName.length < 1 || document.fileName.length > 120 ||
      !isDocumentUploadKind(document.kind) || document.kind !== preview.kind ||
      typeof document.mediaType !== "string" || document.mediaType.length < 1 || document.mediaType.length > 180 ||
      !Number.isSafeInteger(document.size) || Number(document.size) < 1 || Number(document.size) > 50 * 1024 * 1024 ||
      document.status !== "staged" || (!unavailable && preview.status !== "ready") || !Array.isArray(preview.files) ||
      (unavailable ? preview.files.length !== 0 || preview.pages !== null : preview.files.length < 1 || preview.files.length > 2) ||
      !(preview.pages === null || (Number.isSafeInteger(preview.pages) && Number(preview.pages) >= 1 && Number(preview.pages) <= 500))) {
    return null;
  }
  const expectedPrefix = `/api/threads/${document.threadId}/documents/${document.uploadId}/preview/`;
  const files = preview.files.map((value) => record(value));
  if (files.some((file) => !file || typeof file.name !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(file.name) ||
      typeof file.url !== "string" || !file.url.startsWith(expectedPrefix) ||
      file.url !== `${expectedPrefix}${encodeURIComponent(file.name)}`)) return null;
  let legacyExcel: LegacyExcelProvenance | undefined;
  let storedLegacyExcel: StoredLegacyExcelReceipt | undefined;
  if (document.storedLegacyExcel !== undefined) {
    try {
      if (document.legacyExcel !== undefined || document.kind !== "text" || document.mediaType !== "text/plain" || !document.fileName.endsWith(".xls-status.txt")) return null;
      storedLegacyExcel = parseStoredLegacyExcelReceipt(document.storedLegacyExcel);
    } catch { return null; }
  }
  if (document.legacyExcel !== undefined) {
    try {
      if (document.kind !== "xlsx" || !document.fileName.endsWith(".passive.xlsx")) return null;
      legacyExcel = parseLegacyExcelProvenance(document.legacyExcel);
    } catch { return null; }
  }
  return {
    ...(root?.originalStored === true ? { originalStored: true } : {}),
    document: {
      uploadId: document.uploadId as string,
      threadId: document.threadId,
      fileName: document.fileName,
      kind: document.kind,
      mediaType: document.mediaType,
      size: Number(document.size),
      status: "staged",
      ...(legacyExcel ? { legacyExcel } : {}),
      ...(storedLegacyExcel ? { storedLegacyExcel } : {}),
    },
    preview: {
      uploadId: preview.uploadId as string,
      threadId: preview.threadId as string,
      status: unavailable ? "unavailable" : "ready",
      kind: preview.kind as DocumentUploadKind,
      files: files.map((file) => ({ name: file!.name as string, url: file!.url as string })),
      pages: preview.pages as number | null,
    },
  };
}

async function responseError(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  const parsed = record(body);
  const message = typeof parsed?.error === "string"
    ? parsed.error
    : "No se ha podido preparar el documento.";
  const retryAfter = response.headers.get("Retry-After");
  return response.status === 429 && retryAfter
    ? `${message} Reinténtalo en ${retryAfter} s.`
    : message;
}

export async function stageDocument(
  threadId: string,
  file: File,
  uploadId: string,
  signal?: AbortSignal,
) {
  const body = new FormData();
  body.set("uploadId", uploadId);
  body.set("file", file);
  const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/documents`, {
    method: "POST",
    body,
    signal,
  });
  if (!response.ok) throw new Error(await responseError(response));
  const parsed = parseDocumentUploadResponse(await response.json().catch(() => null));
  if (!parsed || parsed.document.uploadId !== uploadId || parsed.document.threadId !== threadId) {
    throw new Error("La respuesta del documento no cumple el contrato seguro.");
  }
  return parsed;
}
