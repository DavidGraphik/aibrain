import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { InstallationConfig } from "@/config/installation-schema";
import { DEFAULT_AUTOMATION_EXECUTION_CONTEXT, type AutomationTask } from "@/automations/contracts";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  userLocale: vi.fn(),
  hostExecution: vi.fn(),
  effectAuthorization: vi.fn(),
  runState: vi.fn(),
  archiveGenerated: vi.fn(),
  runWorkerCodexTurn: vi.fn(),
  finishThreadTurn: vi.fn(),
  getThread: vi.fn(),
  beginThreadTurn: vi.fn(),
  messages: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/i18n/server", () => ({userUiLocaleForInstallation:mocks.userLocale}));
vi.mock("@/automations/run-state", () => ({createAutomationRunState:mocks.runState}));
vi.mock("@/automations/authorized-effects", () => ({createAutomationEffectAuthorization:mocks.effectAuthorization}));
vi.mock("@/automations/host-analysis/execution", () => ({ hostExecution: mocks.hostExecution }));
vi.mock("@/runtime/worker-codex-turn", () => ({ runWorkerCodexTurn: mocks.runWorkerCodexTurn }));
vi.mock("@/runtime/config", () => ({
  readRuntimeConfig: () => ({ mode: "codex", approvalPolicy: "never", sandbox: "workspace-write" }),
}));
vi.mock("@/runtime/approval-store", () => ({ FileApprovalStore: class {} }));
vi.mock("@/memory", () => ({ LocalFileMemoryService: class {} }));
vi.mock("@/runtime/memory-turn", () => ({ FileMemoryTurnAuditSink: class {} }));
vi.mock("@/runtime/permission-turn", () => ({ resolveServerTurnPermissions: vi.fn(async () => ({})) }));
vi.mock("@/automations/audience-store", () => ({ FileAutomationAudienceStore: class { async record() {} async markQuiet() {} } }));
vi.mock("@/connectors/mentions", () => ({
  authorizedConnectorMentionIdsForTurn: vi.fn(async () => ["gmail", "attio"]),
}));
vi.mock("@/settings/server-service", () => ({
  featurePolicyForIdentity: vi.fn(async () => ({ "web-search": true, skills: true })),
}));
vi.mock("@/workbench/store", () => ({
  updateThread:vi.fn(),
  archiveGeneratedAutomationResult:mocks.archiveGenerated,
  createThread: vi.fn(async () => ({ id: "30000000-0000-4000-8000-000000000001" })),
  getThreadRuntimeContext: vi.fn(async () => ({
    projectId: "20000000-0000-4000-8000-000000000001",
    workspaceKey: "workspace",
    projectName: "Operaciones",
    projectInstructions: "",
    projectMemory: "",
    projectSources: [],
    visibleProjects: [],
    branchHistory: null,
  })),
  beginThreadTurn: mocks.beginThreadTurn,
  getThread: mocks.getThread,
  finishThreadTurn: mocks.finishThreadTurn,
}));

import { BackgroundModelAdmissionDeferred } from "@/runtime/model-turn-queue";
import { WorkerTurnRecoveryPendingError } from "@/runtime/worker-turn-recovery-error";
import { executeScheduledTurn } from "@/automations/executor";

const session: AuthSession = {
  provider: "local",
  user: { id: "00000000-0000-4000-8000-000000000001", name: "David", email: "david@example.test" },
  tenant: { id: "automation-qa", name: "Automation QA" },
  expiresAt: "2030-01-01T00:00:00.000Z",
};

const installation = {
  installationId: "automation-qa",
  companyName: "Automation QA",
  branding: { productName: "AiBrain" },
  paths: { dataRoot: "/tmp/aibrain-executor-data", usersRoot: "/tmp/aibrain-executor-users" },
} as unknown as Readonly<InstallationConfig>;

const task: AutomationTask = {
  schemaVersion: 1,
  id: "10000000-0000-4000-8000-000000000001",
  installationId: installation.installationId,
  userId: session.user.id,
  audience: { membershipPolicy: "current", userIds: [session.user.id], groupIds: [] },
  name: "Hello",
  prompt: "Usa @gmail y la skill autorizada para preparar hello.",
  projectId: "20000000-0000-4000-8000-000000000001",
  projectName: "Operaciones",
  timeZone: "Europe/Madrid",
  schedule: { kind: "once", runAt: "2030-08-30T08:02:00.000Z" },
  executionContext: DEFAULT_AUTOMATION_EXECUTION_CONTEXT,
  state: "active",
  nextRunAt: "2030-08-30T08:02:00.000Z",
  lastRunAt: null,
  lastRunStatus: null,
  lastRunError: null,
  retryAt: null,
  manualRun: null,
  deletedAt: null,
  cancellationRequestedAt: null,
  lease: null,
  createdAt: "2030-08-30T08:00:00.000Z",
  updatedAt: "2030-08-30T08:00:00.000Z",
};

