import {mkdtemp,mkdir,rm,writeFile,readFile} from "node:fs/promises";
import os from "node:os";import path from "node:path";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {AuthSession} from "@/auth/types";
import {loadInstallationConfig} from "@/config/installation";
import {UserProvisioner} from "@/users/provisioner";
import {FileAutomationStore} from "./store";
import {FileAutomationProposalStore} from "./chat-proposal-store";
import {listAutomationTasks} from "./server-service";
import {createProject,updateProject} from "@/workbench/store";
import {FileWorkbenchStore} from "@/workbench/filesystem-store";
import {automationRunIdentities,automationTaskThreadId} from "./run-identities";
import type {ChatMessage} from "@/lib/chat-contract";
import {handleAutomationToolCall,AIBRAIN_AUTOMATION_TOOL_NAMESPACE} from "./chat-tools";
vi.mock("server-only",()=>({}));
const ownerId="00000000-0000-4000-8000-000000000011",memberId="00000000-0000-4000-8000-000000000012",outsiderId="00000000-0000-4000-8000-000000000013";
let root = "";
let previousConfig: string | undefined;
let previousAdmins: string | undefined;

function session(userId: string, email: string, name: string): AuthSession {
  return {
    provider: "local",
    user: { id: userId, email, name },
    tenant: { id: "automation-read-qa", name: "Automation Audience QA" },
    expiresAt: "2026-08-31T00:00:00.000Z",
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aibrain-automation-reads-"));
  const dataRoot = path.join(root, "data");
  await mkdir(dataRoot, { mode: 0o700 });
  const configPath = path.join(root, "installation.json");
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    installationId: "automation-read-qa",
    companyName: "Automation Audience QA",
    companySlug: "automation-read-qa",
    publicUrl: "http://localhost:3000",
    branding: { productName: "AiBrain", logoPath: "/logo.svg", faviconPath: "/favicon.ico", accentColor: "#111111" },
    paths: {
      dataRoot,
      companyContextRoot: path.join(dataRoot, "company"),
      usersRoot: path.join(dataRoot, "users"),
      sourceReadRoot: path.join(root, "source"),
      publishWriteRoot: path.join(root, "publish"),
      backupsRoot: path.join(dataRoot, "backups"),
    },
  }));
  previousConfig = process.env.AIBRAIN_INSTALLATION_CONFIG;
  previousAdmins = process.env.AIBRAIN_ADMIN_USER_IDS;
  process.env.AIBRAIN_INSTALLATION_CONFIG = configPath;
  process.env.AIBRAIN_ADMIN_USER_IDS = ownerId;
});

afterEach(async () => {
  if (previousConfig === undefined) delete process.env.AIBRAIN_INSTALLATION_CONFIG;
  else process.env.AIBRAIN_INSTALLATION_CONFIG = previousConfig;
  if (previousAdmins === undefined) delete process.env.AIBRAIN_ADMIN_USER_IDS;
  else process.env.AIBRAIN_ADMIN_USER_IDS = previousAdmins;
  await rm(root, { recursive: true, force: true });
});


