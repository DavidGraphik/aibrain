import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAutomationStore, type ClaimedAutomation } from "@/automations/store";
import { BackgroundModelAdmissionDeferred } from "@/runtime/model-turn-queue";
import { WorkerTurnRecoveryPendingError } from "@/runtime/worker-turn-recovery-error";
import { RuntimeProjectionAdmissionDeferred } from "@/runtime/transport/projection-readiness";
import { runAutomationSweep } from "@/automations/runner";

const roots: string[] = [];
const projectId = "11111111-1111-4111-8111-111111111111";
const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function root() {
  const value = await mkdtemp(path.join(tmpdir(), "aibrain-automations-"));
  roots.push(value);
  await mkdir(path.join(value, userA), { recursive: true, mode: 0o700 });
  await mkdir(path.join(value, userB), { recursive: true, mode: 0o700 });
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

function input(runAt: string) {
  return {
    name: "Informe",
    prompt: "Prepara el informe semanal.",
    projectId,
    projectName: "Operaciones",
    timeZone: "Europe/Madrid",
    schedule: { kind: "once" as const, runAt },
  };
}

describe("FileAutomationStore", () => {
  it("projects abandoned attempts as interrupted without rewriting their audit or inventing a finish time", async () => {
    const usersRoot = await root();
    const store = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot });
    const task = await store.create(input("2030-08-28T09:00:00.000Z"));
    const runKey = `${task.id}:2030-08-28T09:00:00.000Z`;
    const running = {
      schemaVersion: 1 as const, runKey, taskId: task.id, installationId: "tenant-one", userId: userA,
      scheduledFor: "2030-08-28T09:00:00.000Z", status: "running" as const, attempt: 1,
      startedAt: "2030-08-28T09:00:00.000Z", finishedAt: null, threadId: projectId, error: null,
    };
    await store.appendRun(running);
    expect(await store.listRuns()).toEqual([running]);
    const successor = { ...running, attempt: 2, startedAt: "2030-08-28T09:10:00.000Z" };
    await store.appendRun(successor);
    const journalPath = path.join(usersRoot, userA, "automations", "runs.jsonl");
    const journalBefore = await readFile(journalPath, "utf8");
    expect(await store.listRuns(task.id)).toEqual([
      { ...running, status: "interrupted", recoveredByAttempt: 2, recoveredAt: successor.startedAt }, successor,
    ]);
    expect(await store.latestRun(runKey)).toEqual(successor);
    expect(await readFile(journalPath, "utf8")).toBe(journalBefore);
    await store.appendRun({ ...successor, status: "succeeded", finishedAt: "2030-08-28T09:12:00.000Z" });
    const terminalJournal = await readFile(journalPath, "utf8");
    expect((await store.listRuns(task.id)).map(({ status }) => status)).toEqual(["interrupted", "succeeded"]);
    expect((await store.latestRun(runKey))?.status).toBe("succeeded");
    expect(await readFile(journalPath, "utf8")).toBe(terminalJournal);
    const otherRun = { ...running, runKey: `${task.id}:other`, attempt: 1 };
    await store.appendRun(otherRun);
    expect((await store.listRuns()).at(-1)).toEqual(otherRun);
  });
  it("isolates tasks and runs by tenant user", async () => {
    const usersRoot = await root();
    const now = () => Date.parse("2026-08-28T08:00:00.000Z");
    const first = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now });
    const second = new FileAutomationStore({ installationId: "tenant-one", userId: userB, usersRoot, now });
    await first.create(input("2026-08-28T09:00:00.000Z"));
    expect(await first.list()).toHaveLength(1);
    expect(await second.list()).toEqual([]);
    expect(await second.listRuns()).toEqual([]);
  });

  it("migrates legacy tasks to an explicit owner-only audience without changing their ids", async () => {
    const usersRoot = await root();
    const now = () => Date.parse("2026-08-28T08:00:00.000Z");
    const store = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now });
    const created = await store.create(input("2026-08-28T09:00:00.000Z"));
    const legacy = JSON.parse(await readFile(store.tasksPath, "utf8")) as { tasks: Array<Record<string, unknown>> };
    delete legacy.tasks[0]?.audience;
    await writeFile(store.tasksPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

    const [migrated] = await new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now }).list();
    expect(migrated).toMatchObject({ id: created.id, audience: { membershipPolicy: "current", userIds: [userA], groupIds: [] } });
    expect(JSON.parse(await readFile(store.tasksPath, "utf8")).tasks[0].audience)
      .toEqual({ membershipPolicy: "current", userIds: [userA], groupIds: [] });
  });

  it("persists an edited one-time date and time across a fresh store read", async () => {
    const usersRoot = await root();
    const now = () => Date.parse("2026-08-28T08:00:00.000Z");
    const first = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now });
    const created = await first.create(input("2026-08-28T09:00:00.000Z"));
    await first.update(created.id, { schedule: { kind: "once", runAt: "2026-08-29T22:31:00.000Z" } });

    const restarted = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now });
    expect(await restarted.get(created.id)).toMatchObject({
      schedule: { kind: "once", runAt: "2026-08-29T22:31:00.000Z" },
      nextRunAt: "2026-08-29T22:31:00.000Z",
    });
  });

  it("deduplicates concurrent claims with a filesystem lease", async () => {
    const usersRoot = await root();
    let clock = Date.parse("2026-08-28T08:00:00.000Z");
    const store = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now: () => clock });
    await store.create(input("2026-08-28T09:00:00.000Z"));
    clock = Date.parse("2026-08-28T09:00:00.000Z");
    const [left, right] = await Promise.all([store.claimDue("worker-left"), store.claimDue("worker-right")]);
    expect(left.length + right.length).toBe(1);
    expect(new Set([...left, ...right].map((claim) => claim.runKey)).size).toBe(1);
  });

  it("records failures and advances a recurring task", async () => {
    const usersRoot = await root();
    let clock = Date.parse("2026-08-28T07:59:00.000Z");
    const store = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now: () => clock });
    await store.create({ ...input("2026-08-28T09:00:00.000Z"), schedule: { kind: "daily", hour: 10, minute: 0 } });
    clock = Date.parse("2026-08-28T08:00:00.000Z");
    const results = await runAutomationSweep({
      store,
      ownerId: "worker-one",
      now: () => clock,
      maxAttempts: 1,
      execute: async () => { throw new Error("Runtime no disponible"); },
    });
    expect(results).toMatchObject([{ status: "failed", error: "Runtime no disponible" }]);
    const [task] = await store.list();
    expect(task.lastRunStatus).toBe("failed");
    expect(task.nextRunAt).toBe("2026-08-29T08:00:00.000Z");
    expect((await store.listRuns()).map((run) => run.status)).toEqual(["failed"]);
  });

  it("does not execute a terminal run twice after lease recovery", async () => {
    const usersRoot = await root();
    let clock = Date.parse("2026-08-28T08:00:00.000Z");
    const store = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now: () => clock, leaseMs: 1_000 });
    await store.create(input("2026-08-28T09:00:00.000Z"));
    clock = Date.parse("2026-08-28T09:00:00.000Z");
    const [claim] = await store.claimDue("worker-one");
    await store.appendRun({
      schemaVersion: 1,
      runKey: claim.runKey,
      taskId: claim.task.id,
      installationId: claim.task.installationId,
      userId: claim.task.userId,
      scheduledFor: claim.scheduledFor,
      status: "succeeded",
      attempt: 1,
      startedAt: new Date(clock).toISOString(),
      finishedAt: new Date(clock).toISOString(),
      threadId: projectId,
      error: null,
    });
    clock += 2_000;
    let executions = 0;
    await runAutomationSweep({
      store,
      ownerId: "worker-two",
      now: () => clock,
      execute: async () => { executions += 1; return { threadId: null }; },
    });
    expect(executions).toBe(0);
    expect((await store.list())[0].state).toBe("completed");
  });

  it("persists exponential retries with the same idempotency key", async () => {
    const usersRoot = await root();
    let clock = Date.parse("2026-08-28T09:00:00.000Z");
    const store = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now: () => clock });
    await store.create(input("2026-08-28T09:00:00.000Z"));
    const first = await runAutomationSweep({
      store,
      ownerId: "worker-one",
      now: () => clock,
      retryBaseMs: 1_000,
      execute: async () => { throw new Error("transient"); },
    });
    expect(first).toMatchObject([{ status: "failed", error: "transient" }]);
    const [pending] = await store.list();
    expect(pending.retryAt).toBe("2026-08-28T09:00:01.000Z");
    const firstRunKey = (await store.listRuns())[0].runKey;
    clock += 1_000;
    await runAutomationSweep({
      store,
      ownerId: "worker-two",
      now: () => clock,
      retryBaseMs: 1_000,
      execute: async () => ({ threadId: projectId }),
    });
    const runs = await store.listRuns();
    expect(runs.at(-1)).toMatchObject({ runKey: firstRunKey, status: "succeeded", attempt: 2 });
    expect((await store.list())[0].state).toBe("completed");
  });

  it("fences a stale worker after a recovered lease", async () => {
    const usersRoot = await root();
    let clock = Date.parse("2026-08-28T09:00:00.000Z");
    const store = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now: () => clock, leaseMs: 1_000 });
    await store.create(input("2026-08-28T09:00:00.000Z"));
    const [first] = await store.claimDue("worker-one");
    clock += 1_001;
    const [second] = await store.claimDue("worker-two");
    await expect(store.renewLease(first)).rejects.toMatchObject({ code: "AUTOMATION_LEASE_LOST" });
    await store.settle(second, { status: "succeeded" });
    expect((await store.list())[0].state).toBe("completed");
  });

  it("prevents a fenced worker from appending a stale failure after its successor succeeds", async () => {
    const usersRoot = await root();
    let clock = Date.parse("2026-08-28T09:00:00.000Z");
    const store = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now: () => clock, leaseMs: 100 });
    await store.create(input("2026-08-28T09:00:00.000Z"));
    let started!: () => void;
    const executing = new Promise<void>((resolve) => { started = resolve; });
    const staleSweep = runAutomationSweep({
      store,
      ownerId: "worker-stale",
      now: () => clock,
      leaseRenewalMs: 1_000,
      execute: async (_claim, _threadId, _prepared, signal) => {
        started();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return { threadId: projectId };
      },
    });
    await executing;
    clock += 101;
    const [successor] = await store.claimDue("worker-successor");
    const startedAt = new Date(clock).toISOString();
    await store.appendRun({
      schemaVersion: 1,
      runKey: successor.runKey,
      taskId: successor.task.id,
      installationId: successor.task.installationId,
      userId: successor.task.userId,
      scheduledFor: successor.scheduledFor,
      status: "running",
      attempt: 2,
      startedAt,
      finishedAt: null,
      threadId: projectId,
      error: null,
    });
    await store.appendRun({
      schemaVersion: 1,
      runKey: successor.runKey,
      taskId: successor.task.id,
      installationId: successor.task.installationId,
      userId: successor.task.userId,
      scheduledFor: successor.scheduledFor,
      status: "succeeded",
      attempt: 2,
      startedAt,
      finishedAt: startedAt,
      threadId: projectId,
      error: null,
    });
    await store.settle(successor, { status: "succeeded" });
    await staleSweep;

    const history = await store.listRuns(successor.task.id);
    expect(history.at(-1)).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(history.filter((run) => run.status === "failed")).toEqual([]);
  });

  it("runs independent claims concurrently but never duplicates their run key", async () => {
    const usersRoot = await root();
    const clock = Date.parse("2026-08-28T09:00:00.000Z");
    const store = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now: () => clock });
    await store.create(input("2026-08-28T09:00:00.000Z"));
    await store.create({ ...input("2026-08-28T09:00:00.000Z"), name: "Segundo" });
    let running = 0;
    let maximum = 0;
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve; });
    await runAutomationSweep({
      store,
      ownerId: "worker-one",
      concurrency: 2,
      now: () => clock,
      execute: async () => {
        running += 1;
        maximum = Math.max(maximum, running);
        if (running === 2) releaseBoth();
        await bothStarted;
        running -= 1;
        return { threadId: projectId };
      },
    });
    expect(maximum).toBe(2);
    expect(new Set((await store.listRuns()).filter((run) => run.status === "succeeded").map((run) => run.runKey)).size).toBe(2);
  });

  it("cancels an in-flight deletion without retrying and retains its durable history", async () => {
    const usersRoot = await root();
    const clock = Date.parse("2026-08-28T09:00:00.000Z");
    const store = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now: () => clock });
    const task = await store.create(input("2026-08-28T09:00:00.000Z"));
    let started!: () => void;
    const executing = new Promise<void>((resolve) => { started = resolve; });
    const sweep = runAutomationSweep({
      store,
      ownerId: "worker-one",
      now: () => clock,
      leaseRenewalMs: 1,
      execute: async (_claim, _threadId, _prepared, signal) => {
        started();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return { threadId: projectId };
      },
    });
    await executing;
    await store.delete(task.id);
    await sweep;

    expect(await store.list()).toEqual([]);
    const history = await store.listRuns(task.id);
    expect(history.at(-1)).toMatchObject({ status: "failed", attempt: 1, error: "La automatización fue cancelada por su propietario." });
    expect(history.filter((run) => run.status === "running")).toHaveLength(0);
  });

  it("fences an in-flight claim when a foreground note grant changes execution context", async()=>{
    const usersRoot=await root(),clock=Date.parse("2026-08-28T09:00:00.000Z");
    const store=new FileAutomationStore({installationId:"tenant-one",userId:userA,usersRoot,now:()=>clock});
    const task=await store.create(input("2026-08-28T09:00:00.000Z"));
    const [claim]=await store.claimDue("worker-note",1);
    await store.update(task.id,{executionContext:{webSearch:true,inheritAuthorizedSkills:true,inheritAuthorizedConnectors:true}});
    const saved=await store.get(task.id);expect(saved.lease?.fenceToken).toBe(claim.task.lease?.fenceToken);expect(saved.cancellationRequestedAt).not.toBeNull();
  });

  it("fences an in-flight claim when its runtime inputs change", async () => {
    const usersRoot = await root();
    const clock = Date.parse("2026-08-28T09:00:00.000Z");
    const store = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now: () => clock });
    const task = await store.create(input("2026-08-28T09:00:00.000Z"));
    const [claim] = await store.claimDue("worker-one");
    await store.update(task.id, { prompt: "Genera el informe únicamente con cifras aprobadas." });
    await expect(store.renewLease(claim)).rejects.toMatchObject({ code: "AUTOMATION_CANCELLED" });
    expect((await store.list())[0]).toMatchObject({ state: "active", cancellationRequestedAt: expect.any(String) });
  });

  it("persists the prepared result thread in the durable run history", async () => {
    const usersRoot = await root();
    const clock = Date.parse("2026-08-28T09:00:00.000Z");
    const store = new FileAutomationStore({ installationId: "tenant-one", userId: userA, usersRoot, now: () => clock });
    await store.create(input("2026-08-28T09:00:00.000Z"));
    await runAutomationSweep({
      store,
      ownerId: "offline-worker",
      now: () => clock,
      execute: async (_claim, _threadId, prepared) => {
        await prepared(projectId);
        return { threadId: projectId };
      },
    });

    expect((await store.listRuns()).at(-1)).toMatchObject({ status: "succeeded", threadId: projectId });
  });
});

