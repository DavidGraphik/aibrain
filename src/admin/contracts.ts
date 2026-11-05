import type { ControllableAppId } from "@/settings/contracts";

export const WORKSPACE_ROLE_IDS = ["workspace-owner", "workspace-admin", "workspace-member"] as const;
export type WorkspaceRoleId = typeof WORKSPACE_ROLE_IDS[number];
export type WorkspaceCapability = "consult" | "respond" | "execute" | "publish";
export type WorkspacePolicy = {
  apps: Record<ControllableAppId, boolean>;
  capabilities: Record<WorkspaceCapability, boolean>;
};

export type WorkspaceRole = {
  id: WorkspaceRoleId;
  name: string;
  description: string;
  canManageWorkspace: boolean;
  policy: WorkspacePolicy;
};

export type WorkspaceGroup = {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  policy: WorkspacePolicy;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceAssignment = {
  userId: string;
  roleId: WorkspaceRoleId;
};

export type WorkspaceAdminState = {
  schemaVersion: 1;
  installationId: string;
  revision: number;
  roles: WorkspaceRole[];
  groups: WorkspaceGroup[];
  assignments: WorkspaceAssignment[];
};

export type WorkspaceAuditAction =
  | "member.conversations-read"
  | "member.provisioned-local"
  | "member.role-changed"
  | "member.enabled"
  | "member.disabled"
  | "group.created"
  | "group.updated"
  | "group.deleted";

export type WorkspaceAuditEvent = {
  schemaVersion: 1;
  installationId: string;
  actorUserId: string;
  action: WorkspaceAuditAction;
  targetType: "member" | "group";
  targetId: string;
  summary: string;
  occurredAt: string;
};

export type WorkspaceAdminMember = {
  userId: string;
  displayName: string;
  email: string;
  enabled: boolean;
  workerId: string;
  workerState: "absent" | "starting" | "running" | "degraded" | "stopping" | "stopped" | "failed";
  workerHealthy: boolean;
  roleId: WorkspaceRoleId;
  groupIds: string[];
  usage: { turns: number; inputTokens?: string; outputTokens?: string };
};

export type WorkspaceAdminSnapshot = {
  schemaVersion: 1;
  installationId: string;
  companyName: string;
  currentUserRoleId: WorkspaceRoleId;
  identityProvisioning: {
    mode: "local-profile-only";
    emailDelivery: false;
    detail: string;
  };
  roles: WorkspaceRole[];
  groups: WorkspaceGroup[];
  members: WorkspaceAdminMember[];
  audit: Array<WorkspaceAuditEvent & { sequence: number }>;
};

export type WorkspaceAdminCommand =
  | { action: "set-member-role"; userId: string; roleId: WorkspaceRoleId }
  | { action: "set-member-enabled"; userId: string; enabled: boolean }
  | { action: "provision-local-member"; userId: string; email: string; displayName: string }
  | { action: "create-group"; name: string; description: string }
  | { action: "update-group"; groupId: string; name: string; description: string; memberIds: string[]; policy: WorkspacePolicy }
  | { action: "delete-group"; groupId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APP_IDS = ["web-search", "image-generation", "skills", "managed-browser"] as const;
const CAPABILITIES = ["consult", "respond", "execute", "publish"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isWorkspaceRoleId(value: unknown): value is WorkspaceRoleId {
  return typeof value === "string" && WORKSPACE_ROLE_IDS.includes(value as WorkspaceRoleId);
}

export function isWorkspacePolicy(value: unknown): value is WorkspacePolicy {
  if (!record(value) || !record(value.apps) || !record(value.capabilities)) return false;
  const apps = value.apps;
  const capabilities = value.capabilities;
  return Object.keys(value).length === 2 &&
    Object.keys(apps).length === APP_IDS.length && APP_IDS.every((id) => typeof apps[id] === "boolean") &&
    Object.keys(capabilities).length === CAPABILITIES.length && CAPABILITIES.every((id) => typeof capabilities[id] === "boolean");
}

export function isWorkspaceAdminCommand(value: unknown): value is WorkspaceAdminCommand {
  if (!record(value) || typeof value.action !== "string") return false;
  if (value.action === "set-member-role") {
    return Object.keys(value).length === 3 && typeof value.userId === "string" && UUID.test(value.userId) && isWorkspaceRoleId(value.roleId);
  }
  if (value.action === "set-member-enabled") {
    return Object.keys(value).length === 3 && typeof value.userId === "string" && UUID.test(value.userId) && typeof value.enabled === "boolean";
  }
  if (value.action === "provision-local-member") {
    return Object.keys(value).length === 4 && typeof value.userId === "string" && UUID.test(value.userId) &&
      typeof value.email === "string" && value.email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) &&
      typeof value.displayName === "string" && value.displayName.trim().length > 0 && value.displayName.length <= 120;
  }
  if (value.action === "create-group") {
    return Object.keys(value).length === 3 && typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 80 &&
      typeof value.description === "string" && value.description.length <= 300;
  }
  if (value.action === "update-group") {
    return Object.keys(value).length === 6 && typeof value.groupId === "string" && UUID.test(value.groupId) &&
      typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 80 &&
      typeof value.description === "string" && value.description.length <= 300 &&
      Array.isArray(value.memberIds) && value.memberIds.every((id) => typeof id === "string" && UUID.test(id)) &&
      new Set(value.memberIds).size === value.memberIds.length && isWorkspacePolicy(value.policy);
  }
  return value.action === "delete-group" && Object.keys(value).length === 2 && typeof value.groupId === "string" && UUID.test(value.groupId);
}

export function isWorkspaceAdminSnapshot(value: unknown): value is WorkspaceAdminSnapshot {
  return record(value) && value.schemaVersion === 1 && typeof value.installationId === "string" &&
    typeof value.companyName === "string" && isWorkspaceRoleId(value.currentUserRoleId) &&
    Array.isArray(value.roles) && Array.isArray(value.groups) && Array.isArray(value.members) && Array.isArray(value.audit) &&
    record(value.identityProvisioning) && value.identityProvisioning.mode === "local-profile-only" && value.identityProvisioning.emailDelivery === false;
}

export const defaultWorkspacePolicy = (): WorkspacePolicy => ({
  apps: { "web-search": true, "image-generation": true, skills: true, "managed-browser": true },
  capabilities: { consult: true, respond: true, execute: true, publish: true },
});
