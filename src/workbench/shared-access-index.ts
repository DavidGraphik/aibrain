import "server-only";

import { createHash } from "node:crypto";
import path from "node:path";
import type { LocalUser } from "@/auth/local-user-store";
import {
  atomicWriteJson,
  defineVersionedSchema,
  expectArray,
  expectIsoDate,
  expectOneOf,
  expectString,
  FileJournal,
  readValidatedJson,
  recoverAtomicJsonFile,
  ResourceLockManager,
} from "@/storage";
import type { WorkbenchSnapshot } from "@/workbench/types";

export type SharedAccessRole = "editor" | "viewer";
export type SharedAccessResourceType = "project" | "thread";

export type SharedAccessProvenance = {
  source: "shared-access-index";
  grantFingerprint: string;
  projectUpdatedAt: string;
  indexedAt: string;
};

export type SharedAccessGrant = {
  schemaVersion: 1;
  resourceType: SharedAccessResourceType;
  resourceId: string;
  projectId: string;
  ownerUserId: string;
  principalUserId: string;
  principalEmail: string;
  role: SharedAccessRole;
  grantFingerprint: string;
  projectUpdatedAt: string;
  indexedAt: string;
};

export type SharedAccessIndexRebuildResult = {
  schemaVersion: 1;
  dryRun: boolean;
  changed: boolean;
  grantsBefore: number;
  grantsAfter: number;
  grantsAdded: number;
  grantsRemoved: number;
  ownersRebuilt: number;
};

type SharedAccessIndexState = {
  schemaVersion: 1;
  installationId: string;
  updatedAt: string;
  grants: SharedAccessGrant[];
};

type SharedAccessAuditEvent = {
  schemaVersion: 1;
  occurredAt: string;
  action: "sync" | "resolve" | "rebuild";
  outcome: "allowed" | "denied";
  actorUserId: string;
  resourceType: SharedAccessResourceType | "index";
  resourceId: string;
  projectId: string | null;
  ownerUserId: string | null;
  grantFingerprint: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const grantSchema = defineVersionedSchema<SharedAccessGrant>({
  name: "SharedAccessGrant",
  schemaVersion: 1,
  keys: [
    "resourceType", "resourceId", "projectId", "ownerUserId", "principalUserId",
    "principalEmail", "role", "grantFingerprint", "projectUpdatedAt", "indexedAt",
  ],
  parse(record, context) {
    return {
      schemaVersion: 1,
      resourceType: expectOneOf(record.resourceType, ["project", "thread"], context.at("resourceType")),
      resourceId: expectString(record.resourceId, context.at("resourceId"), { minLength: 36, maxLength: 36, pattern: UUID }),
      projectId: expectString(record.projectId, context.at("projectId"), { minLength: 36, maxLength: 36, pattern: UUID }),
      ownerUserId: expectString(record.ownerUserId, context.at("ownerUserId"), { minLength: 36, maxLength: 36, pattern: UUID }),
      principalUserId: expectString(record.principalUserId, context.at("principalUserId"), { minLength: 36, maxLength: 36, pattern: UUID }),
      principalEmail: expectString(record.principalEmail, context.at("principalEmail"), { minLength: 3, maxLength: 320, pattern: EMAIL }),
      role: expectOneOf(record.role, ["editor", "viewer"], context.at("role")),
      grantFingerprint: expectString(record.grantFingerprint, context.at("grantFingerprint"), { minLength: 64, maxLength: 64, pattern: /^[0-9a-f]{64}$/ }),
      projectUpdatedAt: expectIsoDate(record.projectUpdatedAt, context.at("projectUpdatedAt")),
      indexedAt: expectIsoDate(record.indexedAt, context.at("indexedAt")),
    };
  },
});

const indexSchema = defineVersionedSchema<SharedAccessIndexState>({
  name: "SharedAccessIndexState",
  schemaVersion: 1,
  keys: ["installationId", "updatedAt", "grants"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      installationId: expectString(record.installationId, context.at("installationId"), { minLength: 1, maxLength: 120 }),
      updatedAt: expectIsoDate(record.updatedAt, context.at("updatedAt")),
      grants: expectArray(record.grants, context.at("grants"), (value, item) => grantSchema.parse(value, `${item.source}${item.path}`), { maxLength: 100_000 }),
    };
  },
});