beforeEach(() => {
  mocks.messages = [];
  mocks.runState.mockReset();
  mocks.runState.mockResolvedValue(undefined);
  mocks.archiveGenerated.mockReset();
  mocks.archiveGenerated.mockResolvedValue(true);
  mocks.effectAuthorization.mockReset();
  mocks.effectAuthorization.mockResolvedValue(undefined);
  mocks.userLocale.mockReset().mockResolvedValue("es");
  mocks.runWorkerCodexTurn.mockReset();
  mocks.finishThreadTurn.mockClear();
  mocks.getThread.mockReset();
  mocks.getThread.mockImplementation(async () => ({ messages: mocks.messages }));
  mocks.beginThreadTurn.mockReset();
  mocks.beginThreadTurn.mockImplementation(async (_session, _threadId, userMessage, assistantMessage) => {
    mocks.messages = [userMessage, assistantMessage];
    return { outcome: "created", assistantMessage };
  });
  mocks.finishThreadTurn.mockImplementation(async (_session, _threadId, assistantMessage) => {
    mocks.messages = [mocks.messages[0]!, assistantMessage];
  });
  mocks.runWorkerCodexTurn.mockImplementation(async (...args: unknown[]) => {
    const emit = args[10] as (event: unknown) => Promise<void>;
    await emit({ type: "content", value: "TEST-AUTO-P0-OK" });
    await emit({ type: "done" });
  });
});

describe("scheduled automation execution", () => {
  it("does not run the model when effective language records are malformed", async () => {
    mocks.userLocale.mockRejectedValue(Error("Invalid language record"));
    await expect(executeScheduledTurn({installation, session, task, runKey: `${task.id}:invalid-locale`})).rejects.toThrow("Invalid language record");
    expect(mocks.runWorkerCodexTurn).not.toHaveBeenCalled();
  });
  it.each(["ca", "es", "en"])("uses the effective employee/installation language %s", async locale => {
    mocks.userLocale.mockResolvedValue(locale);
    await executeScheduledTurn({installation, session, task, runKey: `${task.id}:locale:${locale}`});
    expect(mocks.userLocale).toHaveBeenCalledWith(installation, session);
    expect(mocks.runWorkerCodexTurn.mock.calls[0][0].preferences.language).toBe(locale);
  });
  it("runs without a browser session with live web, current skills and authorized @ connectors", async () => {
    await expect(executeScheduledTurn({
      installation,
      session,
      task,
      runKey: `${task.id}:${task.nextRunAt}`,
    })).resolves.toEqual({ threadId: "30000000-0000-4000-8000-000000000001" });

    const call = mocks.runWorkerCodexTurn.mock.calls[0];
    expect(call?.[0]).toMatchObject({
      message: task.prompt,
      options: {
        webSearch: true,
        inheritAuthorizedSkills: true,
        connectorMentions: ["gmail", "attio"],
        attachments: [],
      },
    });
    expect(call?.[16]).toBeUndefined();
    expect(call?.[17]).toBe(session);
    expect(call?.[18]).toBe(true);
    expect(mocks.finishThreadTurn).toHaveBeenCalledOnce();
    expect(mocks.messages).toEqual([
      expect.objectContaining({ role: "user", content: task.prompt }),
      expect.objectContaining({ role: "assistant", status: "complete", content: "TEST-AUTO-P0-OK" }),
    ]);
  });

  it("does not mark an occurrence successful when the result conversation is empty", async () => {
    mocks.runWorkerCodexTurn.mockImplementationOnce(async (...args: unknown[]) => {
      const emit = args[10] as (event: unknown) => Promise<void>;
      await emit({ type: "done" });
    });

    await expect(executeScheduledTurn({
      installation,
      session,
      task,
      runKey: `${task.id}:${task.nextRunAt}:empty`,
    })).rejects.toThrow("sin un resultado visible");
  });

  it("requires prompt and terminal content to survive durable thread readback", async () => {
    mocks.getThread.mockResolvedValueOnce({ messages: [] });
    await expect(executeScheduledTurn({
      installation,
      session,
      task,
      runKey: `${task.id}:${task.nextRunAt}:readback`,
    })).rejects.toThrow("no conserva el prompt y el resultado terminal");
  });

  it("rejects an empty terminal result recovered after a worker restart", async () => {
    mocks.beginThreadTurn.mockImplementationOnce(async (_session, _threadId, userMessage, assistantMessage) => {
      const empty = { ...assistantMessage, status: "complete" };
      mocks.messages = [userMessage, empty];
      return { outcome: "existing", assistantMessage: empty };
    });
    await expect(executeScheduledTurn({
      installation,
      session,
      task,
      runKey: `${task.id}:${task.nextRunAt}:recovered-empty`,
      existingThreadId: "30000000-0000-4000-8000-000000000001",
    })).rejects.toThrow("sin un resultado visible");
    expect(mocks.runWorkerCodexTurn).not.toHaveBeenCalled();
  });
});

