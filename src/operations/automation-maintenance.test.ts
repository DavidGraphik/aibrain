import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAutomationStore } from "@/automations/store";
import { runClaimedAutomation } from "@/automations/runner";
import { BackgroundModelAdmissionDeferred } from "@/runtime/model-turn-queue";
import { WorkerTurnRecoveryPendingError } from "@/runtime/worker-turn-recovery-error";
import { MaintenanceCoordinator } from "@/operations/maintenance";
import { AutomationMaintenanceGate, enterInstallationMaintenance, installationMaintenanceStatus, resumeInstallationMaintenance } from "@/operations/automation-maintenance";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const usersRoot = await mkdtemp(path.join(tmpdir(), "automation-maintenance-")); roots.push(usersRoot);
  let clock = Date.parse("2026-11-05T08:00:00.000Z");
  const options = { usersRoot, installationId: "tenant-one", userId, now: () => clock, leaseMs: 1000 };
  const store = new FileAutomationStore(options);
  const task = await store.create({ name: "Informe interno", prompt: "Revisa el documento interno.", projectId,
    projectName: "Operaciones", timeZone: "Europe/Madrid", schedule: { kind: "once", runAt: "2026-11-05T09:00:00.000Z" } });
  clock = Date.parse("2026-11-05T09:00:00.000Z");
  return { store, task, options, advance: () => { clock += 2000; },
    gate: new AutomationMaintenanceGate(options), local: new MaintenanceCoordinator() };
}
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