it('persists an operator dependency gate across restart, editing and manual execution', async () => {
  const usersRoot = await root();
  const now = () => Date.parse('2026-08-28T08:00:00.000Z');
  const store = new FileAutomationStore({installationId:'g03-production',userId:userA,usersRoot,now});
  const task = await store.create(input('2026-08-28T09:00:00.000Z'));
  await store.setPreparationBlock(task.id,'Pendent de connexió a SAGE');
  const restarted = new FileAutomationStore({installationId:'g03-production',userId:userA,usersRoot,now});
  await restarted.update(task.id,{name:'Nou nom',prompt:'Una altra instrucció'});
  await expect(restarted.update(task.id,{state:'active'})).rejects.toThrow('SAGE');
  await expect(restarted.runNow(task.id,'11111111-1111-4111-8111-111111111112')).rejects.toThrow('SAGE');
  expect(await restarted.claimDue('worker')).toEqual([]);
  await restarted.setPreparationBlock(task.id,null);
  expect((await restarted.get(task.id)).state).toBe('paused');
  await restarted.update(task.id,{state:'active'});
});

it("persists an unbounded calendar recurrence and reconciles direct-chat retries after restart", async () => {
  const usersRoot = await root();
  const options = { installationId: "tenant-one", userId: userA, usersRoot, now: () => Date.parse("2026-10-26T08:00:00.000Z") };
  const schedule = { kind: "monthly" as const, months: [2,5,8,11], day: 1, hour: 9, minute: 0 };
  const taskInput = { ...input("2026-11-01T08:00:00.000Z"), schedule };
  const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const created = await new FileAutomationStore(options).create(taskInput, { id });
  const reopened = new FileAutomationStore(options);
  expect(await reopened.create(taskInput, { id })).toEqual(created);
  expect(await reopened.list()).toHaveLength(1);
  expect(await reopened.get(id)).toMatchObject({ schedule, nextRunAt: "2026-11-01T08:00:00.000Z" });
  const foreign = new FileAutomationStore({ ...options, userId: userB });
  expect(await foreign.list()).toHaveLength(0);
});


