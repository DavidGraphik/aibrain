import { awaitHostTurn, HOST_INTERRUPT_GRACE_MS } from "./outcome";
import { waitForHostAnalysis } from "./wait";
import { HOST_QUEUE_MS, HOST_WORK_MS, HOST_TERMINAL_MS } from "./budget";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import type { InstallationConfig } from "@/config/installation-schema";
import { HostAnalysisStore } from "./store";
import { HOST_ANALYSIS_JOBS, parseHostEnvelope, stableId } from "./contracts";
import { prepareHostAnalysis } from "./input";
import { runAutomationSweep, runClaimedAutomation } from "@/automations/runner";
import { AutomationAdmissionPoller } from "@/automations/admission-poller";
import type { ClaimedAutomation } from "@/automations/store";
import { parseAutomationInput, parseAutomationPatch } from "@/automations/contracts";
import { nextAfterOccurrence, nextScheduledInstant } from "@/automations/schedule";
import { BackgroundModelAdmissionDeferred, FileModelTurnQueue } from "@/runtime/model-turn-queue";
vi.mock("./permissions", () => ({ currentHostPermissions: vi.fn(async () => ({ fingerprint: "a".repeat(64) })) }));
vi.mock("server-only", () => ({}));
vi.mock("@/workbench/store", () => ({ getWritableProject: vi.fn(async () => ({})) }));
vi.mock("@/automations/server-service", () => ({ automationWorkspaceContext: vi.fn(async () => ({})), validateAutomationAudience: vi.fn() }));
import { currentHostPermissions } from "./permissions";
import { getWritableProject } from "@/workbench/store";
const userId = "11111111-1111-4111-8111-111111111111", projectId = "10000000-0000-4000-8000-000000000001";
const audience = { membershipPolicy: "current" as const, userIds: [userId], groupIds: [] };
const envelope = { deadlineAt: Number.MAX_SAFE_INTEGER, job: "automation-acceptance" as const, occurrence: "manual-qa-1", input: "Prueba acotada", documents: [] };
let root: string, installation: Readonly<InstallationConfig>, store: HostAnalysisStore;
async function profile(enabled = true, email = "operator@example.invalid") {
  await mkdir(path.join(installation.paths.usersRoot, userId), { recursive: true });
  await writeFile(path.join(installation.paths.usersRoot, userId, "user.json"), JSON.stringify({ schemaVersion: 1, userId, email, enabled, displayName: "David", workerId: "worker-david" }), { mode: 0o600 });
}
async function authorize(job = envelope.job as typeof HOST_ANALYSIS_JOBS[number]) {
  return store.authorize({ job, installationId: installation.installationId, userId, email: "operator@example.invalid", projectId, audience }, async b => {
    await store.tasks(userId).create({ name: job, prompt: "Bound host input", projectId, projectName: "Operaciones", timeZone: "Europe/Madrid", audience, schedule: { kind: "external" } }, { id: b.taskId });
  });
}
beforeEach(async () => {
  vi.clearAllMocks(); root = await mkdtemp(path.join(os.tmpdir(), "host-analysis-"));
  installation = { installationId: "trinalum-production", companyName: "Trinalum", paths: { dataRoot: root, usersRoot: path.join(root, "users") } } as unknown as InstallationConfig;
  store = new HostAnalysisStore(installation, "test-purpose-only-secret-32-characters-long"); await profile();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("UI-bound host analysis durable queue", () => {
  it("defers a fresh host occurrence before request/task admission when real background capacity is occupied", async () => {
    const b = await authorize();
    const queue = new FileModelTurnQueue(path.join(root, "runtime", "model-turn-queue"), {maxConcurrent: 2});
    const admission = await queue.acquire({installationId: installation.installationId, userId, threadId: projectId,
      turnId: "10000000-0000-4000-8000-000000000002"}, {signal:new AbortController().signal, recovering:false, backgroundExecution:true, onWaiting:async()=>{}});
    const id = stableId(`${b.installationId}:${b.job}:${envelope.occurrence}`);
    try {
      await expect(store.submit(envelope)).rejects.toBeInstanceOf(BackgroundModelAdmissionDeferred);
      await expect(readFile(path.join(root, "host-analysis", "requests", `${id}.json`))).rejects.toMatchObject({code:"ENOENT"});
      expect(await store.tasks(userId).get(b.taskId)).toMatchObject({manualRun:null,lastRunStatus:null});
      expect(await store.tasks(userId).claimDue("worker")).toEqual([]);
      await expect(readFile(path.join(root,"users",userId,"automations","runs.jsonl"))).rejects.toMatchObject({code:"ENOENT"});
    } finally { await admission.complete(); }
    const submitted = await store.submit(envelope), original = await store.request(b, id);
    expect(submitted.requestId).toBe(id);
    const occupiedAgain = await queue.acquire({installationId: installation.installationId, userId, threadId: projectId,
      turnId: "10000000-0000-4000-8000-000000000003"}, {signal:new AbortController().signal, recovering:false, backgroundExecution:true, onWaiting:async()=>{}});
    try {
      expect(await store.submit(envelope)).toEqual(submitted);
      expect((await store.request(b,id)).budget).toEqual(original.budget);
      expect((await store.tasks(userId).get(b.taskId)).manualRun?.requestId).toBe(id);
    } finally { await occupiedAgain.complete(); }
  });

  it("reports signed queue expiry without reviving a cancelled occurrence or running model/tools", async () => {
    let now = Date.now(); store = new HostAnalysisStore(installation, "test-purpose-only-secret-32-characters-long", ()=>now);
    const b = await authorize(), submitted = await store.submit(envelope);
    now = (await store.request(b,submitted.requestId)).budget!.queueUntil;
    expect(await store.expire(b.job,submitted.requestId)).toBe(true);
    const native=store.tasks(userId), inference=vi.fn();
    await runAutomationSweep({store:native,ownerId:"late-worker",now:()=>now,execute:async()=>{
      await store.admit(b,submitted.requestId); inference(); return {threadId:projectId};
    }});
    expect(inference).not.toHaveBeenCalled();
    expect(await native.latestRun(`${b.taskId}:manual:${submitted.requestId}`)).toMatchObject({status:"failed",error:"HOST_QUEUE_TIMEOUT",threadId:null});
    await expect(store.result(b.job,submitted.requestId)).rejects.toThrow("HOST_QUEUE_TIMEOUT");
    await expect(store.submit(envelope)).rejects.toThrow("HOST_OCCURRENCE_CANCELLED");
    expect(await native.claimDue("restart")).toEqual([]);
  });
  it("preflight ignores expired waiters using the existing TTL without deleting their record or treating running work as expired", async () => {
    await authorize(); const queueRoot=path.join(root,"runtime","model-turn-queue");
    await mkdir(queueRoot,{recursive:true,mode:0o700});
    const file=path.join(queueRoot,"queue.json"), ticket={key:"a".repeat(64),owner:projectId,state:"waiting",seenAt:Date.now()-300_001};
    const raw=JSON.stringify({schemaVersion:1,tickets:[ticket]}); await writeFile(file,raw,{mode:0o600});
    const queue=new FileModelTurnQueue(queueRoot,{maxConcurrent:2});
    expect(await queue.backgroundCapacityAvailable()).toBe(true);
    expect(await readFile(file,"utf8")).toBe(raw);
    await writeFile(file,JSON.stringify({schemaVersion:1,tickets:[{...ticket,state:"running"}]}),{mode:0o600});
    expect(await queue.backgroundCapacityAvailable()).toBe(false);
  });
  it("does not disclose expiry for a signed foreign identity or tampered request", async () => {
    let now = Date.now(); store = new HostAnalysisStore(installation, "test-purpose-only-secret-32-characters-long", ()=>now);
    const b=await authorize(), {requestId}=await store.submit(envelope);
    now=(await store.request(b,requestId)).budget!.queueUntil;
    await store.expire(b.job,requestId);
    const name=`requests/${requestId}.json`, file=path.join(root,"host-analysis",name);
    const record=JSON.parse(await readFile(file,"utf8"));record.payload.userId=projectId;
    record.mac=createHmac("sha256","test-purpose-only-secret-32-characters-long").update("aibrain-host-analysis-v1\0").update(installation.installationId).update("\0"+name+"\0").update(JSON.stringify(record.payload)).digest("hex");
    await writeFile(file,JSON.stringify(record),{mode:0o600});
    await expect(store.request(b,requestId)).rejects.toThrow("HOST_REQUEST_DENIED");
    record.mac="0".repeat(64);await writeFile(file,JSON.stringify(record),{mode:0o600});
    await expect(store.request(b,requestId)).rejects.toThrow("HOST_RECORD_TAMPERED");
  });
  it("requires one of exactly eight approved bindings, rejects actor injection, and creates no cadence", async () => {
    expect(HOST_ANALYSIS_JOBS).toHaveLength(8);
    for (const job of ["quarterly", "monthly-invoice-reminders", "daily-brief"]) expect(() => parseHostEnvelope({ ...envelope, job })).toThrow();
    expect(() => parseHostEnvelope({ ...envelope, userId })).toThrow();
    await expect(store.submit(envelope)).rejects.toThrow("HOST_BINDING_REQUIRED");
    const b = await authorize();
    await expect(store.submit({ ...envelope, deadlineAt: undefined })).rejects.toThrow("HOST_DEADLINE_REQUIRED");
    const task = await store.tasks(userId).get(b.taskId);
    expect(task).toMatchObject({ schedule: { kind: "external" }, nextRunAt: null, manualRun: null });
    expect(await store.tasks(userId).claimDue("worker")).toEqual([]);
    expect(nextScheduledInstant({ kind: "external" }, "Europe/Madrid", new Date())).toBeNull();
    expect(nextAfterOccurrence({ kind: "external" }, "Europe/Madrid", new Date().toISOString())).toBeNull();
    expect(parseAutomationInput({ name: "test", prompt: "test", projectId, projectName: "Operaciones", timeZone: "Europe/Madrid", schedule: { kind: "external" } })).toBeNull();
    expect(parseAutomationPatch({ schedule: { kind: "external" } })).toBeNull();
  });
  it("authorizes idempotently and recovers task creation interruption with the same ID", async () => {
    const input = { job: envelope.job, installationId: installation.installationId, userId, email: "operator@example.invalid", projectId, audience };
    let interruptedId = "";
    await expect(store.authorize(input, async b => { interruptedId = b.taskId; throw Error("crash"); })).rejects.toThrow("crash");
    const b = await authorize(); expect(b.taskId).toBe(interruptedId);
    expect((await authorize()).taskId).toBe(b.taskId); expect(await store.tasks(userId).list()).toHaveLength(1);
  });
  it("dedupes restarts and competing submissions, uses native leases, and rejects changed source bytes", async () => {
    const b = await authorize();
    const submissions = await Promise.all([store.submit(envelope), store.submit(envelope)]);
    expect(submissions[0]).toEqual(submissions[1]);
    const restarted = new HostAnalysisStore(installation, "test-purpose-only-secret-32-characters-long");
    expect(await restarted.submit(envelope)).toEqual(submissions[0]);
    await expect(store.submit({ ...envelope, input: "changed" })).rejects.toThrow("HOST_OCCURRENCE_CONFLICT");
    const first = await store.tasks(userId).claimDue("worker-one"); expect(first).toHaveLength(1);
    expect(await store.tasks(userId).claimDue("worker-two")).toEqual([]);
    expect(first[0].runKey).toBe(`${b.taskId}:manual:${submissions[0].requestId}`);
  });
  it("settles failed external input once without automatic retries or replay", async () => {
    await authorize(); const { requestId, taskId } = await store.submit(envelope);
    const execute = vi.fn(async () => { throw Error("AUTOMATION_SOURCE_COVERAGE_MISMATCH"); });
    await runAutomationSweep({ store: store.tasks(userId), execute, ownerId: "worker" });
    expect(await store.tasks(userId).get(taskId)).toMatchObject({ retryAt: null, manualRun: null, nextRunAt: null });
    await store.submit(envelope);
    expect(await runAutomationSweep({ store: store.tasks(userId), execute, ownerId: "worker" })).toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
    await expect(store.result(envelope.job, requestId)).rejects.toThrow("HOST_ANALYSIS_FAILED");
  });
  it("polling a cancelled host request records the real denial without inference or revival", async () => {
    const binding = await authorize(); const {requestId,taskId} = await store.submit(envelope);
    await store.cancel(binding.job,requestId);
    const native = store.tasks(userId), inference = vi.fn();
    const poller = new AutomationAdmissionPoller<ClaimedAutomation, unknown>({concurrency:1,onResult:vi.fn(),onError:vi.fn()});
    const source = {userId,claim:(limit:number)=>native.claimDue("polling-worker",limit),
      execute:(claim:ClaimedAutomation)=>runClaimedAutomation({store:native,claim,execute:async()=>{
        await store.admit(binding,requestId);inference();return{threadId:projectId};
      }})};
    await poller.poll([source]);await poller.stop();expect(inference).not.toHaveBeenCalled();
    expect(await native.latestRun(`${taskId}:manual:${requestId}`)).toMatchObject({status:"failed",error:"HOST_REQUEST_DENIED",threadId:null});
    expect(await native.claimDue("restart")).toEqual([]);
    await expect(store.submit(envelope)).rejects.toThrow("HOST_OCCURRENCE_CANCELLED");
  });
  it("returns only validated terminal results and checks current project access again", async () => {
    const b = await authorize(); const { requestId } = await store.submit(envelope);
    await store.admit(b, requestId);
    await store.saveResult(b, requestId, projectId, "verified result", "a".repeat(64));
    expect(await store.result(envelope.job, requestId)).toBeNull();
    await runAutomationSweep({ store: store.tasks(userId), ownerId: "worker", execute: async () => ({
      threadId: projectId, finalize: persist => store.finalize(b, requestId, persist),
    }) });
    expect(await store.result(envelope.job, requestId)).toMatchObject({ result: { payloads: [{ text: "verified result" }] }, meta: { originalDocumentsUploaded: 0 }, external_action_executed: false });
    await expect(store.saveResult(b, requestId, projectId, "replacement", "a".repeat(64))).rejects.toThrow("HOST_RESULT_CONFLICT");
    vi.mocked(currentHostPermissions).mockResolvedValueOnce({ fingerprint: "b".repeat(64) } as never);
    await expect(store.result(envelope.job, requestId)).rejects.toThrow("HOST_PERMISSIONS_CHANGED");
    vi.mocked(getWritableProject).mockRejectedValueOnce(Error("PROJECT_ACCESS_DENIED"));
    await expect(store.result(envelope.job, requestId)).rejects.toThrow("PROJECT_ACCESS_DENIED");
  });
  it("rejects unsigned/tampered bindings and wrong installation signatures", async () => {
    const b = await authorize(), name = path.join(store.root, "bindings", `${b.job}.json`);
    const signed = JSON.parse(await readFile(name, "utf8")); signed.payload.projectId = stableId("other project");
    await writeFile(name, JSON.stringify(signed)); await expect(store.binding(b.job)).rejects.toThrow("HOST_RECORD_TAMPERED");
    const otherTenant = new HostAnalysisStore({ ...installation, installationId: "other-tenant" }, "test-purpose-only-secret-32-characters-long");
    await expect(otherTenant.binding(b.job)).rejects.toThrow("HOST_RECORD_TAMPERED");
    await writeFile(name, JSON.stringify(b)); await expect(store.binding(b.job)).rejects.toThrow("HOST_RECORD_INVALID");
  });
  it("revokes disabled/changed accounts, audiences, exact cancellation and old occurrences after reauthorization", async () => {
    const b = await authorize(); const { requestId } = await store.submit(envelope);
    await profile(false); await expect(store.request(b, requestId)).rejects.toThrow("HOST_BINDING_REVOKED");
    await profile(true, "other@example.test"); await expect(store.request(b, requestId)).rejects.toThrow("HOST_BINDING_REVOKED"); await profile();
    await store.cancel(b.job, requestId); await expect(store.request(b, requestId)).rejects.toThrow("HOST_REQUEST_DENIED");
    await store.revoke(b.job, userId); await expect(store.assertActive(b)).rejects.toThrow("HOST_BINDING_REVOKED");
    const rebound = await authorize(); expect(rebound.taskId).not.toBe(b.taskId);
    await expect(store.submit(envelope)).rejects.toThrow("HOST_OCCURRENCE_CONFLICT");
    await store.tasks(userId).update(rebound.taskId, { audience: { ...audience, userIds: [stableId("new user")] } });
    await expect(store.submit({ ...envelope, occurrence: "new" })).rejects.toThrow("HOST_BINDING_CHANGED");
  });
});
describe("unaltered source preparation and terminal validation", () => {
  const batch = { messages: [{ snapshot_id: "original-id-1" }, { snapshot_id: "original-id-2" }] };
  const input = `Instructions\nMAIL_BATCH_JSON\n${JSON.stringify(batch)}`;
  const output = (ids = ["SNAPSHOT_0001", "SNAPSHOT_0002"]) => JSON.stringify({ results: ids.map(snapshot_id => ({ snapshot_id, notify_now: false, activated_workflows: [], routed_tasks: [], alerts: [] })), processed_snapshot_ids: ids, processed_count: ids.length, external_action_executed: false });
  it("restores exact provider identities and validates already restored recovery without a second remapping", () => {
    const prepared = prepareHostAnalysis({ ...envelope, job: "email-event-router", input });
    expect(prepared.message).toContain("SNAPSHOT_0001"); expect(prepared.message).not.toContain("original-id-1");
    const result = prepared.validate(output()); expect(result).toContain("original-id-1");
    expect(prepared.validate(result, true)).toBe(result);
    expect(() => prepared.validate(output(["SNAPSHOT_0001"]))).toThrow("AUTOMATION_SOURCE_COVERAGE_MISMATCH");
    expect(() => prepared.validate(output().replace('"external_action_executed":false', '"external_action_executed":true'))).toThrow("AUTOMATION_SOURCE_COVERAGE_MISMATCH");
  });
  it("requires exact original PDF bytes, evidence and ordered upload identity", () => {
    const bytes = Buffer.from("%PDF-1.4\noriginal"), uploadName = "SNAPSHOT_0001_document_01_original.pdf", mailbox = "administration@example.invalid";
    const message = { snapshot_id: "id", mailbox, attachment_evidence: { original_verified: true, documents: [{ original_upload_name: uploadName, size: bytes.length, cache_sha256: createHash("sha256").update(mailbox).update(bytes).digest("hex") }] } };
    const pdfInput = `Instructions\nMAIL_BATCH_JSON\n${JSON.stringify({ messages: [message] })}`;
    const value = { ...envelope, job: "email-event-router" as const, input: pdfInput, documents: [{ uploadName, base64: bytes.toString("base64") }] };
    expect(prepareHostAnalysis(value).documents[0].bytes).toEqual(bytes);
    expect(() => prepareHostAnalysis({ ...value, documents: [] })).toThrow("AUTOMATION_ORIGINAL_DOCUMENT_INVALID");
    expect(() => prepareHostAnalysis({ ...value, documents: [{ uploadName, base64: Buffer.from("%PDF-forged").toString("base64") }] })).toThrow("AUTOMATION_ORIGINAL_DOCUMENT_INVALID");
    expect(() => parseHostEnvelope({ ...value, documents: [...value.documents, ...value.documents] })).toThrow("HOST_DOCUMENT_INVALID");
  });
});


describe("durable host deadline integration", () => {
  const start = Date.parse("2026-10-14T13:04:15Z");
  it("reproduces E12 queue + seven-page original preparation without cancelling valid work at 390s", async () => {
    let clock = start;
    store = new HostAnalysisStore(installation, "test-purpose-only-secret-32-characters-long", () => clock);
    const b = await authorize("email-event-router");
    const mailbox = "administration@example.invalid";
    const originals = [Buffer.from("%PDF-1.7\nfixture-3-pages"), Buffer.from("%PDF-1.7\nfixture-4-pages")];
    const documents = originals.map((bytes, i) => ({ uploadName: `SNAPSHOT_000${i + 1}_document_01_original.pdf`, base64: bytes.toString("base64") }));
    const batch = { messages: originals.map((bytes, i) => ({ snapshot_id: `original-${i + 1}`, mailbox, body: "source ".repeat(1800),
      attachment_evidence: { original_verified: true, documents: [{ original_upload_name: documents[i].uploadName, size: bytes.length,
        cache_sha256: createHash("sha256").update(mailbox).update(bytes).digest("hex") }] } })) };
    const value = { ...envelope, job: b.job, input: `instructions\nMAIL_BATCH_JSON\n${JSON.stringify(batch)}`, documents };
    const prepared = prepareHostAnalysis(value);
    expect(prepared.documents).toHaveLength(3); // 2 original byte fixtures + unchanged complete TXT source
    const { requestId } = await store.submit(value);
    const snapshot = await store.request(b, requestId);
    let resolveModel!: () => void, resolveThread!: () => void, admitted!: () => void, threadPrepared!: () => void;
    const model = new Promise<void>(resolve => { resolveModel = resolve; });
    const thread = new Promise<void>(resolve => { resolveThread = resolve; });
    const admission = new Promise<void>(resolve => { admitted = resolve; });
    const preparation = new Promise<void>(resolve => { threadPrepared = resolve; });
    let sweep: Promise<unknown>;
    const events = [
      { at: start + 50_000, async run() {
        sweep = runAutomationSweep({ store: store.tasks(userId), now: () => clock, ownerId: "fixture-worker",
          execute: async (_claim, _existing, onThreadPrepared) => {
            const r = await store.admit(b, requestId); admitted();
            await thread; await onThreadPrepared(projectId); threadPrepared();
            await model;
            const text = prepared.validate(JSON.stringify({ results: ["SNAPSHOT_0001", "SNAPSHOT_0002"].map(snapshot_id => ({ snapshot_id, notify_now: false, activated_workflows: [], routed_tasks: [], alerts: [] })),
              processed_snapshot_ids: ["SNAPSHOT_0001", "SNAPSHOT_0002"], processed_count: 2, external_action_executed: false }));
            await store.saveResult(b, requestId, projectId, text, "a".repeat(64));
            return { threadId: projectId, deadlineAt: r.budget.terminalUntil, finalize: persist => store.finalize(b, requestId, persist) };
          } });
        await admission;
      } },
      { at: start + 69_000, async run() { resolveThread(); await preparation; } },
      { at: start + 400_000, async run() { resolveModel(); await sweep; } },
    ];
    const result = await waitForHostAnalysis({ store, job: b.job, requestId, signal: new AbortController().signal, now: () => clock,
      sleep: async () => {
        const next = events[0]; clock = Math.min(clock + 10_000, next?.at ?? Infinity);
        if (next && clock >= next.at) { events.shift(); await next.run(); }
      } });
    expect(result).toMatchObject({ meta: { originalDocumentsUploaded: 2, threadId: projectId }, external_action_executed: false });
    expect((await store.request(b, requestId)).cancelled).toBe(false);
    expect((await store.tasks(userId).latestRun(`${b.taskId}:manual:${requestId}`))?.status).toBe("succeeded");
    const done = await store.request(b, requestId);
    expect(done.budget?.workUntil).toBe(start + 50_000 + HOST_WORK_MS);
    expect(done.budget?.terminalUntil).toBe(start + 50_000 + HOST_WORK_MS + HOST_TERMINAL_MS);
    clock += 100_000;
    await store.submit({ ...value, deadlineAt: clock + 800_000 });
    await store.cancel(b.job, requestId); // an uncertain late client cannot cancel a terminal result
    expect((await store.request(b, requestId)).cancelled).toBe(false);
    expect((await store.request(b, requestId)).budget).toEqual(done.budget);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.budget?.queueUntil).toBe(start + HOST_QUEUE_MS);
  });
  it("atomically expires queued work, denies inference and preserves failure across retries/rebinds", async () => {
    let clock = start; store = new HostAnalysisStore(installation, "test-purpose-only-secret-32-characters-long", () => clock);
    const b = await authorize(), { requestId } = await store.submit(envelope);
    clock += HOST_QUEUE_MS;
    expect(await store.expire(b.job, requestId)).toBe(true);
    await expect(store.admit(b, requestId)).rejects.toThrow("HOST_QUEUE_TIMEOUT");
    await expect(store.submit(envelope)).rejects.toThrow("HOST_OCCURRENCE_CANCELLED");
  });
  it("admission wins a stale queue-expiry observation; recovery keeps the original clock", async () => {
    let clock = start; store = new HostAnalysisStore(installation, "test-purpose-only-secret-32-characters-long", () => clock);
    const b = await authorize(), { requestId } = await store.submit(envelope);
    expect(await store.waitDeadline(b.job, requestId)).toBe(start + HOST_QUEUE_MS);
    clock += HOST_QUEUE_MS - 1; const admitted = await store.admit(b, requestId);
    clock += 10;
    expect(await store.expire(b.job, requestId)).toBe(false);
    const restarted = new HostAnalysisStore(installation, "test-purpose-only-secret-32-characters-long", () => clock);
    expect((await restarted.admit(b, requestId)).budget).toEqual(admitted.budget);
    clock = admitted.budget.workUntil!;
    await expect(restarted.admit(b, requestId)).rejects.toThrow("HOST_EXECUTION_TIMEOUT");
    await expect(store.saveResult(b, requestId, projectId, "late", "a".repeat(64))).rejects.toThrow("HOST_EXECUTION_TIMEOUT");
  });
  it("explicit cancellation or deadline exhaustion prevents the final succeeded journal", async () => {
    let clock = start; store = new HostAnalysisStore(installation, "test-purpose-only-secret-32-characters-long", () => clock);
    const b = await authorize(), { requestId } = await store.submit(envelope);
    const admitted = await store.admit(b, requestId);
    const persisted = vi.fn(async () => {});
    await store.cancel(b.job, requestId);
    await expect(store.finalize(b, requestId, persisted)).rejects.toThrow("HOST_REQUEST_DENIED");
    expect(persisted).not.toHaveBeenCalled();
    expect(admitted.budget.workUntil).toBe(start + HOST_WORK_MS);
  });
  it("journals a cooperative timeout before terminal expiry and never retries or delivers it", async () => {
    let clock = start;
    store = new HostAnalysisStore(installation, "test-purpose-only-secret-32-characters-long", () => clock);
    const b = await authorize(), { requestId } = await store.submit(envelope);
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const sweep = runAutomationSweep({ store: store.tasks(userId), ownerId: "timeout-worker", now: () => clock,
        execute: async (_claim, _threadId, onThreadPrepared) => {
          const admitted = await store.admit(b, requestId);
          await onThreadPrepared(projectId);
          const turn = awaitHostTurn(async () => { ready(); await new Promise<void>(() => {}); }, controller.signal);
          clock = admitted.budget.workUntil!;
          controller.abort(Error("HOST_EXECUTION_TIMEOUT"));
          await turn;
          throw Error("unreachable success");
        } });
      await started;
      clock += HOST_INTERRUPT_GRACE_MS;
      await vi.advanceTimersByTimeAsync(HOST_INTERRUPT_GRACE_MS);
      expect(await sweep).toEqual([expect.objectContaining({ status: "failed", error: "HOST_EXECUTION_TIMEOUT" })]);
      const r = await store.request(b, requestId);
      const terminal = await store.tasks(userId).latestRun(`${b.taskId}:manual:${requestId}`);
      expect(terminal).toMatchObject({ status: "failed", error: "HOST_EXECUTION_TIMEOUT", threadId: projectId });
      expect(Date.parse(terminal!.finishedAt!)).toBeLessThan(r.budget!.terminalUntil);
      expect(r.cancelled).toBe(false);
      expect(r.terminalCommitted).not.toBe(true);
      expect(await store.expire(b.job, requestId)).toBe(false);
      await expect(store.result(b.job, requestId)).rejects.toThrow("HOST_ANALYSIS_FAILED");
      expect(await store.tasks(userId).get(b.taskId)).toMatchObject({ retryAt: null, manualRun: null });
      expect(await runAutomationSweep({ store: store.tasks(userId), ownerId: "next", execute: vi.fn() })).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it("does not deliver a succeeded journal row when task settlement failed", async () => {
    let clock = start;
    store = new HostAnalysisStore(installation, "test-purpose-only-secret-32-characters-long", () => clock);
    const b = await authorize(), { requestId } = await store.submit(envelope);
    const [claim] = await store.tasks(userId).claimDue("worker");
    await store.admit(b, requestId);
    await store.saveResult(b, requestId, projectId, "validated result", "a".repeat(64));
    clock += 1000;
    await expect(store.finalize(b, requestId, async () => {
      await store.tasks(userId).appendRun({ schemaVersion: 1, runKey: claim.runKey,
        taskId: b.taskId, installationId: installation.installationId, userId,
        scheduledFor: claim.scheduledFor, status: "succeeded", attempt: 1,
        startedAt: new Date(start).toISOString(), finishedAt: new Date(clock).toISOString(),
        threadId: projectId, error: null });
      throw Error("simulated task settlement I/O failure");
    })).rejects.toThrow("simulated task settlement I/O failure");
    expect(await store.result(b.job, requestId)).toBeNull();
    const request = await store.request(b, requestId);
    clock = request.budget!.terminalUntil;
    expect(await store.expire(b.job, requestId)).toBe(true);
    await expect(store.result(b.job, requestId)).rejects.toThrow("HOST_TERMINAL_TIMEOUT");
  });
  it("does not seal a result when persistence exhausts the terminal reserve", async () => {
    let clock = start;
    store = new HostAnalysisStore(installation, "test-purpose-only-secret-32-characters-long", () => clock);
    const b = await authorize(), { requestId } = await store.submit(envelope);
    const admitted = await store.admit(b, requestId);
    await expect(store.finalize(b, requestId, async () => {
      clock = admitted.budget.terminalUntil;
    })).rejects.toThrow("HOST_TERMINAL_TIMEOUT");
    expect((await store.request(b, requestId)).terminalCommitted).not.toBe(true);
  });
});