afterEach(() => vi.useRealTimers());

describe("host analysis terminal boundary", () => {
  const host = () => ({ message: "Prepared original sources", signal: new AbortController().signal,
    policy: { webSearch: false, businessReads: false }, dispose: vi.fn(),
    documents: vi.fn(async () => []), validate: vi.fn(async (text: string) => `restored:${text}`) });
  it("prepares exact host input/options and validates before any terminal success", async () => {
    const adapter = host(); mocks.hostExecution.mockResolvedValueOnce(adapter);
    const calls: string[] = [];
    adapter.validate.mockImplementation(async text => { calls.push("validate"); expect(mocks.finishThreadTurn).not.toHaveBeenCalled(); return `restored:${text}`; });
    await executeScheduledTurn({ installation, session, task: { ...task, schedule: { kind: "external" } }, runKey: `${task.id}:manual:test` });
    expect(calls).toEqual(["validate"]);
    expect(mocks.runWorkerCodexTurn.mock.calls[0][0]).toMatchObject({ message: adapter.message, preferences: { tone: "direct", language: "es" }, options: { experience: "smart", webSearch: false, imageGeneration: false, inheritAuthorizedSkills: false, connectorMentions: [] } });
    expect(mocks.runWorkerCodexTurn.mock.calls[0][21]).toBe(adapter.policy);
    expect(mocks.messages[1]).toMatchObject({ status: "complete", content: "restored:TEST-AUTO-P0-OK" });
    expect(adapter.dispose).toHaveBeenCalledOnce();
  });
  it("keeps exact coverage failure as an error and never persists unvalidated output as complete", async () => {
    const adapter = host(); adapter.validate.mockRejectedValueOnce(Error("AUTOMATION_SOURCE_COVERAGE_MISMATCH")); mocks.hostExecution.mockResolvedValueOnce(adapter);
    await expect(executeScheduledTurn({ installation, session, task: { ...task, schedule: { kind: "external" } }, runKey: `${task.id}:manual:test` })).rejects.toThrow("AUTOMATION_SOURCE_COVERAGE_MISMATCH");
    expect(mocks.messages[1]).toMatchObject({ status: "error", content: "TEST-AUTO-P0-OK", activity: expect.arrayContaining([expect.objectContaining({ detail: "AUTOMATION_SOURCE_COVERAGE_MISMATCH", status: "failed" })]) });
    expect(adapter.dispose).toHaveBeenCalledOnce();
  });
  it("preserves partial work and the actual timeout instead of calling it non-read-only", async () => {
    const controller = new AbortController();
    const adapter = { ...host(), signal: controller.signal };
    mocks.hostExecution.mockResolvedValueOnce(adapter);
    mocks.runWorkerCodexTurn.mockImplementationOnce(async (...args: unknown[]) => {
      const emit = args[10] as (event: unknown) => Promise<void>;
      await emit({ type: "content", value: "Partial analysis" });
      for (let i = 0; i < 36; i++) await emit({ type: "activity", item: { id: `step-${i}`, kind: "tool", label: `Read ${i}`, status: "complete" } });
      for (let i = 0; i < 22; i++) await emit({ type: "toolResult", item: { id: `read-${i}`, kind: "app", title: "Read", status: "complete", summary: null, output: "source", sourceIds: [], createdAt: new Date().toISOString() } });
      controller.abort(Error("HOST_EXECUTION_TIMEOUT"));
      await emit({ type: "stopped" });
    });
    await expect(executeScheduledTurn({ installation, session, task: { ...task, schedule: { kind: "external" } }, runKey: "timeout" })).rejects.toThrow("HOST_EXECUTION_TIMEOUT");
    expect(mocks.messages[1]).toMatchObject({ status: "error", content: "Partial analysis", activity: expect.arrayContaining([expect.objectContaining({ detail: "HOST_EXECUTION_TIMEOUT", status: "failed" })]) });
    expect(mocks.messages[1].activity).toHaveLength(37);
    expect(mocks.messages[1].toolResults).toHaveLength(22);
    expect(adapter.validate).not.toHaveBeenCalled();
  });
  it("preserves model errors separately from permission violations", async () => {
    const adapter = host(); mocks.hostExecution.mockResolvedValueOnce(adapter);
    mocks.runWorkerCodexTurn.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[10] as (event: unknown) => Promise<void>)({ type: "error", message: "Provider unavailable" });
    });
    await expect(executeScheduledTurn({ installation, session, task: { ...task, schedule: { kind: "external" } }, runKey: "model-error" })).rejects.toThrow("HOST_MODEL_ERROR");
    expect(mocks.messages[1]).toMatchObject({ status: "error", content: "Provider unavailable", activity: expect.arrayContaining([expect.objectContaining({ detail: "HOST_MODEL_ERROR", output: "Provider unavailable" })]) });
    expect(adapter.validate).not.toHaveBeenCalled();
  });
  it("still rejects an actual approval request as non-read-only", async () => {
    const adapter = host(); mocks.hostExecution.mockResolvedValueOnce(adapter);
    mocks.runWorkerCodexTurn.mockImplementationOnce(async (...args: unknown[]) => {
      const emit = args[10] as (event: unknown) => Promise<void>;
      await emit({ type: "approval", item: { id: "approval", status: "pending" } });
      await emit({ type: "done" });
    });
    await expect(executeScheduledTurn({ installation, session, task: { ...task, schedule: { kind: "external" } }, runKey: "approval" })).rejects.toThrow("AUTOMATION_NON_READ_ONLY_RESULT");
    expect(adapter.validate).not.toHaveBeenCalled();
  });
  it("bounds cooperative shutdown even if the runtime ignores cancellation and ignores late events", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const adapter = { ...host(), signal: controller.signal };
    mocks.hostExecution.mockResolvedValueOnce(adapter);
    let lateEmit!: (event: unknown) => Promise<void>;
    let finish!: () => void;
    mocks.runWorkerCodexTurn.mockImplementationOnce(async (...args: unknown[]) => {
      lateEmit = args[10] as typeof lateEmit;
      await lateEmit({ type: "content", value: "Before deadline" });
      controller.abort(Error("HOST_EXECUTION_TIMEOUT"));
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const execution = executeScheduledTurn({ installation, session, task: { ...task, schedule: { kind: "external" } }, runKey: "unresponsive" });
    const rejected = expect(execution).rejects.toThrow("HOST_EXECUTION_TIMEOUT");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    const saved = structuredClone(mocks.messages[1]);
    await lateEmit({ type: "content", value: "LATE" });
    await lateEmit({ type: "done" });
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.messages[1]).toEqual(saved);
    expect(mocks.finishThreadTurn).toHaveBeenCalledOnce();
    expect(adapter.validate).not.toHaveBeenCalled();
    expect(adapter.dispose).toHaveBeenCalledOnce();
  });
  it("revalidates already restored persisted results after recovery without inference", async () => {
    const adapter = host(); mocks.hostExecution.mockResolvedValueOnce(adapter);
    mocks.beginThreadTurn.mockImplementationOnce(async (_session, _threadId, userMessage, assistantMessage) => {
      const result = { ...assistantMessage, status: "complete", content: "restored result" };
      mocks.messages = [userMessage, result]; return { outcome: "existing", assistantMessage: result };
    });
    await executeScheduledTurn({ installation, session, task: { ...task, schedule: { kind: "external" } }, runKey: `${task.id}:manual:test` });
    expect(adapter.validate).toHaveBeenCalledWith("restored result", "30000000-0000-4000-8000-000000000001", true);
    expect(mocks.runWorkerCodexTurn).not.toHaveBeenCalled();
  });
});

