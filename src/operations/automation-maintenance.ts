import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, ResourceLockManager } from "@/storage";
import {
  MaintenanceCoordinator,
  MaintenanceDrainInterruptedError,
  MaintenanceDrainTimeoutError,
  type MaintenancePhase,
  type MaintenanceStatus,
} from "@/operations/maintenance";

type GateState = {
  schemaVersion: 1;
  installationId: string;
  phase: MaintenancePhase;
  generation: number;
  transitionedAt: string;
};
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const missing = (error: unknown) => record(error) && error.code === "ENOENT";
function corrupt(): never { throw new Error("Automation maintenance storage is invalid or unsafe."); }

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
    await realpath(directory) !== path.join(await realpath(path.dirname(directory)), path.basename(directory))) corrupt();
}

async function readPrivateJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()) corrupt();
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

/** Cross-process admission fence. The gate lock is held until claims are durable.
 * Renew/settle intentionally use only the task lock, so admitted work can finish
 * while admission is closed. Expiration never counts as settlement. Deferred
 * occurrences remain blockers: a null lease does not prove remote release. */
export class AutomationMaintenanceGate {
  readonly root: string;
  readonly statePath: string;
  private readonly locks: ResourceLockManager;
  constructor(readonly options: { installationId: string; usersRoot: string }) {
    if (!ID.test(options.installationId) || !path.isAbsolute(options.usersRoot)) corrupt();
    this.root = path.join(path.resolve(options.usersRoot), ".automation-maintenance");
    this.statePath = path.join(this.root, "state.json");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(this.root, "locks") });
  }

  private async locked<T>(operation: () => Promise<T>) {
    await privateDirectory(this.root);
    await privateDirectory(path.join(this.root, "locks"));
    return this.locks.withLock("admission", operation);
  }

  private async read(): Promise<GateState> {
    let value: unknown;
    try { value = await readPrivateJson(this.statePath); }
    catch (error) {
      if (!missing(error)) throw error;
      return { schemaVersion: 1, installationId: this.options.installationId,
        phase: "accepting", generation: 1, transitionedAt: new Date(0).toISOString() };
    }
    if (!record(value) || Object.keys(value).length !== 5 || value.schemaVersion !== 1 ||
      value.installationId !== this.options.installationId ||
      !["accepting", "draining", "maintenance"].includes(String(value.phase)) ||
      !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 ||
      typeof value.transitionedAt !== "string" || !Number.isFinite(Date.parse(value.transitionedAt))) corrupt();
    return value as GateState;
  }

  async admit<T>(claim: () => Promise<T>, deferred: T): Promise<T> {
    return this.locked(async () => (await this.read()).phase === "accepting" ? claim() : deferred);
  }

  async state(): Promise<GateState> { return this.locked(() => this.read()); }

  async beginDrain(): Promise<GateState> {
    return this.locked(async () => {
      const state = await this.read();
      if (state.phase !== "accepting") return state;
      return this.write(state, "draining");
    });
  }

  private async write(state: GateState, phase: MaintenancePhase, advanceGeneration = true) {
    const next: GateState = { ...state, phase, generation: state.generation + (advanceGeneration ? 1 : 0),
      transitionedAt: new Date().toISOString() };
    await atomicWriteFile(this.statePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return next;
  }

  async resume() {
    return this.locked(async () => {
      const state = await this.read();
      return state.phase === "accepting" ? state : this.write(state, "accepting");
    });
  }

  /** Read every store, including disabled/deleted users and cancelled tasks.
   * Store files are atomic snapshots. With admission closed they can only lose
   * admitted occurrences or renew them, so an old snapshot can overcount but cannot miss work. */
  async activeJobs(): Promise<number> {
    let count = 0;
    const usersRoot = await realpath(this.options.usersRoot);
    for (const entry of await readdir(usersRoot, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      // User identities use the same bounded identity contract as the store.
      if (!ID.test(entry.name)) corrupt();
      if (!entry.isDirectory() || entry.isSymbolicLink()) corrupt();
      const directory = path.join(usersRoot, entry.name, "automations");
      try {
        const metadata = await lstat(directory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
          await realpath(directory) !== directory) corrupt();
        const value = await readPrivateJson(path.join(directory, "tasks.json"));
        if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.tasks)) corrupt();
        for (const task of value.tasks) {
          if (!record(task) || !UUID.test(String(task.id)) || task.installationId !== this.options.installationId ||
            task.userId !== entry.name || !("lease" in task)) corrupt();
          if (task.retryAt !== undefined && task.retryAt !== null &&
            (typeof task.retryAt !== "string" || !Number.isFinite(Date.parse(task.retryAt)))) corrupt();
          if (task.lease === null) {
            if (task.retryAt) count += 1;
            continue;
          }
          if (!record(task.lease) || typeof task.lease.runKey !== "string" ||
            typeof task.lease.ownerId !== "string" || typeof task.lease.expiresAt !== "string" ||
            !Number.isFinite(Date.parse(task.lease.expiresAt))) corrupt();
          count += 1;
        }
      } catch (error) { if (!missing(error)) throw error; }
    }
    return count;
  }

  async finishDrain(generation: number) {
    return this.locked(async () => {
      const state = await this.read();
      if (state.generation !== generation || state.phase === "accepting") throw new MaintenanceDrainInterruptedError();
      if (await this.activeJobs() !== 0) return false;
      if (state.phase !== "maintenance") await this.write(state, "maintenance", false);
      return true;
    });
  }
}

export async function installationMaintenanceStatus(local: MaintenanceCoordinator, gate: AutomationMaintenanceGate): Promise<MaintenanceStatus> {
  const shared = await gate.state();
  const jobs = await gate.activeJobs();
  const current = local.status();
  const phase = shared.phase === "accepting" ? current.phase :
    (shared.phase === "maintenance" && current.activeActivities === 0 && jobs === 0 ? "maintenance" : "draining");
  return { ...current, phase, generation: shared.generation, transitionedAt: shared.transitionedAt,
    activeActivities: current.activeActivities + jobs,
    activeByKind: { ...current.activeByKind, automation: jobs } };
}

export async function enterInstallationMaintenance(local: MaintenanceCoordinator, gate: AutomationMaintenanceGate, options: { timeoutMs: number }) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000) {
    throw new Error("timeoutMs must be an integer between 1 and 600000.");
  }
  const deadline = Date.now() + options.timeoutMs;
  const shared = await gate.beginDrain();
  const results = await Promise.allSettled([
    local.enter({ timeoutMs: Math.max(1, deadline - Date.now()) }),
    (async () => {
      while (true) {
        const state = await gate.state();
        if (state.phase === "accepting" || state.generation !== shared.generation) throw new MaintenanceDrainInterruptedError();
        if (await gate.activeJobs() === 0) return;
        if (Date.now() >= deadline) throw new MaintenanceDrainTimeoutError(await installationMaintenanceStatus(local, gate));
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
      }
    })(),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  if (!await gate.finishDrain(shared.generation)) throw new MaintenanceDrainTimeoutError(await installationMaintenanceStatus(local, gate));
  return installationMaintenanceStatus(local, gate);
}

export async function resumeInstallationMaintenance(local: MaintenanceCoordinator, gate: AutomationMaintenanceGate) {
  // Reopen local admission only after the durable cross-process fence is clear.
  await gate.resume();
  local.resume();
  return installationMaintenanceStatus(local, gate);
}
