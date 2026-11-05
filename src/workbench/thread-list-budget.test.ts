import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { ChatMessage } from "@/lib/chat-contract";
import { loadInstallationConfig } from "@/config/installation";
import { UserProvisioner } from "@/users/provisioner";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import { FilePinnedThreadStore } from "@/workbench/pinned-thread-store";
import { syncOwnSharedAccess } from "@/workbench/shared-access";
import { listThreads } from "@/workbench/store";
import { GET } from "@/app/api/projects/[projectId]/threads/route";
import type { WorkbenchThread } from "@/workbench/types";

const memory = vi.hoisted(() => ({ heapLimit: undefined as number | undefined, opens: [] as string[] }));
const auth = vi.hoisted(() => ({ session: null as AuthSession | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: async () => auth.session }));
vi.mock("node:v8", async original => {
  const actual = await original<typeof import("node:v8")>();
  return { ...actual, getHeapStatistics: () => ({ ...actual.getHeapStatistics(),
    ...(memory.heapLimit === undefined ? {} : { heap_size_limit: memory.heapLimit }) }) };
});
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (String(args[0]).includes(`${path.sep}workbench-history${path.sep}`)) memory.opens.push(String(args[0]));
    return actual.open(...args);
  } };
});
vi.mock("@/workbench/history-format-policy", () => ({ WORKBENCH_HISTORY_MIGRATION_ENABLED: true }));
vi.mock("@/workbench/segmented-history", async original => ({
  ...await original<typeof import("@/workbench/segmented-history")>(), WORKBENCH_SEGMENT_THRESHOLD: 16 * 1024,
}));

const ownerId = "00000000-0000-4000-8000-000000000071";
const memberId = "00000000-0000-4000-8000-000000000072";
const outsiderId = "00000000-0000-4000-8000-000000000073";
let root = "";
function session(id: string): AuthSession {
  return { provider: "local", user: { id, name: "Synthetic", email: `${id}@example.test` },
    tenant: { id: "list-budget-qa", name: "Synthetic" }, expiresAt: "2030-01-01T00:00:00.000Z" };
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "workbench-list-budget-"));
  const dataRoot = path.join(root, "data"); await mkdir(dataRoot, {mode:0o700});
  const configPath = path.join(root, "installation.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion:1,installationId:"list-budget-qa",companyName:"Synthetic",companySlug:"list-budget-qa",
    publicUrl:"https://list.example.test",branding:{productName:"Synthetic",logoPath:"/logo.svg",faviconPath:"/favicon.ico",accentColor:"#111111"},
    paths:{dataRoot,usersRoot:path.join(dataRoot,"users"),companyContextRoot:path.join(dataRoot,"company"),sourceReadRoot:path.join(root,"source"),publishWriteRoot:path.join(root,"publish"),backupsRoot:path.join(dataRoot,"backups")} }));
  vi.stubEnv("AIBRAIN_INSTALLATION_CONFIG", configPath);
});
afterEach(async () => {
  memory.heapLimit=undefined;memory.opens=[];auth.session=null;vi.restoreAllMocks();vi.unstubAllEnvs();
  await rm(root,{recursive:true,force:true});
});

async function fixture(shared = false) {
  const installation=await loadInstallationConfig();const provisioner=new UserProvisioner(installation);
  for(const id of [ownerId,memberId,outsiderId]) await provisioner.provision({userId:id,email:session(id).user.email,displayName:"Synthetic"});
  const store=FileWorkbenchStore.fromInstallation(installation);
  const project=await store.createProject(ownerId,"Five QA chats");
  if(shared) await store.updateProject(ownerId,project.id,{sharing:{visibility:"shared",members:[{
    id:memberId,email:session(memberId).user.email,name:"Synthetic",role:"editor",status:"active",addedAt:"2026-11-01T00:00:00.000Z",
  }]}});
  const threads: WorkbenchThread[]=[];
  for(const title of ["Álpha","Beta archived","Gamma","Delta","Zeta"])threads.push(await store.createThread(ownerId,project.id,title));
  const other=await store.createProject(ownerId,"Unrelated history");
  const unrelated=await store.createThread(ownerId,other.id,"Unrelated large chat");
  const statePath=path.join(installation.paths.usersRoot,ownerId,"state/workbench.json");
  const state=JSON.parse(await readFile(statePath,"utf8"));
  const lastTimes=new Map<string,string>();
  for(let index=0;index<threads.length;index++){
    const thread=state.threads.find((t:{id:string})=>t.id===threads[index].id);
    thread.createdAt="2026-11-01T00:00:00.000Z";thread.updatedAt=`2026-11-01T00:00:0${index}.000Z`;thread.status=index===1?"archived":"active";
    thread.messages=Array.from({length:index+1},(_,messageIndex):ChatMessage=>({id:randomUUID(),role:messageIndex%2?"assistant":"user",
      content:messageIndex===0?"x".repeat(8192):"Synthetic",status:"complete",createdAt:`2026-11-01T00:00:0${messageIndex}.000Z`,
      activity:[],plan:[],approvals:[],diff:"",attachments:[],artifacts:[]}));
    lastTimes.set(thread.id,thread.messages.at(-1).createdAt);
  }
  const foreign=state.threads.find((t:{id:string})=>t.id===unrelated.id);
  foreign.messages=[{...state.threads.find((t:{id:string})=>t.id===threads[0].id).messages[0],id:randomUUID(),content:"UNRELATED".repeat(4096)}];
  await writeFile(statePath,JSON.stringify(state));
  await store.updateThread(ownerId,threads[0].id,{title:"Álpha"}); // migrate before reducing the synthetic budget
  expect(JSON.parse(await readFile(statePath,"utf8")).schemaVersion).toBe(2);
  const pins=new FilePinnedThreadStore(installation.paths.dataRoot,installation.paths.usersRoot,installation.installationId);
  await pins.update(ownerId,threads[2].id,true);await pins.update(ownerId,threads[0].id,true);
  await syncOwnSharedAccess(session(ownerId));
  memory.heapLimit=100_000; // 20KB per hydration: each returned history fits; aggregate/unrelated do not.
  await expect(store.load(ownerId)).rejects.toThrow("pressupost segur de memòria");
  memory.opens=[];
  return {installation,store,project,threads,lastTimes,pins};
}

