import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AppServerRpcRouter } from "../transport/app-server-rpc-router";
import type { AppServerEvent, AppServerRequest } from "../transport/contracts";
import { currentWorkerExecutionOrigin } from "./kernel-ownership";
import { DirectStdioTransport, DirectStdioWorkerRuntimeFactory, LiveStdioDuplicateSubmissionError } from "./direct-stdio-runtime";
import type { WorkerLaunchContext } from "./types";
import { SERVER_MODEL_PROVIDER } from "../server-model-auth";
import * as modelAuth from "../server-model-auth";
import * as supportQa from "../support-model-qa";

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
it("keeps API bootstrap private on real child pipes, blocks auth/app swaps, preserves MCP, and rejects a secret echo", async () => {
  const f = await context();const key = "sk-synthetic-pipe-only-123456789";
  const config = { cli_auth_credentials_store: "ephemeral", forced_login_method: "api", model_provider: SERVER_MODEL_PROVIDER,
    model_providers: { [SERVER_MODEL_PROVIDER]: { name: "OpenAI", base_url: "https://api.openai.com/v1", wire_api: "responses", requires_openai_auth: true } } };
  await writeFile(f.child, `import {createInterface} from 'node:readline';let token=null;const methods=[];const send=r=>process.stdout.write(JSON.stringify(r)+'\\n');
    createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);methods.push(r.method);
      if(r.method==='initialized')return;
      if(r.method==='config/read')send({id:r.id,result:{config:${JSON.stringify(config)}}});
      else if(r.method==='account/login/start'){token=r.params.apiKey;send({method:'account/login/completed',params:{success:true,echo:token}});send({id:r.id,result:{type:'apiKey',echo:token}});}
      else if(r.method==='account/read')send({id:r.id,result:{account:{type:'apiKey'},echo:token}});
      else if(r.method==='thread/read'&&r.params.threadId==='echo')send({method:'thread/name/updated',params:{threadId:'thread-1',threadName:token}});
      else if(r.method==='thread/read')send({id:r.id,result:{methods,hasKeyArg:process.argv.some(v=>v===token),hasKeyEnv:Object.values(process.env).some(v=>v===token)}});
      else send({id:r.id,result:{}});
    });`);
  const provider=vi.fn(async()=>key),t=transport(f,{apiKeyAuth:provider});expect(provider).not.toHaveBeenCalled();
  await t.connect();await t.send(request("inspect-api"));
  const event=(await next(t)).value!;
  expect(event.message.rpc).toMatchObject({result:{hasKeyArg:false,hasKeyEnv:false,methods:["initialize","initialized","config/read","account/login/start","account/read","thread/read"]}});
  expect(JSON.stringify(event)).not.toContain(key);expect(JSON.stringify(event)).not.toContain("private-auth:");
  const blocked = [["account/login/start",{type:"chatgpt"}],["account/logout",undefined],["app/installed",{}],
    ["account/gatewayOAuth/login",undefined],["account/gatewayOAuth/cancel",undefined],
    ["account/bedrock/setup",{type:"environment",region:"us-east-1"}],
    ["account/sendAddCreditsNudgeEmail",{creditType:"credits"}],
    ["account/rateLimitResetCredit/consume",{idempotencyKey:"synthetic-no-consumption"}]] as const;
  for(const [method,params] of blocked)
    await expect(t.send({clientRequestId:method,kind:"rpc-request",rpc:{id:method,method,...(params===undefined?{}:{params})}} as AppServerRequest)).rejects.toThrow("Server model authentication is unavailable.");
  await t.send(request("after-account-denials"));
  const observed=(await next(t)).value!.message.rpc as {result:{methods:string[]}};
  expect(observed.result.methods.filter(method=>blocked.some(([name])=>name===method))).toEqual(["account/login/start"]); // The private bootstrap only.
  for(const method of ["account/rateLimits/read","account/usage/read"] as const) {
    await t.send({clientRequestId:method,kind:"rpc-request",rpc:{id:method,method}});await next(t);
  }
  await t.send({clientRequestId:"own-mcp-oauth",kind:"rpc-request",rpc:{id:"own-mcp-oauth",method:"mcpServer/oauth/login",params:{name:"own"}}});await next(t);
  for (const [keyPath,value] of [["mcp_servers.own.oauth.callback_url","https://brain.example.test/api/connectors/native/callback"],
    ["mcp_servers.own.oauth.callback_port",43100]] as const) {
    await t.send({clientRequestId:keyPath,kind:"rpc-request",rpc:{id:keyPath,method:"config/value/write",params:{keyPath,value,mergeStrategy:"upsert"}}});await next(t);
  }
  await expect(t.send({clientRequestId:"global-callback",kind:"rpc-request",rpc:{id:"global-callback",method:"config/value/write",params:{keyPath:"mcp_oauth_callback_port",value:43100,mergeStrategy:"upsert"}}})).rejects.toThrow("Server model authentication is unavailable.");
  await t.send({clientRequestId:"own-mcp",kind:"rpc-request",rpc:{id:"own-mcp",method:"mcpServerStatus/list",params:{}}});await next(t);
  await t.send(request("secret-echo","echo"));await expect(next(t)).rejects.toThrow(/Live stdio/);
  for(const file of await allFiles(f.root))expect(await readFile(file,"utf8")).not.toContain(key);
  expect(provider).toHaveBeenCalledOnce();
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
  const f = await context(), observation = path.join(f.root, "launch.json"), executable = path.join(f.root, "fake-codex.mjs");
  const excludedNames = [
    "AIBRAIN_TEST_UNRELATED_SECRET", "SUPABASE_SECRET_KEY", "AIBRAIN_SESSION_SECRET", "OPENAI_API_KEY", "RANDOM_TOKEN",
    "MODTIME_SHOPIFY_CLIENT_SECRET", "MODTIME_SHOPIFY_OAUTH_ENCRYPTION_KEY", "MODTIME_SHOPIFY_ADMIN_TOKEN",
    "MODTIME_SHOPIFY_THEME_CLIENT_SECRET", "MODTIME_SHOPIFY_THEME_ENCRYPTION_KEY",
  ];
  for (const name of excludedNames) vi.stubEnv(name, "synthetic-not-in-child");
  vi.stubEnv("LANG", "en_US.UTF-8");
  await writeFile(executable, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
    const excludedNames = ${JSON.stringify(excludedNames)};
    writeFileSync(${JSON.stringify(observation)}, JSON.stringify({
      args: process.argv.slice(2), home: process.env.HOME, codexHome: process.env.CODEX_HOME,
      xdgConfig: process.env.XDG_CONFIG_HOME, path: process.env.PATH, lang: process.env.LANG,
      leakedNames: Object.keys(process.env).filter(name => excludedNames.includes(name) || name.startsWith('MODTIME_SHOPIFY')),
    })); process.stdin.resume();`, { mode: 0o700 });
  vi.stubEnv("CODEX_BIN", executable);
  const t = new DirectStdioTransport(f.ctx, { quotaToolPrivacy: true, kernelLockCommand: ["python3", "-c", "import fcntl,sys;fcntl.flock(3,fcntl.LOCK_SH|fcntl.LOCK_NB)"] });
  transports.push(t);
  await t.connect();
  await expect.poll(async () => JSON.parse(await readFile(observation, "utf8"))).toMatchObject({
    home: f.ctx.environment.HOME, codexHome: f.ctx.environment.CODEX_HOME,
    xdgConfig: f.ctx.environment.XDG_CONFIG_HOME, path: process.env.PATH, lang: "en_US.UTF-8",
    leakedNames: [], args: expect.arrayContaining(["app-server", "--stdio", "-c"]),
  });
  expect(await currentWorkerExecutionOrigin(f.ctx.transportAudit)).toMatchObject({ instanceId: "app", generation: expect.any(String), ino: expect.any(Number) });
});

it("pins native credential privacy when API auth is selected without the optional privacy flag", async () => {
  const f = await context(), observation = path.join(f.root, "api-launch.json"), executable = path.join(f.root, "fake-api-codex.mjs");
  const config = { cli_auth_credentials_store: "ephemeral", forced_login_method: "api", model_provider: SERVER_MODEL_PROVIDER,
    model_providers: { [SERVER_MODEL_PROVIDER]: { name: "OpenAI", base_url: "https://api.openai.com/v1", wire_api: "responses", requires_openai_auth: true } } };
  await writeFile(executable, `#!${process.execPath}\nimport{writeFileSync}from'node:fs';import{createInterface}from'node:readline';
    writeFileSync(${JSON.stringify(observation)},JSON.stringify(process.argv.slice(2)));
    createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialized')return;
      const result=r.method==='config/read'?{config:${JSON.stringify(config)}}:r.method==='account/login/start'?{type:'apiKey'}:r.method==='account/read'?{account:{type:'apiKey'}}:{};
      process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});`, { mode: 0o700 });
  vi.stubEnv("CODEX_BIN", executable);
  const t = new DirectStdioTransport(f.ctx, { apiKeyAuth: async () => "synthetic-project-key-not-real",
    kernelLockCommand: ["python3", "-c", "import fcntl;fcntl.flock(3,fcntl.LOCK_SH|fcntl.LOCK_NB)"] });
  transports.push(t); await t.connect();
  const args: string[] = JSON.parse(await readFile(observation, "utf8"));
  expect(args).toContain('forced_login_method="api"');
  expect(args.some(arg => arg.startsWith("permissions=") && arg.includes(".credentials.json*") && arg.includes("mcp-oauth-locks"))).toBe(true);
  expect(args.some(arg => arg.startsWith("default_permissions="))).toBe(true);
  expect(args.join(" ")).not.toContain("synthetic-project-key-not-real");
});
it("requires the private personal provider and rejects a denied profile before spawning, then rechecks a warm transport", async () => {
  const f = await context(), factory = vi.fn(f.processFactory);
  expect(() => new DirectStdioTransport(f.ctx, { personalTestAuth: true, processFactory: factory })).toThrow(modelAuth.ModelAuthUnavailableError);
  expect(factory).not.toHaveBeenCalled();
  let active = false;
  vi.spyOn(supportQa, "isSponsoredModelQa").mockResolvedValue(false);
  vi.spyOn(modelAuth, "assertPersonalModelTest").mockImplementation(async identity => {
    if (!active || identity.userId !== f.ctx.userId || identity.installationId !== f.ctx.installationId) throw new modelAuth.ModelAuthUnavailableError();
  });
  const provider = vi.fn(async () => ({ accessToken: "synthetic-personal-only", chatgptAccountId: "synthetic-account", chatgptPlanType: null }));
  const denied = transport(f, { personalTestAuth: true, processFactory: factory, authForContext: () => provider });
  await expect(denied.connect()).rejects.toThrow();expect(factory).not.toHaveBeenCalled();expect(provider).not.toHaveBeenCalled();
  active = true;
  const t = transport(f, { personalTestAuth: true, authForContext: () => provider });await t.connect();await next(t);
  await t.send({ clientRequestId: "own-apps", kind: "rpc-request", rpc: { id: "own-apps", method: "app/installed", params: {} } });
  expect((await next(t)).value).toMatchObject({ nativeIds: { requestId: "own-apps" } });
  for (const [method, params] of [["account/logout", undefined], ["account/gatewayOAuth/login", undefined],
    ["account/sendAddCreditsNudgeEmail", { creditType: "credits" }]] as const)
    await expect(t.send({ clientRequestId: method, kind: "rpc-request", rpc: { id: method, method, ...(params === undefined ? {} : { params }) } } as AppServerRequest)).rejects.toThrow(modelAuth.ModelAuthUnavailableError);
  active = false;
  await expect(t.send({ clientRequestId: "expired-turn", kind: "rpc-request", rpc: { id: "expired-turn", method: "turn/start", params: { threadId: "synthetic", input: [] } } })).rejects.toThrow(modelAuth.ModelAuthUnavailableError);
  expect((await t.health()).pendingRequests).toBe(0);expect(provider).toHaveBeenCalledOnce();
});
it.each([false, true])("pins personal QA privacy before bootstrap without secrets; sponsored Apps disabled=%s", async sponsored => {
  const f = await context(), observation = path.join(f.root, "personal-launch.json"), executable = path.join(f.root, "fake-personal-codex.mjs");
  vi.spyOn(supportQa, "isSponsoredModelQa").mockResolvedValue(sponsored);
  vi.spyOn(modelAuth, "assertPersonalModelTest").mockResolvedValue(undefined);
  await writeFile(executable, `#!${process.execPath}\nimport{writeFileSync}from'node:fs';import{createInterface}from'node:readline';
    writeFileSync(${JSON.stringify(observation)},JSON.stringify(process.argv.slice(2)));
    createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialized')return;
      const result=r.method==='account/login/start'?{type:'chatgptAuthTokens'}:{};
      process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});`, { mode: 0o700 });
  vi.stubEnv("CODEX_BIN", executable);
  const t = new DirectStdioTransport(f.ctx, { personalTestAuth: true, authForContext: () => async () => ({
    accessToken: "synthetic-personal-only-not-real", chatgptAccountId: "synthetic-account", chatgptPlanType: null,
  }), kernelLockCommand: ["python3", "-c", "import fcntl;fcntl.flock(3,fcntl.LOCK_SH|fcntl.LOCK_NB)"] });
  transports.push(t);await t.connect();
  const args: string[] = JSON.parse(await readFile(observation, "utf8"));
  for (const option of ['cli_auth_credentials_store="ephemeral"', 'forced_login_method="chatgpt"', 'model_provider="openai"']) expect(args).toContain(option);
  expect(args.some(arg => arg.startsWith("permissions=") && arg.includes(".credentials.json*") && arg.includes("mcp-oauth-locks"))).toBe(true);
  expect(args.some(arg => arg.startsWith("default_permissions="))).toBe(true);expect(args.join(" ")).not.toContain("synthetic-personal-only-not-real");
  if (sponsored) { expect(args).toContain("features.apps=false"); expect(args).toContain("apps._default.enabled=false"); }
  else expect(args).not.toContain("features.apps=false");
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

it("sponsored target transport blocks owner Apps on warm workers and stops after lease revocation", async () => {
  const f = await context(); let active = true;
  vi.spyOn(modelAuth, "assertPersonalModelTest").mockImplementation(async () => { if (!active) throw new modelAuth.ModelAuthUnavailableError(); });
  vi.spyOn(supportQa, "isSponsoredModelQa").mockImplementation(async () => { if (!active) throw new modelAuth.ModelAuthUnavailableError(); return true; });
  const identities: WorkerLaunchContext[] = [];
  const t = transport(f, { personalTestAuth: true, authForContext: identity => {
    identities.push(identity); return async () => ({ accessToken: "sponsored-test-only", chatgptAccountId: "sponsor-model-only", chatgptPlanType: null });
  } });
  await t.connect(); await next(t);
  expect(identities).toEqual([f.ctx]);
  for (const [method, params] of [["app/installed", {}], ["thread/resume", { threadId: "x", config: { "features.apps": true } }],
    ["turn/start", { threadId: "x", input: [], config: { apps: { owner: { enabled: true } } } }]] as const) {
    await expect(t.send({clientRequestId:method,kind:"rpc-request",rpc:{id:method,method,params}} as AppServerRequest)).rejects.toThrow(modelAuth.ModelAuthUnavailableError);
  }
  active=false;
  await expect(t.send({clientRequestId:"revoked",kind:"rpc-request",rpc:{id:"revoked",method:"thread/read",params:{threadId:"x"}}})).rejects.toThrow(modelAuth.ModelAuthUnavailableError);
  expect((await t.health()).pendingRequests).toBe(0);
});

async function idleFixture(userId?: string) {
  const f = await context(userId);
  await writeFile(f.child, `import{createInterface}from'node:readline';import{readFileSync,writeFileSync,existsSync}from'node:fs';
  let pendingQuick;const processes=new Set(),send=rpc=>process.stdout.write(JSON.stringify(rpc)+'\\n');
  createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line),p=r.params??{};
    if(r.method==='thread/read'){
      if(p.threadId==='release-quick-response'){pendingQuick?.();pendingQuick=null;}
      if(p.threadId==='native-active')send({method:'thread/status/changed',params:{threadId:'native-thread',status:{type:'active',activeFlags:[]}}});
      if(p.threadId==='native-idle')send({method:'thread/status/changed',params:{threadId:'native-thread',status:{type:'idle'}}});
      if(p.threadId==='callback')send({id:'tool-request',method:'item/tool/call',params:{threadId:'tool-thread',turnId:'tool-turn',callId:'tool-call',namespace:'synthetic',tool:'hold',arguments:{}}});
      if(p.threadId==='release-callback')send({method:'thread/name/updated',params:{threadId:'ack-thread',threadName:'released'}});
      if(p.threadId==='hang')return;
      send({id:r.id,result:{thread:{id:p.threadId,turns:[]}}});
    }else if(r.method==='thread/resume'){
      send({id:r.id,result:{thread:{id:'saved-native-thread',turns:JSON.parse(readFileSync('native-history.json','utf8'))}}});
    }else if(r.method==='turn/start'){
      const turn={id:'saved-turn',status:'completed',error:null,items:[]};
      writeFileSync('native-history.json',JSON.stringify([turn]));send({id:r.id,result:{turn}});
    }else if(r.method==='process/spawn'){
      if(processes.has(p.processHandle))send({id:r.id,error:{code:-32600,message:'Process handle is already active'}});
      else{
        processes.add(p.processHandle);
        if(p.command[0]==='quick-exit'){
          processes.delete(p.processHandle);send({method:'process/exited',params:{processHandle:p.processHandle,exitCode:0,stdout:'',stdoutCapReached:false,stderr:'',stderrCapReached:false}});
          pendingQuick=()=>send({id:r.id,result:{}});
        }else send({id:r.id,result:{}});
      }
    }else if(r.method==='process/kill'){processes.delete(p.processHandle);send({method:'process/exited',params:{processHandle:p.processHandle,exitCode:0,stdout:'',stdoutCapReached:false,stderr:'',stderrCapReached:false}});send({id:r.id,result:{}});}
  });`);
  let clock = 0;
  const t = transport(f, { idleTimeoutMs: 120_000, now: () => clock });
  const router = new AppServerRpcRouter(t);
  const read = (id: string) => router.request(request(id, id).rpc as never, 1000);
  const advance = () => { clock += 120_001; };
  return { ...f, t, router, read, advance };
}

it('reclaims a truly idle employee process, preserves native history, and reopens by resume without another turn/start', async () => {
  const f = await idleFixture(), other = await idleFixture('22222222-2222-4222-8222-222222222222');
  try {
    await f.router.request({id:'one-intent',method:'turn/start',params:{threadId:'saved-native-thread',input:[]}} as never, 1000);
    await other.read('independent');
    f.advance();
    await vi.waitFor(() => expect(f.t.reclaimIdle()).toBe(true));
    await f.t.close();
    expect(await f.t.health()).toMatchObject({state:'closed'});
    expect(await other.t.health()).toMatchObject({healthy:true});
    const second = transport(f, { idleTimeoutMs: 0 }), reopened = new AppServerRpcRouter(second);
    try {
      expect(await reopened.request({id:'resume-only',method:'thread/resume',params:{threadId:'saved-native-thread'}} as never,1000))
        .toMatchObject({thread:{id:'saved-native-thread',turns:[{id:'saved-turn',status:'completed'}]}});
      expect(JSON.parse(await readFile(path.join(f.ctx.workspace,'native-history.json'),'utf8'))).toHaveLength(1);
    } finally { await reopened.close(); }
  } finally { await f.router.close(); await other.router.close(); }
});

it('never reclaims an active native thread even when no local turn registration remains', async () => {
  const f = await idleFixture();
  try {
    await f.read('native-active'); f.advance();
    expect(f.t.reclaimIdle()).toBe(false);
    await f.read('native-idle'); f.advance();
    await vi.waitFor(() => expect(f.t.reclaimIdle()).toBe(true));
  } finally { await f.router.close(); }
});

it('retains a disposed turn until its asynchronous provider tool actually finishes', async () => {
  const f = await idleFixture(); let release!: () => void;
  const tool = vi.fn(() => new Promise<never>(resolve => { release = () => resolve({success:true,contentItems:[]} as never); }));
  const turn = f.router.registerTurn('tool-thread','tool-local',{onNotification(){},onFailure(){},onServerRequest:tool});
  turn.bindRuntimeTurn('tool-turn');
  try {
    await f.read('callback'); await vi.waitFor(() => expect(tool).toHaveBeenCalledOnce());
    turn.dispose(); f.advance(); expect(f.t.reclaimIdle()).toBe(false);
    release(); await f.read('release-callback'); f.advance();
    await vi.waitFor(() => expect(f.t.reclaimIdle()).toBe(true));
  } finally { turn.dispose(); await f.router.close(); }
});

it('does not reclaim a pending/uncertain RPC or an independently spawned live job', async () => {
  const f = await idleFixture(), pending = await idleFixture('22222222-2222-4222-8222-222222222222');
  try {
    await f.router.request({id:'job',method:'process/spawn',params:{processHandle:'live-job',command:['synthetic'],cwd:f.ctx.workspace}} as never,1000);
    f.advance(); expect(f.t.reclaimIdle()).toBe(false);
    await f.router.request({id:'exit-job',method:'process/kill',params:{processHandle:'live-job'}} as never,1000);
    f.advance(); await vi.waitFor(() => expect(f.t.reclaimIdle()).toBe(true));
    const uncertain = pending.read('hang').catch(() => undefined);
    await vi.waitFor(async () => expect((await pending.t.health()).pendingRequests).toBe(1));
    pending.advance(); expect(pending.t.reclaimIdle()).toBe(false);
    await pending.router.close(); await uncertain;
  } finally { await f.router.close(); await pending.router.close(); }
});

it('retains the original live job after sequential and concurrently pending duplicate spawn rejections', async () => {
  const f = await idleFixture();
  const spawnJob = (id: string) => f.router.request({id,method:'process/spawn',params:{processHandle:'same-live-handle',command:['synthetic'],cwd:f.ctx.workspace}} as never,1000);
  try {
    await spawnJob('original');
    await expect(spawnJob('duplicate')).rejects.toThrow('already active');
    const duplicates = await Promise.allSettled([spawnJob('concurrent-duplicate-a'),spawnJob('concurrent-duplicate-b')]);
    expect(duplicates.map(result => result.status)).toEqual(['rejected','rejected']);
    f.advance(); expect(f.t.reclaimIdle()).toBe(false);
    await f.router.request({id:'actual-job-exit',method:'process/kill',params:{processHandle:'same-live-handle'}} as never,1000);
    f.advance(); await vi.waitFor(() => expect(f.t.reclaimIdle()).toBe(true));
  } finally { await f.router.close(); }
});

it('does not resurrect a quick process after exit precedes its spawn response, and protects a reused handle generation', async () => {
  const f = await idleFixture(), reused = await idleFixture('22222222-2222-4222-8222-222222222222');
  const spawnJob = (fixture: typeof f, id: string, command: string) => fixture.router.request({id,method:'process/spawn',params:{processHandle:'reusable-handle',command:[command],cwd:fixture.ctx.workspace}} as never,1000);
  try {
    const quick = spawnJob(f,'quick-original','quick-exit');
    await f.read('release-quick-response'); await quick;
    f.advance(); await vi.waitFor(() => expect(f.t.reclaimIdle()).toBe(true));
    const first = spawnJob(reused,'old-generation','quick-exit');
    await reused.read('exit-notification-barrier');
    await spawnJob(reused,'new-generation','synthetic');
    await reused.read('release-quick-response');
    await first;
    await expect(spawnJob(reused,'duplicate-new-generation','synthetic')).rejects.toThrow('already active');
    reused.advance(); expect(reused.t.reclaimIdle()).toBe(false);
    await reused.router.request({id:'new-generation-exit',method:'process/kill',params:{processHandle:'reusable-handle'}} as never,1000);
    reused.advance(); await vi.waitFor(() => expect(reused.t.reclaimIdle()).toBe(true));
  } finally { await f.router.close(); await reused.router.close(); }
});

it('does not reclaim a registered foreground/background turn or a worker before its grace expires', async () => {
  const f = await idleFixture();
  try {
    await f.read('idle'); expect(f.t.reclaimIdle()).toBe(false);
    const turn=f.router.registerTurn('active-thread','active-local',{onNotification(){},onFailure(){},onServerRequest:vi.fn()});
    f.advance(); expect(f.t.reclaimIdle()).toBe(false);
    turn.dispose(); await vi.waitFor(() => expect(f.t.reclaimIdle()).toBe(true));
  } finally { await f.router.close(); }
});

it('automatically reclaims the idle process after the configured grace without a logout or a maintenance caller', async () => {
  const f = await idleFixture();
  const t = transport(f, { idleTimeoutMs: 40 }), router = new AppServerRpcRouter(t);
  try {
    await router.request(request('timer-only').rpc as never,1000);
    await vi.waitFor(async () => expect((await t.health()).state).toBe('closed'),{timeout:1500,interval:20});
    await t.close();
  } finally { await router.close(); }
});