it("guards automation updates against a stale read while holding the store lock",async()=>{
 const usersRoot=await root();let now=Date.parse("2030-08-01T08:00:00.000Z");
 const store=new FileAutomationStore({installationId:"tenant-one",userId:userA,usersRoot,now:()=>now});
 const task=await store.create(input("2030-08-28T09:00:00.000Z"));
 now+=1000;
 const saved=await store.update(task.id,{name:"Nuevo nombre"},{expectedUpdatedAt:task.updatedAt});
 await expect(store.update(task.id,{prompt:"Obsolete overwrite"},{expectedUpdatedAt:task.updatedAt})).rejects.toMatchObject({code:"AUTOMATION_UPDATE_CONFLICT"});
 expect((await store.list())[0]).toEqual(saved);
});

it('recalculates a paused occurrence when its calendar changes without activating or queuing it',async()=>{
 const usersRoot=await root();let clock=Date.parse('2030-08-01T08:00:00.000Z');
 const store=new FileAutomationStore({installationId:'tenant-one',userId:userA,usersRoot,now:()=>clock});
 const task=await store.create(input('2030-08-28T08:00:00.000Z'));clock++;
 await store.update(task.id,{state:'paused'});clock++;
 const saved=await store.update(task.id,{schedule:{kind:'once',runAt:'2030-08-28T09:30:00.000Z'}});
 expect(saved).toMatchObject({id:task.id,state:'paused',nextRunAt:'2030-08-28T09:30:00.000Z',manualRun:null});
 expect(await store.claimDue('worker',1)).toEqual([]);
 const past=await store.update(task.id,{schedule:{kind:'once',runAt:'2030-01-01T08:00:00.000Z'}});
 expect(past.state).toBe('paused');expect(past.nextRunAt).toBeNull();
});

