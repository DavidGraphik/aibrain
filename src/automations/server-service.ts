import "server-only";
import { assertNewAutomationEffectGrant } from "@/automations/effect-grant";

import { readdir } from "node:fs/promises";
import type { WorkspaceAdminState } from "@/admin/contracts";
import { effectiveWorkspacePolicy, FileWorkspaceAdminStore } from "@/admin/workspace-admin-store";
import type { AuthSession } from "@/auth/types";
import { FileLocalUserStore, type LocalUser } from "@/auth/local-user-store";
import type {
  AutomationAudience,
  AutomationAudienceDirectory,
  AutomationTask,
  AutomationTaskInput,
  AutomationTaskPatch,
  AutomationTaskView,
} from "@/automations/contracts";
import {
  canonicalAutomationUsers,
  canonicalizeAutomationAudience,
  invalidAutomationAudienceTargets,
  resolveCurrentAutomationAudience,
} from "@/automations/audience-policy";
import { AutomationStoreError, FileAutomationStore } from "@/automations/store";
import { loadInstallationConfig } from "@/config/installation";
import type { InstallationConfig } from "@/config/installation-schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class AutomationAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "AutomationAccessError";
  }
}

async function localUsers(usersRoot: string) {
  const store = new FileLocalUserStore(usersRoot);
  const entries = await readdir(usersRoot, { withFileTypes: true });
  const values = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && UUID.test(entry.name))
    .map((entry) => store.read(entry.name)));
  return values.filter((user): user is LocalUser => user !== null)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export type AutomationWorkspaceContext = {
  installation: Readonly<InstallationConfig>;
  users: LocalUser[];
  state: WorkspaceAdminState;
};

export async function automationWorkspaceContext(
  installation?: Readonly<InstallationConfig>,
  readOnly = false,
): Promise<AutomationWorkspaceContext> {
  installation ??= await loadInstallationConfig();
  const users = await localUsers(installation.paths.usersRoot);
  const store = new FileWorkspaceAdminStore(installation.installationId, installation.paths.dataRoot);
  const ids = users.map(({ userId }) => userId);
  const state = await (readOnly ? store.readCurrent(ids) : store.read(ids));
  return { installation, users, state };
}

export async function automationWorkspaceForSession(session: AuthSession, readOnly = false) {
  if (session.provider !== "local") {
    throw new AutomationAccessError("AUTOMATION_LOCAL_SESSION_REQUIRED", "Las automatizaciones requieren una cuenta local persistente.", 403);
  }
  const workspace = await automationWorkspaceContext(undefined, readOnly);
  if (session.tenant.id !== workspace.installation.installationId) {
    throw new AutomationAccessError("AUTOMATION_TENANT_MISMATCH", "La sesión no pertenece a esta instalación.", 403);
  }
  const principal = workspace.users.find(({ userId }) => userId === session.user.id);
  if (!principal || !principal.enabled || principal.email !== session.user.email.toLocaleLowerCase()) {
    throw new AutomationAccessError("AUTOMATION_MEMBER_NOT_FOUND", "La cuenta no está habilitada en esta instalación.", 403);
  }
  const role = effectiveWorkspacePolicy(workspace.state, principal.userId).role;
  return { ...workspace, principal, isAdmin: role.canManageWorkspace };
}

function storeForOwner(workspace: AutomationWorkspaceContext, ownerUserId: string) {
  return new FileAutomationStore({
    installationId: workspace.installation.installationId,
    userId: ownerUserId,
    usersRoot: workspace.installation.paths.usersRoot,
  });
}

export function validateAutomationAudience(
  audience: AutomationAudience,
  workspace: AutomationWorkspaceContext,
  preferredUserId?: string,
) {
  const invalid = invalidAutomationAudienceTargets(audience, workspace.users, workspace.state.groups);
  if (invalid.userIds.length || invalid.groupIds.length) {
    throw new AutomationAccessError(
      "AUTOMATION_AUDIENCE_INVALID",
      "La audiencia contiene usuarios desactivados o destinatarios ajenos a esta empresa.",
      400,
    );
  }
  return canonicalizeAutomationAudience(audience, workspace.users, preferredUserId);
}

export function automationTaskAccess(
  task: AutomationTask,
  principalUserId: string,
  workspace: AutomationWorkspaceContext,
  isAdmin: boolean,
) {
  const canViewResults = isAdmin || resolveCurrentAutomationAudience(
    task.audience,
    workspace.users,
    workspace.state.groups,
  ).has(principalUserId);
  return {
    canManage: isAdmin || task.userId === principalUserId,
    canViewResults,
  };
}

async function allTasks(workspace: AutomationWorkspaceContext) {
  return (await Promise.all(workspace.users.map((user) => storeForOwner(workspace, user.userId).list()))).flat();
}

export function visibleAutomationTasks(
  tasks: readonly AutomationTask[],
  principalUserId: string,
  workspace: AutomationWorkspaceContext,
  isAdmin: boolean,
) {
  return tasks.flatMap((task): AutomationTaskView[] => {
    const access = automationTaskAccess(task, principalUserId, workspace, isAdmin);
    return access.canManage || access.canViewResults ? [{
      ...task,
      owner: {
        userId: task.userId,
        name: workspace.users.find(({ userId }) => userId === task.userId)?.displayName ?? "Usuario no disponible",
      },
      access,
    }] : [];
  });
}