it("passes only the server-created scoped effect authority to the background runtime", async () => {
  const authority = { allowedEffects:["attio-task"],taskId:task.id,runKey:"test-run",revalidate:async()=>true };
  mocks.effectAuthorization.mockResolvedValueOnce(authority);
  await executeScheduledTurn({installation,session,task,runKey:"test-run"});
  expect(mocks.effectAuthorization).toHaveBeenCalledWith(expect.objectContaining({installation,session,task,runKey:"test-run",localTurnId:expect.any(String),signal:expect.any(AbortSignal)}));
  expect(mocks.runWorkerCodexTurn.mock.calls[0][23]).toBe(authority);
});

it("commits state only after terminal readback and closes an explicit quiet generated result before run settlement", async()=>{
 const state={finalize:vi.fn(async()=>({quiet:true})),requireVisible:vi.fn()};mocks.runState.mockResolvedValue(state);
 const result=await executeScheduledTurn({installation,session,task,runKey:"own-run"});
 expect(mocks.runWorkerCodexTurn.mock.calls[0][24]).toBe(state);
 expect(mocks.finishThreadTurn.mock.invocationCallOrder[0]).toBeLessThan(state.finalize.mock.invocationCallOrder[0]);
 expect(mocks.archiveGenerated).not.toHaveBeenCalled();const persist=vi.fn(async()=>{});await result.finalize!(persist);
 expect(mocks.archiveGenerated).toHaveBeenCalledWith(session,"own-run",expect.objectContaining({projectId:task.projectId,prompt:task.prompt,resultHash:expect.any(String)}));
 expect(mocks.archiveGenerated.mock.invocationCallOrder[0]).toBeLessThan(persist.mock.invocationCallOrder[0]);
});
it("leaves default visible results active and does not commit private state on a failed model result",async()=>{
 const state={finalize:vi.fn(async()=>({quiet:false})),requireVisible:vi.fn()};mocks.runState.mockResolvedValue(state);
 const result=await executeScheduledTurn({installation,session,task,runKey:"visible-run"});await result.finalize!(async()=>{});expect(mocks.archiveGenerated).not.toHaveBeenCalled();
 state.finalize.mockClear();mocks.runWorkerCodexTurn.mockImplementationOnce(async(...args:unknown[])=>{await(args[10]as(event:unknown)=>Promise<void>)({type:"error",message:"model failed"});});
 await expect(executeScheduledTurn({installation,session,task,runKey:"failed-run"})).rejects.toThrow();expect(state.finalize).not.toHaveBeenCalled();
});
it("recovers a previously persisted quiet result without resuming its archived model thread",async()=>{
 const state={finalize:vi.fn(async()=>({quiet:true})),requireVisible:vi.fn()};mocks.runState.mockResolvedValue(state);
 const first=await executeScheduledTurn({installation,session,task,runKey:"recovered-run"});await first.finalize!(async()=>{});
 mocks.getThread.mockImplementation(async()=>({projectId:task.projectId,status:"archived",messages:mocks.messages}));
 const recovered=await executeScheduledTurn({installation,session,task,runKey:"recovered-run",existingThreadId:first.threadId});
 expect(mocks.runWorkerCodexTurn).toHaveBeenCalledTimes(1);expect(state.finalize).toHaveBeenLastCalledWith(expect.any(String),{recoverPrepared:true});await recovered.finalize!(async()=>{});
});