async function fixture(){
 const installation=await loadInstallationConfig(),provisioner=new UserProvisioner(installation);
 for(const[userId,email,name]of[[ownerId,"owner@example.test","Owner"],[memberId,"member@example.test","Member"],[outsiderId,"outsider@example.test","Outsider"]])await provisioner.provision({userId,email,displayName:name});
 const owner=session(ownerId,"owner@example.test","Owner"),member=session(memberId,"member@example.test","Member"),outsider=session(outsiderId,"outsider@example.test","Outsider");
 const project=await createProject(owner,"Private owner project"),otherProject=await createProject(member,"Private member project");
 await updateProject(owner,project.id,{sharing:{visibility:"shared",members:[{id:"00000000-0000-4000-8000-000000000099",email:outsider.user.email,name:"Outsider",role:"viewer",status:"active",addedAt:new Date().toISOString()}]}});
 const store=new FileAutomationStore({installationId:installation.installationId,usersRoot:installation.paths.usersRoot,userId:ownerId}),memberStore=new FileAutomationStore({installationId:installation.installationId,usersRoot:installation.paths.usersRoot,userId:memberId});
 const schedule={kind:"monthly" as const,months:[2,5,8,11],day:1,hour:9,minute:0,startAt:"2027-02-01T08:00:00.000Z"};
 const make=(name:string,prompt:string,audience:string[])=>store.create({name,prompt,projectId:project.id,projectName:project.name,timeZone:"Europe/Madrid",schedule,audience:{membershipPolicy:"current",userIds:audience,groupIds:[]}});
 const privateTask=await make("Owner private","OWNER PRIVATE PROMPT",[ownerId]),received=await make("Received summary","DO NOT DISCLOSE ANOTHER OWNER PROMPT",[memberId]);
 const own=await memberStore.create({name:"Own review",prompt:"MEMBER OWN PROMPT",projectId:otherProject.id,projectName:otherProject.name,timeZone:"Europe/Madrid",schedule});
 // Initialize the existing workspace policy before checking read-only behavior.
 await listAutomationTasks(owner);
 return{installation,owner,member,outsider,store,memberStore,privateTask,received,own};
}
async function call(auth:AuthSession,tool:string,args:Record<string,unknown>={}){
 const params={threadId:"runtime",turnId:"turn",callId:"read-call",namespace:AIBRAIN_AUTOMATION_TOOL_NAMESPACE,tool,arguments:args};
 return handleAutomationToolCall(params as never,{session:auth,sourceThreadId:"20000000-0000-4000-8000-000000000011",sourceTurnId:"30000000-0000-4000-8000-000000000011",sourceMessage:"Read existing automations",runtimeThreadId:"runtime",runtimeTurnId:"turn",usersRoot:(await loadInstallationConfig()).paths.usersRoot});
}
function content(response:Awaited<ReturnType<typeof call>>){const item=response.contentItems[0];if(item.type!=="inputText")throw Error("expected text");return JSON.parse(item.text);}
afterEach(()=>vi.restoreAllMocks());
describe("automation chat read isolation",()=>{
 it("reads the actual persisted manual queue on a paused owned task without running it or changing its schedule",async()=>{
  const f=await fixture();const paused=await f.store.update(f.privateTask.id,{state:'paused'});
  const queued=await f.store.runNow(paused.id,'50000000-0000-4000-8000-000000000071',{expectedUpdatedAt:paused.updatedAt});
  const file=path.join(f.installation.paths.usersRoot,ownerId,'automations','tasks.json'),before=await readFile(file,'utf8');
  for(const tool of ['list','get']){
   const data=content(await call(f.owner,tool,tool==='get'?{taskId:queued.id}:{}));
   const task=tool==='get'?data.task:data.tasks.find((item:{taskId:string})=>item.taskId===queued.id);
   expect(task).toMatchObject({state:'paused',schedule:paused.schedule,nextRunAt:paused.nextRunAt,execution:{status:'queued'},lastRunStatus:null});
   expect(task).not.toHaveProperty('manualRun');expect(task).not.toHaveProperty('lease');expect(task).not.toHaveProperty('retryAt');
  }
  expect(await readFile(file,'utf8')).toBe(before);expect((await f.store.get(queued.id)).manualRun).toEqual(queued.manualRun);
 });
 it("lists owned and received metadata and rereads only the exact owner's private prompt",async()=>{
  const f=await fixture(),listed=content(await call(f.member,"list"));
  expect(listed.tasks.map((task:{taskId:string})=>task.taskId).sort()).toEqual([f.received.id,f.own.id].sort());
  expect(JSON.stringify(listed)).not.toContain("PROMPT");expect(JSON.stringify(listed)).not.toContain("effectGrant");expect(JSON.stringify(listed)).not.toContain("lease");
  expect(content(await call(f.member,"get",{taskId:f.received.id})).task).not.toHaveProperty("prompt");
  const own=content(await call(f.member,"get",{taskId:f.own.id})).task;
  expect(own).toMatchObject({taskId:f.own.id,prompt:"MEMBER OWN PROMPT",schedule:f.own.schedule,nextRunAt:f.own.nextRunAt,allowedEffects:[]});
  // Administrative management does not expose a different owner's prompt.
  expect(content(await call(f.owner,"get",{taskId:f.own.id})).task).not.toHaveProperty("prompt");
 });
 it("keeps another project/user private, rechecks audience revocation and rejects forged tenants/targets",async()=>{
  const f=await fixture();expect(content(await call(f.outsider,"list")).tasks).toEqual([]);
  const forbidden=await call(f.member,"get",{taskId:f.privateTask.id}),missing=await call(f.member,"get",{taskId:"90000000-0000-4000-8000-000000000099"});expect(forbidden).toEqual(missing);expect(forbidden.success).toBe(false);
  await f.store.update(f.received.id,{audience:{membershipPolicy:"current",userIds:[ownerId],groupIds:[]}});
  expect((await call(f.member,"get",{taskId:f.received.id})).success).toBe(false);
  expect((await call({...f.member,tenant:{id:"foreign-tenant",name:"Foreign"}},"list")).success).toBe(false);
  expect((await call({...f.member,user:{...f.member.user,email:"forged@example.test"}},"list")).success).toBe(false);
  for(const args of [{userId:ownerId},{tenantId:"foreign"},{projectId:f.privateTask.projectId}])expect((await call(f.member,"list",args)).success).toBe(false);
  expect((await call(f.member,"get",{taskId:f.privateTask.id,userId:ownerId})).success).toBe(false);
 });
 it("performs no create/update/delete/run/proposal writes when listing or reading",async()=>{
  const f=await fixture(),files=[ownerId,memberId].map(id=>path.join(f.installation.paths.usersRoot,id,"automations","tasks.json"));
  const before=await Promise.all(files.map(file=>readFile(file,"utf8")));
  const spies=[vi.spyOn(FileAutomationStore.prototype,"create"),vi.spyOn(FileAutomationStore.prototype,"update"),vi.spyOn(FileAutomationStore.prototype,"delete"),vi.spyOn(FileAutomationStore.prototype,"runNow"),vi.spyOn(FileAutomationProposalStore.prototype,"propose"),vi.spyOn(FileAutomationProposalStore.prototype,"confirm")];
  expect((await call(f.member,"list")).success).toBe(true);expect((await call(f.member,"get",{taskId:f.own.id})).success).toBe(true);
  expect(await Promise.all(files.map(file=>readFile(file,"utf8")))).toEqual(before);for(const spy of spies)expect(spy).not.toHaveBeenCalled();
  for(const tool of["update","delete","run"])expect((await call(f.member,tool,{taskId:f.own.id})).success).toBe(false);
 });
});


