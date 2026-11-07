import "server-only";
import type { AuthSession } from "@/auth/types";
import { getThread } from "@/workbench/store";
import { isUuid } from "@/workbench/types";
import { WorkbenchNotFoundError } from "@/workbench/errors";

/** Presentation reference, NOT a capability or a secret. Never grants access.
 * Avoids exposing internal UUIDs or requiring a broad display-redaction bypass.
 * Call only for metadata already resolved through the authenticated store. */
export function conversationReferenceUrl(threadId: string) {
  if (!isUuid(threadId)) throw new WorkbenchNotFoundError();
  return `/conversations/${Buffer.from(threadId.replaceAll("-", ""), "hex").toString("base64url")}`;
}

export async function readConversationReference(session: AuthSession, reference: string) {
  if (session.provider !== "local" || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now() ||
      !/^[A-Za-z0-9_-]{22}$/.test(reference)) throw new WorkbenchNotFoundError();
  const bytes = Buffer.from(reference, "base64url");
  if (bytes.length !== 16 || bytes.toString("base64url") !== reference) throw new WorkbenchNotFoundError();
  const hex = bytes.toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!isUuid(id)) throw new WorkbenchNotFoundError();
  // Resolve on EVERY open: the URL is not proof of ownership/sharing. Existing
  // store checks also reject foreign users/tenants before reading their data.
  return getThread(session, id);
}