describe("authorized quiet terminal without model text",()=>{
 const authority=()=>({quietResult:vi.fn(async():Promise<{reason:string}|null>=>({reason:"Existing task verified, no changes"})),finalize:vi.fn(async()=>({quiet:true})),requireVisible:vi.fn()});
 const doneOnly=async(...args:unknown[])=>{await(args[10]as(event:unknown)=>Promise<void>)({type:"done"});};
 it("persists and rereads a server receipt before committing an explicitly authorized quiet terminal",async()=>{
  const state=authority();mocks.runState.mockResolvedValue(state);mocks.runWorkerCodexTurn.mockImplementationOnce(doneOnly);
  const result=await executeScheduledTurn({installation,session,task,runKey:"quiet-no-text"});
  expect(state.quietResult).toHaveBeenCalledWith({recoverPrepared:false});
  expect(mocks.messages[1]).toMatchObject({status:"complete",content:"Revisión completada sin novedades."});
  expect(mocks.finishThreadTurn.mock.invocationCallOrder[0]).toBeLessThan(state.finalize.mock.invocationCallOrder[0]);
  expect(mocks.getThread.mock.invocationCallOrder.at(-1)).toBeLessThan(state.finalize.mock.invocationCallOrder[0]);
  expect(mocks.archiveGenerated).not.toHaveBeenCalled();await result.finalize!(async()=>{});
  expect(mocks.archiveGenerated).toHaveBeenCalledOnce();
 });
 it("repairs the proven persisted empty terminal after restart without another model call",async()=>{
  const state=authority();state.quietResult.mockResolvedValueOnce(null);mocks.runState.mockResolvedValue(state);mocks.runWorkerCodexTurn.mockImplementationOnce(doneOnly);
  const input={installation,session,task,runKey:"persisted-empty-quiet"};
  await expect(executeScheduledTurn(input)).rejects.toThrow("sin un resultado visible");
  expect(mocks.messages[1]).toMatchObject({status:"complete",content:""});expect(state.finalize).not.toHaveBeenCalled();
  mocks.getThread.mockImplementation(async()=>({projectId:task.projectId,messages:mocks.messages}));
  const recovered=await executeScheduledTurn({...input,existingThreadId:"30000000-0000-4000-8000-000000000001"});
  expect(state.quietResult).toHaveBeenLastCalledWith({recoverPrepared:true});
  expect(mocks.runWorkerCodexTurn).toHaveBeenCalledOnce();expect(mocks.messages[1].content).toBe("Revisión completada sin novedades.");
  await recovered.finalize!(async()=>{});expect(mocks.archiveGenerated).toHaveBeenCalledOnce();
 });
 it("rejects a claimed quiet tool projection without the private state authorization",async()=>{
  const state=authority();state.quietResult.mockResolvedValue(null);mocks.runState.mockResolvedValue(state);
  mocks.runWorkerCodexTurn.mockImplementationOnce(async(...args:unknown[])=>{
   const emit=args[10]as(event:unknown)=>Promise<void>;
   await emit({type:"toolResult",item:{id:"claimed-quiet",kind:"app",title:"automation state · finish quiet",status:"complete",output:'{"quiet":true}',sourceIds:[],createdAt:new Date().toISOString()}});await emit({type:"done"});
  });
  await expect(executeScheduledTurn({installation,session,task,runKey:"unproven-quiet"})).rejects.toThrow("sin un resultado visible");
  expect(state.finalize).not.toHaveBeenCalled();expect(mocks.archiveGenerated).not.toHaveBeenCalled();
 });
 it.each(["failed","stopped","running"])("keeps %s tool work from being converted into a quiet success",async status=>{
  const state=authority();mocks.runState.mockResolvedValue(state);
  mocks.runWorkerCodexTurn.mockImplementationOnce(async(...args:unknown[])=>{const emit=args[10]as(event:unknown)=>Promise<void>;await emit({type:"toolResult",item:{id:"failed-read",kind:"app",title:"Provider read",status,sourceIds:[],createdAt:new Date().toISOString()}});await emit({type:"done"});});
  await expect(executeScheduledTurn({installation,session,task,runKey:"failed-tool"})).rejects.toThrow("sin un resultado visible");
  expect(state.quietResult).not.toHaveBeenCalled();expect(state.finalize).not.toHaveBeenCalled();
 });
 it("preserves model failures and rejects a receipt lost or changed during durable readback",async()=>{
  const state=authority();mocks.runState.mockResolvedValue(state);
  mocks.runWorkerCodexTurn.mockImplementationOnce(async(...args:unknown[])=>{await(args[10]as(event:unknown)=>Promise<void>)({type:"error",message:"Provider failed"});});
  await expect(executeScheduledTurn({installation,session,task,runKey:"failed-model"})).rejects.toThrow("Provider failed");
  expect(state.quietResult).not.toHaveBeenCalled();expect(state.finalize).not.toHaveBeenCalled();
  mocks.runWorkerCodexTurn.mockImplementationOnce(doneOnly);
  mocks.getThread.mockImplementationOnce(async()=>({messages:[mocks.messages[0],{...mocks.messages[1],content:"Different text"}]}));
  await expect(executeScheduledTurn({installation,session,task,runKey:"quiet-readback-changed"})).rejects.toThrow("no conserva el prompt y el resultado terminal");
  expect(state.finalize).not.toHaveBeenCalled();expect(mocks.archiveGenerated).not.toHaveBeenCalled();
 });
});