it('checks the current version under the manual-run lock while preserving exact request replay',async()=>{
 const usersRoot=await root();let clock=Date.parse('2030-08-01T08:00:00.000Z');
 const store=new FileAutomationStore({installationId:'tenant-one',userId:userA,usersRoot,now:()=>clock});
 const task=await store.create(input('2030-08-28T08:00:00.000Z'));clock++;
 const paused=await store.update(task.id,{state:'paused'});clock++;
 const edited=await store.update(task.id,{name:'Updated reminder'});clock++;
 await expect(store.runNow(task.id,projectId,{expectedUpdatedAt:paused.updatedAt})).rejects.toMatchObject({code:'AUTOMATION_UPDATE_CONFLICT'});
 expect((await store.get(task.id)).manualRun).toBeNull();
 const queued=await store.runNow(task.id,projectId,{expectedUpdatedAt:edited.updatedAt});
 expect(queued).toMatchObject({state:'paused',manualRun:{requestId:projectId},nextRunAt:task.nextRunAt});
 expect(await store.runNow(task.id,projectId,{expectedUpdatedAt:edited.updatedAt})).toEqual(queued);
});

it('repairs the legacy stale paused next-run value when the owner requests one manual occurrence',async()=>{
 const usersRoot=await root();let clock=Date.parse('2030-08-01T08:00:00.000Z');
 const store=new FileAutomationStore({installationId:'tenant-one',userId:userA,usersRoot,now:()=>clock});
 const task=await store.create(input('2030-08-28T08:00:00.000Z'));clock++;
 const paused=await store.update(task.id,{state:'paused'});
 const file=path.join(usersRoot,userA,'automations','tasks.json'),snapshot=JSON.parse(await readFile(file,'utf8'));
 snapshot.tasks[0].schedule={kind:'once',runAt:'2030-08-28T09:30:00.000Z'};
 await writeFile(file,JSON.stringify(snapshot));clock++;
 const queued=await store.runNow(task.id,projectId,{expectedUpdatedAt:paused.updatedAt});
 expect(queued).toMatchObject({state:'paused',nextRunAt:'2030-08-28T09:30:00.000Z',manualRun:{requestId:projectId}});
});

