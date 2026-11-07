import type { ChatMessage, GeneratedArtifact } from "@/lib/chat-contract";

/** Only a server-labelled, immutable source copy can accompany a quiet review.
 * Unknown/legacy artifacts and every generated or published document stay visible. */
function readSource(artifact: GeneratedArtifact, threadId: string) {
  return artifact.type === "document" && artifact.provenance === "source-read" &&
    artifact.url === `/api/threads/${threadId}/connector-files/${artifact.id}` &&
    artifact.status === "ready" && artifact.error === null &&
    artifact.publicationStatus === null && artifact.publicationError === null && artifact.targetLabel === null;
}

export function automationResultNeedsReview(result: ChatMessage, threadId: string) {
  return Boolean(result.approvals.length || result.artifacts?.some(item => !readSource(item, threadId)) ||
    result.toolResults?.some(item => item.status !== "complete"));
}
