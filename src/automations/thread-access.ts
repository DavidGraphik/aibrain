import "server-only";

import type { AuthSession } from "@/auth/types";
import { FileAutomationAudienceStore, type AutomationThreadDelivery } from "@/automations/audience-store";
import { automationTaskAccess, automationWorkspaceForSession } from "@/automations/server-service";
import { AutomationStoreError, FileAutomationStore } from "@/automations/store";
import { loadInstallationConfig } from "@/config/installation";
import type { AutomationTask } from "@/automations/contracts";

async function audienceStoreForSession(session: AuthSession) {
  const installation = await loadInstallationConfig();
  if (session.provider !== "local" || session.tenant.id !== installation.installationId) return null;
  return new FileAutomationAudienceStore({
    installationId: installation.installationId,
    dataRoot: installation.paths.dataRoot,
  });
}

function authorizeTaskDelivery(
  delivery: AutomationThreadDelivery,
  task: AutomationTask,
  context: Awaited<ReturnType<typeof automationWorkspaceForSession>>,
) {
  if (task.id !== delivery.taskId || task.userId !== delivery.ownerUserId || task.projectId !== delivery.projectId ||
    task.installationId !== context.installation.installationId) return null;
  const access = automationTaskAccess(task, context.principal.userId, context, context.isAdmin);
  return access.canViewResults ? { delivery, task } : null;
}

async function authorizedDelivery(
  delivery: AutomationThreadDelivery,
  context: Awaited<ReturnType<typeof automationWorkspaceForSession>>,
) {
  if (!context.users.some(({ userId }) => userId === delivery.ownerUserId)) return null;
  const store = new FileAutomationStore({
    installationId: context.installation.installationId,
    userId: delivery.ownerUserId,
    usersRoot: context.installation.paths.usersRoot,
  });
  try {
    const task = await store.get(delivery.taskId, { includeDeleted: true });
    return authorizeTaskDelivery(delivery, task, context);
  } catch (error) {
    if (error instanceof AutomationStoreError && error.code === "AUTOMATION_NOT_FOUND") return null;
    throw error;
  }
}

export async function resolveAutomationThreadAccess(session: AuthSession, threadId: string) {
  const audienceStore = await audienceStoreForSession(session);
  if (!audienceStore) return null;
  const delivery = await audienceStore.findByThread(threadId);
  if (!delivery) return null;
  return resolveAutomationDeliveryAccess(session, delivery);
}

/** Internal fresh-delivery resolver: task, user and group policy are re-read. */
export async function resolveAutomationDeliveryAccess(session: AuthSession, delivery: AutomationThreadDelivery, readOnly = false) {
  const context = await automationWorkspaceForSession(session, readOnly);
  const authorized = await authorizedDelivery(delivery, context);
  return authorized ? { ...authorized, context } : null;
}

export async function listAutomationThreadAccess(session: AuthSession) {
  const audienceStore = await audienceStoreForSession(session);
  if (!audienceStore) return [];
  const deliveries = await audienceStore.list();
  if (deliveries.length === 0) return [];
  const context = await automationWorkspaceForSession(session);
  const knownUserIds = new Set(context.users.map(({ userId }) => userId));
  const byOwner = Map.groupBy(deliveries.filter(({ ownerUserId }) => knownUserIds.has(ownerUserId)), ({ ownerUserId }) => ownerUserId);
  const authorized = await Promise.all([...byOwner].map(async ([ownerUserId, ownerDeliveries]) => {
    const tasks = await new FileAutomationStore({
      installationId: context.installation.installationId,
      userId: ownerUserId,
      usersRoot: context.installation.paths.usersRoot,
    }).list({ includeDeleted: true });
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    return ownerDeliveries.flatMap((delivery) => {
      const task = tasksById.get(delivery.taskId);
      const value = task ? authorizeTaskDelivery(delivery, task, context) : null;
      return value ? [value] : [];
    });
  }));
  return [...new Map(authorized.flat().map(item=>[item.delivery.threadId,item])).values()];
}


/** Only the generated response of an explicitly quiet delivered run is suppressed.
 * Authorize the current task/audience again; human messages are never selected. */
export async function quietAutomationResultMessageIds(session:AuthSession) {
  const audienceStore=await audienceStoreForSession(session);if(!audienceStore)return [];
  const quiet=await audienceStore.listQuiet();if(!quiet.length)return [];
  const context=await automationWorkspaceForSession(session);
  const {automationRunIdentities,isAutomationResultThread}=await import("./run-identities");
  const authorized=await Promise.all(quiet.map(item=>authorizedDelivery(item,context)));
  return authorized.flatMap(item=>item&&isAutomationResultThread(item.task,item.delivery.runKey,item.delivery.threadId)?[{threadId:item.delivery.threadId,messageId:automationRunIdentities(item.delivery.runKey).assistantMessageId}]:[]);
}
