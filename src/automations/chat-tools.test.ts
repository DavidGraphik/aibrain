import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { DynamicToolCallParams } from "../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams";
import type { JsonValue } from "../../contracts/codex/0.162.1/types/serde_json/JsonValue";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  userId: "00000000-0000-4000-8000-000000000001",
  projectId: "10000000-0000-4000-8000-000000000001",
  sourceThreadId: "20000000-0000-4000-8000-000000000001",
  project: {
    id: "10000000-0000-4000-8000-000000000001",
    name: "Conversaciones",
    slug: "aibrain-standalone-chats",
    status: "active" as const,
  },
  createAutomationTask: vi.fn(),
  updateAutomationTask: vi.fn(),
  runAutomationTaskNow: vi.fn(),
  tasks: [] as Record<string,unknown>[],
  allow: true,
}));

vi.mock("@/automations/server-service", () => ({
  automationWorkspaceForSession: vi.fn(async () => ({ installation: {}, users: [], state: {}, principal: {}, isAdmin: false })),
  createAutomationTask: mocks.createAutomationTask,
  updateAutomationTask: mocks.updateAutomationTask,
  runAutomationTaskNow: mocks.runAutomationTaskNow,
  listAutomationTasks: vi.fn(async () => ({
    tasks: mocks.tasks,
    directory: {
      membershipPolicy: "current" as const,
      currentUserId: mocks.userId,
      users: [{ id: mocks.userId, name: "David" }],
      groups: [],
    },
  })),
  validateAutomationAudience: vi.fn((audience) => audience),
}));

vi.mock("@/runtime/permission-turn", () => ({ resolveServerTurnPermissions: async () => ({allow:mocks.allow}), permissionAllowsGenericToolExecution: (p:{allow?:boolean}) => p.allow === true }));

vi.mock("@/workbench/store", () => ({
  getProject: vi.fn(async () => mocks.project),
  loadWorkbench: vi.fn(async (_session: unknown, metadataOnly?: boolean) => {
    if (!metadataOnly) throw new Error("Unrelated aggregate history exceeds the memory budget");
    return { projects: [mocks.project] };
  }),
}));

import {
  AIBRAIN_AUTOMATION_TOOL_NAMESPACE,
  AUTOMATION_DYNAMIC_TOOLS,
  automationChatDeveloperInstructions,
  handleAutomationToolCall,
  needsAutomationChatTools,
} from "@/automations/chat-tools";

const session: AuthSession = {
  provider: "local",
  user: { id: mocks.userId, name: "David", email: "david@example.test" },
  tenant: { id: "automation-qa", name: "Automation QA" },
  expiresAt: "2030-01-01T00:00:00.000Z",
};

function toolCall(tool: "create" | "propose" | "confirm" | "update" | "run_now", turnId: string, args: JsonValue): DynamicToolCallParams {
  return {
    threadId: "runtime-thread",
    turnId,
    callId: `call-${turnId}`,
    namespace: AIBRAIN_AUTOMATION_TOOL_NAMESPACE,
    tool,
    arguments: args,
  };
}

beforeEach(() => {
  mocks.tasks=[];mocks.allow=true;
  mocks.updateAutomationTask.mockReset();
  mocks.updateAutomationTask.mockImplementation(async (_session,id,patch) => ({...mocks.tasks.find(t=>t.id===id),...patch}));
  mocks.runAutomationTaskNow.mockReset();
  mocks.runAutomationTaskNow.mockImplementation(async (_session,id) => mocks.tasks.find(t=>t.id===id));
  mocks.createAutomationTask.mockReset();
  mocks.createAutomationTask.mockImplementation(async (_session, _input, options: { taskId: string }) => ({ id: options.taskId }));
});

afterEach(()=>vi.restoreAllMocks());