it.each([false,true])("preserves a manual occurrence through replay deferral without effects or spent attempts (cancelled: %s)",async(cancelled)=>{
 const usersRoot=await root();let clock=Date.parse("2030-08-01T08:00:00.000Z");
 const store=new FileAutomationStore({installationId:"tenant-one",userId:userA,usersRoot,now:()=>clock});
 const task=await store.create(input("2030-08-28T09:00:00.000Z"));
 await store.update(task.id,{state:"paused"});await store.runNow(task.id,projectId);
 const original=(await store.get(task.id)).manualRun;
 let ready=false,effects=0;const keys:string[]=[];
 const execute=async(claim:ClaimedAutomation)=>{keys.push(claim.runKey);if(!ready)throw new RuntimeProjectionAdmissionDeferred();effects++;return{threadId:projectId};};
 for(let i=0;i<2;i++){
  expect((await runAutomationSweep({store,now:()=>clock,maxAttempts:1,execute}))[0]).toMatchObject({status:"deferred",error:null});
  expect((await store.get(task.id))).toMatchObject({manualRun:original,lastRunStatus:null,lastRunError:null,lease:null});
  clock+=30001;
 }
 expect(effects).toBe(0);expect(new Set(keys).size).toBe(1);
 expect((await store.listRuns()).every(run=>run.attempt===1)).toBe(true);
 if(cancelled)await store.update(task.id,{prompt:"Changed while waiting for recovery"});
 ready=true;
 const result=await runAutomationSweep({store,now:()=>clock,maxAttempts:1,execute});
 expect(result[0].status).toBe(cancelled?"failed":"succeeded");
 expect(effects).toBe(cancelled?0:1);
 if(!cancelled)expect((await store.listRuns()).every(run=>run.attempt===1)).toBe(true);
 expect((await store.get(task.id))).toMatchObject({state:"paused",manualRun:null,retryAt:null,lease:null});
 expect(await runAutomationSweep({store,now:()=>clock,execute})).toEqual([]);
 expect(effects).toBe(cancelled?0:1);
});

