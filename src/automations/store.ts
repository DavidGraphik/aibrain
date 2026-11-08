import { AutomationMaintenanceGate } from "@/operations/automation-maintenance";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AutomationRun,
  AutomationRunHistory,
  AutomationSnapshot,
  AutomationTask,
  AutomationTaskInput,
  AutomationTaskPatch,
} from "@/automations/contracts";
import {
  DEFAULT_AUTOMATION_EXECUTION_CONTEXT,
  isAutomationAudience,
  isAutomationExecutionContext,
  isAutomationSchedule,
  isIsoDate,
  isRecord,
  isValidTimeZone,
} from "@/automations/contracts";
import { nextAfterOccurrence, nextScheduledInstant } from "@/automations/schedule";
import {
  atomicWriteJson,
  FileJournal,
  ResourceLockManager,
  ResourceLockTimeoutError,
  type StorageSchema,
} from "@/storage";

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LEASE_MS = 10 * 60_000;

export class AutomationStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AutomationStoreError";
  }
}

function invalid(source: string): never {
  throw new AutomationStoreError("AUTOMATION_STORAGE_CORRUPT", `Datos de automatización no válidos: ${source}.`);
}

function parseLease(value: unknown) {
  if (value === null) return null;
  if (!isRecord(value) || ![4, 5].includes(Object.keys(value).length) ||
    typeof value.runKey !== "string" || value.runKey.length > 200 ||
    typeof value.ownerId !== "string" || value.ownerId.length > 128 ||
    !isIsoDate(value.scheduledFor) || !isIsoDate(value.expiresAt)) invalid("lease");
  if ("fenceToken" in value && (typeof value.fenceToken !== "string" || value.fenceToken.length < 16 || value.fenceToken.length > 128)) invalid("lease");
  // A legacy lease cannot be settled by the fenced runner. The next locked
  // claim replaces it after expiry, without rejecting an in-flight upgrade.
  return {
    ...value,
    fenceToken: typeof value.fenceToken === "string" ? value.fenceToken : "legacy-unfenced",
  } as AutomationTask["lease"];
}

function parseTask(value: unknown): AutomationTask {
  if (!isRecord(value) || value.schemaVersion !== 1 || !UUID_PATTERN.test(String(value.id)) ||
    typeof value.installationId !== "string" || typeof value.userId !== "string" ||
    !(value.audience === undefined || isAutomationAudience(value.audience)) ||
    typeof value.name !== "string" || !value.name || value.name.length > 100 ||
    typeof value.prompt !== "string" || !value.prompt || value.prompt.length > 20_000 ||
    !UUID_PATTERN.test(String(value.projectId)) || typeof value.projectName !== "string" ||
    !isValidTimeZone(value.timeZone) || !isAutomationSchedule(value.schedule) ||
    !(value.executionContext === undefined || isAutomationExecutionContext(value.executionContext)) ||
    !(value.preparationBlock === undefined || value.preparationBlock === null || (typeof value.preparationBlock === "string" && value.preparationBlock.length > 0 && value.preparationBlock.length <= 500)) ||
    !["active", "paused", "completed"].includes(String(value.state)) ||
    !(value.nextRunAt === null || isIsoDate(value.nextRunAt)) ||
    !(value.lastRunAt === null || isIsoDate(value.lastRunAt)) ||
    !(value.lastRunStatus === null || value.lastRunStatus === "succeeded" || value.lastRunStatus === "failed") ||
    !(value.lastRunError === null || typeof value.lastRunError === "string") ||
    !(value.retryAt === undefined || value.retryAt === null || isIsoDate(value.retryAt)) ||
    !(value.manualRun === undefined || value.manualRun === null || (isRecord(value.manualRun) &&
      Object.keys(value.manualRun).length === 2 && typeof value.manualRun.requestId === "string" &&
      UUID_PATTERN.test(value.manualRun.requestId) && isIsoDate(value.manualRun.scheduledFor))) ||
    !(value.deletedAt === undefined || value.deletedAt === null || isIsoDate(value.deletedAt)) ||
    !(value.cancellationRequestedAt === undefined || value.cancellationRequestedAt === null || isIsoDate(value.cancellationRequestedAt)) ||
    !isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)) invalid("task");
  return {
    ...value,
    // Backward-compatible migration: existing tasks initially deliver only
    // to their owner. Any locked read/write persists this explicit selector.
    audience: value.audience ?? {
      membershipPolicy: "current",
      userIds: [value.userId],
      groupIds: [],
    },
    executionContext: value.executionContext ?? DEFAULT_AUTOMATION_EXECUTION_CONTEXT,
    retryAt: value.retryAt ?? null,
    manualRun: value.manualRun ?? null,
    deletedAt: value.deletedAt ?? null,
    cancellationRequestedAt: value.cancellationRequestedAt ?? null,
    lease: parseLease(value.lease),
  } as AutomationTask;
}