async function recordedResult(f: Awaited<ReturnType<typeof fixture>>, date: string, text = "Original historical report", shared = false) {
 const runKey = `${f.privateTask.id}:${date}`, ids = {...automationRunIdentities(runKey),...(shared?{threadId:automationTaskThreadId(f.privateTask)!}:{})};
 const workbench = new FileWorkbenchStore({installationId:f.installation.installationId,usersRoot:f.installation.paths.usersRoot});
 await workbench.createThread(ownerId,f.privateTask.projectId,"Programada · Historical report",ids.threadId);
 const user:ChatMessage={id:ids.userMessageId,role:"user",content:"PRIVATE SOURCE PROMPT",status:"complete",createdAt:date,activity:[],plan:[],approvals:[],diff:"",attachments:[],artifacts:[]};
 const assistant:ChatMessage={...user,id:ids.assistantMessageId,role:"assistant",content:text};
 await workbench.beginThreadTurn(ownerId,ids.threadId,user,assistant);
 await workbench.finishThreadTurn(ownerId,ids.threadId,assistant,"private-runtime-token-do-not-disclose");
 await f.store.appendRun({schemaVersion:1,runKey,taskId:f.privateTask.id,installationId:f.installation.installationId,userId:ownerId,scheduledFor:date,status:"succeeded",attempt:1,startedAt:date,finishedAt:date,threadId:ids.threadId,error:null});
 return {runKey,ids,workbench};
}

