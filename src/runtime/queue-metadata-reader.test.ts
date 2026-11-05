import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm, lstat, chmod, realpath, readFile, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireWorkerKernelLease } from "./workers/kernel-ownership";
import { DurableTurnSubmission } from "./turn-submission-store";
import { FileModelTurnQueue } from "./model-turn-queue";
import { modelQueueReconciler } from "./model-turn-queue-recovery";
import { ResourceLockManager } from "@/storage";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { parseInstallationConfig } from "@/config/installation-schema";
import { WorkerProvisioner, readExistingWorkerLaunchContext } from "./workers/provisioner";
import { readIsolatedQueueTerminal, withExistingQueueMetadataBoundary } from "./queue-metadata-reader";
vi.mock("server-only",()=>({}));
const roots:string[]=[];
const userId="00000000-0000-4000-8000-000000000001";
async function fixture(){
  const root=await realpath(await mkdtemp(path.join(tmpdir(),"queue-metadata-")));roots.push(root);
  const config=parseInstallationConfig({schemaVersion:1,installationId:"queue-qa",companyName:"QA",companySlug:"queue-qa",publicUrl:"http://localhost:3000",
    branding:{productName:"QA",logoPath:"/logo.svg",faviconPath:"/favicon.svg",accentColor:"#3366ff"},
    paths:{dataRoot:path.join(root,"data"),usersRoot:path.join(root,"data/users"),companyContextRoot:path.join(root,"data/company"),sourceReadRoot:path.join(root,"source"),publishWriteRoot:path.join(root,"publish"),backupsRoot:path.join(root,"data/backups")}});
  await Promise.all([config.paths.companyContextRoot,config.paths.sourceReadRoot,config.paths.publishWriteRoot].map(p=>mkdir(p,{recursive:true,mode:0o700})));
  const manifest=await new WorkerProvisioner({config,sharedCodexAuth:null}).provision(userId);
  vi.spyOn(FileLocalUserStore.prototype,"read").mockResolvedValue({enabled:true} as Awaited<ReturnType<FileLocalUserStore["read"]>>);
  return {root,config,manifest};
}
const childSource=`const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const r=JSON.parse(line);if(!r.id)return;
const result=r.method==='initialize'?{userAgent:'test'}:r.method==='thread/read'?{thread:{id:'remote-thread',turns:[]}}:r.method==='thread/turns/list'?{data:[{id:'remote-turn',status:'interrupted',items:[]}],nextCursor:null}:null;
if(result===null){process.exit(9);return;}process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});`;
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
describe("isolated cold queue metadata reader",()=>{
  it("reads a cold owner's exact terminal through an independent child without touching a live worker",async()=>{
    const f=await fixture();const live=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
    let ownChild:ReturnType<typeof spawn>|undefined;
    try{
      const result=await readIsolatedQueueTerminal(f.config,userId,"remote-thread","remote-turn",{processFactory:context=>{
        expect(context.userId).toBe(userId);expect(context.environment.CODEX_HOME).toBe(f.manifest.roots.codexHome);
        expect(context.environment.HOME).toBe(f.manifest.roots.home);
        ownChild=spawn(process.execPath,["-e",childSource],{cwd:context.workspace,stdio:["pipe","pipe","pipe"]});return ownChild as ChildProcessWithoutNullStreams;
      }});
      expect(result).toBe("interrupted");expect(live.exitCode).toBeNull();expect(live.signalCode).toBeNull();
      expect(ownChild?.exitCode!==null||ownChild?.signalCode!==null).toBe(true);
    }finally{live.kill();}
  });
  it("lets a cold initialize use the existing total budget past three seconds", async () => {
    const f = await fixture();
    const methods: string[] = [];
    const source = childSource.replace("process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');", "setTimeout(()=>process.stdout.write(JSON.stringify({id:r.id,result})+'\\n'),r.method==='initialize'?3100:0);");
    expect(source).not.toBe(childSource);
    const result = await readIsolatedQueueTerminal(f.config, userId, "remote-thread", "remote-turn", { processFactory: context => {
      const child = spawn(process.execPath, ["-e", source], { cwd: context.workspace, stdio: ["pipe", "pipe", "pipe"] });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((chunk: unknown, ...args: unknown[]) => {
        const request = JSON.parse(String(chunk)); methods.push(request.method);
        return Reflect.apply(write, child.stdin, [chunk, ...args]);
      }) as typeof child.stdin.write;
      return child;
    } });
    expect(result).toBe("interrupted");
    expect(methods).toEqual(["initialize", "initialized", "thread/read", "thread/turns/list"]);
  }, 7000);

  it("does not reset the total deadline after a late initialize", async () => {
    const f = await fixture(); let child: ChildProcessWithoutNullStreams | undefined;
    const acknowledged: string[] = [];
    const source = childSource.replace("process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');", "setTimeout(()=>process.stdout.write(JSON.stringify({id:r.id,result})+'\\n'),r.method==='initialize'?250:300);");
    expect(source).not.toBe(childSource);
    const started = performance.now();
    await expect(readIsolatedQueueTerminal(f.config, userId, "remote-thread", "remote-turn", { timeoutMs: 450, processFactory: () => {
      child = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.on("data", bytes => {
        for (const line of bytes.toString().trim().split("\n")) {
          const reply = JSON.parse(line);
          if (reply.result?.userAgent) acknowledged.push("initialize");
          if (reply.result?.thread) acknowledged.push("thread/read");
        }
      });
      return child;
    } })).rejects.toThrow("unavailable");
    expect(acknowledged).toEqual(["initialize"]); // no new 450ms allowance after the 250ms startup
    expect(performance.now() - started).toBeLessThan(1100); // original deadline + bounded owned-child cleanup
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
  });
  it.each(["timeout","failure","server-request"])("fails closed and cleans only its diagnostic child: %s",async failure=>{
    const f=await fixture();let child:ReturnType<typeof spawn>|undefined;
    const source=failure==="timeout"?"setInterval(()=>{},1000)":failure==="failure"?"process.exit(2)":`process.stdout.write(JSON.stringify({id:'request',method:'account/chatgptAuthTokens/refresh',params:{}})+'\\n');setInterval(()=>{},1000)`;
    await expect(readIsolatedQueueTerminal(f.config,userId,"remote-thread","remote-turn",{timeoutMs:100,processFactory:()=>{
      child=spawn(process.execPath,["-e",source],{stdio:["pipe","pipe","pipe"]});return child as never;
    }})).rejects.toThrow("unavailable");
    expect(child?.exitCode!==null||child?.signalCode!==null).toBe(true);
  });
  it("refuses cold interpretation while a live gateway owns another process role",async()=>{
    const f=await fixture();const locks=new ResourceLockManager({rootDirectory:path.join(f.manifest.roots.transportAudit,"runtime-instances/automation-worker/gateway-locks")});
    const owner=await locks.acquire("worker-journal-owner");const factory=vi.fn();
    try {
      await expect(readIsolatedQueueTerminal(f.config,userId,"remote-thread","remote-turn",{processFactory:factory})).rejects.toThrow();
      expect(factory).not.toHaveBeenCalled();await owner.assertHeld();
    } finally {await owner.release();}
  });
  it("does not steal a stale foreign gateway lease to manufacture interrupted proof",async()=>{
    const f=await fixture();const lockRoot=path.join(f.manifest.roots.transportAudit,"runtime-instances/automation-worker/gateway-locks");
    const locks=new ResourceLockManager({rootDirectory:lockRoot,heartbeatIntervalMs:100_000,staleAfterMs:300_000});
    const owner=await locks.acquire("worker-journal-owner");const lockPath=locks.lockPathFor("worker-journal-owner");
    const ownerFile=path.join(lockPath,"owner.json");const metadata=JSON.parse(await readFile(ownerFile,"utf8"));
    metadata.hostname="different-container";const bytes=JSON.stringify(metadata);await writeFile(ownerFile,bytes,{mode:0o600});
    await utimes(lockPath,new Date(1),new Date(1));const factory=vi.fn();
    try {
      await expect(readIsolatedQueueTerminal(f.config,userId,"remote-thread","remote-turn",{processFactory:factory})).rejects.toThrow();
      expect(factory).not.toHaveBeenCalled();expect(await readFile(ownerFile,"utf8")).toBe(bytes);await owner.assertHeld();
    } finally {await owner.release();}
  });
  it("warm metadata borrows only its own role and refuses another live owner",async()=>{
    const f=await fixture();const root=f.manifest.roots.transportAudit;
    const own=await new ResourceLockManager({rootDirectory:path.join(root,"runtime-instances/app/gateway-locks")}).acquire("worker-journal-owner");
    const read=vi.fn(async()=>"completed");
    try {
      expect(await withExistingQueueMetadataBoundary(f.config,userId,read)).toBe("completed");
      const other=await new ResourceLockManager({rootDirectory:path.join(root,"runtime-instances/automation-worker/gateway-locks")}).acquire("worker-journal-owner");
      try {await expect(withExistingQueueMetadataBoundary(f.config,userId,read)).rejects.toThrow();expect(read).toHaveBeenCalledTimes(1);await other.assertHeld();}
      finally {await other.release();}
      await own.assertHeld();
    } finally {await own.release();}
  });
  it("recovers an exact dead origin while another role remains alive, and closes only its reader on failure",async()=>{
    const f=await fixture();const command=["python3","-c","import fcntl,sys;fcntl.flock(3,(fcntl.LOCK_SH if '--shared' in sys.argv else fcntl.LOCK_EX)|fcntl.LOCK_NB)"];
    const generation="00000000-0000-4000-8000-000000000010";
    const owner=await acquireWorkerKernelLease(f.manifest.roots.transportAudit,generation,"shared",{lockCommand:command});
    const origin={generation,instanceId:"app",dev:owner.dev,ino:owner.ino};
    const other=await acquireWorkerKernelLease(f.manifest.roots.transportAudit,"00000000-0000-4000-8000-000000000011","shared",{lockCommand:command});
    const factory=vi.fn(()=>spawn(process.execPath,["-e",childSource],{stdio:["pipe","pipe","pipe"]}));
    try {
      await expect(readIsolatedQueueTerminal(f.config,userId,"remote-thread","remote-turn",{origin,lockCommand:command,processFactory:factory})).rejects.toThrow("unavailable");expect(factory).not.toHaveBeenCalled();
      await owner.close();
      expect(await readIsolatedQueueTerminal(f.config,userId,"remote-thread","remote-turn",{origin,lockCommand:command,processFactory:factory})).toBe("interrupted");
      await expect(readIsolatedQueueTerminal(f.config,userId,"remote-thread","remote-turn",{origin,lockCommand:command,processFactory:()=>spawn(process.execPath,["-e","process.exit(2)"],{stdio:["pipe","pipe","pipe"]})})).rejects.toThrow("unavailable");
      const check=await acquireWorkerKernelLease(f.manifest.roots.transportAudit,generation,"exclusive",{lockCommand:command,expected:origin});await check.close();
    } finally {await other.close();}
  });
  it("reconciles a durable queued turn after its origin dies while another employee role keeps running",async()=>{
    const f=await fixture();const command=["python3","-c","import fcntl,sys;fcntl.flock(3,(fcntl.LOCK_SH if '--shared' in sys.argv else fcntl.LOCK_EX)|fcntl.LOCK_NB)"];
    const generation="00000000-0000-4000-8000-000000000020";
    const owner=await acquireWorkerKernelLease(f.manifest.roots.transportAudit,generation,"shared",{lockCommand:command});
    const origin={generation,instanceId:"app",dev:owner.dev,ino:owner.ino};
    const threadId="00000000-0000-4000-8000-000000000021",turnId="00000000-0000-4000-8000-000000000022";
    const submission=await DurableTurnSubmission.open({userRoot:f.manifest.roots.userRoot,workspace:f.manifest.roots.workspace,installationId:f.config.installationId,userId,projectId:"00000000-0000-4000-8000-000000000023",threadId,assistantMessageId:turnId,binding:"b".repeat(64)});
    const requestId=`turn-start:${turnId}`;await submission.bindExecutionOrigin(origin,requestId);await submission.prepareInputs(async()=>({directory:null,codexInputs:[]}));await submission.bindThread("remote-thread");
    await submission.dispatchOnce({threadId:"remote-thread",input:[],clientUserMessageId:turnId},requestId);await submission.bindTurn("remote-turn");await submission.close();
    const queueRoot=path.join(f.root,"queue");const queue=new FileModelTurnQueue(queueRoot,{maxConcurrent:1});await queue.acquire({installationId:f.config.installationId,userId,threadId,turnId},{signal:new AbortController().signal,recovering:false,onWaiting:async()=>{}});
    const factory=vi.fn(()=>spawn(process.execPath,["-e",childSource],{stdio:["pipe","pipe","pipe"]}));
    const reconcile=modelQueueReconciler({installationId:f.config.installationId,usersRoot:f.config.paths.usersRoot,readTerminal:(actor,thread,turn,boundOrigin)=>readIsolatedQueueTerminal(f.config,actor,thread,turn,{origin:boundOrigin??undefined,lockCommand:command,processFactory:factory})});
    const other=await acquireWorkerKernelLease(f.manifest.roots.transportAudit,"00000000-0000-4000-8000-000000000024","shared",{lockCommand:command});
    try {
      await queue.reconcileRunning(reconcile);expect(factory).not.toHaveBeenCalled();expect(JSON.parse(await readFile(path.join(queueRoot,"queue.json"),"utf8")).tickets).toHaveLength(1);
      await owner.close();await queue.reconcileRunning(reconcile);
      expect(JSON.parse(await readFile(path.join(queueRoot,"queue.json"),"utf8")).tickets).toEqual([]);
      expect(JSON.parse(await readFile(submission.filePath,"utf8"))).toMatchObject({phase:"terminal",terminal:"interrupted",runtimeTurnId:"remote-turn"});
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {await other.close();}
  });
  it("refuses unsafe provisioning without repairing it or spawning",async()=>{
    const f=await fixture();await chmod(f.manifest.roots.codexHome,0o755);const factory=vi.fn();
    await expect(readIsolatedQueueTerminal(f.config,userId,"remote-thread","remote-turn",{processFactory:factory})).rejects.toThrow("unsafe");
    expect(factory).not.toHaveBeenCalled();expect((await lstat(f.manifest.roots.codexHome)).mode&0o777).toBe(0o755);
  });
  it("refuses disabled owners before reading their runtime or spawning",async()=>{
    const f=await fixture();vi.mocked(FileLocalUserStore.prototype.read).mockResolvedValue({enabled:false} as Awaited<ReturnType<FileLocalUserStore["read"]>>);const factory=vi.fn();
    await expect(readIsolatedQueueTerminal(f.config,userId,"remote-thread","remote-turn",{processFactory:factory})).rejects.toThrow("unavailable");expect(factory).not.toHaveBeenCalled();
  });
  it("rejects another user's root in a forged manifest",async()=>{
    const f=await fixture();
    await writeFile(f.manifest.roots.manifest,JSON.stringify({...f.manifest,userId:"00000000-0000-4000-8000-000000000002"}),{mode:0o600});
    await expect(readExistingWorkerLaunchContext(f.config,userId)).rejects.toThrow("installation");
  });
});