const snapshotSchema: StorageSchema<AutomationSnapshot> = {
  name: "AutomationSnapshot",
  parse(value, source = "AutomationSnapshot") {
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.tasks) ||
      Object.keys(value).some((key) => key !== "schemaVersion" && key !== "tasks")) invalid(source);
    return { schemaVersion: 1, tasks: value.tasks.map(parseTask) };
  },
};

const runSchema: StorageSchema<AutomationRun> = {
  name: "AutomationRun",
  parse(value, source = "AutomationRun") {
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.runKey !== "string" ||
      !UUID_PATTERN.test(String(value.taskId)) || typeof value.installationId !== "string" ||
      typeof value.userId !== "string" || !isIsoDate(value.scheduledFor) ||
      !["running", "succeeded", "failed"].includes(String(value.status)) ||
      !Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1 || !isIsoDate(value.startedAt) ||
      !(value.finishedAt === null || isIsoDate(value.finishedAt)) ||
      !(value.threadId === null || UUID_PATTERN.test(String(value.threadId))) ||
      !(value.error === null || typeof value.error === "string")) invalid(source);
    return value as AutomationRun;
  },
};

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function ensurePrivateDirectory(directory: string) {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new AutomationStoreError("AUTOMATION_PATH_UNSAFE", "El directorio de automatizaciones no es privado.");
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

export type AutomationStoreOptions = {
  installationId: string;
  userId: string;
  usersRoot: string;
  now?: () => number;
  leaseMs?: number;
};

export type ClaimedAutomation = {
  task: AutomationTask;
  runKey: string;
  ownerId: string;
  scheduledFor: string;
};

export class FileAutomationStore {
  readonly root: string;
  readonly tasksPath: string;
  readonly runsPath: string;
  private readonly locks: ResourceLockManager;
  private readonly runs: FileJournal<AutomationRun>;
  private readonly now: () => number;
  private readonly leaseMs: number;

  constructor(readonly options: AutomationStoreOptions) {
    if (!IDENTITY_PATTERN.test(options.installationId) || !IDENTITY_PATTERN.test(options.userId) ||
      !path.isAbsolute(options.usersRoot)) {
      throw new AutomationStoreError("AUTOMATION_IDENTITY_INVALID", "Identidad o raíz de automatizaciones no válida.");
    }
    this.root = path.join(path.resolve(options.usersRoot), options.userId, "automations");
    this.tasksPath = path.join(this.root, "tasks.json");
    this.runsPath = path.join(this.root, "runs.jsonl");
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.locks = new ResourceLockManager({ rootDirectory: path.join(this.root, "locks"), now: this.now });
    this.runs = new FileJournal({ filePath: this.runsPath, lockManager: this.locks, payloadSchema: runSchema, now: this.now });
  }

  private async prepare() {
    await ensurePrivateDirectory(this.root);
    await ensurePrivateDirectory(path.join(this.root, "locks"));
  }

  private async readUnlocked(): Promise<{ snapshot: AutomationSnapshot; migrated: boolean }> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.tasksPath, "utf8"));
      const migrated = isRecord(raw) && Array.isArray(raw.tasks) &&
        raw.tasks.some((task) => isRecord(task) &&
          (!("audience" in task) || !("executionContext" in task) || !("manualRun" in task)));
      return { snapshot: snapshotSchema.parse(raw, this.tasksPath), migrated };
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { snapshot: { schemaVersion: 1, tasks: [] }, migrated: false };
      throw error;
    }
  }

  private assertOwnership(task: AutomationTask) {
    if (task.installationId !== this.options.installationId || task.userId !== this.options.userId) {
      throw new AutomationStoreError("AUTOMATION_IDENTITY_MISMATCH", "La automatización pertenece a otro usuario o instalación.");
    }
  }

  private async mutate<T>(operation: (snapshot: AutomationSnapshot) => T | Promise<T>, lockOptions: { timeoutMs?: number } = {}) {
    await this.prepare();
    return this.locks.withLock("automation-tasks", async () => {
      const { snapshot } = await this.readUnlocked();
      snapshot.tasks.forEach((task) => this.assertOwnership(task));
      const result = await operation(snapshot);
      await atomicWriteJson(this.tasksPath, snapshot, snapshotSchema);
      return result;
    }, lockOptions);
  }

  private async read<T>(operation: (snapshot: AutomationSnapshot) => T) {
    await this.prepare();
    const current = await this.readUnlocked();
    current.snapshot.tasks.forEach((task) => this.assertOwnership(task));
    if (!current.migrated) return operation(current.snapshot);
    // Only legacy normalization needs a write lock. Ordinary reads retain the
    // original lock-free atomic-snapshot path used by polling UI and workers.
    return this.locks.withLock("automation-tasks", async () => {
      const { snapshot, migrated } = await this.readUnlocked();
      snapshot.tasks.forEach((task) => this.assertOwnership(task));
      if (migrated) await atomicWriteJson(this.tasksPath, snapshot, snapshotSchema);
      return operation(snapshot);
    });
  }

  async list(options: { includeDeleted?: boolean } = {}) {
    return this.read((snapshot) => snapshot.tasks
      .filter((task) => options.includeDeleted || task.deletedAt === null)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  async get(taskId: string, options: { includeDeleted?: boolean } = {}) {
    if (!UUID_PATTERN.test(taskId)) throw new AutomationStoreError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.");
    return this.read((snapshot) => {
      const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
      if (!task || (!options.includeDeleted && task.deletedAt !== null)) {
        throw new AutomationStoreError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.");
      }
      this.assertOwnership(task);
      return { ...task };
    });
  }

  async create(input: AutomationTaskInput, options: { id?: string } = {}) {
    const now = new Date(this.now());
    const nextRunAt = nextScheduledInstant(input.schedule, input.timeZone, new Date(now.getTime() - 1));
    if (!nextRunAt && input.schedule.kind !== "external") throw new AutomationStoreError("AUTOMATION_DATE_PAST", "La fecha de ejecución ya ha pasado.");
    const task: AutomationTask = {
      schemaVersion: 1,
      id: options.id ?? randomUUID(),
      installationId: this.options.installationId,
      userId: this.options.userId,
      ...input,
      executionContext: input.executionContext ?? DEFAULT_AUTOMATION_EXECUTION_CONTEXT,
      audience: input.audience ?? {
        membershipPolicy: "current",
        userIds: [this.options.userId],
        groupIds: [],
      },
      state: "active",
      nextRunAt,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
      retryAt: null,
      manualRun: null,
      deletedAt: null,
      cancellationRequestedAt: null,
      lease: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    return this.mutate((snapshot) => {
      const existing = snapshot.tasks.find((candidate) => candidate.id === task.id);
      if (!existing) {
        snapshot.tasks.push(task);
        return task;
      }
      const sameInput = JSON.stringify({ ...existing, state: undefined, nextRunAt: undefined, lastRunAt: undefined,
        lastRunStatus: undefined, lastRunError: undefined, retryAt: undefined, manualRun: undefined,
        deletedAt: undefined, cancellationRequestedAt: undefined, lease: undefined, createdAt: undefined, updatedAt: undefined }) ===
        JSON.stringify({ ...task, state: undefined, nextRunAt: undefined, lastRunAt: undefined,
          lastRunStatus: undefined, lastRunError: undefined, retryAt: undefined, manualRun: undefined,
          deletedAt: undefined, cancellationRequestedAt: undefined, lease: undefined, createdAt: undefined, updatedAt: undefined });
      if (!sameInput) throw new AutomationStoreError("AUTOMATION_CREATE_CONFLICT", "La creación idempotente no coincide con la automatización existente.");
      return { ...existing };
    });
  }

  async update(taskId: string, patch: AutomationTaskPatch, options: {expectedUpdatedAt?:string} = {}) {
    if (!UUID_PATTERN.test(taskId)) throw new AutomationStoreError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.");
    return this.mutate((snapshot) => {
      const index = snapshot.tasks.findIndex((task) => task.id === taskId);
      if (index < 0) throw new AutomationStoreError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.");
      const current = snapshot.tasks[index];
      this.assertOwnership(current);
      if (current.deletedAt !== null) throw new AutomationStoreError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.");
      if (options.expectedUpdatedAt!==undefined && current.updatedAt!==options.expectedUpdatedAt) throw new AutomationStoreError("AUTOMATION_UPDATE_CONFLICT", "La automatización ha cambiado; vuelve a leerla antes de actualizar.");
      const state = patch.state ?? current.state;
      if (current.preparationBlock && state === "active") throw new AutomationStoreError("AUTOMATION_DEPENDENCY_PENDING", current.preparationBlock);
      // A claim is a snapshot of these runtime inputs. Keep its lease while
      // cancelling it so the owning worker can record the terminal history,
      // but fence it before it can produce a turn for obsolete instructions.
      const invalidatesActiveClaim = state === "paused" ||
        "prompt" in patch || "projectId" in patch || "schedule" in patch || "timeZone" in patch || "executionContext" in patch;
      const changesRetryInstructions = "prompt" in patch || "projectId" in patch || "executionContext" in patch;
      // A failed occurrence still owns its deterministic messages while waiting
      // for retry. Cancel it rather than feed a new prompt into those same IDs.
      const cancelsPendingRetry = changesRetryInstructions && current.retryAt !== null &&
        (state === "active" || current.manualRun !== null) &&
        (current.manualRun !== null || !patch.schedule && !patch.timeZone);
      const cancellationRequested = invalidatesActiveClaim && current.lease !== null || cancelsPendingRetry;
      const next: AutomationTask = {
        ...current,
        ...patch,
        state,
        // Retain the lease while a turn is being cancelled. The claimant can
        // then write its terminal history, whereas clearing it would allow a
        // stale process to race a replacement lease.
        lease: current.lease,
        retryAt: state === "paused" || patch.schedule || patch.timeZone ? null : current.retryAt,
        cancellationRequestedAt: cancellationRequested
          ? new Date(this.now()).toISOString()
          : state === "active" ? null : current.cancellationRequestedAt,
        updatedAt: new Date(this.now()).toISOString(),
      };
      if (patch.schedule || patch.timeZone || state === "active" && current.state !== "active") {
        next.nextRunAt = nextScheduledInstant(next.schedule, next.timeZone, new Date(this.now() - 1));
        if (state === "active" && !next.nextRunAt && next.schedule.kind !== "external") throw new AutomationStoreError("AUTOMATION_DATE_PAST", "La fecha de ejecución ya ha pasado.");
      }
      snapshot.tasks[index] = next;
      return next;
    });
  }

  /** Operator only: unblock after validating the connection; leaves the task paused. */
  async setPreparationBlock(taskId: string, reason: string | null) {
    if (reason !== null && (!reason.trim() || reason.length > 500)) throw new Error("Invalid preparation reason");
    return this.mutate((snapshot) => {
      const task = snapshot.tasks.find((item) => item.id === taskId && item.deletedAt === null);
      if (!task) throw new AutomationStoreError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.");
      this.assertOwnership(task);
      task.preparationBlock = reason;
      task.state = "paused";
      task.manualRun = null;
      task.retryAt = null;
      task.nextRunAt = null;
      task.updatedAt = new Date(this.now()).toISOString();
      task.cancellationRequestedAt = task.lease ? task.updatedAt : null;
      return { ...task };
    });
  }

  async delete(taskId: string) {
    return this.mutate((snapshot) => {
      const index = snapshot.tasks.findIndex((task) => task.id === taskId);
      if (index < 0) throw new AutomationStoreError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.");
      const task = snapshot.tasks[index];
      this.assertOwnership(task);
      if (task.deletedAt !== null) throw new AutomationStoreError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.");
      const now = new Date(this.now()).toISOString();
      // Keep a leased record until the owner observes cancellation. This is a
      // durable cancellation fence, not a best-effort process-local signal.
      task.state = "paused";
      task.retryAt = null;
      task.deletedAt = now;
      task.cancellationRequestedAt = task.lease ? now : null;
      task.updatedAt = now;
      return true;
    });
  }

  async runNow(taskId: string, requestId: string, options: {expectedUpdatedAt?:string} = {}) {
    if (!UUID_PATTERN.test(taskId) || !UUID_PATTERN.test(requestId)) {
      throw new AutomationStoreError("AUTOMATION_RUN_REQUEST_INVALID", "La solicitud de ejecución no es válida.");
    }
    const runKey = `${taskId}:manual:${requestId}`;
    // The journal is the durable idempotency ledger after manualRun is cleared
    // on settlement. Replaying the same client request must remain a read even
    // after restart or completion, including an uncertain terminal response.
    if (await this.latestRun(runKey)) return this.get(taskId);
    return this.mutate((snapshot) => {
      const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
      if (!task || task.deletedAt !== null) throw new AutomationStoreError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.");
      this.assertOwnership(task);
      if (task.preparationBlock) throw new AutomationStoreError("AUTOMATION_DEPENDENCY_PENDING", task.preparationBlock);
      if (task.manualRun?.requestId === requestId) return { ...task };
      if (options.expectedUpdatedAt !== undefined && task.updatedAt !== options.expectedUpdatedAt) {
        throw new AutomationStoreError("AUTOMATION_UPDATE_CONFLICT", "La automatización ha cambiado; vuelve a leerla antes de ejecutarla.");
      }
      if (task.manualRun || task.lease) {
        throw new AutomationStoreError("AUTOMATION_RUN_PENDING", "Ya hay una ejecución pendiente o en curso.");
      }
      const now = new Date(this.now()).toISOString();
      // Older paused edits retained the previous calendar's nextRunAt. Repair
      // that derived value during this requested mutation, while preserving a
      // live recurrence's independently pending scheduled occurrence.
      if (task.state === "paused") task.nextRunAt = nextScheduledInstant(task.schedule, task.timeZone, new Date(this.now() - 1));
      task.manualRun = { requestId, scheduledFor: now };
      task.updatedAt = now;
      return { ...task };
    });
  }

  async claimDue(ownerId: string, limit = 10): Promise<ClaimedAutomation[]> {
    if (!IDENTITY_PATTERN.test(ownerId)) throw new AutomationStoreError("AUTOMATION_OWNER_INVALID", "Identidad de worker no válida.");
    const gate = new AutomationMaintenanceGate(this.options);
    return gate.admit(async () => {
      try {
        return await this.mutate((snapshot) => {
      const now = this.now();
      const claims: ClaimedAutomation[] = [];
      for (const task of snapshot.tasks.toSorted((a, b) =>
        (a.retryAt ?? a.manualRun?.scheduledFor ?? a.nextRunAt ?? "").localeCompare(
          b.retryAt ?? b.manualRun?.scheduledFor ?? b.nextRunAt ?? ""))) {
        const scheduledFor = task.manualRun?.scheduledFor ?? task.nextRunAt;
        const dueAt = task.retryAt ?? scheduledFor;
        if (task.preparationBlock || claims.length >= limit || task.deletedAt !== null || (!task.manualRun && task.state !== "active") || !scheduledFor || !dueAt ||
          new Date(dueAt).getTime() > now ||
          (task.lease && new Date(task.lease.expiresAt).getTime() > now)) continue;
        const runKey = task.manualRun
          ? `${task.id}:manual:${task.manualRun.requestId}`
          : `${task.id}:${scheduledFor}`;
        task.lease = {
          runKey,
          ownerId,
          fenceToken: randomUUID(),
          scheduledFor,
          expiresAt: new Date(now + this.leaseMs).toISOString(),
        };
        task.updatedAt = new Date(now).toISOString();
        claims.push({ task: { ...task }, runKey, ownerId, scheduledFor });
      }
      return claims;
        }, { timeoutMs: 0 });
      } catch (error) {
        // Never retain the installation admission fence while waiting behind a
        // settling task writer or the first-install legacy bridge. A later
        // normal poll uses the same untouched occurrence and receipt identity.
        if (error instanceof ResourceLockTimeoutError) return [];
        throw error;
      }
    }, []);
  }

  async settle(claim: ClaimedAutomation, outcome: { status: "succeeded" | "failed"; error?: string | null }) {
    return this.mutate((snapshot) => {
      const task = snapshot.tasks.find((candidate) => candidate.id === claim.task.id);
      if (!task) throw new AutomationStoreError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.");
      this.assertOwnership(task);
      if (!task.lease || task.lease.runKey !== claim.runKey || task.lease.ownerId !== claim.ownerId ||
        task.lease.fenceToken !== claim.task.lease?.fenceToken) {
        throw new AutomationStoreError("AUTOMATION_LEASE_LOST", "La concesión de ejecución ya no pertenece a este worker.");
      }
      task.lastRunAt = new Date(this.now()).toISOString();
      task.lastRunStatus = outcome.status;
      task.lastRunError = outcome.status === "failed" ? (outcome.error ?? "Error de ejecución") : null;
      const manualOccurrence = task.manualRun !== null && claim.runKey === `${task.id}:manual:${task.manualRun.requestId}`;
      // Bound restart catch-up to one occurrence. A long outage must not turn
      // into a burst of every missed daily/weekly job.
      if (manualOccurrence) {
        task.manualRun = null;
      } else if (task.deletedAt !== null) {
        task.nextRunAt = null;
        task.state = "completed";
      } else if (task.state === "paused") {
        // A user pause during a running occurrence applies before the next
        // recurrence. Preserve its terminal outcome but do not reschedule it.
        task.nextRunAt = null;
      } else {
        task.nextRunAt = nextAfterOccurrence(task.schedule, task.timeZone,
          new Date(Math.max(this.now(), new Date(claim.scheduledFor).getTime())).toISOString());
        task.state = task.nextRunAt ? "active" : "completed";
      }
      task.retryAt = null;
      task.cancellationRequestedAt = null;
      task.lease = null;
      task.updatedAt = task.lastRunAt;
      return { ...task };
    });
  }

  async renewLease(claim: ClaimedAutomation) {
    return this.mutate((snapshot) => {
      const task = snapshot.tasks.find((candidate) => candidate.id === claim.task.id);
      if (!task?.lease || task.lease.runKey !== claim.runKey || task.lease.ownerId !== claim.ownerId ||
        task.lease.fenceToken !== claim.task.lease?.fenceToken) {
        throw new AutomationStoreError("AUTOMATION_LEASE_LOST", "La concesión de ejecución ya no pertenece a este worker.");
      }
      if (task.deletedAt !== null || (!task.manualRun && task.state !== "active") || task.cancellationRequestedAt !== null) {
        throw new AutomationStoreError("AUTOMATION_CANCELLED", "La automatización fue cancelada por su propietario.");
      }
      task.lease.expiresAt = new Date(this.now() + this.leaseMs).toISOString();
      task.updatedAt = new Date(this.now()).toISOString();
      return task.lease.expiresAt;
    });
  }

  async appendRun(run: AutomationRun) {
    this.assertRunOwnership(run);
    await this.prepare();
    return this.runs.append(run);
  }

  /** Typed admission/recovery deferral preserves occurrence, history and retry budget. */
  async deferAdmission(claim: ClaimedAutomation, retryAt: string) {
    if(!isIsoDate(retryAt))throw new AutomationStoreError("AUTOMATION_RETRY_INVALID","La reprogramación no es válida.");
    return this.mutate(snapshot=>{
      const task=snapshot.tasks.find(candidate=>candidate.id===claim.task.id);
      if(!task)throw new AutomationStoreError("AUTOMATION_NOT_FOUND","Automatización no encontrada.");
      this.assertOwnership(task);
      if(!task.lease||task.lease.runKey!==claim.runKey||task.lease.ownerId!==claim.ownerId||task.lease.fenceToken!==claim.task.lease?.fenceToken)throw new AutomationStoreError("AUTOMATION_LEASE_LOST","La concesión ya no pertenece a este worker.");
      if(task.deletedAt!==null||(!task.manualRun&&task.state!=="active")||task.cancellationRequestedAt!==null)throw new AutomationStoreError("AUTOMATION_CANCELLED","La automatización fue cancelada por su propietario.");
      task.retryAt=retryAt;task.lease=null;task.updatedAt=new Date(this.now()).toISOString();
      return {...task};
    });
  }

  async retry(claim: ClaimedAutomation, outcome: { error: string; retryAt: string }) {
    if (!isIsoDate(outcome.retryAt)) throw new AutomationStoreError("AUTOMATION_RETRY_INVALID", "La reprogramación no es válida.");
    return this.mutate((snapshot) => {
      const task = snapshot.tasks.find((candidate) => candidate.id === claim.task.id);
      if (!task) throw new AutomationStoreError("AUTOMATION_NOT_FOUND", "Automatización no encontrada.");
      this.assertOwnership(task);
      if (!task.lease || task.lease.runKey !== claim.runKey || task.lease.ownerId !== claim.ownerId ||
        task.lease.fenceToken !== claim.task.lease?.fenceToken) {
        throw new AutomationStoreError("AUTOMATION_LEASE_LOST", "La concesión de ejecución ya no pertenece a este worker.");
      }
      task.lastRunAt = new Date(this.now()).toISOString();
      task.lastRunStatus = "failed";
      task.lastRunError = outcome.error;
      task.retryAt = task.deletedAt === null && (task.state === "active" || task.manualRun !== null) ? outcome.retryAt : null;
      task.cancellationRequestedAt = null;
      task.lease = null;
      task.updatedAt = task.lastRunAt;
      return { ...task };
    });
  }

  private assertRunOwnership(run: AutomationRun) {
    if (run.installationId !== this.options.installationId || run.userId !== this.options.userId) {
      throw new AutomationStoreError("AUTOMATION_IDENTITY_MISMATCH", "La ejecución pertenece a otro usuario o instalación.");
    }
  }

  private async latestAttempts(taskId?: string) {
    await this.prepare();
    const entries = await this.runs.read();
    const latestByAttempt = new Map<string, AutomationRun>();
    for (const entry of entries) {
      const run = entry.payload;
      this.assertRunOwnership(run);
      if (taskId && run.taskId !== taskId) continue;
      // The append-only journal may contain a pre-thread running snapshot, a
      // running snapshot with the durable result thread and the terminal
      // outcome for one attempt.  Product history projects that lifecycle as
      // one row, while retaining every event on disk for recovery/audit.
      latestByAttempt.set(`${run.runKey}\0${run.attempt}`, run);
    }
    return [...latestByAttempt.values()];
  }

  async listRuns(taskId?: string): Promise<AutomationRunHistory[]> {
    const attempts = await this.latestAttempts(taskId);
    const byRun = Map.groupBy(attempts, (run) => run.runKey);
    return attempts.map((run) => {
      if (run.status !== "running") return run;
      const successor = byRun.get(run.runKey)?.filter((candidate) => candidate.attempt > run.attempt)
        .toSorted((left, right) => left.attempt - right.attempt)[0];
      if (!successor) return run;
      // The successor proves this attempt lost ownership, not when it stopped
      // or whether its model turn completed. Keep those facts unknown and keep
      // the original append-only records intact, including legacy recoveries.
      return { ...run, status: "interrupted", recoveredByAttempt: successor.attempt, recoveredAt: successor.startedAt };
    });
  }

  async latestRun(runKey: string) {
    return (await this.latestAttempts()).filter((run) => run.runKey === runKey).at(-1) ?? null;
  }
}
