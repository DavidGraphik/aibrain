import "server-only";

import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import type { AuthSession } from "@/auth/types";
import { FileLocalUserStore, type LocalUser } from "@/auth/local-user-store";
import { loadInstallationConfig } from "@/config/installation";
import {
  type WorkspaceAdminCommand,
  type WorkspaceAdminSnapshot,
  type WorkspaceRoleId,
} from "@/admin/contracts";
import { effectiveWorkspacePolicy, FileWorkspaceAdminStore } from "@/admin/workspace-admin-store";
import { workerRuntimeHealth } from "@/runtime/worker-runtime-service";
import { aggregateTurnUsage, FileUsageStore } from "@/usage/file-usage-store";
import { executeUserLifecycleCommand } from "@/users/lifecycle-server";
import { UserProvisioner } from "@/users/provisioner";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class WorkspaceAdminError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "WorkspaceAdminError";
  }
}

async function localUsers(usersRoot: string): Promise<LocalUser[]> {
  const store = new FileLocalUserStore(usersRoot);
  const entries = await readdir(usersRoot, { withFileTypes: true });
  const users = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && UUID.test(entry.name))
    .map((entry) => store.read(entry.name)));
  return users.filter((user): user is LocalUser => user !== null)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

async function context(session: AuthSession) {
  if (session.provider !== "local" || !UUID.test(session.user.id)) {
    throw new WorkspaceAdminError("ADMIN_LOCAL_SESSION_REQUIRED", "El centro de administración requiere una cuenta local de empresa.", 403);
  }
  const installation = await loadInstallationConfig();
  if (session.tenant.id !== installation.installationId) {
    throw new WorkspaceAdminError("ADMIN_TENANT_MISMATCH", "La sesión no pertenece a esta instalación.", 403);
  }
  const users = await localUsers(installation.paths.usersRoot);
  if (!users.some(({ userId }) => userId === session.user.id)) {
    throw new WorkspaceAdminError("ADMIN_MEMBER_NOT_FOUND", "El administrador no está provisionado en esta instalación.", 403);
  }
  const store = new FileWorkspaceAdminStore(installation.installationId, installation.paths.dataRoot);
  const state = await store.read(users.map(({ userId }) => userId));
  return { installation, users, store, state };
}

export async function workspaceRoleForSession(session: AuthSession) {
  const { state } = await context(session);
  return effectiveWorkspacePolicy(state, session.user.id).role;
}

export async function isWorkspaceAdmin(session: AuthSession) {
  try {
    return (await workspaceRoleForSession(session)).canManageWorkspace;
  } catch {
    return false;
  }
}

async function authorizedContext(session: AuthSession) {
  const resolved = await context(session);
  const effective = effectiveWorkspacePolicy(resolved.state, session.user.id);
  if (!effective.role.canManageWorkspace) {
    throw new WorkspaceAdminError("ADMIN_ROLE_REQUIRED", "Se necesita el rol de administrador del workspace.", 403);
  }
  return { ...resolved, effective };
}

export async function workspaceAdminSnapshot(session: AuthSession): Promise<WorkspaceAdminSnapshot> {
  const { installation, users, store, state, effective } = await authorizedContext(session);
  const usageStore = new FileUsageStore({
    installationId: installation.installationId,
    dataRoot: installation.paths.dataRoot,
  });
  const turns = await usageStore.listTurns();
  const members = await Promise.all(users.map(async (user) => {
    const assignment = state.assignments.find((item) => item.userId === user.userId);
    const memberTurns = aggregateTurnUsage(turns.filter((turn) => turn.userId === user.userId));
    const health = await workerRuntimeHealth(user.userId).catch(() => null);
    return {
      userId: user.userId,
      displayName: user.displayName,
      email: user.email,
      enabled: user.enabled,
      workerId: user.workerId,
      workerState: health?.state ?? "absent" as const,
      workerHealthy: health?.healthy ?? false,
      roleId: assignment?.roleId ?? "workspace-member" as WorkspaceRoleId,
      groupIds: state.groups.filter((group) => group.memberIds.includes(user.userId)).map(({ id }) => id),
      usage: {
        turns: memberTurns.turns,
        ...(!installation.usageLimits ? {
          inputTokens: String(memberTurns.tokens.inputTokens),
          outputTokens: String(memberTurns.tokens.outputTokens),
        } : {}),
      },
    };
  }));
  return {
    schemaVersion: 1,
    installationId: installation.installationId,
    companyName: installation.companyName,
    currentUserRoleId: effective.roleId,
    identityProvisioning: {
      mode: "local-profile-only",
      emailDelivery: false,
      detail: "Esta instalación no dispone de una API de invitación o correo. El alta crea únicamente el perfil, worker y workspace locales para una identidad ya creada en el IdP.",
    },
    roles: state.roles,
    groups: state.groups,
    members,
    audit: await store.auditLog(100),
  };
}

function assertMember(stateUserIds: readonly string[], userId: string) {
  if (!stateUserIds.includes(userId)) {
    throw new WorkspaceAdminError("ADMIN_MEMBER_NOT_FOUND", "La persona no está provisionada en esta instalación.", 404);
  }
}