it("defers busy model admission durably without a failure or spent attempt even beyond five minutes",async()=>{
 const usersRoot=await root();let clock=Date.parse("2030-08-01T08:00:00.000Z");
 const store=new FileAutomationStore({installationId:"tenant-one",userId:userA,usersRoot,now:()=>clock});
 const task=await store.create(input(new Date(clock).toISOString()));
 const execute=async()=>{throw new BackgroundModelAdmissionDeferred();};
 for(let n=0;n<12;n++){
  const result=await runAutomationSweep({store,now:()=>clock,maxAttempts:1,execute});
  expect(result[0]).toMatchObject({status:"deferred",error:null});
  const saved=await store.get(task.id);expect(saved.lease).toBeNull();expect(saved.lastRunStatus).toBeNull();expect(saved.nextRunAt).toBe(task.nextRunAt);
  clock+=30001;
 }
 expect((await store.listRuns()).every(run=>run.status==="running"&&run.attempt===1)).toBe(true);
 const success=await runAutomationSweep({store,now:()=>clock,maxAttempts:1,execute:async()=>({threadId:projectId})});
 expect(success[0].status).toBe("succeeded");expect((await store.listRuns()).at(-1)).toMatchObject({status:"succeeded",attempt:1});
 expect((await store.get(task.id)).state).toBe("completed");
});

