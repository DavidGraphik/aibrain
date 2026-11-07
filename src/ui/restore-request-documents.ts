import type { ChatAttachment } from "@/lib/chat-contract";
import type { StagedComposerDocument, DocumentUploadKind } from "@/ui/document-ui-adapter";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS = new Set<DocumentUploadKind>(["docx", "xlsx", "xls", "pptx", "pdf", "text", "image", "audio"]);
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Reuse the original staged upload; never silently substitute a newer version. */
export async function restoreRequestDocument(threadId: string, attachment: ChatAttachment, signal: AbortSignal): Promise<StagedComposerDocument> {
  const unavailable: StagedComposerDocument = {
    ...attachment, uploadId: attachment.id, threadId, kind: attachment.mimeType.startsWith("image/") ? "image" : "text",
    previewFiles: [], pages: null, status: "error", error: "Vuelve a adjuntar este archivo o quítalo para continuar.",
  };
  if (!UUID.test(threadId) || !UUID.test(attachment.id)) return unavailable;
  try {
    const prefix = `/api/threads/${threadId}/documents/${attachment.id}`;
    const response = await fetch(prefix, { cache: "no-store", credentials: "same-origin", signal });
    if (!response.ok) return unavailable;
    const document = record(record(await response.json())?.document);
    if (!document || document.threadId !== threadId || document.documentId !== attachment.id ||
        typeof document.originalVersionId !== "string" || !UUID.test(document.originalVersionId) || !Array.isArray(document.versions)) return unavailable;
    const original = document.versions.map(record).find((version) => version?.versionId === document.originalVersionId);
    if (!original || original.fileName !== attachment.name || original.mediaType !== attachment.mimeType || original.size !== attachment.size ||
        typeof original.kind !== "string" || !KINDS.has(original.kind as DocumentUploadKind) ||
        typeof original.previewUrl !== "string") return unavailable;
    const previewPrefix = `${prefix}/versions/${document.originalVersionId}/preview/`;
    if (!original.previewUrl.startsWith(previewPrefix) || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(original.previewUrl.slice(previewPrefix.length))) return unavailable;
    return { ...unavailable, kind: original.kind as DocumentUploadKind, status: "ready", error: null,
      passive: typeof original.fileName === "string" && original.fileName.endsWith(".passive.xlsx"),
      previewFiles: [{ name: original.previewUrl.slice(previewPrefix.length), url: original.previewUrl }] };
  } catch (error) {
    if (signal.aborted) throw error;
    return unavailable;
  }
}