describe('scheduled terminal handoff recovery', () => {
 it('keeps a completed runtime awaiting handoff recoverable without a false error, then preserves its same-run pending state', async () => {
  const state = { quietResult: vi.fn(async () => ({ reason: 'Same occurrence verified' })),
   finalize: vi.fn(async () => ({ quiet: true })), requireVisible: vi.fn() };
  mocks.runState.mockResolvedValue(state);
  mocks.runWorkerCodexTurn.mockImplementationOnce(async (...args: unknown[]) => {
   const emit = args[10] as (event: unknown) => Promise<void>;
   await emit({ type: 'content', value: 'Review complete without errors.' }); await emit({ type: 'done' });
   throw new WorkerTurnRecoveryPendingError('Background thread release pending');
  });
  const input = { installation, session, task, runKey: 'same-occurrence' };
  await expect(executeScheduledTurn(input)).rejects.toBeInstanceOf(WorkerTurnRecoveryPendingError);
  expect(mocks.finishThreadTurn).not.toHaveBeenCalled(); expect(state.finalize).not.toHaveBeenCalled();
  expect(mocks.messages[1].status).toBe('streaming');
  mocks.beginThreadTurn.mockImplementationOnce(async (_session, _threadId, user, assistant) => {
   mocks.messages = [user, assistant]; return { outcome: 'existing', assistantMessage: assistant };
  });
  mocks.runWorkerCodexTurn.mockImplementationOnce(async (...args: unknown[]) => {
   await (args[10] as (event: unknown) => Promise<void>)({ type: 'done' });
  });
  const recovered = await executeScheduledTurn({ ...input, existingThreadId: '30000000-0000-4000-8000-000000000001' });
  expect(state.quietResult).toHaveBeenLastCalledWith({ recoverPrepared: true });
  expect(state.finalize).toHaveBeenLastCalledWith(expect.any(String), { recoverPrepared: true });
  expect(mocks.messages[1]).toMatchObject({ status: 'complete', content: 'Revisión completada sin novedades.' });
  await recovered.finalize!(async () => {});
 });

 it('does not suppress a genuine model error just because writer release is also pending', async () => {
  mocks.runWorkerCodexTurn.mockImplementationOnce(async (...args: unknown[]) => {
   await (args[10] as (event: unknown) => Promise<void>)({ type: 'error', message: 'Actual provider failure' });
   throw new WorkerTurnRecoveryPendingError('Background thread release pending');
  });
  await expect(executeScheduledTurn({ installation, session, task, runKey: 'actual-failure' })).rejects.toThrow('Actual provider failure');
  expect(mocks.messages[1]).toMatchObject({ status: 'error', content: 'Actual provider failure' });
 });
});


