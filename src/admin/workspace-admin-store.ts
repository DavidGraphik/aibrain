import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  defaultWorkspacePolicy,
  isWorkspacePolicy,
  isWorkspaceRoleId,
  type WorkspaceAdminState,
  type WorkspaceAssignment,
  type WorkspaceAuditAction,
  type WorkspaceAuditEvent,
  type WorkspaceGroup,
  type WorkspacePolicy,
  type WorkspaceRole,
  type WorkspaceRoleId,
} from "@/admin/contracts";
import {
  atomicWriteJson,
  defineVersionedSchema,
  expectArray,
  expectBoolean,
  expectInteger,
  expectIsoDate,
  expectOneOf,
  expectStrictRecord,
  expectString,
  FileJournal,
  recoverAtomicJsonFile,
  readValidatedJson,
  ResourceLockManager,
  type ValidationContext,
} from "@/storage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTALLATION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const AUDIT_ACTIONS: readonly WorkspaceAuditAction[] = [
  "member.conversations-read", "member.provisioned-local", "member.role-changed", "member.enabled", "member.disabled",
  "group.created", "group.updated", "group.deleted",
];

function safeText(value: unknown, context: ValidationContext, maximum: number) {
  const text = expectString(value, context, { minLength: 0, maxLength: maximum });
  if (/\p{C}/u.test(text)) context.fail("contains control characters");
  return text;
}

function policy(value: unknown, context: ValidationContext): WorkspacePolicy {
  if (!isWorkspacePolicy(value)) context.fail("expected a complete workspace policy");
  return value;
}

function role(value: unknown, context: ValidationContext): WorkspaceRole {
  const item = expectStrictRecord(value, ["id", "name", "description", "canManageWorkspace", "policy"], context);
  if (!isWorkspaceRoleId(item.id)) context.at("id").fail("expected a built-in workspace role");
  const roleId = item.id as WorkspaceRoleId;
  return {
    id: roleId,
    name: safeText(item.name, context.at("name"), 80),
    description: safeText(item.description, context.at("description"), 300),
    canManageWorkspace: expectBoolean(item.canManageWorkspace, context.at("canManageWorkspace")),
    policy: policy(item.policy, context.at("policy")),
  };
}

function group(value: unknown, context: ValidationContext): WorkspaceGroup {
  const item = expectStrictRecord(value, ["id", "name", "description", "memberIds", "policy", "createdAt", "updatedAt"], context);
  const memberIds = expectArray(item.memberIds, context.at("memberIds"), (id, itemContext) =>
    expectString(id, itemContext, { minLength: 36, maxLength: 36, pattern: UUID }));
  if (new Set(memberIds).size !== memberIds.length) context.at("memberIds").fail("member ids must be unique");
  const createdAt = expectIsoDate(item.createdAt, context.at("createdAt"));
  const updatedAt = expectIsoDate(item.updatedAt, context.at("updatedAt"));
  if (updatedAt < createdAt) context.at("updatedAt").fail("must not precede createdAt");
  return {
    id: expectString(item.id, context.at("id"), { minLength: 36, maxLength: 36, pattern: UUID }),
    name: safeText(item.name, context.at("name"), 80),
    description: safeText(item.description, context.at("description"), 300),
    memberIds,
    policy: policy(item.policy, context.at("policy")),
    createdAt,
    updatedAt,
  };
}

function assignment(value: unknown, context: ValidationContext): WorkspaceAssignment {
  const item = expectStrictRecord(value, ["userId", "roleId"], context);
  if (!isWorkspaceRoleId(item.roleId)) context.at("roleId").fail("expected a workspace role");
  const roleId = item.roleId as WorkspaceRoleId;
  return {
    userId: expectString(item.userId, context.at("userId"), { minLength: 36, maxLength: 36, pattern: UUID }),
    roleId,
  };
}

export const workspaceAdminStateSchema = defineVersionedSchema<WorkspaceAdminState>({
  name: "WorkspaceAdminState",
  schemaVersion: 1,
  keys: ["installationId", "revision", "roles", "groups", "assignments"],
  parse(record, context) {
    const roles = expectArray(record.roles, context.at("roles"), role, { maxLength: 3 });
    const groups = expectArray(record.groups, context.at("groups"), group, { maxLength: 200 });
    const assignments = expectArray(record.assignments, context.at("assignments"), assignment);
    if (new Set(roles.map(({ id }) => id)).size !== roles.length || roles.length !== 3) context.at("roles").fail("all built-in roles are required exactly once");
    if (new Set(groups.map(({ id }) => id)).size !== groups.length) context.at("groups").fail("group ids must be unique");
    if (new Set(assignments.map(({ userId }) => userId)).size !== assignments.length) context.at("assignments").fail("user assignments must be unique");
    if (assignments.length > 0 && !assignments.some(({ roleId }) => roleId === "workspace-owner")) {
      context.at("assignments").fail("at least one workspace owner is required");
    }
    return {
      schemaVersion: 1,
      installationId: expectString(record.installationId, context.at("installationId"), { minLength: 2, maxLength: 63, pattern: INSTALLATION_ID }),
      revision: expectInteger(record.revision, context.at("revision"), { minimum: 0 }),
      roles,
      groups,
      assignments,
    };
  },
});