describe('owner-only coarse automation execution readback',()=>{
 const taskId='50000000-0000-4000-8000-000000000071';
 const now=Date.parse('2030-08-30T08:00:00.000Z');
 const manualRun={requestId:'50000000-0000-4000-8000-000000000072',scheduledFor:'2030-08-30T07:59:00.000Z'};
 const lease={runKey:'private-run-key',ownerId:'private-worker-owner',fenceToken:'private-fence-token',scheduledFor:manualRun.scheduledFor,expiresAt:'2030-08-30T08:10:00.000Z'};
 const task=()=>({id:taskId,userId:mocks.userId,name:'Own paused reminder',prompt:'private-prompt',projectId:mocks.projectId,projectName:'Own project',timeZone:'Europe/Madrid',schedule:{kind:'once',runAt:'2030-09-01T08:00:00.000Z'},executionContext:{allowedEffects:[],effectGrant:{token:'private-grant-token'}},audience:{membershipPolicy:'current',userIds:[mocks.userId],groupIds:[]},owner:{userId:mocks.userId},access:{canManage:true,canViewResults:true},deletedAt:null,updatedAt:'2030-08-30T07:00:00.000Z',state:'paused',lease:null,manualRun:null,retryAt:null,nextRunAt:'2030-09-01T08:00:00.000Z',lastRunAt:null,lastRunStatus:null});
 const context=()=>({session,sourceThreadId:mocks.sourceThreadId,sourceTurnId:'30000000-0000-4000-8000-000000000088',sourceMessage:'Comprueba si sigue pendiente, sin ejecutarla.',runtimeThreadId:'runtime-thread',runtimeTurnId:'read',usersRoot:'/not-used'});
 async function read(tool:'list'|'get'){
  const response=await handleAutomationToolCall({threadId:'runtime-thread',turnId:'read',callId:'read',namespace:AIBRAIN_AUTOMATION_TOOL_NAMESPACE,tool,arguments:tool==='get'?{taskId}:{}},context());
  expect(response.success).toBe(true);const item=response.contentItems[0];if(item.type!=='inputText')throw Error('expected text');const value=JSON.parse(item.text);return tool==='get'?value.task:value.tasks[0];
 }
 it.each([
  ['paused manual queue',{manualRun},{status:'queued'}],
  ['active claim',{manualRun,lease},{status:'running'}],
  ['expired claim',{manualRun,lease:{...lease,expiresAt:'2030-08-30T07:59:59.999Z'}},{status:'uncertain',reason:'lease_expired'}],
  ['exact expiry boundary',{lease:{...lease,expiresAt:'2030-08-30T08:00:00.000Z'}},{status:'uncertain',reason:'lease_expired'}],
  ['unavailable expiry',{lease:{...lease,expiresAt:'invalid'}},{status:'uncertain',reason:'lease_expiry_unavailable'}],
  ['pending retry before manual queue',{manualRun,retryAt:'2030-08-30T08:05:00.000Z'},{status:'retry_pending'}],
  ['claim before retry',{lease,retryAt:'2030-08-30T08:05:00.000Z'},{status:'running'}],
  ['idle paused schedule',{}, {status:'idle'}],
  ['idle active future schedule',{state:'active'},{status:'idle'}],
 ])('projects %s without exposing execution internals or changing stored state',async(_label,patch,expected)=>{
  vi.spyOn(Date,'now').mockReturnValue(now);mocks.tasks=[{...task(),...patch}];const before=structuredClone(mocks.tasks);
  for(const tool of ['list','get'] as const){
   const actual=await read(tool);expect(actual.execution).toEqual(expected);expect(actual).toMatchObject({state:mocks.tasks[0].state,schedule:mocks.tasks[0].schedule,nextRunAt:mocks.tasks[0].nextRunAt});
   expect(JSON.stringify(actual)).not.toMatch(/private-run-key|private-worker-owner|private-fence-token|private-grant-token|requestId|retryAt|manualRun|expiresAt|fenceToken|effectGrant|runtime/);
  }
  expect(mocks.tasks).toEqual(before);expect(mocks.runAutomationTaskNow).not.toHaveBeenCalled();expect(mocks.updateAutomationTask).not.toHaveBeenCalled();expect(mocks.createAutomationTask).not.toHaveBeenCalled();
 });
 it.each([{canManage:false,canViewResults:true},{canManage:true,canViewResults:true}])('preserves received/admin metadata without private execution status: %j',async access=>{
  mocks.tasks=[{...task(),userId:'00000000-0000-4000-8000-000000000099',owner:{userId:'00000000-0000-4000-8000-000000000099'},access,manualRun,lease,retryAt:'2030-08-30T08:05:00.000Z'}];
  for(const tool of ['list','get'] as const){const actual=await read(tool);expect(actual).not.toHaveProperty('execution');expect(actual).not.toHaveProperty('prompt');expect(actual).not.toHaveProperty('allowedEffects');expect(actual).not.toHaveProperty('audience');expect(actual).toMatchObject({taskId,access,state:'paused'});expect(JSON.stringify(actual)).not.toMatch(/private-|requestId|retryAt|manualRun|expiresAt|fenceToken|effectGrant|runtime/);}
 });
 it('guides current queue observations and completed original results without a second run or delivery claim',async()=>{
  const guide=await automationChatDeveloperInstructions(session,{projectId:mocks.projectId});expect(guide).toContain('execution.status');expect(guide).toContain('lease_expired');expect(guide).toContain('sin lanzar otra ejecución');expect(guide).toContain('Ninguno de esos estados prueba entrega externa');
 });
});