describe("thread list above aggregate history budget",()=>{
  it("serves five own chats through the real GET with exact counts, pin order, filters and pagination",async()=>{
    const f=await fixture();auth.session=session(ownerId);
    const found=[];let cursor:string|null=null;
    do{
      const params=new URLSearchParams({status:"all",limit:"2",...(cursor?{cursor}:{})});
      const response=await GET(new Request(`https://list.example.test/api/projects/${f.project.id}/threads?${params}`),{params:Promise.resolve({projectId:f.project.id})});
      expect(response.status).toBe(200);const page=await response.json();found.push(...page.threads);cursor=page.nextCursor;
    }while(cursor);
    expect(found.map(t=>t.id)).toEqual([f.threads[0].id,f.threads[2].id,f.threads[4].id,f.threads[3].id,f.threads[1].id]);
    expect(memory.opens).toHaveLength(5); // only requested histories; never the unrelated object
    for(const t of found){expect(t.messageCount).toBe(f.threads.findIndex(x=>x.id===t.id)+1);expect(t.lastMessageAt).toBe(f.lastTimes.get(t.id));expect(t).not.toHaveProperty("messages");}
    expect((await listThreads(session(ownerId),f.project.id,{status:"active",limit:50,query:"alpha"})).items.map(t=>t.id)).toEqual([f.threads[0].id]);
    expect((await listThreads(session(ownerId),f.project.id,{status:"archived",limit:50})).items.map(t=>t.id)).toEqual([f.threads[1].id]);
    const first=await listThreads(session(ownerId),f.project.id,{status:"all",limit:2});
    await expect(listThreads(session(ownerId),f.project.id,{status:"active",limit:2,cursor:first.nextCursor!})).rejects.toThrow("cursor");
  });
  it("lists shared counts with personal pins, rechecks canonical revocation and denies cross-user access",async()=>{
    const f=await fixture(true);await f.pins.update(memberId,f.threads[4].id,true);
    const page=await listThreads(session(memberId),f.project.id,{status:"all",limit:50});
    expect(page.items).toHaveLength(5);expect(page.items[0]).toMatchObject({id:f.threads[4].id,pinned:true,messageCount:5,access:{role:"editor"}});
    expect(page.items.find(t=>t.id===f.threads[0].id)?.pinned).toBe(false);
    auth.session=session(outsiderId);memory.opens=[];
    const response=await GET(new Request(`https://list.example.test/api/projects/${f.project.id}/threads?status=all&limit=50`),{params:Promise.resolve({projectId:f.project.id})});
    expect(response.status).toBe(404);expect(memory.opens).toEqual([]);
    await f.store.updateProject(ownerId,f.project.id,{sharing:{visibility:"private",members:[]}}); // deliberately leave indexed grant stale
    await expect(listThreads(session(memberId),f.project.id,{status:"all",limit:50})).rejects.toThrow("Projecte no trobat");
    expect(memory.opens).toEqual([]);
  });
  it("keeps filesystem pagination counts exact without hydrating aggregate histories",async()=>{
    const f=await fixture();const result=[];let cursor:string|undefined;
    do{const page=await f.store.listThreads(ownerId,f.project.id,{status:"all",limit:2,...(cursor?{cursor}:{})});result.push(...page.items);cursor=page.nextCursor??undefined;}while(cursor);
    expect(result).toHaveLength(5);expect(new Set(result.map(t=>t.id)).size).toBe(5);
    for(const t of result)expect(t.messageCount).toBe(f.threads.findIndex(x=>x.id===t.id)+1);
    expect(memory.opens).toHaveLength(5);
  });
});