it('retains the exact admitted occurrence during terminal handoff recovery without a false failure or repeated effects', async () => {
 const usersRoot=await root();let clock=Date.parse('2030-08-01T08:00:00.000Z');
 const store=new FileAutomationStore({installationId:'tenant-one',userId:userA,usersRoot,now:()=>clock});
 const task=await store.create(input(new Date(clock).toISOString()));let effects=0;const keys:string[]=[];
 const first=await runAutomationSweep({store,now:()=>clock,maxAttempts:1,execute:async claim=>{
  keys.push(claim.runKey);effects++;throw new WorkerTurnRecoveryPendingError('Completed turn needs writer-release reconciliation');
 }});
 expect(first[0]).toMatchObject({status:'deferred',error:null});
 expect(await store.get(task.id)).toMatchObject({lastRunStatus:null,lastRunError:null,lease:null});
 expect((await store.listRuns()).every(run=>run.status==='running'&&run.attempt===1)).toBe(true);
 clock+=30001;
 const recovered=await runAutomationSweep({store,now:()=>clock,maxAttempts:1,execute:async claim=>{keys.push(claim.runKey);return{threadId:projectId};}});
 expect(recovered[0].status).toBe('succeeded');expect(new Set(keys).size).toBe(1);expect(effects).toBe(1);
 expect((await store.listRuns()).at(-1)).toMatchObject({status:'succeeded',attempt:1});
});

it.each(['prompt','executionContext'] as const)('cancels an old retry before deterministic turn replay after editing %s',async change=>{
 const usersRoot=await root();let clock=Date.parse('2026-08-28T09:00:00.000Z');
 const store=new FileAutomationStore({installationId:'tenant-one',userId:userA,usersRoot,now:()=>clock});
 const task=await store.create({...input(new Date(clock).toISOString()),schedule:{kind:'interval',minutes:30,anchorAt:new Date(clock).toISOString()}});
 const prompts=new Map<string,string>();let dispatches=0;
 const execute=async(claim:ClaimedAutomation,_thread:string|null,prepared:(id:string)=>Promise<void>)=>{
  dispatches++;const prior=prompts.get(claim.runKey);
  if(prior&&prior!==claim.task.prompt)throw Error('deterministic turn content collision');
  prompts.set(claim.runKey,claim.task.prompt);await prepared(projectId);
  if(dispatches===1)throw Error('transient failure after persisting original prompt');
  return{threadId:projectId};
 };
 await runAutomationSweep({store,now:()=>clock,ownerId:'edit-retry-worker',retryBaseMs:1000,execute});
 const before=await store.get(task.id);expect(before.lease).toBeNull();expect(before.retryAt).not.toBeNull();
 clock+=500;
 await store.update(task.id,change==='prompt'?{prompt:'New human instructions'}:{executionContext:{webSearch:true,inheritAuthorizedSkills:true,inheritAuthorizedConnectors:true}});
 expect((await store.get(task.id)).cancellationRequestedAt).not.toBeNull();
 clock+=1500;
 const cancelled=await runAutomationSweep({store,now:()=>clock,ownerId:'edit-retry-worker',retryBaseMs:1000,execute});
 expect(cancelled[0]).toMatchObject({status:'failed',error:'La automatización fue cancelada por su propietario.'});
 expect(dispatches).toBe(1);expect([...prompts.values()]).toEqual([task.prompt]);
 const saved=await store.get(task.id);expect(saved.retryAt).toBeNull();expect(saved.lease).toBeNull();expect(saved.nextRunAt).toBe('2026-08-28T09:30:00.000Z');
 clock=Date.parse(saved.nextRunAt!);await runAutomationSweep({store,now:()=>clock,ownerId:'edit-retry-worker',execute});
 expect(dispatches).toBe(2);expect(prompts.size).toBe(2);expect((await store.get(task.id)).lastRunStatus).toBe('succeeded');
});

it('cancels an edited expired active claim before invoking its recovered executor',async()=>{
 const usersRoot=await root();let clock=Date.parse('2026-08-28T09:00:00.000Z');
 const store=new FileAutomationStore({installationId:'tenant-one',userId:userA,usersRoot,now:()=>clock,leaseMs:1000});
 const task=await store.create({...input(new Date(clock).toISOString()),schedule:{kind:'interval',minutes:30,anchorAt:new Date(clock).toISOString()}});
 const [claim]=await store.claimDue('crashed-worker');
 await store.appendRun({schemaVersion:1,runKey:claim.runKey,taskId:task.id,installationId:'tenant-one',userId:userA,scheduledFor:claim.scheduledFor,status:'running',attempt:1,startedAt:new Date(clock).toISOString(),finishedAt:null,threadId:projectId,error:null});
 await store.update(task.id,{prompt:'Edited while the worker was absent'});clock+=1500;
 let executions=0;
 await runAutomationSweep({store,now:()=>clock,ownerId:'successor-worker',execute:async()=>{executions++;throw Error('must never reuse old IDs');}});
 expect(executions).toBe(0);expect((await store.listRuns(task.id)).at(-1)).toMatchObject({status:'failed',error:'La automatización fue cancelada por su propietario.'});
 expect((await store.get(task.id)).nextRunAt).toBe('2026-08-28T09:30:00.000Z');
});