describe("automation chat creation", () => {
  it("detects scheduling turns that need a fresh dynamic-tool thread", () => {
    expect(needsAutomationChatTools("Envíame hello dentro de 2 minutos")).toBe(true);
    expect(needsAutomationChatTools("Cada lunes revisa @gmail y prepara un resumen")).toBe(true);
    expect(needsAutomationChatTools("recordarme con la próxima factura")).toBe(true);
    expect(needsAutomationChatTools("cada mes el día 2")).toBe(true);
    expect(needsAutomationChatTools("Confirmo, créala")).toBe(true);
    expect(needsAutomationChatTools("Qué automatizaciones tengo")).toBe(true);
    expect(needsAutomationChatTools("Consulta mis recordatorios")).toBe(true);
    expect(needsAutomationChatTools("Qué tengo programado")).toBe(true);
    expect(needsAutomationChatTools("Sí, esa conclusión es correcta")).toBe(false);
    expect(needsAutomationChatTools("Resume la conversación anterior")).toBe(false);
  });

  it("gives natural relative instructions safe current-user defaults", async () => {
    const instructions = await automationChatDeveloperInstructions(session, {
      projectId: mocks.projectId,
      currentTime: new Date("2030-08-30T08:00:00.000Z"),
      timeZone: "Europe/Madrid",
    });

    expect(instructions).toContain("envíame hello dentro de 2 minutos");
    expect(instructions).toContain("no pidas aclaraciones por esos campos");
    expect(instructions).toContain("menciones @");
    expect(instructions).toContain('"projectName":"Sin proyecto"');
    expect(instructions).toContain('"currentTime":"2030-08-30T08:00:00.000Z"');
    expect(instructions).toContain(`"userIds":["${mocks.userId}"]`);
  });

  it("confirms the latest durable proposal from a later natural yes without repeating its id", async () => {
    const usersRoot = await mkdtemp(path.join(os.tmpdir(), "aibrain-chat-confirm-"));
    const base = {
      session,
      sourceThreadId: mocks.sourceThreadId,
      sourceMessage: "Envíame hello dentro de 2 minutos",
      runtimeThreadId: "runtime-thread",
      usersRoot,
    };
    const proposed = await handleAutomationToolCall(toolCall("propose", "runtime-turn-one", {
      name: "Hello",
      prompt: "Envía hello como resultado de esta automatización.",
      projectId: mocks.projectId,
      timeZone: "Europe/Madrid",
      schedule: { kind: "once", runAt: "2030-08-30T08:02:00.000Z" },
      audience: { membershipPolicy: "current", userIds: [mocks.userId], groupIds: [] },
    }), {
      ...base,
      sourceTurnId: "30000000-0000-4000-8000-000000000001",
      runtimeTurnId: "runtime-turn-one",
    });
    expect(proposed.success).toBe(true);

    const confirmed = await handleAutomationToolCall(toolCall("confirm", "runtime-turn-two", {}), {
      ...base,
      sourceMessage: "Sí, adelante",
      sourceTurnId: "30000000-0000-4000-8000-000000000002",
      runtimeTurnId: "runtime-turn-two",
    });
    const replay = await handleAutomationToolCall(toolCall("confirm", "runtime-turn-three", {}), {
      ...base,
      sourceMessage: "Confirmo",
      sourceTurnId: "30000000-0000-4000-8000-000000000003",
      runtimeTurnId: "runtime-turn-three",
    });

    expect(confirmed.success).toBe(true);
    expect(replay.success).toBe(true);
    expect(mocks.createAutomationTask).toHaveBeenCalledTimes(1);
  });
});