describe("installation automation maintenance", () => {
  it("drains a previously admitted real runner through durable settlement, defers new claims, and resumes across fresh instances without duplicates", async () => {
    const { store, task, options, gate, local } = await fixture();
    const [claim] = await store.claimDue("old-worker", 1);
    const running = deferred(); const finish = deferred(); let executions = 0;
    const execution = runClaimedAutomation({ store, claim, now: options.now, execute: async () => {
      executions += 1; running.release(); await finish.promise; return { threadId: projectId };
    } });
    await running.promise;
    const drain = enterInstallationMaintenance(local, gate, { timeoutMs: 2000 });
    // beginDrain shares the exact admission lock used by the independent store.
    const shared = await gate.beginDrain(); expect(shared.phase).toBe("draining");
    await expect(new FileAutomationStore(options).claimDue("new-worker")).resolves.toEqual([]);
    expect(await installationMaintenanceStatus(local, gate)).toMatchObject({ phase: "draining", activeActivities: 1, activeByKind: { automation: 1 } });
    finish.release(); await execution;
    expect(await drain).toMatchObject({ phase: "maintenance", activeActivities: 0 });
    expect((await store.listRuns(task.id)).map(({ status }) => status)).toEqual(["succeeded"]);
    expect(executions).toBe(1);
    const queued = await store.create({ name: "Siguiente", prompt: "Otra revisión interna.", projectId,
      projectName: "Operaciones", timeZone: "Europe/Madrid", schedule: { kind: "once", runAt: "2026-11-05T10:00:00.000Z" } });
    await store.runNow(queued.id, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const tasksBefore = await readFile(store.tasksPath, "utf8");
    const freshGate = new AutomationMaintenanceGate(options);
    await expect(new FileAutomationStore(options).claimDue("replacement-worker")).resolves.toEqual([]);
    expect(await readFile(store.tasksPath, "utf8")).toBe(tasksBefore);
    await resumeInstallationMaintenance(new MaintenanceCoordinator(), freshGate);
    const claims = await new FileAutomationStore(options).claimDue("replacement-worker");
    expect(claims.map(({ task }) => task.id)).toEqual([queued.id]);
    expect(await store.claimDue("concurrent-worker")).toEqual([]);
  });

  it("shares the closed fence with a separate scheduler process and resumes the same queued occurrence", async () => {
    const { options, gate, store, task } = await fixture();
    const before = await readFile(store.tasksPath, "utf8");
    await gate.beginDrain();
    const script = `import storeModule from './src/automations/store.ts';
      const { FileAutomationStore } = storeModule;
      const options = JSON.parse(process.argv[1]);
      const store = new FileAutomationStore({...options, now: () => Date.parse('2026-11-05T09:00:00.000Z')});
      console.log(JSON.stringify((await store.claimDue('separate-worker')).map(({task,runKey}) => ({id:task.id,runKey}))));`;
    const child = () => promisify(execFile)(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(options)], { cwd: process.cwd() });
    expect(JSON.parse((await child()).stdout)).toEqual([]);
    expect(await readFile(store.tasksPath, "utf8")).toBe(before);
    await gate.resume();
    expect(JSON.parse((await child()).stdout)).toEqual([{ id: task.id, runKey: `${task.id}:2026-11-05T09:00:00.000Z` }]);
    expect(await gate.activeJobs()).toBe(1);
  });

  it("does not hold admission behind a cross-process legacy holder during new claims, resume and receiver status readback", async () => {
    const { gate, store, options, local, task } = await fixture();
    const before = await readFile(store.tasksPath, "utf8");
    const script = `import lockModule from './src/storage/resource-lock.ts';
      const {ResourceLockManager} = lockModule;
      const manager = new ResourceLockManager({rootDirectory:process.argv[1]});
      const lease = await manager.acquire('automation-tasks');
      console.log('HELD');
      process.stdin.once('data',async()=>{await lease.release();process.exit(0);});`;
    const holder = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script,
      path.join(store.root, "locks")], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(holder, "close");
    const lines = createInterface({ input: holder.stdout });
    try {
      expect((await once(lines, "line"))[0]).toBe("HELD");
      await enterInstallationMaintenance(local, gate, { timeoutMs: 1000 });
      await gate.resume();
      // Same race as receiver resume: the durable gate is accepting before its
      // final status read, while the old holder still owns every task lock.
      const results = await Promise.all([
        new FileAutomationStore(options).claimDue("replacement-scheduler"),
        resumeInstallationMaintenance(local, gate),
        installationMaintenanceStatus(local, gate),
      ]);
      expect(results[0]).toEqual([]);
      expect(results[1]).toMatchObject({ phase: "accepting", activeActivities: 0 });
      expect(await installationMaintenanceStatus(local, gate)).toMatchObject({ phase: "accepting", activeActivities: 0 });
      expect(await readFile(store.tasksPath, "utf8")).toBe(before);
      expect(await store.listRuns()).toEqual([]);
    } finally {
      holder.stdin.end("release\n"); await exited; lines.close();
    }
    const [claim] = await store.claimDue("replacement-scheduler");
    expect(claim.task.id).toBe(task.id);
    expect(claim.runKey).toBe(`${task.id}:2026-11-05T09:00:00.000Z`);
    expect(await store.claimDue("other-scheduler")).toEqual([]);
  });

  it("does not treat an expired lease as finished and reports timeout honestly without changing the task or prior outcome", async () => {
    const { store, gate, local, advance } = await fixture();
    const [claim] = await store.claimDue("old-worker"); advance();
    const before = await readFile(store.tasksPath, "utf8");
    await expect(enterInstallationMaintenance(local, gate, { timeoutMs: 20 })).rejects.toMatchObject({ code: "MAINTENANCE_DRAIN_TIMEOUT", status: { activeActivities: 1 } });
    expect(await readFile(store.tasksPath, "utf8")).toBe(before);
    expect(await store.listRuns()).toEqual([]);
    expect(await store.claimDue("replacement-worker")).toEqual([]);
    await store.settle(claim, { status: "failed", error: "Actual failure" });
    expect(await enterInstallationMaintenance(local, gate, { timeoutMs: 200 })).toMatchObject({ phase: "maintenance", activeActivities: 0 });
  });

  it("keeps a deferred remote recovery fenced after its lease was released, then permits normal reconciliation only after resume", async () => {
    const { store, gate, local, options, advance } = await fixture();
    const [claim] = await store.claimDue("old-worker");
    await store.deferAdmission(claim, "2026-11-05T09:00:01.000Z"); advance();
    expect((await store.get(claim.task.id)).lease).toBeNull();
    const before = await readFile(store.tasksPath, "utf8");
    await expect(enterInstallationMaintenance(local, gate, { timeoutMs: 20 })).rejects.toMatchObject({ code: "MAINTENANCE_DRAIN_TIMEOUT", status: { activeActivities: 1 } });
    expect(await store.claimDue("new-worker")).toEqual([]);
    expect(await readFile(store.tasksPath, "utf8")).toBe(before);
    await resumeInstallationMaintenance(local, gate);
    const [recovery] = await new FileAutomationStore(options).claimDue("normal-reconciliation");
    expect(recovery.runKey).toBe(claim.runKey);
    await store.settle(recovery, { status: "failed", error: "Verified terminal failure" });
    expect(await enterInstallationMaintenance(local, gate, { timeoutMs: 200 })).toMatchObject({ phase: "maintenance", activeActivities: 0 });
    expect((await store.get(claim.task.id)).lastRunError).toBe("Verified terminal failure");
  });

  it.each([new BackgroundModelAdmissionDeferred(), new WorkerTurnRecoveryPendingError()])(
    "fails closed for indistinguishable persisted deferral (%s), but does not count never-admitted queued work",
    async (deferral) => {
      const { store, task, gate, options, local } = await fixture();
      expect(await gate.activeJobs()).toBe(0);
      await store.update(task.id, { state: "paused" });
      await store.runNow(task.id, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
      expect(await gate.activeJobs()).toBe(0);
      const [claim] = await store.claimDue("worker");
      expect(await runClaimedAutomation({ store, claim, now: options.now,
        execute: async () => { throw deferral; } })).toMatchObject({ status: "deferred", error: null });
      expect(await store.get(task.id)).toMatchObject({ lease: null, retryAt: "2026-11-05T09:00:30.000Z", lastRunStatus: null });
      // The current durable contract records neither typed reason. Do not infer
      // safe no-dispatch from an error string or from the cleared task lease.
      await expect(enterInstallationMaintenance(local, gate, { timeoutMs: 20 })).rejects.toMatchObject({ code: "MAINTENANCE_DRAIN_TIMEOUT" });
      expect(await gate.activeJobs()).toBe(1);
    },
  );

  it("includes foreground work and permits settlement/cancellation while closed", async () => {
    const { store, task, gate, local } = await fixture();
    const [claim] = await store.claimDue("worker");
    const foreground = local.acquire("turn");
    const drain = enterInstallationMaintenance(local, gate, { timeoutMs: 2000 });
    await gate.beginDrain();
    await store.delete(task.id);
    expect(await gate.activeJobs()).toBe(1);
    await store.settle(claim, { status: "failed", error: "Cancelled by owner" });
    expect((await installationMaintenanceStatus(local, gate)).activeActivities).toBe(1);
    foreground.release();
    expect(await drain).toMatchObject({ phase: "maintenance", activeActivities: 0 });
  });

  it("serializes a claim already inside admission before closing and never admits after closure", async () => {
    const { gate, options } = await fixture();
    const entered = deferred(); const persist = deferred(); const order: string[] = [];
    const admission = gate.admit(async () => { order.push("claim"); entered.release(); await persist.promise; order.push("durable"); return [1]; }, []);
    await entered.promise;
    const closing = new AutomationMaintenanceGate(options).beginDrain().then(() => { order.push("closed"); });
    persist.release(); await Promise.all([admission, closing]);
    expect(order).toEqual(["claim", "durable", "closed"]);
    expect(await gate.admit(async () => { throw new Error("must not execute"); }, [])).toEqual([]);
  });

  it("explicit resume interrupts pending drains rather than publishing maintenance", async () => {
    const { store, gate, local } = await fixture(); await store.claimDue("worker");
    const drain = enterInstallationMaintenance(local, gate, { timeoutMs: 1000 });
    const result = drain.then(() => null, (error: unknown) => error);
    await gate.beginDrain(); await resumeInstallationMaintenance(local, gate); expect(await result).toMatchObject({ code: "MAINTENANCE_DRAIN_INTERRUPTED" });
    expect((await gate.state()).phase).toBe("accepting");
  });

  it("fails closed for a foreign installation, malformed state and symlink state", async () => {
    const { gate, options, store } = await fixture(); await gate.beginDrain();
    const foreign = new AutomationMaintenanceGate({ ...options, installationId: "tenant-two" });
    await expect(foreign.state()).rejects.toThrow("invalid or unsafe");
    await writeFile(gate.statePath, "{}", { mode: 0o600 });
    await expect(store.claimDue("worker")).rejects.toThrow("invalid or unsafe");
    await rm(gate.statePath); await symlink(store.tasksPath, gate.statePath);
    await expect(gate.state()).rejects.toThrow();
  });

  it("refuses unsafe or foreign owner snapshots instead of claiming zero active work", async () => {
    const { gate, store } = await fixture(); await gate.beginDrain();
    const snapshot = JSON.parse(await readFile(store.tasksPath, "utf8")); snapshot.tasks[0].userId = projectId;
    await writeFile(store.tasksPath, JSON.stringify(snapshot));
    await expect(gate.activeJobs()).rejects.toThrow("invalid or unsafe");
    snapshot.tasks[0].userId = userId; await writeFile(store.tasksPath, JSON.stringify(snapshot)); await chmod(store.tasksPath, 0o644);
    await expect(gate.activeJobs()).rejects.toThrow("invalid or unsafe");
  });
});
