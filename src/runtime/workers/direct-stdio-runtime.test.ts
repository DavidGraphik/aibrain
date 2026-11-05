import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AppServerRpcRouter } from "../transport/app-server-rpc-router";
import type { AppServerEvent, AppServerRequest } from "../transport/contracts";
import { currentWorkerExecutionOrigin } from "./kernel-ownership";
import { DirectStdioTransport, DirectStdioWorkerRuntimeFactory, LiveStdioDuplicateSubmissionError } from "./direct-stdio-runtime";
import type { WorkerLaunchContext } from "./types";

vi.mock("server-only", () => ({}));
const roots: string[] = [], transports: DirectStdioTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.close()));
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const program = `import {createInterface} from 'node:readline';import{closeSync}from'node:fs';
let chain=Promise.resolve(), count=0, token=null, pendingRead;
const send=(rpc,fragment=false)=>{chain=chain.then(()=>new Promise(resolve=>{const b=Buffer.from(JSON.stringify(rpc)+'\\n');
 if(fragment){const i=b.indexOf(Buffer.from('🌲'))+1;process.stdout.write(b.subarray(0,i));setTimeout(()=>{process.stdout.write(b.subarray(i));resolve()},5)}
 else {process.stdout.write(b);resolve()}}));};
send({method:'thread/name/updated',params:{threadId:'thread-1',threadName:'Árbol 🌲'}},true);
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
 if(r.method)count++;
 if(r.method==='initialize')send({id:r.id,result:{}});
 else if(r.method==='initialized'){}
 else if(r.method==='account/login/start'){token=r.params.accessToken;send({id:r.id,result:{type:'chatgptAuthTokens'}})}
 else if(r.method==='account/read'&&token==='synthetic-initial'){pendingRead=r.id;send({id:'refresh-private',method:'account/chatgptAuthTokens/refresh',params:{reason:'unauthorized',previousAccountId:'synthetic-account'}})}
 else if(r.id==='refresh-private'){token=r.result.accessToken;send({id:pendingRead,result:{authenticated:token==='synthetic-renewed'}})}
 else if(r.method==='thread/read'){
  if(r.params.threadId==='crash'){process.exit(23);return}
  if(r.params.threadId==='disconnect'){process.stdout.end();setInterval(()=>{},1000);return}
  if(r.params.threadId==='close-input'){process.stdin.on('error',()=>{});process.stdin.pause();try{closeSync(0)}catch{};send({method:'thread/name/updated',params:{threadId:'thread-1',threadName:'input-closed'}});setInterval(()=>{},1000);return}
  if(r.params.threadId==='close-stderr')process.stderr.end();
  if(r.params.threadId==='hang')return;
  if(r.params.threadId==='invalid'){process.stdout.write('private-payload-must-not-be-logged\\n');return}
  send({id:r.id,result:{count,cwd:process.cwd(),home:process.env.HOME,codexHome:process.env.CODEX_HOME,extraSecret:!!process.env.AIBRAIN_TEST_UNRELATED_SECRET}});
  if(r.params.threadId==='callback')send({id:'callback-1',method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:'call-1',namespace:'synthetic',tool:'echo',arguments:{value:'fixture'}}});
 }else if(r.method==='app/installed')send({id:r.id,result:{count}});
 else if(r.id==='callback-1')send({method:'thread/name/updated',params:{threadId:'thread-1',threadName:'callback-complete'}});
});`;