const auditSchema = defineVersionedSchema<SharedAccessAuditEvent>({
  name: "SharedAccessAuditEvent",
  schemaVersion: 1,
  keys: ["occurredAt", "action", "outcome", "actorUserId", "resourceType", "resourceId", "projectId", "ownerUserId", "grantFingerprint"],
  parse(record, context) {
    const nullableId = (value: unknown, field: string) => {
      if (value === null) return null;
      return expectString(value, context.at(field), { minLength: 36, maxLength: 36, pattern: UUID });
    };
    const nullableFingerprint = record.grantFingerprint === null
      ? null
      : expectString(record.grantFingerprint, context.at("grantFingerprint"), { minLength: 64, maxLength: 64, pattern: /^[0-9a-f]{64}$/ });
    return {
      schemaVersion: 1,
      occurredAt: expectIsoDate(record.occurredAt, context.at("occurredAt")),
      action: expectOneOf(record.action, ["sync", "resolve", "rebuild"], context.at("action")),
      outcome: expectOneOf(record.outcome, ["allowed", "denied"], context.at("outcome")),
      actorUserId: expectString(record.actorUserId, context.at("actorUserId"), { minLength: 36, maxLength: 36, pattern: UUID }),
      resourceType: expectOneOf(record.resourceType, ["project", "thread", "index"], context.at("resourceType")),
      resourceId: expectString(record.resourceId, context.at("resourceId"), { minLength: 36, maxLength: 36, pattern: UUID }),
      projectId: nullableId(record.projectId, "projectId"),
      ownerUserId: nullableId(record.ownerUserId, "ownerUserId"),
      grantFingerprint: nullableFingerprint,
    };
  },
});

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function nowIso(now: () => number) {
  return new Date(now()).toISOString();
}

function fingerprint(value: Omit<SharedAccessGrant, "schemaVersion" | "grantFingerprint" | "indexedAt">) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sortedGrants(grants: readonly SharedAccessGrant[]) {
  return [...grants].toSorted((left, right) =>
    left.grantFingerprint.localeCompare(right.grantFingerprint) ||
    left.indexedAt.localeCompare(right.indexedAt));
}

function countByFingerprint(grants: readonly SharedAccessGrant[]) {
  const counts = new Map<string, number>();
  for (const grant of grants) {
    counts.set(grant.grantFingerprint, (counts.get(grant.grantFingerprint) ?? 0) + 1);
  }
  return counts;
}

export class FileSharedAccessIndex {
  private readonly filePath: string;
  private readonly locks: ResourceLockManager;
  private readonly audit: FileJournal<SharedAccessAuditEvent>;
  private readonly now: () => number;