export const workspaceAuditEventSchema = defineVersionedSchema<WorkspaceAuditEvent>({
  name: "WorkspaceAuditEvent",
  schemaVersion: 1,
  keys: ["installationId", "actorUserId", "action", "targetType", "targetId", "summary", "occurredAt"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      installationId: expectString(record.installationId, context.at("installationId"), { minLength: 2, maxLength: 63, pattern: INSTALLATION_ID }),
      actorUserId: expectString(record.actorUserId, context.at("actorUserId"), { minLength: 36, maxLength: 36, pattern: UUID }),
      action: expectOneOf(record.action, AUDIT_ACTIONS, context.at("action")),
      targetType: expectOneOf(record.targetType, ["member", "group"] as const, context.at("targetType")),
      targetId: expectString(record.targetId, context.at("targetId"), { minLength: 36, maxLength: 36, pattern: UUID }),
      summary: safeText(record.summary, context.at("summary"), 300),
      occurredAt: expectIsoDate(record.occurredAt, context.at("occurredAt")),
    };
  },
});

function roles(): WorkspaceRole[] {
  const full = defaultWorkspacePolicy();
  return [
    { id: "workspace-owner", name: "Propietario", description: "Control total del workspace y de sus administradores.", canManageWorkspace: true, policy: full },
    { id: "workspace-admin", name: "Administrador", description: "Gestiona personas, grupos y políticas del workspace.", canManageWorkspace: true, policy: defaultWorkspacePolicy() },
    { id: "workspace-member", name: "Miembro", description: "Usa la aplicación con las políticas asignadas por la empresa.", canManageWorkspace: false, policy: defaultWorkspacePolicy() },
  ];
}

function configuredAdmins() {
  return [...new Set((process.env.AIBRAIN_ADMIN_USER_IDS ?? "")
    .split(",").map((value) => value.trim()).filter((value) => UUID.test(value)))];
}