async function context(userId = "11111111-1111-4111-8111-111111111111") {
  const root = await realpath(await mkdtemp("/tmp/live-stdio-")); roots.push(root);
  const home = path.join(root, userId, "home"), codexHome = path.join(root, userId, "codex"), workspace = path.join(root, userId, "workspace");
  for (const p of [home, codexHome, workspace]) await mkdir(p, { recursive: true, mode: 0o700 });
  const child = path.join(root, "synthetic.mjs"); await writeFile(child, program);
  const ctx: WorkerLaunchContext = { installationId: "synthetic-installation", userId, workerId: `worker-${userId}`,
    environment: { HOME: home, CODEX_HOME: codexHome, XDG_CACHE_HOME: path.join(home,"cache"), XDG_CONFIG_HOME: path.join(home,"config"),
      XDG_DATA_HOME: path.join(home,"data"), XDG_STATE_HOME: path.join(home,"state"), TMPDIR: path.join(home,"tmp") },
    mounts: { runtimeReadOnly: [], runtimeReadWrite: [workspace], browserReadWrite: [] }, workspace,
    staging: path.join(root,"staging"), artifacts: path.join(root,"artifacts"), transportAudit: path.join(root,"audit"),
    browser: { profile: path.join(root,"profile"), downloads: path.join(root,"downloads") } };
  await mkdir(ctx.transportAudit, { mode: 0o700 });
  const processFactory = () => spawn(process.execPath, [child], { cwd: workspace, env: { NODE_ENV: "test", ...ctx.environment }, stdio: ["pipe","pipe","pipe"] });
  return { root, ctx, child, processFactory };
}
function request(id: string, threadId = "inspect"): AppServerRequest {
  return { clientRequestId: id, kind: "rpc-request", rpc: { id, method: "thread/read", params: { threadId } } };
}
function transport(f: Awaited<ReturnType<typeof context>>, options: ConstructorParameters<typeof DirectStdioTransport>[1] = {}) {
  const value = new DirectStdioTransport(f.ctx, { processFactory: f.processFactory, ...options }); transports.push(value); return value;
}
async function next(transport: DirectStdioTransport) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([transport.events()[Symbol.asyncIterator]().next(), new Promise<never>((_, reject) => { timer=setTimeout(()=>reject(Error("Synthetic pipe event timeout")),3000); })]); }
  finally { clearTimeout(timer); }
}
async function allFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for(const entry of await readdir(directory,{withFileTypes:true})) { const p=path.join(directory,entry.name); if(entry.isDirectory())result.push(...await allFiles(p));else result.push(p); }
  return result;
}