it("creates a recurring reminder immediately and reconciles retries from the same authenticated turn", async () => {
  const usersRoot = await mkdtemp(path.join(os.tmpdir(), "aibrain-chat-direct-"));
  const context = { session, sourceThreadId: mocks.sourceThreadId, sourceMessage: "Recuérdame cada día 2 pedir el listado", runtimeThreadId: "runtime-thread", runtimeTurnId: "runtime-direct", sourceTurnId: "30000000-0000-4000-8000-000000000005", usersRoot };
  const args = { name: "Listado mensual", prompt: "Recordar solicitar el listado sin enviar correos.", projectId: mocks.projectId, timeZone: "Europe/Madrid", schedule: { kind: "monthly", months: [1,2,3,4,5,6,7,8,9,10,11,12], day: 2, hour: 9, minute: 0, startAt:"2027-02-01T09:00:00+01:00" }, audience: { membershipPolicy: "current", userIds: [mocks.userId], groupIds: [] } };
  const first = await handleAutomationToolCall(toolCall("create", "runtime-direct", args), context);
  const retried = await handleAutomationToolCall({ ...toolCall("create", "runtime-direct", args), callId: "retry-call" }, context);
  expect(first.success).toBe(true);
  expect(mocks.createAutomationTask.mock.calls[0][1].schedule.startAt).toBe("2027-02-01T08:00:00.000Z");
  expect(retried).toEqual(first);
  const invalid=await handleAutomationToolCall(toolCall("create","runtime-direct",{...args,schedule:{...args.schedule,startAt:"2027-02-30T09:00:00+01:00"}}),{...context,sourceTurnId:"30000000-0000-4000-8000-000000000099"});
  expect(invalid.success).toBe(false);
  expect(mocks.createAutomationTask).toHaveBeenCalledTimes(2);
  expect(mocks.createAutomationTask.mock.calls[0][2].taskId).toEqual(mocks.createAutomationTask.mock.calls[1][2].taskId);
  const instructions = await automationChatDeveloperInstructions(session, { projectId: mocks.projectId });
  expect(instructions).toContain("sin pedir otro sí");
  expect(instructions).toContain("No sustituyas una recurrencia por un lote finito");
});

it("accepts the real 30-minute reminder shape including ISO without milliseconds and retains the employee work window", async () => {
  const usersRoot = await mkdtemp(path.join(os.tmpdir(), "aibrain-chat-interval-"));
  const context = { session, sourceThreadId: mocks.sourceThreadId, sourceMessage: "Vigila cada 30 minutos de lunes a viernes de 8 a 18", runtimeThreadId: "runtime-thread", runtimeTurnId: "runtime-interval", sourceTurnId: "30000000-0000-4000-8000-000000000006", usersRoot };
  const result = await handleAutomationToolCall(toolCall("create", "runtime-interval", { name: "Próxima factura", prompt: "Avisar de certificados por posición con la próxima factura.", projectId: mocks.projectId, timeZone: "Europe/Madrid", schedule: { kind: "interval", minutes: 30, anchorAt: "2030-08-30T07:30:00Z", window: { weekdays: [1,2,3,4,5], startHour: 8, endHour: 18 } }, audience: { membershipPolicy: "current", userIds: [mocks.userId], groupIds: [] } }), context);
  expect(result.success).toBe(true);
  expect(mocks.createAutomationTask.mock.calls[0][1].schedule).toEqual({ kind: "interval", minutes: 30, anchorAt: "2030-08-30T07:30:00.000Z", window: { weekdays: [1,2,3,4,5], startHour: 8, endHour: 18 } });
  const failed = await handleAutomationToolCall(toolCall("create", "runtime-interval", { name: "bad" }), context);
  expect(failed.success).toBe(false);
  expect(JSON.stringify(failed)).toContain("not-created");
  expect(JSON.stringify(failed)).toContain("incompleta");
});

it("rejects a foreign runtime turn without creating scheduled work", async () => {
  const result = await handleAutomationToolCall(toolCall("create", "foreign-runtime", {}), { session, sourceThreadId: mocks.sourceThreadId, sourceMessage: "Recordatorio", runtimeThreadId: "runtime-thread", runtimeTurnId: "current-runtime", sourceTurnId: "30000000-0000-4000-8000-000000000007", usersRoot: "/not-used" });
  expect(result.success).toBe(false);
  expect(mocks.createAutomationTask).not.toHaveBeenCalled();
});