describe("own automation result recovery from another chat",()=>{
 it("recovers the persisted original with paging, filters dates and omits private runtime/prompt",async()=>{
  const f=await fixture();
  const first=await recordedResult(f,"2030-08-28T17:00:00.000Z","FIRST original report");
  await recordedResult(f,"2030-08-29T17:00:00.000Z","SECOND original report");
  const global=vi.spyOn(FileWorkbenchStore.prototype,"load").mockRejectedValue(new Error("aggregate history over safe memory budget"));
  const selected=vi.spyOn(FileWorkbenchStore.prototype,"getThread");
  const listed=content(await call(f.owner,"list_runs",{taskId:f.privateTask.id,limit:1}));
  expect(listed).toMatchObject({total:2,nextOffset:1});expect(listed.runs[0].scheduledFor).toBe("2030-08-29T17:00:00.000Z");
  expect(selected).not.toHaveBeenCalled();
  const filtered=content(await call(f.owner,"list_runs",{taskId:f.privateTask.id,after:"2030-08-28T00:00:00Z",before:"2030-08-28T23:59:59Z"}));expect(filtered.runs).toHaveLength(1);
  const part=content(await call(f.owner,"get_run",{taskId:f.privateTask.id,runKey:first.runKey,limit:6}));
  expect(part.result).toMatchObject({content:"FIRST ",offset:0,nextOffset:6,totalCharacters:21,source:"persisted-automation-result"});
  const rest=content(await call(f.owner,"get_run",{taskId:f.privateTask.id,runKey:first.runKey,offset:part.result.nextOffset}));
  expect(part.result.content+rest.result.content).toBe("FIRST original report");expect(rest.result.nextOffset).toBeNull();
  expect(selected).toHaveBeenLastCalledWith(ownerId,first.ids.threadId);expect(global).not.toHaveBeenCalled();
  expect(JSON.stringify(part)).not.toMatch(/private-runtime-token|PRIVATE SOURCE PROMPT|effectGrant|fenceToken/);
 });
 it("denies foreign owners, received/admin access, forged targets and tenants before reading histories",async()=>{
  const f=await fixture(),r=await recordedResult(f,"2030-08-28T17:00:00.000Z");
  const reads=vi.spyOn(FileWorkbenchStore.prototype,"getThread");
  const absent=await call(f.member,"get_run",{taskId:"90000000-0000-4000-8000-000000000099",runKey:r.runKey});
  expect(await call(f.member,"get_run",{taskId:f.privateTask.id,runKey:r.runKey})).toEqual(absent);
  expect((await call(f.member,"list_runs",{taskId:f.received.id})).success).toBe(false);
  expect((await call(f.owner,"list_runs",{taskId:f.own.id})).success).toBe(false);
  expect((await call({...f.owner,tenant:{id:"foreign-tenant",name:"Foreign"}},"list_runs",{taskId:f.privateTask.id})).success).toBe(false);
  expect((await call(f.owner,"get_run",{taskId:f.privateTask.id,runKey:r.runKey,userId:memberId})).success).toBe(false);
  expect((await call(f.owner,"list_runs",{taskId:f.privateTask.id,limit:51})).success).toBe(false);
  expect((await call(f.owner,"get_run",{taskId:f.privateTask.id,runKey:r.runKey,limit:16001})).success).toBe(false);
  expect(reads).not.toHaveBeenCalled();
 });
 it("reports failed or missing results honestly and never substitutes later human replies",async()=>{
  const f=await fixture(),r=await recordedResult(f,"2030-08-28T17:00:00.000Z");
  const msg:ChatMessage={id:"40000000-0000-4000-8000-000000000001",role:"user",content:"Later human question",status:"complete",createdAt:"2030-08-29T17:00:00.000Z",activity:[],plan:[],approvals:[],diff:"",attachments:[],artifacts:[]};
  await r.workbench.beginThreadTurn(ownerId,r.ids.threadId,msg,{...msg,id:"40000000-0000-4000-8000-000000000002",role:"assistant",content:"Later unrelated answer"});
  const original=content(await call(f.owner,"get_run",{taskId:f.privateTask.id,runKey:r.runKey}));expect(original.result.content).toBe("Original historical report");
  const failedKey=`${f.privateTask.id}:2030-08-29T17:00:00.000Z`;
  await f.store.appendRun({schemaVersion:1,runKey:failedKey,taskId:f.privateTask.id,installationId:f.installation.installationId,userId:ownerId,scheduledFor:"2030-08-29T17:00:00.000Z",status:"failed",attempt:1,startedAt:"2030-08-29T17:00:00.000Z",finishedAt:"2030-08-29T17:01:00.000Z",threadId:null,error:"Authentication unavailable"});
  const failed=content(await call(f.owner,"get_run",{taskId:f.privateTask.id,runKey:failedKey}));expect(failed).toMatchObject({run:{status:"failed",error:"Authentication unavailable"},result:null});
 });
});


it("recovers the selected original occurrence from a recurring conversation containing later results",async()=>{
 const f=await fixture();
 const first=await recordedResult(f,"2030-08-28T17:00:00.000Z","FIRST recurring original",true);
 const second=await recordedResult(f,"2030-08-29T17:00:00.000Z","SECOND recurring original",true);
 expect(first.ids.threadId).toBe(second.ids.threadId);
 expect(content(await call(f.owner,"get_run",{taskId:f.privateTask.id,runKey:first.runKey})).result.content).toBe("FIRST recurring original");
 expect(content(await call(f.owner,"get_run",{taskId:f.privateTask.id,runKey:second.runKey})).result.content).toBe("SECOND recurring original");
 expect((await first.workbench.getThread(ownerId,first.ids.threadId)).messages).toHaveLength(4);
 await f.store.update(f.privateTask.id,{schedule:{kind:"once",runAt:"2030-09-01T17:00:00.000Z"}});
 expect(content(await call(f.owner,"get_run",{taskId:f.privateTask.id,runKey:first.runKey})).result.content).toBe("FIRST recurring original");
});