function initialState(installationId: string, userIds: readonly string[]): WorkspaceAdminState {
  const provisioned = new Set(userIds);
  const admins = configuredAdmins().filter((userId) => provisioned.has(userId));
  if (admins.length === 0) {
    throw new Error(
      "Workspace owner bootstrap is required: configure AIBRAIN_ADMIN_USER_IDS with a provisioned user before creating workspace-admin state.",
    );
  }
  return workspaceAdminStateSchema.parse({
    schemaVersion: 1,
    installationId,
    revision: 0,
    roles: roles(),
    groups: [],
    assignments: userIds.map((userId) => ({
      userId,
      roleId: admins.includes(userId)
        ? admins[0] === userId ? "workspace-owner" : "workspace-admin"
        : "workspace-member",
    })),
  });
}

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export class FileWorkspaceAdminStore {
  private readonly root: string;
  private readonly statePath: string;
  private readonly locks: ResourceLockManager;
  private readonly audit: FileJournal<WorkspaceAuditEvent>;

  constructor(readonly installationId: string, dataRoot: string, private readonly now: () => number = Date.now) {
    if (!INSTALLATION_ID.test(installationId) || !path.isAbsolute(dataRoot)) throw new Error("Workspace admin store configuration is invalid.");
    this.root = path.join(dataRoot, "workspace-admin");
    this.statePath = path.join(this.root, "state.json");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(this.root, "locks") });
    this.audit = new FileJournal({
      filePath: path.join(this.root, "audit.jsonl"),
      lockManager: new ResourceLockManager({ rootDirectory: path.join(this.root, "audit-locks") }),
      payloadSchema: workspaceAuditEventSchema,
      now,
    });
  }

  private async prepare() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Workspace admin storage root is unsafe.");
    await chmod(this.root, 0o700);
  }

  private reconcile(state: WorkspaceAdminState, userIds: readonly string[]) {
    const known = new Set(userIds);
    state.assignments = state.assignments.filter(({ userId }) => known.has(userId));
    for (const userId of userIds) {
      const current = state.assignments.find((item) => item.userId === userId);
      if (current) continue;
      state.assignments.push({
        userId,
        roleId: "workspace-member",
      });
    }
    for (const group of state.groups) group.memberIds = group.memberIds.filter((id) => known.has(id));
    return state;
  }

  private async readUnlocked(userIds: readonly string[]) {
    try {
      const state = (await recoverAtomicJsonFile(this.statePath, workspaceAdminStateSchema)).value;
      if (state.installationId !== this.installationId) throw new Error("Workspace admin state belongs to another installation.");
      return this.reconcile(state, userIds);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const state = initialState(this.installationId, userIds);
      await atomicWriteJson(this.statePath, state, workspaceAdminStateSchema, { mode: 0o600 });
      return state;
    }
  }

  /** Current canonical policy for a read-only scan; no rewrite/fsync per item. */
  async readCurrent(userIds: readonly string[]) {
    await this.prepare();
    try {
      const state = await readValidatedJson(this.statePath, workspaceAdminStateSchema);
      if (state.installationId !== this.installationId) throw new Error("Workspace admin state belongs to another installation.");
      return this.reconcile(state, userIds);
    } catch (error) {
      if (!isMissing(error)) throw error;
      return this.read(userIds); // retain first-use initialization only
    }
  }

  async read(userIds: readonly string[]) {
    await this.prepare();
    return this.locks.withLock(`workspace-admin:${this.installationId}`, async () => {
      const state = await this.readUnlocked(userIds);
      await atomicWriteJson(this.statePath, state, workspaceAdminStateSchema, { mode: 0o600 });
      return structuredClone(state);
    });
  }

  async mutate(
    userIds: readonly string[],
    actorUserId: string,
    operation: (state: WorkspaceAdminState) => { action: WorkspaceAuditAction; targetType: "member" | "group"; targetId: string; summary: string },
  ) {
    await this.prepare();
    const result = await this.locks.withLock(`workspace-admin:${this.installationId}`, async () => {
      const state = await this.readUnlocked(userIds);
      const audit = operation(state);
      state.revision += 1;
      await atomicWriteJson(this.statePath, state, workspaceAdminStateSchema, { mode: 0o600 });
      return { state: structuredClone(state), audit };
    });
    await this.audit.append({
      schemaVersion: 1,
      installationId: this.installationId,
      actorUserId,
      ...result.audit,
      occurredAt: new Date(this.now()).toISOString(),
    });
    return result.state;
  }

  async recordConversationRead(actorUserId: string, targetId: string, threadId?: string, actorEmail?: string) {
    await this.prepare();
    await this.audit.append({ schemaVersion: 1, installationId: this.installationId, actorUserId,
      action: "member.conversations-read", targetType: "member", targetId,
      summary: `${actorEmail ? `Programmer ${actorEmail}: ` : ""}${threadId ? `Conversation ${threadId} consulted` : "Conversation list consulted"}`,
      occurredAt: new Date(this.now()).toISOString() });
  }

  async auditLog(limit = 100) {
    const entries = await this.audit.read();
    return entries.slice(-limit).reverse().map(({ sequence, payload }) => ({ sequence, ...payload }));
  }

  newGroup(name: string, description: string): WorkspaceGroup {
    const now = new Date(this.now()).toISOString();
    return {
      id: randomUUID(), name: name.trim(), description: description.trim(), memberIds: [],
      policy: defaultWorkspacePolicy(), createdAt: now, updatedAt: now,
    };
  }
}

export function effectiveWorkspacePolicy(
  state: Pick<WorkspaceAdminState, "roles" | "groups" | "assignments">,
  userId: string,
) {
  const assignment = state.assignments.find((item) => item.userId === userId);
  const roleId: WorkspaceRoleId = assignment?.roleId ?? "workspace-member";
  const role = state.roles.find((item) => item.id === roleId) ?? roles()[2]!;
  const memberships = state.groups.filter((item) => item.memberIds.includes(userId));
  const result = structuredClone(role.policy);
  for (const group of memberships) {
    for (const key of Object.keys(result.apps) as Array<keyof typeof result.apps>) {
      result.apps[key] = result.apps[key] && group.policy.apps[key];
    }
    for (const key of Object.keys(result.capabilities) as Array<keyof typeof result.capabilities>) {
      result.capabilities[key] = result.capabilities[key] && group.policy.capabilities[key];
    }
  }
  return { roleId, role, groups: memberships, policy: result };
}