it("records only the requested narrow effects with the original authenticated human action", async () => {
  const usersRoot = await mkdtemp(path.join(os.tmpdir(), "aibrain-chat-effects-"));
  const triniSession = {...session,tenant:{id:"trinalum-production",name:"Trinalum"}};
  const human = "Cada día 2 crea en Attio la tarea de pedir el listado a Deniz. No envíes correos.";
  const result = await handleAutomationToolCall(toolCall("create", "runtime-effects", {name:"Listado",prompt:"Crear la Task de pedir listado a Deniz.",projectId:mocks.projectId,timeZone:"Europe/Madrid",schedule:{kind:"monthly",months:[1,2,3,4,5,6,7,8,9,10,11,12],day:2,hour:9,minute:0},audience:{membershipPolicy:"current",userIds:[mocks.userId],groupIds:[]},allowedEffects:["attio-task"]}), {session:triniSession,sourceThreadId:mocks.sourceThreadId,sourceTurnId:"30000000-0000-4000-8000-000000000009",sourceMessage:human,runtimeThreadId:"runtime-thread",runtimeTurnId:"runtime-effects",usersRoot});
  expect(result.success).toBe(true);
  expect(mocks.createAutomationTask.mock.calls[0][1].executionContext).toMatchObject({allowedEffects:["attio-task"],effectGrant:{installationId:"trinalum-production",userId:mocks.userId,projectId:mocks.projectId,sourceMessage:human}});
});


it("exposes create, owned updates and authorized reads with provider-compatible descriptions",()=>{
 const namespace=AUTOMATION_DYNAMIC_TOOLS[0];expect(namespace.type).toBe("namespace");expect(namespace.description!.length).toBeLessThanOrEqual(1024);
 if(namespace.type==="namespace") {expect(namespace.tools.map(tool=>tool.name)).toEqual(["list_runs","get_run","list","get","update","run_now","create"]);for(const tool of namespace.tools)expect(tool.description!.length).toBeLessThanOrEqual(1024);}
});