it.each(["error","stopped"])("does not let a late done overwrite a real %s before quiet closeout",async type=>{
 const state={quietResult:vi.fn(async()=>({reason:"Nothing new"})),finalize:vi.fn(async()=>({quiet:true})),requireVisible:vi.fn()};mocks.runState.mockResolvedValue(state);
 mocks.runWorkerCodexTurn.mockImplementationOnce(async(...args:unknown[])=>{const emit=args[10]as(event:unknown)=>Promise<void>;await emit({type,message:"Real provider failure"});await emit({type:"done"});});
 await expect(executeScheduledTurn({installation,session,task,runKey:"failed-then-done"})).rejects.toThrow();
 expect(mocks.messages[1].status).toBe(type);expect(state.quietResult).not.toHaveBeenCalled();expect(state.finalize).not.toHaveBeenCalled();expect(mocks.archiveGenerated).not.toHaveBeenCalled();
});

describe('quiet source document closeout',()=>{
 const source={id:'40000000-0000-4000-8000-000000000001',type:'document' as const,name:'original.pdf',
  url:'/api/threads/30000000-0000-4000-8000-000000000001/connector-files/40000000-0000-4000-8000-000000000001',kind:'pdf' as const,
  mimeType:'application/pdf',size:100,status:'ready' as const,pages:null,previewUrl:null,publicationStatus:null,publicationError:null,targetLabel:null,error:null,provenance:'source-read' as const};
 it('commits quiet and retains read originals in the archived result',async()=>{
  const state={finalize:vi.fn(async()=>({quiet:true})),requireVisible:vi.fn()};mocks.runState.mockResolvedValue(state);
  mocks.runWorkerCodexTurn.mockImplementationOnce(async(...args:unknown[])=>{const emit=args[10]as(event:unknown)=>Promise<void>;
   await emit({type:'artifact',item:source});await emit({type:'content',value:'No new invoice verified.'});await emit({type:'done'});
  });
  const result=await executeScheduledTurn({installation,session,task,runKey:'source-quiet'});
  expect(state.requireVisible).not.toHaveBeenCalled();expect(mocks.messages[1].artifacts).toEqual([source]);
  await result.finalize!(async()=>{});expect(mocks.archiveGenerated).toHaveBeenCalledOnce();
 });
 it('keeps an original-only review visible without an explicit quiet state outcome',async()=>{
  const state={finalize:vi.fn(async()=>({quiet:false})),requireVisible:vi.fn()};mocks.runState.mockResolvedValue(state);
  mocks.runWorkerCodexTurn.mockImplementationOnce(async(...args:unknown[])=>{const emit=args[10]as(event:unknown)=>Promise<void>;
   await emit({type:'artifact',item:source});await emit({type:'content',value:'Read original.'});await emit({type:'done'});
  });
  const result=await executeScheduledTurn({installation,session,task,runKey:'source-visible-default'});await result.finalize!(async()=>{});
  expect(mocks.archiveGenerated).not.toHaveBeenCalled();
 });
 it('retains the visible veto for generated files despite a claimed quiet result',async()=>{
  let quiet=true;const state={finalize:vi.fn(async()=>({quiet})),requireVisible:vi.fn(async()=>{quiet=false})};mocks.runState.mockResolvedValue(state);
  mocks.runWorkerCodexTurn.mockImplementationOnce(async(...args:unknown[])=>{const emit=args[10]as(event:unknown)=>Promise<void>;
   await emit({type:'artifact',item:{...source,provenance:undefined}});await emit({type:'content',value:'Created document.'});await emit({type:'done'});
  });
  const result=await executeScheduledTurn({installation,session,task,runKey:'generated-visible'});
  expect(state.requireVisible).toHaveBeenCalledWith('result-needs-review');await result.finalize!(async()=>{});expect(mocks.archiveGenerated).not.toHaveBeenCalled();
 });
});

