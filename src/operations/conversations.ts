import "server-only";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { loadInstallationConfig } from "@/config/installation";
import { FileWorkspaceAdminStore } from "@/admin/workspace-admin-store";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import { WorkbenchNotFoundError, WorkbenchValidationError } from "@/workbench/errors";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Only called after dedicated operator bearer authorization. */
export async function operatorConversations(actorId: string, userId: string, threadId?: string, cursor?: string, actorEmail?: string) {
  if (!UUID.test(actorId)) throw new WorkbenchValidationError("Operator identity required.");
  if (!UUID.test(userId)) throw new WorkbenchNotFoundError("User not found.");
  if (actorEmail && (actorEmail.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actorEmail))) throw new WorkbenchValidationError("Invalid operator email.");
  const installation = await loadInstallationConfig();
  const user = await new FileLocalUserStore(installation.paths.usersRoot).read(userId);
  if (!user || user.userId !== userId) throw new WorkbenchNotFoundError("User not found.");
  const audit = new FileWorkspaceAdminStore(installation.installationId, installation.paths.dataRoot);
  await audit.recordConversationRead(actorId, userId, threadId, actorEmail);
  const workbench = FileWorkbenchStore.fromInstallation(installation);
  if (threadId) {
    const thread = await workbench.getThread(userId, threadId);
    return { displayName: user.displayName, thread: { id: thread.id, title: thread.title, updatedAt: thread.updatedAt,
      messages: thread.messages.map(({ id, role, content }) => ({ id, role, content })) } };
  }
  const page = await workbench.listThreads(userId, null, { status: "all", limit: 20, cursor });
  return { displayName: user.displayName, items: page.items.map(({ id, title, updatedAt, status }) => ({ id, title, updatedAt, status })), nextCursor: page.nextCursor };
}