describe("automation chat updates",()=>{
 const taskId="50000000-0000-4000-8000-000000000001";
 const updatedAt="2030-08-30T08:00:00.000Z";
 const current=()=>({id:taskId,userId:mocks.userId,name:"Catálogo",prompt:"Recordar enviar catálogo cada día",projectId:mocks.projectId,projectName:"Conversaciones",timeZone:"Europe/Madrid",schedule:{kind:"daily",hour:9,minute:0},executionContext:{webSearch:"always",inheritAuthorizedSkills:true,inheritAuthorizedConnectors:true},audience:{membershipPolicy:"current",userIds:[mocks.userId],groupIds:[]},owner:{userId:mocks.userId,name:"David"},access:{canManage:true,canViewResults:true},deletedAt:null,updatedAt,state:"active"});
 const context=()=>({session,sourceThreadId:mocks.sourceThreadId,sourceTurnId:"30000000-0000-4000-8000-000000000010",sourceMessage:"Avisarme solo de lunes a viernes, sábados y domingos no",runtimeThreadId:"runtime-thread",runtimeTurnId:"edit",usersRoot:"/not-used"});
 const call=(patch:JsonValue,extra={})=>toolCall("update","edit",{taskId,expectedUpdatedAt:updatedAt,patch,...extra});
 it("edits the owned schedule in place, preserving the audience and prompt",async()=>{
  mocks.tasks=[current()];
  const schedule={kind:"weekly",weekdays:[1,2,3,4,5],hour:9,minute:0};
  const result=await handleAutomationToolCall(call({schedule}),context());
  expect(result.success).toBe(true);
  expect(mocks.updateAutomationTask).toHaveBeenCalledWith(session,taskId,{schedule},{expectedUpdatedAt:updatedAt,ownerOnly:true});
  expect(mocks.createAutomationTask).not.toHaveBeenCalled();
  expect(result.contentItems).toEqual(expect.arrayContaining([expect.objectContaining({text:expect.stringContaining('"status":"updated"')})]));
 });
 it("normalizes offset schedule dates on update using the same calendar validation as creation",async()=>{
  mocks.tasks=[current()];
  expect((await handleAutomationToolCall(call({schedule:{kind:"once",runAt:"2030-09-02T09:00:00+02:00"}}),context())).success).toBe(true);
  expect(mocks.updateAutomationTask.mock.calls[0][2].schedule.runAt).toBe("2030-09-02T07:00:00.000Z");
 });
 it("rejects stale, received, foreign, forbidden and malformed updates without writes",async()=>{
  for(const task of [{...current(),userId:"foreign"},{...current(),updatedAt:"2030-08-30T09:00:00.000Z"},{...current(),access:{canManage:false,canViewResults:true}},{...current(),schedule:{kind:"external"}}]){
   mocks.tasks=[task];expect((await handleAutomationToolCall(call({state:"paused"}),context())).success).toBe(false);
  }
  mocks.tasks=[current()];
  for(const patch of [{audience:{userIds:["foreign"]}},{executionContext:{}},{projectId:mocks.projectId},{state:"deleted"},{schedule:{kind:"interval",minutes:1}},{}]) expect((await handleAutomationToolCall(call(patch),context())).success).toBe(false);
  mocks.allow=false;expect((await handleAutomationToolCall(call({state:"paused"}),context())).success).toBe(false);
  expect(mocks.updateAutomationTask).not.toHaveBeenCalled();
 });
 it("rebinds an edited effect prompt to this authenticated human request without adding effects",async()=>{
  mocks.tasks=[{...current(),executionContext:{...current().executionContext,allowedEffects:["attio-task"]}}];
  const ctx={...context(),session:{...session,tenant:{id:"trinalum-production",name:"Trinalum"}}};
  const result=await handleAutomationToolCall(call({prompt:"Crear recordatorios en Attio solo de lunes a viernes"}),ctx);
  expect(result.success).toBe(true);
  expect(mocks.updateAutomationTask.mock.calls[0][2].executionContext).toMatchObject({allowedEffects:["attio-task"],effectGrant:{sourceMessage:ctx.sourceMessage,userId:mocks.userId,projectId:mocks.projectId}});
 });
 it("adds only an explicitly requested note effect to the owned task, preserving its grants and scope",async()=>{
  mocks.tasks=[{...current(),executionContext:{...current().executionContext,allowedEffects:["attio-task","mail-draft"]}}];
  const human="En el seguimiento Nabaltec existente registra también las respuestas verificadas como notas en Attio, sin enviar correos.";
  const ctx={...context(),sourceMessage:human,session:{...session,tenant:{id:"trinalum-production",name:"Trinalum"}}};
  const result=await handleAutomationToolCall(call({}, {addAllowedEffects:["attio-note"]}),ctx);
  expect(result.success).toBe(true);
  const patch=mocks.updateAutomationTask.mock.calls[0][2];
  expect(patch.executionContext).toMatchObject({allowedEffects:["attio-task","mail-draft","attio-note"],effectGrant:{sourceMessage:human,userId:mocks.userId,projectId:mocks.projectId}});
  expect(patch).not.toHaveProperty("audience");expect(patch).not.toHaveProperty("projectId");expect(patch).not.toHaveProperty("schedule");
 });
 it("does not use background, foreign owner, admin or support status to expand effects",async()=>{
  const ctx={...context(),session:{...session,tenant:{id:"trinalum-production",name:"Trinalum"}}};
  mocks.tasks=[current()];
  for(const effects of [["attio-task"],["mail-draft"],["send-mail"],["attio-note","attio-task"],[]])expect((await handleAutomationToolCall(call({}, {addAllowedEffects:effects}),ctx)).success).toBe(false);
  expect((await handleAutomationToolCall(call({}, {addAllowedEffects:["attio-note"]}),{...ctx,backgroundExecution:true})).success).toBe(false);
  mocks.tasks=[{...current(),userId:"00000000-0000-4000-8000-000000000099",access:{canManage:true}}];
  expect((await handleAutomationToolCall(call({}, {addAllowedEffects:["attio-note"]}),{...ctx,session:{...ctx.session,support:{actorEmail:"operator@example.test",expiresAt:"2035-01-01T00:00:00Z"}}})).success).toBe(false);
  expect(mocks.updateAutomationTask).not.toHaveBeenCalled();
 });

});