async function locateTask(workspace: AutomationWorkspaceContext, taskId: string) {
  if (!UUID.test(taskId)) throw new AutomationAccessError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.", 404);
  for (const user of workspace.users) {
    try {
      const store = storeForOwner(workspace, user.userId);
      return { store, task: await store.get(taskId, { includeDeleted: true }) };
    } catch (error) {
      if (error instanceof AutomationStoreError && error.code === "AUTOMATION_NOT_FOUND") continue;
      throw error;
    }
  }
  throw new AutomationAccessError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.", 404);
}

export async function listAutomationTasks(session: AuthSession) {
  const context = await automationWorkspaceForSession(session);
  const tasks = visibleAutomationTasks(await allTasks(context), context.principal.userId, context, context.isAdmin);
  const directory: AutomationAudienceDirectory = {
    membershipPolicy: "current",
    currentUserId: context.principal.userId,
    users: canonicalAutomationUsers(
      context.users.filter(({ enabled }) => enabled),
      context.principal.userId,
    ).map(({ userId, displayName }) => ({ id: userId, name: displayName })),
    groups: context.state.groups.map(({ id, name }) => ({ id, name })),
  };
  return { tasks: tasks.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)), directory };
}

export async function createAutomationTask(session: AuthSession, input: AutomationTaskInput, options: { taskId?: string } = {}) {
  assertNewAutomationEffectGrant(input.executionContext, {installationId:session.tenant.id,userId:session.user.id,projectId:input.projectId,prompt:input.prompt});
  if (input.schedule.kind === "external") throw new AutomationAccessError("HOST_BINDING_REQUIRED", "Usa la autorización operativa.", 403);
  const context = await automationWorkspaceForSession(session);
  const audience = validateAutomationAudience(input.audience ?? {
    membershipPolicy: "current",
    userIds: [context.principal.userId],
    groupIds: [],
  }, context, context.principal.userId);
  const task = await storeForOwner(context, context.principal.userId).create({ ...input, audience }, { id: options.taskId });
  return { ...task, owner: { userId: context.principal.userId, name: context.principal.displayName }, access: { canManage: true, canViewResults: true } } satisfies AutomationTaskView;
}

export async function updateAutomationTask(session: AuthSession, taskId: string, patch: AutomationTaskPatch, options: {expectedUpdatedAt?:string;ownerOnly?:boolean} = {}) {
  const context = await automationWorkspaceForSession(session);
  const located = await locateTask(context, taskId);
  const access = automationTaskAccess(located.task, context.principal.userId, context, context.isAdmin);
  if (!access.canManage || located.task.deletedAt !== null || options.ownerOnly && located.task.userId!==session.user.id) {
    throw new AutomationAccessError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.", 404);
  }
  if (located.task.schedule.kind === "external" && (patch.schedule || patch.prompt || patch.projectId || patch.timeZone)) {
    throw new AutomationAccessError("HOST_BINDING_REAUTHORIZE", "Revoca y autoriza de nuevo este análisis desde su pantalla de autorización.", 409);
  }
  if (patch.executionContext) assertNewAutomationEffectGrant(patch.executionContext,{installationId:session.tenant.id,userId:located.task.userId,projectId:patch.projectId??located.task.projectId,prompt:patch.prompt??located.task.prompt});
  const nextPatch = patch.audience
    ? { ...patch, audience: validateAutomationAudience(patch.audience, context, context.principal.userId) }
    : patch;
  const task = await located.store.update(taskId, nextPatch, {expectedUpdatedAt:options.expectedUpdatedAt});
  return { ...task, owner: { userId: task.userId, name: context.users.find(({ userId }) => userId === task.userId)?.displayName ?? "Usuario no disponible" }, access: automationTaskAccess(task, context.principal.userId, context, context.isAdmin) } satisfies AutomationTaskView;
}

export async function deleteAutomationTask(session: AuthSession, taskId: string) {
  const context = await automationWorkspaceForSession(session);
  const located = await locateTask(context, taskId);
  const access = automationTaskAccess(located.task, context.principal.userId, context, context.isAdmin);
  if (!access.canManage || located.task.deletedAt !== null) {
    throw new AutomationAccessError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.", 404);
  }
  return located.store.delete(taskId);
}

export async function runAutomationTaskNow(session: AuthSession, taskId: string, clientRequestId: string, options: {expectedUpdatedAt?:string;ownerOnly?:boolean} = {}) {
  const context = await automationWorkspaceForSession(session);
  const located = await locateTask(context, taskId);
  const access = automationTaskAccess(located.task, context.principal.userId, context, context.isAdmin);
  if (!access.canManage || located.task.deletedAt !== null || options.ownerOnly && located.task.userId !== session.user.id) {
    throw new AutomationAccessError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.", 404);
  }
  if (located.task.schedule.kind === "external") throw new AutomationAccessError("HOST_INPUT_REQUIRED", "Este análisis requiere un lote del scheduler autorizado.", 409);
  const task = await located.store.runNow(taskId, clientRequestId, {expectedUpdatedAt:options.expectedUpdatedAt});
  return { ...task, owner: { userId: task.userId, name: context.users.find(({ userId }) => userId === task.userId)?.displayName ?? "Usuario no disponible" }, access: automationTaskAccess(task, context.principal.userId, context, context.isAdmin) } satisfies AutomationTaskView;
}

export async function automationRunsForSession(session: AuthSession, taskId: string) {
  const context = await automationWorkspaceForSession(session);
  const located = await locateTask(context, taskId);
  const access = automationTaskAccess(located.task, context.principal.userId, context, context.isAdmin);
  if (!access.canViewResults) {
    throw new AutomationAccessError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.", 404);
  }
  return located.store.listRuns(taskId);
}