it("uses real child pipes with fragmented UTF-8 and native IDs, without a durable/replay cursor or event journals", async () => {
  const f=await context(), t=transport(f); await t.connect();
  const welcome=(await next(t)).value as AppServerEvent;
  expect(welcome).toMatchObject({delivery:"live",epoch:t.capabilities.epoch,nativeIds:{threadId:"thread-1"},message:{rpc:{params:{threadName:"Árbol 🌲"}}}});
  await t.send(request("one"));
  expect((await next(t)).value).toMatchObject({nativeIds:{requestId:"one"},delivery:"live",epoch:t.capabilities.epoch});
  expect(await t.health()).toMatchObject({lastEventId:null,lastEventSequence:null,reconnectAttempt:0});
  expect(await allFiles(f.ctx.transportAudit)).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.jsonl$/u)]));
  expect("recoverResponse" in t).toBe(false); expect("acknowledge" in t).toBe(false);
});
it("does not dispatch a repeated or uncertain submission twice", async () => {
  const f=await context(), t=transport(f); await t.connect(); await next(t);
  await expect(t.send({clientRequestId:"foreign-response",kind:"rpc-response",rpc:{id:"another-users-request",result:{}}})).rejects.toThrow(/No current live server request/u);
  await t.send(request("uncertain","hang"));
  await expect(t.send(request("uncertain","hang"))).rejects.toBeInstanceOf(LiveStdioDuplicateSubmissionError);
  await t.send(request("inspect"));
  expect((await next(t)).value).toMatchObject({message:{rpc:{result:{count:2}}}});
});
it("allows a completed native metadata observation to use the same RPC purpose again for fresh data", async () => {
  const f=await context(),t=transport(f),router=new AppServerRpcRouter(t);
  try{
    const rpc={method:"app/installed" as const,id:"installed-health",params:{}};
    expect(await router.request(rpc,3000)).toEqual({count:1});
    expect(await router.request(rpc,3000)).toEqual({count:2});
    expect((await t.health()).pendingRequests).toBe(0);
  }finally{await router.close();}
});
it("never repeats a handed-off turn/start without its native response", async () => {
  const f=await context(),t=transport(f);await t.connect();await next(t);
  const start: AppServerRequest={clientRequestId:"one-turn-start",kind:"rpc-request",rpc:{method:"turn/start",id:"one-turn-start",params:{threadId:"thread-1",input:[]}}};
  await t.send(start);
  await expect(t.send(start)).rejects.toBeInstanceOf(LiveStdioDuplicateSubmissionError);
  expect((await t.health()).pendingRequests).toBe(1);
  await t.send(request("after-uncertain-start"));
  expect((await next(t)).value).toMatchObject({message:{rpc:{result:{count:2}}}});
});
it("reuses router callback scoping while bypassing every durable ACK and watermark in live mode", async () => {
  const f=await context(), t=transport(f);
  const forbidden=vi.fn(()=>{throw Error("No live durable cursor/ACK");});
  Object.assign(t,{acknowledge:forbidden,acknowledgeBatch:forbidden,deliverySequenceStart:forbidden,projectionSequenceTarget:forbidden});
  const names: string[]=[];
  const router=new AppServerRpcRouter(t,{onNotification:n=>{if(n.method==="thread/name/updated")names.push(n.params.threadName??"");}});
  const callback=vi.fn(async()=>({success:true,contentItems:[{type:"inputText",text:"synthetic-result"}]}));
  const registration=router.registerTurn("thread-1","local-turn",{onNotification(){},onServerRequest:callback,onFailure(){}});registration.bindRuntimeTurn("turn-1");
  try {
    await router.assertProjectionReady();
    await router.request(request("callback","callback").rpc as never,3000);
    await expect.poll(()=>names.includes("callback-complete")).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1); expect(forbidden).not.toHaveBeenCalled();
  }finally{registration.dispose();await router.close();}
});
it("fails a crashed or malformed child without replay, reopening, or exposing stdout payloads", async () => {
  for(const mode of ["crash","invalid","disconnect"]){
    const f=await context(), factory=vi.fn(f.processFactory),t=transport(f,{processFactory:factory});
    const router=new AppServerRpcRouter(t);
    try{
      await expect(router.request(request(mode,mode).rpc as never,3000)).rejects.toThrow(/Live stdio/u);
      await expect(t.send(request("after-failure"))).rejects.toThrow();
      expect(factory).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(await t.health())).not.toContain("private-payload");
    }finally{await router.close();}
  }
});
it("keeps two employee homes, processes, epochs and responses separate", async () => {
  const a=await context(),b=await context("22222222-2222-4222-8222-222222222222");
  const ta=transport(a),tb=transport(b),ra=new AppServerRpcRouter(ta),rb=new AppServerRpcRouter(tb);
  try{
    const [one,two]=await Promise.all([ra.request(request("same-id").rpc as never,3000),rb.request(request("same-id").rpc as never,3000)]);
    expect(one).toMatchObject({home:a.ctx.environment.HOME,codexHome:a.ctx.environment.CODEX_HOME,cwd:a.ctx.workspace});
    expect(two).toMatchObject({home:b.ctx.environment.HOME,codexHome:b.ctx.environment.CODEX_HOME,cwd:b.ctx.workspace});
    expect(ta.capabilities.epoch).not.toBe(tb.capabilities.epoch);
  }finally{await ra.close();await rb.close();}
});
it("authenticates and refreshes personal tokens privately before public dispatch, with no secret events or journals", async () => {
  const f=await context();let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  const provider=vi.fn(async()=>{await gate;return{accessToken:++calls===1?"synthetic-initial":"synthetic-renewed",chatgptAccountId:"synthetic-account",chatgptPlanType:null};});
  const t=transport(f,{authForContext:ctx=>{expect(ctx.userId).toBe(f.ctx.userId);return provider;}});
  const starting=t.connect();await expect.poll(()=>provider.mock.calls.length).toBe(1);
  expect((await t.health()).healthy).toBe(false);release();await starting;
  const events: AppServerEvent[]=[];const router=new AppServerRpcRouter(t,{onNotification:(_,event)=>{events.push(event);}});
  try{
    expect(await router.request({method:"account/read",id:"personal-read",params:{refreshToken:false}},3000)).toEqual({authenticated:true});
    expect(provider).toHaveBeenLastCalledWith("synthetic-account","synthetic-initial");
    expect(JSON.stringify(events)).not.toContain("synthetic-initial");expect(JSON.stringify(events)).not.toContain("private-auth:");
    expect((await allFiles(f.ctx.transportAudit)).some(p=>p.endsWith(".jsonl"))).toBe(false);
  }finally{await router.close();}
});
it("rejects mixed personal/shared identity and prevents another owner in the same employee/role", async () => {
  const f=await context(),provider=async()=>({accessToken:"synthetic",chatgptAccountId:"fixture",chatgptPlanType:null}),factory=vi.fn(f.processFactory);
  expect(()=>new DirectStdioWorkerRuntimeFactory({sharedAuth:provider,authForContext:()=>provider,processFactory:factory}).create(f.ctx)).toThrow(/Personal authentication/u);
  expect(factory).not.toHaveBeenCalled();
  const first=transport(f),second=transport(f,{processFactory:factory});await first.connect();
  await expect(second.connect()).rejects.toThrow();expect(factory).not.toHaveBeenCalled();expect((await first.health()).healthy).toBe(true);
});
it("retains the real protected launcher, filesystem privacy overrides, minimal env and compatible kernel execution origin", async () => {
  const f=await context(),observation=path.join(f.root,"launch.json"),executable=path.join(f.root,"fake-codex.mjs");
  await writeFile(executable,`#!${process.execPath}\nimport{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(observation)},JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,extra:!!process.env.AIBRAIN_TEST_UNRELATED_SECRET}));process.stdin.resume();`,{mode:0o700});
  vi.stubEnv("CODEX_BIN",executable);vi.stubEnv("AIBRAIN_TEST_UNRELATED_SECRET","synthetic-not-in-child");
  const t=new DirectStdioTransport(f.ctx,{quotaToolPrivacy:true,kernelLockCommand:["python3","-c","import fcntl,sys;fcntl.flock(3,fcntl.LOCK_SH|fcntl.LOCK_NB)"]});transports.push(t);
  await t.connect();
  await expect.poll(async()=>JSON.parse(await readFile(observation,"utf8"))).toMatchObject({home:f.ctx.environment.HOME,extra:false,args:expect.arrayContaining(["app-server","--stdio","-c"])});
  expect(await currentWorkerExecutionOrigin(f.ctx.transportAudit)).toMatchObject({instanceId:"app",generation:expect.any(String),ino:expect.any(Number)});
});
it("can close before startup without spawning a child", async () => {
  const f=await context(),factory=vi.fn(f.processFactory),t=transport(f,{processFactory:factory});
  await t.close();await expect(t.connect()).rejects.toThrow();expect(factory).not.toHaveBeenCalled();
});
it("rejects oversized input before connecting or dispatching", async () => {
  const f=await context(),factory=vi.fn(f.processFactory),t=transport(f,{processFactory:factory});
  await expect(t.send({clientRequestId:"oversize",kind:"rpc-request",rpc:{method:"thread/start",id:"oversize",params:{developerInstructions:"x".repeat(8*1024*1024)}}})).rejects.toMatchObject({code:"TRANSPORT_REQUEST_TOO_LARGE"});
  expect(factory).not.toHaveBeenCalled();
});
it("contains stdin EPIPE and permits stderr EOF without treating diagnostics as the protocol", async () => {
  const f=await context(),t=transport(f);await t.connect();await next(t);
  await t.send(request("close-input","close-input"));
  expect((await next(t)).value).toMatchObject({message:{rpc:{params:{threadName:"input-closed"}}}});
  await expect(t.send(request("after-input-close"))).rejects.toThrow();
  const other=await context(),healthy=transport(other),router=new AppServerRpcRouter(healthy);
  try{await expect(router.request(request("close-stderr","close-stderr").rpc as never,3000)).resolves.toMatchObject({count:1});}
  finally{await router.close();}
});
it("cleans a failed spawn and can release its own role for a fresh runtime without replay", async () => {
  const f=await context(),failed=transport(f,{processFactory:()=>spawn("/nonexistent/aibrain-synthetic-child",[],{stdio:["pipe","pipe","pipe"]})});
  await expect(failed.connect()).rejects.toThrow(/Live/u);await failed.close();
  const successor=transport(f);await successor.connect();expect((await successor.health()).healthy).toBe(true);
});
