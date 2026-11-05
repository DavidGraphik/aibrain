import { currentThreadToolsetRevision } from "./thread-token";

export function runtimeThreadIdForChatMessage(
  context: { threadId: string; toolsetRevision: string | null } | null,
  _message: string,
  installationId?: string,
) {
  if (!context) return null;
  // Dynamic tools are immutable per runtime thread. The chat route carries
  // durable conversation history into a fresh runtime when the catalog changes.
  // All follow-ups must upgrade, including legacy create-only Trinalum threads:
  // a keyword cannot determine whether their fixed tools/guidance are safe.
  return context.toolsetRevision === currentThreadToolsetRevision(installationId) ? context.threadId : null;
}