  constructor(options: { dataRoot: string; installationId: string; now?: () => number }) {
    const root = path.join(path.resolve(options.dataRoot), "workbench-shared-access");
    this.filePath = path.join(root, "index.json");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(root, "locks") });
    this.audit = new FileJournal({
      filePath: path.join(root, "audit.jsonl"),
      lockManager: this.locks,
      payloadSchema: auditSchema,
      now: options.now,
    });
    this.installationId = options.installationId;
    this.now = options.now ?? Date.now;
  }

  private readonly installationId: string;

  private emptyState(): SharedAccessIndexState {
    return { schemaVersion: 1, installationId: this.installationId, updatedAt: nowIso(this.now), grants: [] };
  }

  private async readLocked() {
    try {
      const state = (await recoverAtomicJsonFile(this.filePath, indexSchema)).value;
      if (state.installationId !== this.installationId) {
        throw new Error("Shared access index belongs to a different installation.");
      }
      return state;
    } catch (error) {
      if (isMissing(error)) return this.emptyState();
      throw error;
    }
  }

  private async readWithoutMutation() {
    try {
      const state = await readValidatedJson(this.filePath, indexSchema);
      if (state.installationId !== this.installationId) {
        throw new Error("Shared access index belongs to a different installation.");
      }
      return state;
    } catch (error) {
      if (isMissing(error)) return this.emptyState();
      throw error;
    }
  }

  private buildOwnerGrants(owner: LocalUser, snapshot: WorkbenchSnapshot, users: readonly LocalUser[]) {
    const indexedAt = nowIso(this.now);
    const usersByEmail = new Map(users.filter((user) => user.enabled).map((user) => [user.email, user]));
    const grants: SharedAccessGrant[] = [];
    for (const project of snapshot.projects) {
      if (project.sharing.visibility !== "shared") continue;
      const threads = snapshot.threads.filter((thread) => thread.projectId === project.id);
      for (const member of project.sharing.members) {
        const principal = usersByEmail.get(member.email);
        if (!principal || principal.userId === owner.userId) continue;
        const role: SharedAccessRole = member.role === "viewer" ? "viewer" : "editor";
        const build = (resourceType: SharedAccessResourceType, resourceId: string): SharedAccessGrant => {
          const value = {
            resourceType,
            resourceId,
            projectId: project.id,
            ownerUserId: owner.userId,
            principalUserId: principal.userId,
            principalEmail: principal.email,
            role,
            projectUpdatedAt: project.updatedAt,
          };
          return { schemaVersion: 1, ...value, grantFingerprint: fingerprint(value), indexedAt };
        };
        grants.push(build("project", project.id), ...threads.map((thread) => build("thread", thread.id)));
      }
    }
    return grants.toSorted((left, right) =>
      left.ownerUserId.localeCompare(right.ownerUserId) ||
      left.principalUserId.localeCompare(right.principalUserId) ||
      left.resourceType.localeCompare(right.resourceType) ||
      left.resourceId.localeCompare(right.resourceId));
  }

  async rebuildFromPrivilegedSnapshots(options: {
    operatorUserId: string;
    owners: readonly { owner: LocalUser; snapshot: WorkbenchSnapshot }[];
    users: readonly LocalUser[];
    dryRun: boolean;
  }): Promise<SharedAccessIndexRebuildResult> {
    if (!UUID.test(options.operatorUserId)) throw new Error("Shared access rebuild operator id is invalid.");
    const generated = options.owners.flatMap(({ owner, snapshot }) =>
      this.buildOwnerGrants(owner, snapshot, options.users));
    const project = (current: SharedAccessIndexState) => {
      const existingByFingerprint = new Map(current.grants.map((grant) => [grant.grantFingerprint, grant]));
      const grants = sortedGrants(generated.map((grant) => {
        const existing = existingByFingerprint.get(grant.grantFingerprint);
        return existing ? { ...grant, indexedAt: existing.indexedAt } : grant;
      }));
      const currentGrants = sortedGrants(current.grants);
      const changed = JSON.stringify(currentGrants.map((grant) => grant.grantFingerprint)) !==
        JSON.stringify(grants.map((grant) => grant.grantFingerprint));
      const before = countByFingerprint(current.grants);
      const after = countByFingerprint(grants);
      let grantsAdded = 0;
      let grantsRemoved = 0;
      for (const [key, count] of after) grantsAdded += Math.max(0, count - (before.get(key) ?? 0));
      for (const [key, count] of before) grantsRemoved += Math.max(0, count - (after.get(key) ?? 0));
      const result: SharedAccessIndexRebuildResult = {
        schemaVersion: 1,
        dryRun: options.dryRun,
        changed,
        grantsBefore: current.grants.length,
        grantsAfter: grants.length,
        grantsAdded,
        grantsRemoved,
        ownersRebuilt: options.owners.length,
      };
      return { grants, result };
    };
    if (options.dryRun) return project(await this.readWithoutMutation()).result;
    return this.locks.withLock(`shared-access-index:${this.installationId}`, async () => {
      const { grants, result } = project(await this.readLocked());
      if (result.changed) {
        await atomicWriteJson(this.filePath, {
          schemaVersion: 1,
          installationId: this.installationId,
          updatedAt: nowIso(this.now),
          grants,
        }, indexSchema, { mode: 0o600 });
      }
      await this.audit.append({
        schemaVersion: 1,
        occurredAt: nowIso(this.now),
        action: "rebuild",
        outcome: "allowed",
        actorUserId: options.operatorUserId,
        resourceType: "index",
        resourceId: options.operatorUserId,
        projectId: null,
        ownerUserId: null,
        grantFingerprint: null,
      });
      return result;
    });
  }

  async syncOwnerSnapshot(options: { owner: LocalUser; snapshot: WorkbenchSnapshot; users: readonly LocalUser[] }) {
    const grants = this.buildOwnerGrants(options.owner, options.snapshot, options.users);
    return this.locks.withLock(`shared-access-index:${this.installationId}`, async () => {
      const current = await this.readLocked();
      const currentFingerprints = current.grants
        .filter((grant) => grant.ownerUserId === options.owner.userId)
        .map((grant) => grant.grantFingerprint)
        .toSorted();
      const nextFingerprints = grants.map((grant) => grant.grantFingerprint).toSorted();
      if (currentFingerprints.length === nextFingerprints.length &&
          currentFingerprints.every((fingerprint, index) => fingerprint === nextFingerprints[index])) {
        return current;
      }
      const state: SharedAccessIndexState = {
        schemaVersion: 1,
        installationId: this.installationId,
        updatedAt: nowIso(this.now),
        grants: [...current.grants.filter((grant) => grant.ownerUserId !== options.owner.userId), ...grants],
      };
      await atomicWriteJson(this.filePath, state, indexSchema, { mode: 0o600 });
      await this.audit.append({
        schemaVersion: 1,
        occurredAt: nowIso(this.now),
        action: "sync",
        outcome: "allowed",
        actorUserId: options.owner.userId,
        resourceType: "project",
        resourceId: options.owner.userId,
        projectId: null,
        ownerUserId: options.owner.userId,
        grantFingerprint: null,
      });
      return state;
    });
  }

  async syncThreadFromProject(options: {
    actorUserId: string;
    ownerUserId: string;
    projectId: string;
    threadId: string;
  }) {
    return this.locks.withLock(`shared-access-index:${this.installationId}`, async () => {
      const current = await this.readLocked();
      const indexedAt = nowIso(this.now);
      const projectGrants = current.grants.filter((grant) =>
        grant.resourceType === "project" &&
        grant.ownerUserId === options.ownerUserId &&
        grant.projectId === options.projectId);
      const threadGrants = projectGrants.map((projectGrant) => {
        const value = {
          resourceType: "thread" as const,
          resourceId: options.threadId,
          projectId: projectGrant.projectId,
          ownerUserId: projectGrant.ownerUserId,
          principalUserId: projectGrant.principalUserId,
          principalEmail: projectGrant.principalEmail,
          role: projectGrant.role,
          projectUpdatedAt: projectGrant.projectUpdatedAt,
        };
        return { schemaVersion: 1 as const, ...value, grantFingerprint: fingerprint(value), indexedAt };
      });
      const state: SharedAccessIndexState = {
        schemaVersion: 1,
        installationId: this.installationId,
        updatedAt: indexedAt,
        grants: [
          ...current.grants.filter((grant) => !(grant.resourceType === "thread" && grant.ownerUserId === options.ownerUserId && grant.resourceId === options.threadId)),
          ...threadGrants,
        ],
      };
      await atomicWriteJson(this.filePath, state, indexSchema, { mode: 0o600 });
      await this.audit.append({
        schemaVersion: 1,
        occurredAt: indexedAt,
        action: "sync",
        outcome: "allowed",
        actorUserId: options.actorUserId,
        resourceType: "thread",
        resourceId: options.threadId,
        projectId: options.projectId,
        ownerUserId: options.ownerUserId,
        grantFingerprint: null,
      });
    });
  }

  async resolve(options: { principal: LocalUser; resourceType: SharedAccessResourceType; resourceId: string }) {
    return this.locks.withLock(`shared-access-index:${this.installationId}`, async () => {
      const state = await this.readLocked();
      const grant = state.grants.find((candidate) =>
        candidate.resourceType === options.resourceType &&
        candidate.resourceId === options.resourceId &&
        candidate.principalUserId === options.principal.userId &&
        candidate.principalEmail === options.principal.email);
      await this.audit.append({
        schemaVersion: 1,
        occurredAt: nowIso(this.now),
        action: "resolve",
        outcome: grant ? "allowed" : "denied",
        actorUserId: options.principal.userId,
        resourceType: options.resourceType,
        resourceId: options.resourceId,
        projectId: grant?.projectId ?? null,
        ownerUserId: grant?.ownerUserId ?? null,
        grantFingerprint: grant?.grantFingerprint ?? null,
      });
      return grant ?? null;
    });
  }

  async listProjectsForPrincipal(principal: LocalUser) {
    return this.locks.withLock(`shared-access-index:${this.installationId}`, async () => {
      const state = await this.readLocked();
      return state.grants.filter((grant) =>
        grant.resourceType === "project" &&
        grant.principalUserId === principal.userId &&
        grant.principalEmail === principal.email);
    });
  }

  async readAudit() {
    return this.audit.read();
  }
}
