import "server-only";
import type { AuthSession } from "@/auth/types";
import type { InstallationConfig } from "@/config/installation-schema";
import { resourceLocationIndexForInstallation } from "@/library/server-resource-access";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import { conversationReferenceUrl } from "@/workbench/conversation-reference";
import { operationalLogger } from "@/operations/server-logger";
import { isUuid } from "@/workbench/types";

/** Discovery metadata only. Existing attachment tools must verify message membership and original access. */
async function loadCurrentProjectUploadCatalog(
  installation: Readonly<InstallationConfig>, session: AuthSession | undefined, projectId: string, threadId: string,
) {
  if (!session || session.provider !== "local" || session.tenant.id !== installation.installationId ||
      !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now() ||
      ![session.user.id, projectId, threadId].every(isUuid)) return null;
  const store = FileWorkbenchStore.fromInstallation(installation);
  const scope = async () => {
    if (Date.parse(session.expiresAt) <= Date.now()) return null;
    const own = await store.loadAccessSnapshot(session.user.id);
    const project = own.projects.find(project => project.id === projectId);
    if (!project || project.status !== "active" || project.sharing.visibility !== "private" || project.sharing.members.length ||
        !own.threads.some(thread => thread.id === threadId && thread.projectId === projectId && thread.status === "active")) return null;
    return new Set(own.threads.filter(thread => thread.projectId === projectId && (thread.status === "active" || thread.status === "archived")).map(thread => thread.id));
  };
  if (!await scope()) return null;
  const indexed = await resourceLocationIndexForInstallation(installation).listForProjects(new Set([projectId]), "upload");
  const threads = await scope();
  if (!threads) return null;
  const uploads = indexed.filter(resource => resource.kind === "upload" && resource.storageOwnerId === session.user.id &&
    resource.projectId === projectId && threads.has(resource.threadId))
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.resourceId.localeCompare(b.resourceId));
  return {
    untrustedData: true, scope: "own-current-private-project-uploads", metadataOnly: true,
    messageMembershipVerified: false, readPermissionGranted: false,
    totalCount: uploads.length, truncated: uploads.length > 20,
    uploads: uploads.slice(0, 20).map(resource => ({
      fileName: resource.fileName, mediaType: resource.mediaType, bytes: resource.size,
      chatReference: conversationReferenceUrl(resource.threadId),
    })),
  };
}

/** Optional discovery must never make an otherwise valid chat unavailable. */
export async function currentProjectUploadCatalog(...args: Parameters<typeof loadCurrentProjectUploadCatalog>) {
  try { return await loadCurrentProjectUploadCatalog(...args); }
  catch {
    try { operationalLogger.warn("documents.project_upload_catalog_unavailable", { installationId: args[0].installationId }); }
    catch { /* An optional metadata warning cannot fail the user's turn either. */ }
    return null;
  }
}

export function projectUploadCatalogContext(catalog: Awaited<ReturnType<typeof currentProjectUploadCatalog>>) {
  if (!catalog) return "";
  const json = JSON.stringify(catalog).replace(/[<>\u2028\u2029]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `BEGIN UNTRUSTED CURRENT PROJECT UPLOAD METADATA JSON\n${json}\nEND UNTRUSTED CURRENT PROJECT UPLOAD METADATA JSON`;
}