describe('owned automation manual execution from chat',()=>{
 const taskId='50000000-0000-4000-8000-000000000001';
 const expectedUpdatedAt='2030-08-30T08:00:00.000Z';
 const task=()=>({id:taskId,userId:mocks.userId,name:'Own paused reminder',prompt:'Internal reminder only',projectId:mocks.projectId,projectName:'Own project',timeZone:'Europe/Madrid',schedule:{kind:'once',runAt:'2030-09-01T08:00:00.000Z'},executionContext:{allowedEffects:[]},audience:{membershipPolicy:'current',userIds:[mocks.userId],groupIds:[]},owner:{userId:mocks.userId},access:{canManage:true,canViewResults:true},deletedAt:null,updatedAt:expectedUpdatedAt,state:'paused'});
 const context=()=>({session,sourceThreadId:mocks.sourceThreadId,sourceTurnId:'30000000-0000-4000-8000-000000000088',sourceMessage:'Ejecuta ahora una sola vez mi recordatorio y déjalo pausado.',runtimeThreadId:'runtime-thread',runtimeTurnId:'manual',usersRoot:'/not-used'});
 const call=()=>toolCall('run_now','manual',{taskId,expectedUpdatedAt});
 it('queues one owned paused occurrence using a stable server-derived request ID without changing grants or schedule',async()=>{
  mocks.tasks=[task()];const first=await handleAutomationToolCall(call(),context());
  const replay=await handleAutomationToolCall({...call(),callId:'retry-different-call-id'},context());
  expect(first.success).toBe(true);expect(replay).toEqual(first);
  const a=mocks.runAutomationTaskNow.mock.calls[0],b=mocks.runAutomationTaskNow.mock.calls[1];
  expect(a).toEqual(b);expect(a.slice(0,2)).toEqual([session,taskId]);
  expect(a[2]).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
  expect(a[3]).toEqual({expectedUpdatedAt,ownerOnly:true});
  expect(JSON.stringify(first)).toContain('queued');expect(JSON.stringify(first)).not.toContain('succeeded');
  expect(mocks.updateAutomationTask).not.toHaveBeenCalled();expect(mocks.createAutomationTask).not.toHaveBeenCalled();
 });
 it('denies background, foreign/received and host-managed work or revoked permissions without queuing',async()=>{
  mocks.tasks=[task()];expect((await handleAutomationToolCall(call(),{...context(),backgroundExecution:true})).success).toBe(false);
  mocks.tasks=[{...task(),userId:'00000000-0000-4000-8000-000000000099'}];expect((await handleAutomationToolCall(call(),context())).success).toBe(false);
  mocks.tasks=[{...task(),schedule:{kind:'external'}}];expect((await handleAutomationToolCall(call(),context())).success).toBe(false);
  mocks.tasks=[task()];mocks.allow=false;expect((await handleAutomationToolCall(call(),context())).success).toBe(false);
  expect(mocks.runAutomationTaskNow).not.toHaveBeenCalled();
 });
 it('returns the actual stale-version conflict and does not falsely claim a queued run',async()=>{
  mocks.tasks=[task()];mocks.runAutomationTaskNow.mockRejectedValueOnce(Error('La automatización ha cambiado; vuelve a leerla antes de ejecutarla.'));
  const response=await handleAutomationToolCall(call(),context());expect(response.success).toBe(false);
  expect(JSON.stringify(response)).toContain('not-queued');expect(JSON.stringify(response)).toContain('ha cambiado');
 });
});


it.each(["weekly", "daily", "interval"])("normalizes a requested first date for %s without changing owner or replay identity", async kind => {
 const usersRoot = await mkdtemp(path.join(os.tmpdir(), "aibrain-chat-start-"));
 const context = {session, sourceThreadId:mocks.sourceThreadId, sourceTurnId:"30000000-0000-4000-8000-000000000088", sourceMessage:"De lunes a viernes desde el 9 de noviembre", runtimeThreadId:"runtime-thread", runtimeTurnId:"runtime-start", usersRoot};
 const schedule = kind === "interval" ? {kind,minutes:60,anchorAt:"2026-11-04T18:00:00Z",startAt:"2026-11-09T09:00:00+01:00"} : {kind,hour:9,minute:0,...(kind === "weekly" ? {weekdays:[1,2,3,4,5]} : {}), startAt:"2026-11-09T09:00:00+01:00"};
 const args = {name:"Inicio real",prompt:"Muestra el recordatorio",projectId:mocks.projectId,timeZone:"Europe/Madrid",schedule,audience:{membershipPolicy:"current",userIds:[mocks.userId],groupIds:[]}};
 const first = await handleAutomationToolCall(toolCall("create","runtime-start",args),context);
 expect(first.success).toBe(true);
 expect(mocks.createAutomationTask.mock.calls[0][1].schedule.startAt).toBe("2026-11-09T08:00:00.000Z");
 expect(await handleAutomationToolCall({...toolCall("create","runtime-start",args),callId:"retry-start"},context)).toEqual(first);
 expect(mocks.createAutomationTask.mock.calls[0][2].taskId).toBe(mocks.createAutomationTask.mock.calls[1][2].taskId);
});