it('observes an edit racing with executor failure before deciding whether to retry',async()=>{
 const usersRoot=await root(),clock=Date.parse('2026-08-28T09:00:00.000Z');
 const store=new FileAutomationStore({installationId:'tenant-one',userId:userA,usersRoot,now:()=>clock});
 const task=await store.create({...input(new Date(clock).toISOString()),schedule:{kind:'interval',minutes:30,anchorAt:new Date(clock).toISOString()}});
 await runAutomationSweep({store,now:()=>clock,ownerId:'racing-worker',execute:async()=>{
  await store.update(task.id,{prompt:'Current human request'});throw Error('old executor failed before the renewal timer');
 }});
 const saved=await store.get(task.id);expect(saved.retryAt).toBeNull();expect(saved.nextRunAt).toBe('2026-08-28T09:30:00.000Z');expect(saved.lastRunError).toBe('La automatización fue cancelada por su propietario.');
});

it('cancels an edited manual retry while preserving the paused recurrence',async()=>{
 const usersRoot=await root();let clock=Date.parse('2026-08-28T09:00:00.000Z');
 const store=new FileAutomationStore({installationId:'tenant-one',userId:userA,usersRoot,now:()=>clock});
 const task=await store.create(input('2030-08-28T09:00:00.000Z'));await store.update(task.id,{state:'paused'});await store.runNow(task.id,projectId);
 let executions=0;
 const execute=async()=>{executions++;throw Error('Failed after persisting manual turn');};
 await runAutomationSweep({store,now:()=>clock,ownerId:'manual-worker',retryBaseMs:1000,execute});
 await store.update(task.id,{prompt:'Changed manual instructions'});clock+=1500;
 await runAutomationSweep({store,now:()=>clock,ownerId:'manual-worker',retryBaseMs:1000,execute});
 expect(executions).toBe(1);const saved=await store.get(task.id);expect(saved.state).toBe('paused');expect(saved.manualRun).toBeNull();expect(saved.retryAt).toBeNull();expect(saved.lease).toBeNull();
});


it("persists and recalculates a paused weekday start without claiming early or duplicating it", async () => {
  const usersRoot = await root();
  let now = Date.parse("2026-11-04T17:00:00.000Z");
  const store = new FileAutomationStore({installationId: "tenant-one", userId: userA, usersRoot, now: () => now});
  const schedule = {kind: "weekly" as const, weekdays: [1,2,3,4,5], hour: 9, minute: 0};
  const task = await store.create({...input("2030-01-01T08:00:00.000Z"), schedule});
  await store.update(task.id, {state: "paused"});
  const updated = await store.update(task.id, {schedule: {...schedule, startAt: "2026-11-09T08:00:00.000Z"}});
  expect(updated.state).toBe("paused");
  expect(updated.nextRunAt).toBe("2026-11-09T08:00:00.000Z");
  const reloaded = new FileAutomationStore({installationId: "tenant-one", userId: userA, usersRoot, now: () => now});
  expect((await reloaded.list())[0].schedule).toEqual(updated.schedule);
  expect(await store.claimDue("worker")).toEqual([]);
  await store.update(task.id, {state: "active"});
  now = Date.parse("2026-11-06T08:00:00.000Z");
  expect(await store.claimDue("worker")).toEqual([]);
  now = Date.parse("2026-11-09T08:00:00.000Z");
  const claimed = await store.claimDue("worker");
  expect(claimed).toHaveLength(1);
  expect(claimed[0].scheduledFor).toBe("2026-11-09T08:00:00.000Z");
  expect(await store.claimDue("another-worker")).toEqual([]);
  const foreign = new FileAutomationStore({installationId: "tenant-one", userId: userB, usersRoot, now: () => now});
  expect(await foreign.list()).toEqual([]);
  await expect(foreign.update(task.id, {schedule})).rejects.toThrow();
});
