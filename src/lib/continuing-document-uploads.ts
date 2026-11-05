import type { ChatMessage } from "./chat-contract";
import { MAX_FILES_PER_MESSAGE } from "./chat-attachment-limits";

const documentTypes = new Set([
  "application/pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain", "text/csv",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keep the latest original batch available when continuing its conversation.
// These are references, never filesystem paths or assistant-generated files.
// The server rechecks every staging ID against the authenticated actor, this
// exact thread and the current documents.read policy on every turn.
export function continuingDocumentUploads(messages: readonly (Pick<ChatMessage, "role" | "attachments"> & Partial<Pick<ChatMessage, "createdAt">>)[], notBefore?: string): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (notBefore && (!message.createdAt || message.createdAt < notBefore)) continue;
    if (message.role !== "user" || !message.attachments.length) continue;
    const ids = message.attachments.filter(a => documentTypes.has(a.mimeType) && uuid.test(a.id)).map(a => a.id);
    return [...new Set(ids)].slice(0, MAX_FILES_PER_MESSAGE);
  }
  return [];
}