function soleOwner(state: { assignments: Array<{ userId: string; roleId: WorkspaceRoleId }> }, userId: string) {
  return state.assignments.find((item) => item.userId === userId)?.roleId === "workspace-owner" &&
    state.assignments.filter((item) => item.roleId === "workspace-owner").length === 1;
}

export async function executeWorkspaceAdminCommand(session: AuthSession, command: WorkspaceAdminCommand) {
  let resolved = await authorizedContext(session);
  let userIds = resolved.users.map(({ userId }) => userId);

  if (command.action === "provision-local-member") {
    const result = await new UserProvisioner(resolved.installation).provision({
      userId: command.userId,
      email: command.email,
      displayName: command.displayName,
      enabled: true,
      requireInitialPasswordChange: true,
    });
    resolved.users = await localUsers(resolved.installation.paths.usersRoot);
    userIds = resolved.users.map(({ userId }) => userId);
    await resolved.store.mutate(userIds, session.user.id, () => ({
      action: "member.provisioned-local",
      targetType: "member",
      targetId: command.userId,
      summary: `${result.created ? "Perfil local creado" : "Perfil local verificado"} para ${result.user.email}; no se envió ningún correo.`,
    }));
    return { snapshot: await workspaceAdminSnapshot(session), result: { created: result.created, emailSent: false, identityCreated: false } };
  }

  if (command.action === "set-member-enabled") {
    assertMember(userIds, command.userId);
    if (!command.enabled && soleOwner(resolved.state, command.userId)) {
      throw new WorkspaceAdminError("ADMIN_LAST_OWNER", "No se puede desactivar al único propietario del workspace.", 409);
    }
    await executeUserLifecycleCommand({
      schemaVersion: 1,
      requestId: randomUUID(),
      action: command.enabled ? "enable" : "disable",
      userId: command.userId,
    });
    await resolved.store.mutate(userIds, session.user.id, () => ({
      action: command.enabled ? "member.enabled" : "member.disabled",
      targetType: "member",
      targetId: command.userId,
      summary: command.enabled ? "Acceso local habilitado." : "Acceso local deshabilitado y sesiones revocadas.",
    }));
    return { snapshot: await workspaceAdminSnapshot(session) };
  }

  if (command.action === "set-member-role") {
    assertMember(userIds, command.userId);
    await resolved.store.mutate(userIds, session.user.id, (state) => {
      if (command.roleId !== "workspace-owner" && soleOwner(state, command.userId)) {
        throw new WorkspaceAdminError("ADMIN_LAST_OWNER", "El workspace debe conservar al menos un propietario.", 409);
      }
      const assignment = state.assignments.find((item) => item.userId === command.userId);
      if (!assignment) throw new WorkspaceAdminError("ADMIN_MEMBER_NOT_FOUND", "No existe una asignación para la persona.", 404);
      assignment.roleId = command.roleId;
      return {
        action: "member.role-changed",
        targetType: "member",
        targetId: command.userId,
        summary: `Rol cambiado a ${command.roleId}.`,
      };
    });
    return { snapshot: await workspaceAdminSnapshot(session) };
  }

  if (command.action === "create-group") {
    await resolved.store.mutate(userIds, session.user.id, (state) => {
      if (state.groups.some((group) => group.name.toLocaleLowerCase() === command.name.trim().toLocaleLowerCase())) {
        throw new WorkspaceAdminError("ADMIN_GROUP_CONFLICT", "Ya existe un grupo con ese nombre.", 409);
      }
      const group = resolved.store.newGroup(command.name, command.description);
      state.groups.push(group);
      return { action: "group.created", targetType: "group", targetId: group.id, summary: `Grupo ${group.name} creado.` };
    });
    return { snapshot: await workspaceAdminSnapshot(session) };
  }

  if (command.action === "delete-group") {
    await resolved.store.mutate(userIds, session.user.id, (state) => {
      const group = state.groups.find((item) => item.id === command.groupId);
      if (!group) throw new WorkspaceAdminError("ADMIN_GROUP_NOT_FOUND", "Grupo no encontrado.", 404);
      state.groups = state.groups.filter((item) => item.id !== command.groupId);
      return { action: "group.deleted", targetType: "group", targetId: command.groupId, summary: `Grupo ${group.name} eliminado.` };
    });
    return { snapshot: await workspaceAdminSnapshot(session) };
  }

  for (const userId of command.memberIds) assertMember(userIds, userId);
  await resolved.store.mutate(userIds, session.user.id, (state) => {
    const group = state.groups.find((item) => item.id === command.groupId);
    if (!group) throw new WorkspaceAdminError("ADMIN_GROUP_NOT_FOUND", "Grupo no encontrado.", 404);
    group.name = command.name.trim();
    group.description = command.description.trim();
    group.memberIds = [...command.memberIds];
    group.policy = structuredClone(command.policy);
    group.updatedAt = new Date().toISOString();
    return { action: "group.updated", targetType: "group", targetId: group.id, summary: `Grupo ${group.name} y sus políticas actualizados.` };
  });
  return { snapshot: await workspaceAdminSnapshot(session) };
}