it("resumes a terminal read-only capacity failure in its original report and recovers its completed continuation",async()=>{
 const { MODEL_CAPACITY_MESSAGE }=await import("@/runtime/model-capacity-retry");
 const input={installation,session,task,runKey:"capacity-readonly"};
 mocks.runWorkerCodexTurn.mockImplementationOnce(async(...args:unknown[])=>{
  const emit=args[10]as(event:unknown)=>Promise<void>;
  await emit({type:"error",message:MODEL_CAPACITY_MESSAGE});
 });
 await expect(executeScheduledTurn(input)).rejects.toThrow(MODEL_CAPACITY_MESSAGE);
 const failed=structuredClone(mocks.messages);
 mocks.beginThreadTurn.mockImplementation(async(_s,_t,user,assistant)=>{
  const previous=mocks.messages.find(item=>item.id===assistant.id);
  if(previous)return{outcome:"existing",assistantMessage:previous};
  mocks.messages.push(user,assistant);return{outcome:"created",assistantMessage:assistant};
 });
 mocks.finishThreadTurn.mockImplementation(async(_s,_t,assistant)=>{
  const index=mocks.messages.findIndex(item=>item.id===assistant.id);mocks.messages[index]=assistant;
 });
 mocks.getThread.mockImplementation(async()=>({projectId:task.projectId,messages:mocks.messages}));
 const resumed={...input,existingThreadId:"30000000-0000-4000-8000-000000000001"};
 await executeScheduledTurn(resumed);
 expect(mocks.messages).toHaveLength(4);
 expect(mocks.messages.slice(0,2)).toEqual(failed);
 expect(mocks.runWorkerCodexTurn).toHaveBeenCalledTimes(2);
 expect(mocks.runWorkerCodexTurn.mock.calls[0][0].assistantMessageId).not.toBe(mocks.runWorkerCodexTurn.mock.calls[1][0].assistantMessageId);
 await executeScheduledTurn(resumed);
 expect(mocks.runWorkerCodexTurn).toHaveBeenCalledTimes(2);
 expect(mocks.messages).toHaveLength(4);
});

it("keeps pre-dispatch background deferral pending without writing a failed or successful message",async()=>{
 mocks.runWorkerCodexTurn.mockRejectedValue(new BackgroundModelAdmissionDeferred());
 await expect(executeScheduledTurn({installation,session,task,runKey:"deferred-slot"})).rejects.toBeInstanceOf(BackgroundModelAdmissionDeferred);
 expect(mocks.finishThreadTurn).not.toHaveBeenCalled();expect(mocks.archiveGenerated).not.toHaveBeenCalled();
});


it("appends recurring runs to one conversation through restart, rename and archive; retries keep exact occurrence messages",async()=>{
 const {automationTaskThreadId}=await import("./run-identities");
 const {WorkbenchNotFoundError}=await import("@/workbench/errors");
 const workbench=await import("@/workbench/store");
 const recurring={...task,schedule:{kind:"interval" as const,minutes:30,anchorAt:task.nextRunAt!}};
 const id=automationTaskThreadId(recurring)!;
 let exists=false,status="active";
 const create=vi.mocked(workbench.createThread);create.mockClear();
 create.mockImplementationOnce(async(_s,projectId,title,input)=>{exists=true;expect(input?.id).toBe(id);return{id,projectId,title,status:"active",messages:[]}as never;});
 mocks.getThread.mockImplementation(async(_s,threadId)=>{
  if(!exists)throw new WorkbenchNotFoundError("not found");
  expect(threadId).toBe(id);return{id,projectId:task.projectId,status,messages:mocks.messages};
 });
 vi.mocked(workbench.updateThread).mockImplementation(async(_s,threadId,patch)=>{expect(threadId).toBe(id);status=patch.status!;return{}as never;});
 mocks.beginThreadTurn.mockImplementation(async(_s,_t,user,assistant)=>{mocks.messages.push(user,assistant);return{outcome:"created",assistantMessage:assistant};});
 mocks.finishThreadTurn.mockImplementation(async(_s,_t,assistant)=>{const index=mocks.messages.findIndex(item=>item.id===assistant.id);mocks.messages[index]=assistant;});
 const first={installation,session,task:recurring,runKey:`${task.id}:2030-08-30T08:00:00.000Z`};
 expect((await executeScheduledTurn(first)).threadId).toBe(id);
 const initial=structuredClone(mocks.messages);
 const next={...first,task:{...recurring,name:"Renamed monitor"},runKey:`${task.id}:2030-08-30T08:30:00.000Z`};
 status="archived";
 expect((await executeScheduledTurn(next)).threadId).toBe(id);
 expect(create).toHaveBeenCalledOnce();expect(status).toBe("active");
 expect(mocks.messages).toHaveLength(4);expect(mocks.messages.slice(0,2)).toEqual(initial);
 expect(new Set(mocks.messages.map(item=>item.id)).size).toBe(4);
 expect((await executeScheduledTurn(next)).threadId).toBe(id);
 expect(mocks.messages).toHaveLength(4);expect(mocks.runWorkerCodexTurn).toHaveBeenCalledTimes(2);
 const state={finalize:vi.fn(async()=>({quiet:true})),requireVisible:vi.fn()};mocks.runState.mockResolvedValue(state);
 const quiet=await executeScheduledTurn({...next,runKey:`${task.id}:2030-08-30T09:00:00.000Z`});
 await quiet.finalize!(async()=>{});expect(mocks.archiveGenerated).not.toHaveBeenCalled();expect(status).toBe("active");
});
