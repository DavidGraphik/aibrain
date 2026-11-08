import { requestPagedThreadRecovery } from "@/runtime/paged-thread-recovery";
import { ColdThreadRecoveryTimeoutError } from "@/runtime/cold-thread-recovery";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect as connectTcp } from "node:net";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from "vitest";
import {
  AppServerRpcRouter,
  FileTransportEventJournal,
  WebSocketAppServerTransport,
} from "@/runtime/transport";
import {
  NodeWebSocketFactory,
  LocalGatewayWorkerRuntimeFactory,
  PrivateWorkerGateway,
  workerEgressEnvironment,
  workerTransportAuditRoot,
} from "@/runtime/workers/local-gateway-runtime";
import type { WorkerLaunchContext } from "@/runtime/workers/types";
import { quotaToolPermissionConfigOverrides } from "@/runtime/quota-tool-permissions";
import { FileJournal, ResourceLockManager } from "@/storage";
import * as ownerAuthentication from "@/runtime/installation-owner-auth";

vi.mock("server-only", () => ({}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const APPROVAL_SCOPE_DIGEST = createHash("sha256")
  .update(JSON.stringify(["thread-1", "turn-1"]))
  .digest("hex");
const PROCESS_RECOVERY_TEST_TIMEOUT_MS = 30_000;
const roots: string[] = [];

describe("worker egress environment", () => {
  it("exposes only the restricted worker channel through standard proxy variables", () => {
    const token = "worker_token_000000000000000000000000000000000";
    const environment = workerEgressEnvironment({
      NODE_ENV: "production",
      AIBRAIN_EGRESS_PROXY_URL: "http://egress-gateway:8080",
      AIBRAIN_EGRESS_WORKER_TOKEN: token,
      AIBRAIN_EGRESS_BROWSER_TOKEN: "browser-secret-must-not-leak",
      AIBRAIN_EGRESS_SERVER_TOKEN: "server-secret-must-not-leak",
    });
    expect(environment).toMatchObject({
      NO_PROXY: "127.0.0.1,localhost,::1",
      HTTP_PROXY: expect.any(String),
      HTTPS_PROXY: expect.any(String),
      ALL_PROXY: expect.any(String),
      no_proxy: "127.0.0.1,localhost,::1",
      http_proxy: expect.any(String),
      https_proxy: expect.any(String),
      all_proxy: expect.any(String),
    });
    expect(environment.http_proxy).toBe(environment.HTTP_PROXY);
    expect(environment.https_proxy).toBe(environment.HTTPS_PROXY);
    expect(environment.all_proxy).toBe(environment.ALL_PROXY);
    const proxy = new URL(environment.HTTPS_PROXY);
    expect(proxy).toMatchObject({
      protocol: "http:",
      hostname: "egress-gateway",
      port: "8080",
      username: "aibrain",
      password: token,
    });
    expect(JSON.stringify(environment)).not.toContain("browser-secret");
    expect(JSON.stringify(environment)).not.toContain("server-secret");
  });

  it("fails closed in production and rejects partial or credential-bearing configuration", () => {
    expect(() => workerEgressEnvironment({ NODE_ENV: "production" })).toThrow(/required/u);
    expect(() => workerEgressEnvironment({
      NODE_ENV: "test",
      AIBRAIN_EGRESS_PROXY_URL: "http://egress-gateway:8080",
    })).toThrow(/required/u);
    expect(() => workerEgressEnvironment({
      NODE_ENV: "test",
      AIBRAIN_EGRESS_PROXY_URL: "http://attacker:password@egress-gateway:8080",
      AIBRAIN_EGRESS_WORKER_TOKEN: "worker_token_000000000000000000000000000000000",
    })).toThrow(/credential-free/u);
  });
});

describe("worker transport audit isolation", () => {
  it("uses stable disjoint journals for the app and detached automation worker", () => {
    const root = "/var/lib/aibrain/data/users/user/audit/transport";
    expect(workerTransportAuditRoot(root, "app")).toBe(path.join(root, "runtime-instances", "app"));
    expect(workerTransportAuditRoot(root, "automation-worker")).toBe(
      path.join(root, "runtime-instances", "automation-worker"),
    );
    expect(workerTransportAuditRoot(root, "app")).not.toBe(workerTransportAuditRoot(root, "automation-worker"));
  });

  it("rejects traversal and unstable instance identifiers", () => {
    expect(() => workerTransportAuditRoot("/audit", "../worker")).toThrow(/invalid/u);
    expect(() => workerTransportAuditRoot("/audit", "worker/other")).toThrow(/invalid/u);
    expect(() => workerTransportAuditRoot("/audit", "Automation Worker")).toThrow(/invalid/u);
  });
});

function initializeRequest(clientRequestId = "initialize-request-1") {
  return {
    clientRequestId,
    kind: "rpc-request" as const,
    rpc: {
      method: "initialize" as const,
      id: clientRequestId,
      params: {
        clientInfo: { name: "aibrain_test", title: "AiBrain Test", version: "1.0.0" },
        capabilities: null,
      },
    },
  };
}

function approvalResponse(clientRequestId = `server-response:approval-event:${APPROVAL_SCOPE_DIGEST}`) {
  return {
    clientRequestId,
    kind: "rpc-response" as const,
    rpc: { id: "approval-1", result: { decision: "accept" } },
  };
}

async function nextEvent(transport: WebSocketAppServerTransport) {
  const iterator = transport.events()[Symbol.asyncIterator]();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for worker event.")), 2_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe("private per-user worker gateway", () => {
  let root: string;
  let context: WorkerLaunchContext;
  let fakeServer: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "aibrain-worker-gateway-")));
    roots.push(root);
    const userRoot = path.join(root, "users", USER_ID);
    const runtimeRoot = path.join(userRoot, "runtime");
    const transportAudit = path.join(userRoot, "audit", "transport");
    const workspace = path.join(userRoot, "workspace");
    await Promise.all([
      mkdir(transportAudit, { recursive: true, mode: 0o700 }),
      mkdir(workspace, { recursive: true, mode: 0o700 }),
    ]);
    context = {
      installationId: "qa-company",
      userId: USER_ID,
      workerId: `worker-${USER_ID}`,
      environment: {
        HOME: path.join(runtimeRoot, "home"),
        CODEX_HOME: path.join(runtimeRoot, "codex-home"),
        XDG_CACHE_HOME: path.join(runtimeRoot, "xdg", "cache"),
        XDG_CONFIG_HOME: path.join(runtimeRoot, "xdg", "config"),
        XDG_DATA_HOME: path.join(runtimeRoot, "xdg", "data"),
        XDG_STATE_HOME: path.join(runtimeRoot, "xdg", "state"),
        TMPDIR: path.join(userRoot, "staging", "tmp"),
      },
      mounts: {
        runtimeReadOnly: [path.join(root, "company"), path.join(root, "source-ro")],
        runtimeReadWrite: [runtimeRoot, workspace, transportAudit],
        browserReadWrite: [path.join(userRoot, "browser")],
      },
      workspace,
      staging: path.join(userRoot, "staging"),
      artifacts: path.join(userRoot, "artifacts"),
      transportAudit,
      browser: {
        profile: path.join(userRoot, "browser", "profile"),
        downloads: path.join(userRoot, "browser", "downloads"),
      },
    };
    fakeServer = path.join(root, "fake-app-server.mjs");
    await writeFile(fakeServer, [
      'import { createInterface } from "node:readline";',
      'const lines = createInterface({ input: process.stdin });',
      'lines.on("line", (line) => {',
      '  const request = JSON.parse(line);',
      '  if (request.id !== undefined) process.stdout.write(JSON.stringify({ id: request.id, result: { acceptedMethod: request.method } }) + "\\n");',
      '});',
    ].join("\n"), { mode: 0o600 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("answers external token refresh privately without journaling credentials or exposing it as a tool", async () => {
    context = { ...context, installationId: "trinalum-production" };
    vi.stubEnv("AIBRAIN_CODEX_OWNER_AUTH_SOCKET", "/run/trinalum-owner-auth/broker.sock");
    vi.stubEnv("AIBRAIN_CODEX_AUTH_SCOPE", "installation-owner");
    vi.stubEnv("AIBRAIN_INSTALLATION_OWNER_AUTH_ACK", "trinalum-production");
    const accessToken = "private-temporary-access-token-must-never-appear-in-journals";
    const ownerAccess = vi.spyOn(ownerAuthentication, "readInstallationOwnerAccess").mockResolvedValue({ accessToken, chatgptAccountId: "owner" });
    await writeFile(fakeServer, [
      'import { createInterface } from "node:readline";',
      'let pending; const lines = createInterface({ input: process.stdin });',
      'lines.on("line", (line) => { const request = JSON.parse(line);',
      'if (request.method === "initialize") { pending=request.id; process.stdout.write(JSON.stringify({id:"owner-refresh",method:"account/chatgptAuthTokens/refresh",params:{reason:"unauthorized",previousAccountId:"owner"}})+"\\n"); }',
      `else if(request.id === "owner-refresh" && request.result?.accessToken === ${JSON.stringify(accessToken)}) process.stdout.write(JSON.stringify({id:pending,result:{privateRefreshAnswered:true}})+"\\n");`,
      '});',
    ].join("\n"));
    const worker = gateway(); await worker.start();
    const client = transport(worker); const router = new AppServerRpcRouter(client);
    try {
      await router.start();
      const request = initializeRequest();
      expect(await router.request(request.rpc, 5_000)).toEqual({ privateRefreshAnswered: true });
      expect(ownerAccess).toHaveBeenCalledWith("trinalum-production", "owner");
      for (const filename of ["gateway-events.jsonl", "gateway-requests.jsonl", "test-client-events.jsonl"]) {
        const journal = await readFile(path.join(context.transportAudit, filename), "utf8");
        expect(journal).not.toContain(accessToken); expect(journal).not.toContain("account/chatgptAuthTokens/refresh");
      }
    } finally { await router.close(); await worker.stop(); }
  });

  function gateway(options: { maxRetainedCompletedRequests?: number; maxRetainedObservationBytes?: number; sharedAuth?: import("./shared-auth-broker").SharedAuthProvider } = {}) {
    return new PrivateWorkerGateway({
      context,
      ...options,
      processFactory: () => spawn(process.execPath, [fakeServer], {
        cwd: context.workspace,
        env: { NODE_ENV: "test", ...context.environment },
        stdio: ["pipe", "pipe", "pipe"],
      }),
    });
  }

  it("durably batches queued notifications before exposing them and replays each identity after restart", async () => {
    await writeFile(fakeServer, [
      'import {createInterface} from "node:readline";',
      'createInterface({input:process.stdin}).on("line",line=>{const r=JSON.parse(line);if(r.id===undefined)return;',
      'process.stdout.write(JSON.stringify({id:r.id,result:{}})+"\\n"+Array.from({length:40},(_,i)=>JSON.stringify({method:"warning",params:{threadId:null,message:"note-"+i}})).join("\\n")+"\\n");});',
    ].join("\n"));
    const original=FileTransportEventJournal.prototype.appendBatch;
    let release!:()=>void,entered=false;const held=new Promise<void>(resolve=>{release=resolve;});
    const sizes:number[]=[];
    vi.spyOn(FileTransportEventJournal.prototype,"appendBatch").mockImplementation(async function(this: FileTransportEventJournal, events){
      if(this.filePath.endsWith("gateway-events.jsonl")){sizes.push(events.length);entered=true;await held;}
      return original.call(this,events);
    });
    const worker=gateway();await worker.start();const client=transport(worker);
    try {
      await client.connect();await client.send(initializeRequest("burst"));
      expect((await nextEvent(client)).value?.message.kind).toBe("rpc-response");
      await vi.waitFor(()=>expect(entered).toBe(true));
      let exposed=false;const pending=nextEvent(client).then(value=>{exposed=true;return value;});
      await new Promise(resolve=>setTimeout(resolve,25));expect(exposed).toBe(false);
      release();const received=[(await pending).value!];
      for(let i=1;i<40;i++)received.push((await nextEvent(client)).value!);
      expect(received.map(e=>e.message.kind==="rpc-notification"&&e.message.rpc.method==="warning"?e.message.rpc.params.message:null)).toEqual(Array.from({length:40},(_,i)=>"note-"+i));
      expect(sizes).toEqual([32,8]);
      const cold=new FileTransportEventJournal({filePath:path.join(context.transportAudit,"gateway-events.jsonl"),lockManager:new ResourceLockManager({rootDirectory:path.join(context.transportAudit,"cold-locks")})});
      expect((await cold.readEvents()).slice(1)).toEqual(received);
    } finally {release();await client.close();await worker.stop();}
  });

  it("preserves valid queued notifications before failing closed on a malformed protocol member", async () => {
    await writeFile(fakeServer, [
      'const rows=[{method:"warning",params:{threadId:null,message:"valid-1"}},{method:"warning",params:{threadId:null,message:"valid-2"}},{method:"warning",params:{threadId:null,message:123}}];',
      'setTimeout(()=>process.stdout.write(rows.map(x=>JSON.stringify(x)).join("\\n")+"\\n"),100);process.stdin.resume();',
    ].join("\n"));
    const worker=gateway();await worker.start();
    try {await vi.waitFor(async()=>expect((await worker.health()).state).toBe("failed"),{timeout:5000});}
    finally {await worker.stop();}
    const entries=(await readFile(path.join(context.transportAudit,"gateway-events.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    expect(entries.map(x=>x.payload.message.rpc.params.message)).toEqual(["valid-1","valid-2"]);
  });

  it("persists a private structural failure receipt across worker restart without retaining raw stdout or stderr",async()=>{
    await writeFile(fakeServer, 'setTimeout(()=>{process.stderr.write("Bearer private-stderr-token");process.stdout.write("{invalid-private-provider-body\\n");},100);process.stdin.resume();');
    const worker=gateway();await worker.start();
    try {
      for(let n=0;n<200 && (await worker.health()).state!=="failed";n++) await new Promise(resolve=>setTimeout(resolve,10));
      expect((await worker.health()).state).toBe("failed");
    } finally {await worker.stop();}
    const receipt=path.join(context.transportAudit,"gateway-last-failure.json");
    const saved=await readFile(receipt,"utf8");
    expect(JSON.parse(saved)).toMatchObject({stage:"stdout-processing",errorType:"SyntaxError",
      stdoutJson:{byteCount:Buffer.byteLength("{invalid-private-provider-body"),prefixClass:"jsonobject"}});
    expect(saved).not.toMatch(/private|Bearer|provider-body|stderr-token/);
    expect((await stat(receipt)).mode & 0o777).toBe(0o600);
    await writeFile(fakeServer,"process.stdin.resume();");
    const replacement=gateway();await replacement.start();await replacement.stop();
    expect(await readFile(receipt,"utf8")).toBe(saved);
  });

  it("journals preceding valid text before failing closed on malformed stdout", async () => {
    await writeFile(fakeServer, [
      'const delta={method:"item/agentMessage/delta",params:{threadId:"synthetic-thread",turnId:"synthetic-turn",itemId:"synthetic-item",delta:"synthetic text"}};',
      'setTimeout(()=>process.stdout.write(JSON.stringify(delta)+"\\n{invalid\\n"),100);process.stdin.resume();',
    ].join("\n"));
    const worker=gateway();await worker.start();
    try {
      await vi.waitFor(async()=>expect((await worker.health()).state).toBe("failed"),{timeout:5000});
    } finally { await worker.stop(); }
    const entries=(await readFile(path.join(context.transportAudit,"gateway-events.jsonl"),"utf8")).trim().split("\n")
      .map(line=>JSON.parse(line) as {payload:{message:{rpc:{method?:string;params?:{delta?:string}}}}});
    expect(entries.some(entry=>entry.payload.message.rpc.method==="item/agentMessage/delta" &&
      entry.payload.message.rpc.params?.delta==="synthetic text")).toBe(true);
    const failure=JSON.parse(await readFile(path.join(context.transportAudit,"gateway-last-failure.json"),"utf8"));
    expect(failure).toMatchObject({stage:"stdout-processing",errorType:"SyntaxError"});
  });

  it("ACKs a late cold metadata reply without poisoning the shared WebSocket when its caller generation expires",async()=>{
    await writeFile(fakeServer,[
      'import {createInterface} from "node:readline";',
      'createInterface({input:process.stdin}).on("line",line=>{const r=JSON.parse(line);if(r.id===undefined)return;setTimeout(()=>process.stdout.write(JSON.stringify({id:r.id,result:r.method==="thread/resume"?{thread:{id:"old-thread",turns:[]}}:{acceptedMethod:r.method}})+"\\n"),r.method==="thread/resume"?60:0);});',
    ].join("\n"));
    const worker=gateway();await worker.start();const clientTransport=transport(worker);const router=new AppServerRpcRouter(clientTransport);
    try {
      await router.start();let expired=false;const persisted=vi.fn();
      const client={request:(method:unknown,params:unknown,purpose:unknown,timeout:unknown,beforeResolve:unknown)=>router.request({method,id:purpose,params}as never,timeout as number,beforeResolve as never)};
      const recovering=requestPagedThreadRecovery(client as never,"thread/resume",{threadId:"old-thread"},"late-cold-resume",1000,"same-current-user-message",async()=>{
        if(expired)throw new ColdThreadRecoveryTimeoutError();persisted();
      });
      expired=true;
      await expect(recovering).rejects.toBeInstanceOf(ColdThreadRecoveryTimeoutError);
      expect(persisted).not.toHaveBeenCalled();
      expect(await router.request({...initializeRequest().rpc,id:"other-active-thread"} as never,1000)).toEqual({acceptedMethod:"initialize"});
      expect((await clientTransport.health()).healthy).toBe(true);
      expect((await worker.health()).healthy).toBe(true);
    } finally {await router.close();await clientTransport.close();await worker.stop();}
  });

  it('drains an accepted client frame and the durable ACK it enqueues before stop returns', async () => {
    const worker = gateway();
    // An owned generation can have accepted client work without a live child.
    // Hold that producer until shutdown has captured its initial drain set.
    Reflect.set(worker, 'state', 'running');
    let releaseFrame!: () => void, releaseAck!: () => void, ackStarted!: () => void, drainingFrame!: () => void;
    const frameReady = new Promise<void>(resolve => { releaseFrame = resolve; });
    const ackReady = new Promise<void>(resolve => { releaseAck = resolve; });
    const acknowledging = new Promise<void>(resolve => { ackStarted = resolve; });
    const draining = new Promise<void>(resolve => { drainingFrame = resolve; });
    const output = path.join(context.transportAudit, 'late-accepted-ack.json');
    let ack = Promise.resolve();
    const frameChain = frameReady.then(() => {
      ack = (Reflect.get(worker, 'eventAcknowledgementChain') as Promise<void>).then(async () => {
        ackStarted(); await ackReady; await writeFile(output, '{"durable":true}', { mode: 0o600 });
      });
      Reflect.set(worker, 'eventAcknowledgementChain', ack);
    });
    const originalCatch = frameChain.catch.bind(frameChain);
    vi.spyOn(frameChain, 'catch').mockImplementation(onRejected => { drainingFrame(); return originalCatch(onRejected); });
    Reflect.set(worker, 'clientFrameChain', frameChain);
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    try {
      await draining; releaseFrame(); await acknowledging;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(stopped).toBe(false);
      releaseAck(); await stopping;
      expect(await readFile(output, 'utf8')).toBe('{"durable":true}');
      expect((await worker.health()).state).toBe('stopped');
    } finally { releaseFrame(); releaseAck(); await stopping; await ack; }
  });

  it("keeps live events contiguous with paginated replay and never duplicates its final page", async () => {
    const payload = (sequence: number) => ({ eventId: `event-${sequence}`, sequence,
      occurredAt: "2026-10-26T00:00:00.000Z", message: { kind: "rpc-notification" as const,
        rpc: { method: "warning" as const, params: { threadId: null, message: `event ${sequence}` } } } });
    await mkdir(context.transportAudit, { recursive: true });
    await writeFile(path.join(context.transportAudit, "gateway-events.jsonl"),
      Array.from({ length: 300 }, (_, index) => JSON.stringify({ schemaVersion: 1, sequence: index + 1,
        eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        recordedAt: "2026-10-26T00:00:00.000Z", payload: payload(index + 1) })).join("\n") + "\n");
    let firstWrite!: () => void, releaseWrite!: () => void;
    const writing = new Promise<void>(resolve => { firstWrite = resolve; });
    const received: number[] = [];
    const socket = { readyState: WebSocket.OPEN, close: vi.fn(),
      send(raw: string, done?: (error?: Error) => void) {
        const frame = JSON.parse(raw);
        if (frame.type !== "event") { done?.(); return; }
        received.push(frame.event.sequence);
        if (frame.event.sequence === 1) { releaseWrite = () => done?.(); firstWrite(); }
        else done?.();
      } } as unknown as WebSocket;
    const worker = gateway();
    const internal = worker as unknown as { activeSocket: WebSocket;
      resume(socket: WebSocket, eventId: unknown, sequence: unknown): Promise<void>;
      recordAppServerOutput(value: unknown): Promise<unknown> };
    internal.activeSocket = socket;
    const readEvents = FileTransportEventJournal.prototype.readEvents;
    let finalPageLive = false;
    const read = vi.spyOn(FileTransportEventJournal.prototype, "readEvents")
      .mockImplementation(async function (this: FileTransportEventJournal, after = 0, limit?: number, maxBytes?: number) {
        if (after === 256 && !finalPageLive) {
          finalPageLive = true;
          // Arrives while the final replay read is in flight. It must not be
          // sent directly or included once here and again through the live lane.
          await internal.recordAppServerOutput({ method: "warning", params: { threadId: null, message: "live 302" } });
        }
        return readEvents.call(this, after, limit, maxBytes);
      });
    let resumed: Promise<void> | undefined;
    try {
      resumed = internal.resume(socket, null, null);
      await writing;
      await internal.recordAppServerOutput({ method: "warning", params: { threadId: null, message: "live 301" } });
      expect(received).toEqual([1]); // live append is durable, but cannot overtake replay
      releaseWrite();
      await resumed;
      expect(finalPageLive).toBe(true);
      expect(received).toEqual(Array.from({ length: 302 }, (_, index) => index + 1));
      expect(new Set(received).size).toBe(302);
      expect(socket.close).not.toHaveBeenCalled();
    } finally { releaseWrite?.(); try { await resumed; } finally { read.mockRestore(); } }
  });

  it('recovers an exact 9 MiB answer while running and replays it after restart without redispatch', async () => {
    const answer = 'Q'.repeat(9 * 1024 * 1024) + 'END-QA';
    const requestLog = path.join(root, 'large-answer-requests.jsonl');
    await writeFile(fakeServer, `import { createInterface } from 'node:readline';
      import {appendFileSync} from 'node:fs';
      createInterface({input:process.stdin}).on('line',line=>{ const r=JSON.parse(line); if(r.id===undefined)return;
      appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({id:r.id,method:r.method})+'\\n');
      const result=r.method==='thread/turns/list'?{data:[{id:'qa-turn',status:'completed',items:[{type:'userMessage',clientId:'qa-input'},{type:'agentMessage',text:'Q'.repeat(9*1024*1024)+'END-QA'}]}],nextCursor:null}:{acceptedMethod:r.method};
      process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});`, { mode: 0o600 });
    let worker = gateway(); await worker.start();
    let router = new AppServerRpcRouter(transport(worker));
    const request = { method: 'thread/turns/list' as const, id: 'large-final-answer', params: { threadId: 'qa-thread', limit: 1, itemsView: 'full' as const } };
    try {
      const result = await router.request(request, 10_000) as { data: { items: { text?: string }[] }[] };
      expect(result.data[0].items[1].text).toBe(answer);
      expect((await worker.health()).state).toBe('running');
      await expect(router.request({ method: 'thread/read', id: 'after-large-answer', params: { threadId: 'qa-thread', includeTurns: false } }, 3_000)).resolves.toEqual({ acceptedMethod: 'thread/read' });
      await router.close(); await worker.stop();
      worker = gateway(); await worker.start();
      router = new AppServerRpcRouter(transport(worker));
      const recovered = await router.request(request, 10_000) as typeof result;
      expect(recovered.data[0].items[1].text).toBe(answer);
      expect((await worker.health()).state).toBe('running');
      const dispatched = (await readFile(requestLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(dispatched.filter(r => r.id === request.id)).toHaveLength(1);
    } finally { await router.close(); await worker.stop(); }
  }, PROCESS_RECOVERY_TEST_TIMEOUT_MS);

  it("handles external login and renewal privately without writing access tokens to either journal", async () => {
    await writeFile(fakeServer, [
      'import { createInterface } from "node:readline";',
      'const write = value => process.stdout.write(JSON.stringify(value) + "\\n");',
      'let initialized = false; let loginToken; let pending;',
      'createInterface({ input: process.stdin }).on("line", line => {',
      'const rpc = JSON.parse(line);',
      'if (rpc.method === "initialize") { write(initialized ? {id:rpc.id,error:{code:-32600,message:"Already initialized"}} : {id:rpc.id,result:{}}); initialized=true; }',
      'else if (rpc.method === "account/login/start") { loginToken=rpc.params.accessToken; write({id:rpc.id,result:{type:"chatgptAuthTokens"}}); }',
      'else if (rpc.method === "account/read") { pending=rpc.id; write({id:"private-renewal",method:"account/chatgptAuthTokens/refresh",params:{reason:"unauthorized",previousAccountId:"qa-account"}}); }',
      'else if (rpc.id === "private-renewal") { write({id:pending,result:{renewed:Boolean(rpc.result?.accessToken && rpc.result.accessToken !== loginToken)}}); }',
      '});',
    ].join("\n"), { mode: 0o600 });
    const provider = vi.fn(async (_account?: string | null, rejected?: string) => ({
      accessToken: rejected ? "private-replacement-token" : "private-initial-token",
      chatgptAccountId: "qa-account", chatgptPlanType: "business",
    }));
    const worker = gateway({ sharedAuth: provider });
    await worker.start();
    const client = transport(worker);
    const router = new AppServerRpcRouter(client);
    try {
      await expect(router.request({ method: "account/read", id: "public-probe", params: { refreshToken: false } }, 3_000)).resolves.toEqual({ renewed: true });
      expect(provider).toHaveBeenLastCalledWith("qa-account", "private-initial-token");
      for (const name of ["gateway-events.jsonl", "gateway-requests.jsonl", "test-client-events.jsonl"]) {
        const bytes = await readFile(path.join(context.transportAudit, name), "utf8");
        expect(bytes).not.toContain("private-initial-token");
        expect(bytes).not.toContain("private-replacement-token");
        expect(bytes).not.toContain("account/chatgptAuthTokens/refresh");
      }
    } finally { await router.close(); await worker.stop(); }
  });

  it("authenticates the personal context privately before exposing the managed transport or journaling a public request", async () => {
    await writeFile(fakeServer, [
      'import { createInterface } from "node:readline";',
      'const write=value=>process.stdout.write(JSON.stringify(value)+"\\n");let token;',
      'createInterface({input:process.stdin}).on("line",line=>{const rpc=JSON.parse(line);',
      'if(rpc.method==="initialize")write({id:rpc.id,result:{}});',
      'else if(rpc.method==="account/login/start"){token=rpc.params.accessToken;write({id:rpc.id,result:{type:"chatgptAuthTokens"}});}',
      'else if(rpc.method==="account/read")write({id:rpc.id,result:{authenticated:Boolean(token),socketRootExposed:Boolean(process.env.AIBRAIN_CODEX_USER_ACCESS_SOCKET_ROOT)}});',
      '});',
    ].join("\n"));
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const accessToken = "synthetic-personal-access-private-to-stdio";
    const provider = vi.fn(async () => { await ready; return { accessToken, chatgptAccountId: "personal-qa", chatgptPlanType: null }; });
    const forContext = vi.fn(() => provider);
    const worker = new LocalGatewayWorkerRuntimeFactory({
      authForContext: forContext,
      runtimeInstanceId: "personal-test",
      processFactory: launch => spawn(process.execPath, [fakeServer], {
        cwd: launch.workspace, env: { NODE_ENV: "test", ...launch.environment }, stdio: ["pipe", "pipe", "pipe"],
      }),
    }).create(context);
    const starting = worker.start();
    try {
      await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
      expect(forContext).toHaveBeenCalledWith(context);
      expect((await worker.health()).state).toBe("starting");
      release(); await starting;
      const router = new AppServerRpcRouter(worker.transport);
      try {
        expect(await router.request({ method: "account/read", id: "personal-public-read", params: { refreshToken: false } }, 3_000))
          .toEqual({ authenticated: true, socketRootExposed: false });
      } finally { await router.close(); }
      const audit = path.join(context.transportAudit, "runtime-instances", "personal-test");
      for (const file of ["gateway-events.jsonl", "gateway-requests.jsonl", "client-events.jsonl"]) {
        const bytes = await readFile(path.join(audit, file), "utf8");
        expect(bytes).not.toContain(accessToken);
        expect(bytes).not.toContain("account/login/start");
        expect(bytes).not.toContain("private-auth:");
      }
    } finally { release(); await starting.catch(() => undefined); await worker.stop(); }
  });

  it("rejects personal plus shared providers before spawning a worker", async () => {
    const provider = async () => ({ accessToken: "synthetic-access", chatgptAccountId: "qa", chatgptPlanType: null });
    const processFactory = vi.fn();
    const worker = new LocalGatewayWorkerRuntimeFactory({ sharedAuth: provider, authForContext: () => provider, processFactory }).create(context);
    await expect(worker.start()).rejects.toThrow("cannot share");
    expect(processFactory).not.toHaveBeenCalled();
    await worker.stop();
  });

  function transport(worker: PrivateWorkerGateway) {
    if (!worker.endpoint) throw new Error("Gateway did not start.");
    const journal = new FileTransportEventJournal({
      filePath: path.join(context.transportAudit, "test-client-events.jsonl"),
      lockManager: new ResourceLockManager({
        rootDirectory: path.join(context.transportAudit, "test-client-locks"),
      }),
    });
    return new WebSocketAppServerTransport({
      endpoint: worker.endpoint,
      socketFactory: new NodeWebSocketFactory(),
      auth: {
        placement: "authorization-header",
        credentialProvider: {
          async getCredential() {
            return { kind: "capability-token" as const, token: worker.token };
          },
        },
      },
      journal,
      // Keep this integration fixture responsive without treating transient CI
      // scheduler stalls as a network failure. Heartbeat timeout behaviour is
      // covered by the dedicated transport tests.
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 2_000,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      reconnectJitterRatio: 0,
    });
  }

  it("releases journal ownership after cancellation during startup repair", async () => {
    let finishRepair!: () => void;
    const repair = vi.spyOn(FileTransportEventJournal.prototype, "verifyAndRepair")
      .mockImplementationOnce(() => new Promise(resolve => { finishRepair = () => resolve({ count: 0, lastSequence: 0, repairedBytes: 0 }); }));
    const cancelled = gateway();
    const successor = gateway();
    try {
      const result = cancelled.start().catch(error => error);
      await vi.waitFor(() => expect(repair).toHaveBeenCalled());
      const stopping = cancelled.stop();
      finishRepair();
      expect(await result).toBeInstanceOf(Error);
      await stopping;
      await successor.start();
      expect((await successor.health()).healthy).toBe(true);
    } finally {
      repair.mockRestore();
      await Promise.all([cancelled.stop(), successor.stop()]);
    }
  });

  it("rejects a second live owner before touching the shared replay journals and permits restart", async () => {
    const first = gateway();
    const duplicate = gateway();
    const successor = gateway();
    let router: AppServerRpcRouter | null = null;
    try {
      await first.start();
      router = new AppServerRpcRouter(transport(first));
      expect(await router.request(initializeRequest().rpc, 3_000)).toEqual({ acceptedMethod: "initialize" });
      const eventPath = path.join(context.transportAudit, "gateway-events.jsonl");
      const before = await readFile(eventPath, "utf8").catch(() => "");
      await expect(duplicate.start()).rejects.toThrow();
      expect(await readFile(eventPath, "utf8").catch(() => "")).toBe(before);
      expect((await first.health()).healthy).toBe(true);
      expect(duplicate.endpoint).toBeNull();
      expect(await router.request({ method: "account/read", id: "owner-read-after-duplicate", params: { refreshToken: false } }, 3_000))
        .toEqual({ acceptedMethod: "account/read" });
      await router.close();
      await first.stop();
      await successor.start();
      expect((await successor.health()).healthy).toBe(true);
    } finally {
      await router?.close();
      await Promise.all([first.stop(), duplicate.stop(), successor.stop()]);
    }
  });
  it.each(["", "GET /app-server HTTP/1.1\r\nHost: localhost\r\n"])(
    "stops an owned gateway with an unfinished HTTP handshake (%j)", async (partialRequest) => {
      const worker = gateway();
      await worker.start();
      const endpoint = new URL(worker.endpoint!);
      const accepted = once(Reflect.get(worker, "server"), "connection");
      const socket = connectTcp(Number(endpoint.port), endpoint.hostname);
      socket.on("error", () => { /* Shutdown may reset a not-yet-upgraded connection. */ });
      let stopping: Promise<void> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await once(socket, "connect");
        const [peer] = await accepted;
        if (partialRequest) {
          const received = once(peer, "data");
          socket.write(partialRequest);
          await received;
        }
        // A reconnect can own a TCP connection before it becomes a WebSocket.
        // It must not hold shutdown until Node's multi-minute HTTP timeout.
        stopping = worker.stop();
        await Promise.race([
          stopping,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Unfinished handshake blocked shutdown.")), 1_000);
          }),
        ]);
        expect((await worker.health()).state).toBe("stopped");
      } finally {
        if (timeout) clearTimeout(timeout);
        socket.destroy();
        await (stopping ?? worker.stop());
      }
    },
  );

  it.each([undefined, false, true])("launches immutable quota profiles only when enabled (%s)", async (quotaToolPrivacy) => {
    const argumentsPath = path.join(root, "worker-arguments.json");
    const executable = path.join(root, "codex-test.mjs");
    await writeFile(executable, [
      `#!${process.execPath}`,
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));`,
      'process.stdin.resume();',
    ].join("\n"), { mode: 0o700 });
    vi.stubEnv("CODEX_BIN", executable);
    const runtime = new LocalGatewayWorkerRuntimeFactory({
      quotaToolPrivacy,
      kernelLockCommand: ["python3", "-c", "import fcntl,sys;fcntl.flock(3,(fcntl.LOCK_SH if '--shared' in sys.argv else fcntl.LOCK_EX)|fcntl.LOCK_NB)"],
      runtimeInstanceId: "automation-worker",
    }).create(context);
    try {
      await runtime.start();
      const expectedOverrides = quotaToolPrivacy
        ? quotaToolPermissionConfigOverrides({
          codexHome: context.environment.CODEX_HOME,
          transportAudit: context.transportAudit,
        }).flatMap((value) => ["-c", value])
        : [];
      await expect.poll(async () => JSON.parse(await readFile(argumentsPath, "utf8")))
        .toEqual(["app-server", "--stdio", ...expectedOverrides]);
      if (quotaToolPrivacy) {
        const serialized = await readFile(argumentsPath, "utf8");
        expect(serialized).toContain(path.join(context.environment.CODEX_HOME, "sessions"));
        expect(serialized).toContain(context.transportAudit);
        expect(serialized).not.toContain("runtime-instances");
      }
    } finally {
      await runtime.stop();
    }
  });

  it("rejects unsafe quota roots before starting a worker", async () => {
    const processFactory = vi.fn();
    const runtime = new LocalGatewayWorkerRuntimeFactory({ quotaToolPrivacy: true, processFactory })
      .create({ ...context, environment: { ...context.environment, CODEX_HOME: "relative-home" } });
    await expect(runtime.start()).rejects.toThrow(/espacio privado/u);
    expect(processFactory).not.toHaveBeenCalled();
  });

  it("keeps an injected process factory's context-only contract with quota privacy enabled", async () => {
    const processFactory = vi.fn(() => spawn(process.execPath, [fakeServer], {
      cwd: context.workspace,
      env: { NODE_ENV: "test", ...context.environment },
      stdio: ["pipe", "pipe", "pipe"],
    }));
    const runtime = new LocalGatewayWorkerRuntimeFactory({
      quotaToolPrivacy: true,
      processFactory,
      runtimeInstanceId: "app",
    }).create(context);
    try {
      await runtime.start();
      expect(processFactory).toHaveBeenCalledExactlyOnceWith({
        ...context,
        transportAudit: workerTransportAuditRoot(context.transportAudit, "app"),
      });
    } finally {
      await runtime.stop();
    }
  });

  it("runs app and automation transports concurrently without sharing replay journals", async () => {
    const processFactory = () => spawn(process.execPath, [fakeServer], {
      cwd: context.workspace,
      env: { NODE_ENV: "test", ...context.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const appRuntime = new LocalGatewayWorkerRuntimeFactory({
      processFactory,
      runtimeInstanceId: "app",
    }).create(context);
    const automationRuntime = new LocalGatewayWorkerRuntimeFactory({
      processFactory,
      runtimeInstanceId: "automation-worker",
    }).create(context);
    try {
      await Promise.all([appRuntime.start(), automationRuntime.start()]);
      await Promise.all([appRuntime.transport.connect(), automationRuntime.transport.connect()]);
      await Promise.all([
        appRuntime.transport.send(initializeRequest("shared-request-id")),
        automationRuntime.transport.send(initializeRequest("shared-request-id")),
      ]);
      const [appEvent, automationEvent] = await Promise.all([
        appRuntime.transport.events()[Symbol.asyncIterator]().next(),
        automationRuntime.transport.events()[Symbol.asyncIterator]().next(),
      ]);
      expect(appEvent.value).toMatchObject({ message: { kind: "rpc-response", rpc: { id: "shared-request-id" } } });
      expect(automationEvent.value).toMatchObject({ message: { kind: "rpc-response", rpc: { id: "shared-request-id" } } });
      await Promise.all([
        readFile(path.join(workerTransportAuditRoot(context.transportAudit, "app"), "gateway-events.jsonl"), "utf8"),
        readFile(path.join(workerTransportAuditRoot(context.transportAudit, "automation-worker"), "gateway-events.jsonl"), "utf8"),
      ]);
    } finally {
      await Promise.allSettled([
        appRuntime.transport.close(),
        automationRuntime.transport.close(),
        appRuntime.stop(),
        automationRuntime.stop(),
      ]);
    }
  });

  it("authenticates on loopback, validates the pinned RPC contract and persists the event before delivery", async () => {
    const worker = gateway();
    await worker.start();
    const client = transport(worker);
    try {
      await client.connect();
      await client.send(initializeRequest());
      const received = await nextEvent(client);
      expect(received).toMatchObject({
        done: false,
        value: {
          sequence: 1,
          message: {
            kind: "rpc-response",
            rpc: { id: "initialize-request-1", result: { acceptedMethod: "initialize" } },
          },
        },
      });
      expect(await worker.health()).toMatchObject({ healthy: true, state: "running" });
    } finally {
      await client.close();
      await worker.stop();
    }
  });

  it("admits a new chat while an earlier App Server output is still being persisted", async () => {
    const worker = gateway();
    await worker.start();
    const client = transport(worker);
    let releaseOutput!: () => void;
    const outputGate = new Promise<void>((resolve) => { releaseOutput = resolve; });
    let outputPersistenceStarted!: () => void;
    const outputPersistence = new Promise<void>((resolve) => { outputPersistenceStarted = resolve; });
    const internals = worker as unknown as {
      events: { append(event: Parameters<FileTransportEventJournal["append"]>[0]): Promise<boolean> };
    };
    const append = internals.events.append.bind(internals.events);
    let firstOutput = true;
    internals.events.append = async (event) => {
      if (firstOutput) {
        firstOutput = false;
        outputPersistenceStarted();
        await outputGate;
      }
      return append(event);
    };
    try {
      await client.connect();
      await client.send(initializeRequest("busy-chat"));
      await outputPersistence;

      let newChatAdmitted = false;
      const newChat = client.send(initializeRequest("new-chat")).then(() => { newChatAdmitted = true; });
      await vi.waitFor(() => expect(newChatAdmitted).toBe(true), { timeout: 5_000 });

      releaseOutput();
      await newChat;
      const responses = await Promise.all([nextEvent(client), nextEvent(client)]);
      expect(responses.map(({ value }) => value && value.message.kind === "rpc-response"
        ? value.message.rpc.id
        : null)).toEqual(["busy-chat", "new-chat"]);
    } finally {
      releaseOutput();
      await client.close();
      await worker.stop();
    }
  });

  it("admits a new chat while an earlier event acknowledgement is still being persisted", async () => {
    const worker = gateway();
    await worker.start();
    const client = transport(worker);
    const gatewayEventsPath = path.join(context.transportAudit, "gateway-events.jsonl");
    const deliveryLocks = new ResourceLockManager({
      rootDirectory: path.join(context.transportAudit, "gateway-locks"),
    });
    const lease = await deliveryLocks.acquire(
      `transport-delivery:${gatewayEventsPath}.delivery.json`,
    );
    try {
      await client.connect();
      await client.send(initializeRequest("ack-blocked-chat"));
      const first = await nextEvent(client);
      expect(first.value).toMatchObject({
        message: { kind: "rpc-response", rpc: { id: "ack-blocked-chat" } },
      });

      const newChat = client.send(initializeRequest("chat-after-blocked-ack"));
      await expect(Promise.race([
        newChat,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("event acknowledgement blocked new chat admission")),
          1_000,
        )),
      ])).resolves.toBeUndefined();
    } finally {
      await lease.release();
      await client.close();
      await worker.stop();
    }
  }, PROCESS_RECOVERY_TEST_TIMEOUT_MS);

  it("rejects unauthenticated WebSockets before protocol negotiation", async () => {
    const worker = gateway();
    await worker.start();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(worker.endpoint!, { headers: { Authorization: "Bearer invalid-token-value-that-is-long-enough" } });
        socket.once("unexpected-response", (_, response) => resolve(response.statusCode ?? 0));
        socket.once("error", reject);
      });
      expect(status).toBe(401);
    } finally {
      await worker.stop();
    }
  });

  it("recovers the durable cursor and replays a completed duplicate without executing it in the restarted child", async () => {
    const firstWorker = gateway();
    await firstWorker.start();
    const firstClient = transport(firstWorker);
    await firstClient.connect();
    await firstClient.send(initializeRequest());
    const firstEvent = await nextEvent(firstClient);
    expect(firstEvent.value).toMatchObject({ sequence: 1 });
    if (!firstEvent.done) await firstClient.acknowledge(firstEvent.value);
    await firstClient.close();
    await firstWorker.stop();

    const restartedWorker = gateway();
    await restartedWorker.start();
    const restartedClient = transport(restartedWorker);
    try {
      await restartedClient.connect();
      await restartedClient.send(initializeRequest());
      const repeated = await nextEvent(restartedClient);
      expect(repeated.value).toMatchObject({
        sequence: 2,
        message: { kind: "rpc-response", rpc: { id: "initialize-request-1" } },
      });
    } finally {
      await restartedClient.close();
      await restartedWorker.stop();
    }
  });

  it("acknowledges an identical in-flight retry without dispatching it twice", async () => {
    await writeFile(fakeServer, [
      'import { createInterface } from "node:readline";',
      'const lines = createInterface({ input: process.stdin });',
      'const write = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
      'const pending = [];',
      'lines.on("line", (line) => {',
      '  const request = JSON.parse(line);',
      '  if (request.id === "initialize-request-1") { pending.push(request); return; }',
      '  if (request.id === "release-request") {',
      '    for (const held of pending) write({ id: held.id, result: { acceptedMethod: held.method } });',
      '    write({ id: request.id, result: { acceptedMethod: request.method } });',
      '  }',
      '});',
    ].join("\n"), { mode: 0o600 });
    const worker = gateway();
    await worker.start();
    const firstClient = transport(worker);
    const retryingClient = transport(worker);
    try {
      await firstClient.connect();
      await firstClient.send(initializeRequest());
      await firstClient.close();

      await retryingClient.connect();
      await retryingClient.send(initializeRequest());
      await retryingClient.send(initializeRequest("release-request"));
      const originalResponse = await nextEvent(retryingClient);
      const releaseResponse = await nextEvent(retryingClient);
      expect(originalResponse.value).toMatchObject({
        sequence: 1,
        message: {
          kind: "rpc-response",
          rpc: { id: "initialize-request-1", result: { acceptedMethod: "initialize" } },
        },
      });
      expect(releaseResponse.value).toMatchObject({
        sequence: 2,
        message: {
          kind: "rpc-response",
          rpc: { id: "release-request", result: { acceptedMethod: "initialize" } },
        },
      });
      const durableEvents = (await readFile(
        path.join(context.transportAudit, "gateway-events.jsonl"),
        "utf8",
      )).trim().split("\n").map((line) => JSON.parse(line) as {
        payload: { message: { kind: string; rpc: { id?: string } } };
      });
      expect(durableEvents.filter((entry) =>
        entry.payload.message.kind === "rpc-response"
        && entry.payload.message.rpc.id === "initialize-request-1"
      )).toHaveLength(1);
    } finally {
      await firstClient.close();
      await retryingClient.close();
      await worker.stop();
    }
  });

  it("rejects an accepted request left uncertain by an App Server restart", async () => {
    await writeFile(fakeServer, [
      'import { createInterface } from "node:readline";',
      'const lines = createInterface({ input: process.stdin });',
      'lines.on("line", () => {});',
    ].join("\n"), { mode: 0o600 });
    const firstWorker = gateway();
    await firstWorker.start();
    const firstClient = transport(firstWorker);
    await firstClient.connect();
    await firstClient.send(initializeRequest());
    await firstClient.close();
    await firstWorker.stop();

    const restartedWorker = gateway();
    await restartedWorker.start();
    const restartedClient = transport(restartedWorker);
    try {
      await restartedClient.connect();
      await expect(restartedClient.send(initializeRequest())).rejects.toThrow(/uncertain/u);
    } finally {
      await restartedClient.close();
      await restartedWorker.stop();
    }
  });

  it("does not recompact irreducible protected receipts for every warm RPC", async () => {
    const request = initializeRequest("thread-start:protected-history");
    await mkdir(context.transportAudit, { recursive: true });
    await writeFile(path.join(context.transportAudit, "gateway-requests.jsonl"), JSON.stringify({
      schemaVersion: 1, sequence: 1, eventId: "00000000-0000-4000-8000-000000000001",
      recordedAt: "2026-10-26T00:00:00.000Z", payload: { schemaVersion: 1,
        clientRequestId: request.clientRequestId,
        canonicalHash: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
        status: "completed", responseJson: JSON.stringify({ id: request.rpc.id, result: { value: "x".repeat(8_192) } }),
        occurredAt: "2026-10-26T00:00:00.000Z" } }) + "\n");
    const worker = gateway({ maxRetainedObservationBytes: 1024 });
    await worker.start();
    const compact = vi.spyOn(FileJournal.prototype, "compactSelected");
    const client = transport(worker);
    try {
      await client.connect();
      for (let i = 1; i <= 4; i += 1) {
        await client.send(initializeRequest(`warm-${i}`));
        const response = await nextEvent(client);
        expect(response.value).toMatchObject({ message: { kind: "rpc-response", rpc: { id: `warm-${i}` } } });
        if (!response.done) await client.acknowledge(response.value);
      }
      expect(compact).not.toHaveBeenCalled();
      await expect(worker.recoverResponse(request)).resolves.toMatchObject({ id: request.rpc.id });
    } finally { compact.mockRestore(); await client.close(); await worker.stop(); }
  });

  it("bounds completed request history while retaining uncertain outcomes", async () => {
    const worker = gateway({ maxRetainedCompletedRequests: 2 });
    await worker.start();
    const client = transport(worker);
    try {
      await client.connect();
      for (let index = 1; index <= 4; index += 1) {
        await client.send(initializeRequest(`bounded-request-${index}`));
        const received = await nextEvent(client);
        if (!received.done) await client.acknowledge(received.value);
      }
      const lines = (await readFile(
        path.join(context.transportAudit, "gateway-requests.jsonl"),
        "utf8",
      )).trim().split("\n");
      expect(lines.length).toBeLessThanOrEqual(4);
    } finally {
      await client.close();
      await worker.stop();
    }
  });

  it("binds unsubscribe recovery to the original request and thread without dispatch",async()=>{
    const worker=gateway();await worker.start();const client=transport(worker);
    const request={clientRequestId:"background-release:own-turn:own-request",kind:"rpc-request" as const,rpc:{method:"thread/unsubscribe" as const,id:"background-release:own-turn:own-request",params:{threadId:"own-thread"}}};
    try{
      await client.connect();await client.send(request);await nextEvent(client);
      const ledgerPath=path.join(context.transportAudit,"gateway-requests.jsonl"),before=await readFile(ledgerPath,"utf8");
      expect(await worker.recoverResponse(request)).toMatchObject({id:request.rpc.id});
      await expect(worker.recoverResponse({...request,rpc:{...request.rpc,params:{threadId:"foreign-thread"}}})).rejects.toThrow(/does not match/);
      expect(await worker.recoverResponse({...request,clientRequestId:"background-release:stale-request",rpc:{...request.rpc,id:"background-release:stale-request"}})).toBeNull();
      expect(await readFile(ledgerPath,"utf8")).toBe(before);
    }finally{await client.close();await worker.stop();}
  });

  it("reads an exact late response after restart without dispatching or accepting a new request", async () => {
    const original = initializeRequest("thread-start:late-original");
    const worker = gateway();
    await worker.start();
    const client = transport(worker);
    try {
      await client.connect();
      await client.send(original);
      await nextEvent(client);
    } finally { await client.close(); await worker.stop(); }
    const restarted = gateway();
    await restarted.start();
    try {
      const ledgerPath = path.join(context.transportAudit, "gateway-requests.jsonl");
      const before = await readFile(ledgerPath, "utf8");
      await expect(restarted.recoverResponse(original)).resolves.toEqual({
        id: original.rpc.id, result: { acceptedMethod: "initialize" },
      });
      await expect(restarted.recoverResponse(initializeRequest("thread-start:never-sent"))).resolves.toBeNull();
      const changed = initializeRequest("thread-start:late-original");
      changed.rpc.params.clientInfo.name = "changed";
      await expect(restarted.recoverResponse(changed)).rejects.toThrow(/does not match/u);
      expect(await readFile(ledgerPath, "utf8")).toBe(before);
    } finally { await restarted.stop(); }
  });

  it.each(["thread-resume", "turn-completion-reconcile"])("compacts oversized %s observations but preserves creation and uncertain receipts", async (prefix) => {
    const entries = [
      ["thread-start:recoverable", "completed"],
      ["turn-start:recoverable", "completed"],
      ["thread-resume:uncertain", "accepted"],
      ...Array.from({ length: 6 }, (_, i) => [`${prefix}:observed-${i}`, "completed"]),
    ];
    const ledgerPath = path.join(context.transportAudit, "gateway-requests.jsonl");
    const records = entries.map(([id, status], index) => {
      const request = initializeRequest(id);
      return {
        schemaVersion: 1, sequence: index + 1,
        eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        recordedAt: "2026-10-02T10:30:00.000Z",
        payload: { schemaVersion: 1, clientRequestId: id,
          canonicalHash: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
          status, responseJson: status === "accepted" ? null : JSON.stringify({ id, result: { value: "x".repeat(2048) } }),
          occurredAt: "2026-10-02T10:30:00.000Z" },
      };
    });
    await mkdir(context.transportAudit, { recursive: true });
    await writeFile(ledgerPath, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const worker = gateway({ maxRetainedObservationBytes: 4096 });
    await worker.start();
    try {
      const retained = (await readFile(ledgerPath, "utf8")).trim().split("\n").map(line => JSON.parse(line).payload);
      expect(retained.map(record => record.clientRequestId)).toEqual(expect.arrayContaining([
        "thread-start:recoverable", "turn-start:recoverable", "thread-resume:uncertain", `${prefix}:observed-5`,
      ]));
      expect(retained).toHaveLength(4);
      await expect(worker.recoverResponse(initializeRequest("thread-start:recoverable"))).resolves.toHaveProperty("result");
      await expect(worker.recoverResponse(initializeRequest("thread-resume:uncertain"))).resolves.toBeNull();
      await expect(worker.recoverResponse(initializeRequest(`${prefix}:observed-0`))).resolves.toBeNull();
    } finally { await worker.stop(); }
  });

  it("confirms a server response only after durable progress in the same turn", async () => {
    await writeFile(fakeServer, [
      'import { createInterface } from "node:readline";',
      'const lines = createInterface({ input: process.stdin });',
      'const write = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
      'lines.on("line", (line) => {',
      '  const rpc = JSON.parse(line);',
      '  if (rpc.method) {',
      '    write({ id: rpc.id, result: {} });',
      '    write({ method: "item/commandExecution/requestApproval", id: "approval-1", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 1, environmentId: null, command: "pwd" } });',
      '    return;',
      '  }',
      '  setTimeout(() => write({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "approval processed" } }), 100);',
      '});',
    ].join("\n"), { mode: 0o600 });
    const worker = gateway();
    await worker.start();
    const client = transport(worker);
    try {
      await client.connect();
      await client.send(initializeRequest());
      const initialized = await nextEvent(client);
      const approval = await nextEvent(client);
      expect(approval.value).toMatchObject({
        message: { kind: "rpc-request", rpc: { id: "approval-1" } },
      });
      if (!initialized.done) await client.acknowledge(initialized.value);
      if (approval.done) throw new Error("Expected a durable approval event.");
      await client.acknowledge(approval.value);
      const responseId = `server-response:${approval.value.eventId}:${APPROVAL_SCOPE_DIGEST}`;

      let confirmed = false;
      const submission = client.send(approvalResponse(responseId)).then(() => { confirmed = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(confirmed).toBe(false);
      await submission;
      const progress = await nextEvent(client);
      expect(progress.value).toMatchObject({
        message: { kind: "rpc-notification", rpc: { params: { delta: "approval processed" } } },
      });
    } finally {
      await client.close();
      await worker.stop();
    }
  });

  it("ACKs an already completed server response when recovery cannot reproduce its original decision", async () => {
    await writeFile(fakeServer, [
      'import { createInterface } from "node:readline";',
      'const lines = createInterface({ input: process.stdin });',
      'const write = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
      'lines.on("line", (line) => {',
      '  const rpc = JSON.parse(line);',
      '  if (rpc.method) {',
      '    write({ id: rpc.id, result: {} });',
      '    write({ method: "item/commandExecution/requestApproval", id: "approval-1", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 1, environmentId: null, command: "pwd" } });',
      '    return;',
      '  }',
      '  write({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "approval processed once" } });',
      '});',
    ].join("\n"), { mode: 0o600 });
    const worker = gateway();
    await worker.start();
    const firstClient = transport(worker);
    try {
      await firstClient.connect();
      await firstClient.send(initializeRequest());
      const initialized = await nextEvent(firstClient);
      const approval = await nextEvent(firstClient);
      if (!initialized.done) await firstClient.acknowledge(initialized.value);
      if (approval.done) throw new Error("Expected a durable approval event.");
      await firstClient.acknowledge(approval.value);
      const responseId = `server-response:${approval.value.eventId}:${APPROVAL_SCOPE_DIGEST}`;
      await firstClient.send(approvalResponse(responseId));
      const progress = await nextEvent(firstClient);
      if (!progress.done) await firstClient.acknowledge(progress.value);
      await firstClient.close();

      const recoveredClient = transport(worker);
      try {
        await recoveredClient.connect();
        await expect(recoveredClient.send({
          ...approvalResponse(responseId),
          rpc: { id: "approval-1", error: { code: -32602, message: "No active route." } },
        })).resolves.toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const progressEvents = (await readFile(
          path.join(context.transportAudit, "gateway-events.jsonl"),
          "utf8",
        )).trim().split("\n").map((line) => JSON.parse(line) as {
          payload: { message: { kind: string; rpc: { method?: string } } };
        }).filter((entry) => entry.payload.message.kind === "rpc-notification"
          && entry.payload.message.rpc.method === "item/agentMessage/delta");
        expect(progressEvents).toHaveLength(1);
      } finally {
        await recoveredClient.close();
      }
    } finally {
      await firstClient.close();
      await worker.stop();
    }
  });

  it("drains an uncertain response from an earlier child before a new initialize response", async () => {
    // A failed lifecycle stage must identify its boundary and clean up rather
    // than consume the whole recovery-test deadline with an unlabelled hang.
    async function stage<T>(name: string, operation: Promise<T>) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Recovery stage stalled: ${name}`)), 5_000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    await writeFile(fakeServer, [
      'import { createInterface } from "node:readline";',
      'const lines = createInterface({ input: process.stdin });',
      'const write = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
      'lines.on("line", (line) => {',
      '  const rpc = JSON.parse(line);',
      '  if (rpc.method) {',
      '    write({ id: rpc.id, result: {} });',
      '    write({ method: "item/commandExecution/requestApproval", id: "approval-1", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 1, environmentId: null, command: "pwd" } });',
      '    return;',
      '  }',
      '  process.exit(42);',
      '});',
    ].join("\n"), { mode: 0o600 });
    const firstWorker = gateway();
    await stage("first worker start", firstWorker.start());
    const firstClient = transport(firstWorker);
    try {
      await stage("first client connect", firstClient.connect());
      await stage("initialize accepted", firstClient.send(initializeRequest()));
      const initialized = await nextEvent(firstClient);
      const approval = await nextEvent(firstClient);
      if (!initialized.done) await firstClient.acknowledge(initialized.value);
      expect(approval.value).toMatchObject({
        message: { kind: "rpc-request", rpc: { id: "approval-1" } },
      });
      if (approval.done) throw new Error("Expected a durable approval event.");
      const uncertain = firstClient.send(approvalResponse(
        `server-response:${approval.value.eventId}:${APPROVAL_SCOPE_DIGEST}`,
      )).then(
        () => null,
        (error: unknown) => error,
      );
      await vi.waitFor(async () => expect((await firstWorker.health()).state).toBe("failed"));
      await firstClient.close();
      expect(await stage("uncertain send settles after close", uncertain)).toBeInstanceOf(Error);

    } finally {
      await firstClient.close();
      await stage("first worker shutdown", firstWorker.stop());
    }

    await writeFile(fakeServer, [
      'import { createInterface } from "node:readline";',
      'const lines = createInterface({ input: process.stdin });',
      'const write = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
      'lines.on("line", (line) => {',
      '  const rpc = JSON.parse(line);',
      '  if (rpc.method) write({ id: rpc.id, result: {} });',
      '  else write({ method: "warning", params: { message: "stale response was dispatched" } });',
      '});',
    ].join("\n"), { mode: 0o600 });
    const restartedWorker = gateway();
    await stage("restarted worker start", restartedWorker.start());
    const restartedClient = transport(restartedWorker);
    const router = new AppServerRpcRouter(restartedClient);
    try {
      await expect(router.request(
        initializeRequest("initialize-after-stale-replay").rpc,
        3_000,
      )).resolves.toEqual({});
      const durableEvents = (await readFile(
        path.join(context.transportAudit, "gateway-events.jsonl"),
        "utf8",
      )).trim().split("\n").map((line) => JSON.parse(line) as {
        payload: { message: { kind: string; rpc: { method?: string } } };
      });
      expect(durableEvents.filter((entry) =>
        entry.payload.message.kind === "rpc-notification"
        && entry.payload.message.rpc.method === "warning"
      )).toHaveLength(0);
      await vi.waitFor(async () => {
        const cursor = JSON.parse(await readFile(
          path.join(context.transportAudit, "test-client-events.jsonl.delivery.json"),
          "utf8",
        )) as { sequence: number };
        expect(cursor.sequence).toBeGreaterThanOrEqual(3);
      }, { timeout: 5_000 });
    } finally {
      await router.close();
      await restartedClient.close();
      await stage("restarted worker shutdown", restartedWorker.stop());
    }
  }, PROCESS_RECOVERY_TEST_TIMEOUT_MS);

  it("does not dispatch a first response to a server request from an earlier App Server", async () => {
    await writeFile(fakeServer, [
      'import { createInterface } from "node:readline";',
      'const lines = createInterface({ input: process.stdin });',
      'const write = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
      'lines.on("line", (line) => {',
      '  const rpc = JSON.parse(line);',
      '  write({ id: rpc.id, result: {} });',
      '  write({ method: "item/commandExecution/requestApproval", id: "approval-1", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 1, environmentId: null, command: "pwd" } });',
      '  setTimeout(() => process.exit(42), 25);',
      '});',
    ].join("\n"), { mode: 0o600 });
    const firstWorker = gateway();
    await firstWorker.start();
    const firstClient = transport(firstWorker);
    await firstClient.connect();
    await firstClient.send(initializeRequest());
    const initialized = await nextEvent(firstClient);
    const approval = await nextEvent(firstClient);
    if (!initialized.done) await firstClient.acknowledge(initialized.value);
    if (approval.done) throw new Error("Expected a durable approval event.");
    expect(approval.value).toMatchObject({
      message: { kind: "rpc-request", rpc: { id: "approval-1" } },
    });
    const responseId = `server-response:${approval.value.eventId}:${APPROVAL_SCOPE_DIGEST}`;
    await vi.waitFor(async () => expect((await firstWorker.health()).state).toBe("failed"));
    await firstClient.close();
    await firstWorker.stop();

    await writeFile(fakeServer, [
      'import { createInterface } from "node:readline";',
      'const lines = createInterface({ input: process.stdin });',
      'const write = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
      'lines.on("line", (line) => {',
      '  const rpc = JSON.parse(line);',
      '  if (rpc.method) write({ id: rpc.id, result: {} });',
      '  else write({ method: "warning", params: { threadId: "thread-1", turnId: "turn-1", message: "response for old request was dispatched" } });',
      '});',
    ].join("\n"), { mode: 0o600 });
    const restartedWorker = gateway();
    await restartedWorker.start();
    const restartedClient = transport(restartedWorker);
    try {
      await restartedClient.connect();
      const replayedApproval = await nextEvent(restartedClient);
      expect(replayedApproval.value).toMatchObject({
        message: { kind: "rpc-request", rpc: { id: "approval-1" } },
      });

      await expect(restartedClient.send(approvalResponse(responseId))).resolves.toBeUndefined();
      if (!replayedApproval.done) await restartedClient.acknowledge(replayedApproval.value);
      await restartedClient.send(initializeRequest("initialize-after-old-request"));
      const next = await nextEvent(restartedClient);
      expect(next.value).toMatchObject({
        message: {
          kind: "rpc-response",
          rpc: { id: "initialize-after-old-request", result: {} },
        },
      });
      const receipt = (await readFile(
        path.join(context.transportAudit, "gateway-requests.jsonl"),
        "utf8",
      )).trim().split("\n").map((line) => JSON.parse(line) as {
        payload: { clientRequestId: string; status: string };
      }).findLast((entry) => entry.payload.clientRequestId === responseId);
      expect(receipt?.payload).toMatchObject({
        clientRequestId: responseId,
        status: "accepted",
      });
    } finally {
      await restartedClient.close();
      await restartedWorker.stop();
    }
  }, PROCESS_RECOVERY_TEST_TIMEOUT_MS);

  it("does not replay the same uncertain server response into a restarted child", async () => {
    await writeFile(fakeServer, [
      'import { createInterface } from "node:readline";',
      'const lines = createInterface({ input: process.stdin });',
      'const write = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
      'lines.on("line", (line) => {',
      '  const rpc = JSON.parse(line);',
      '  if (rpc.method) {',
      '    write({ id: rpc.id, result: {} });',
      '    write({ method: "item/commandExecution/requestApproval", id: "approval-1", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 1, environmentId: null, command: "pwd" } });',
      '  } else process.exit(42);',
      '});',
    ].join("\n"), { mode: 0o600 });
    const firstWorker = gateway();
    await firstWorker.start();
    const firstClient = transport(firstWorker);
    await firstClient.connect();
    await firstClient.send(initializeRequest());
    const initialized = await nextEvent(firstClient);
    const approval = await nextEvent(firstClient);
    if (!initialized.done) await firstClient.acknowledge(initialized.value);
    if (approval.done) throw new Error("Expected a durable approval event.");
    await firstClient.acknowledge(approval.value);
    const responseId = `server-response:${approval.value.eventId}:${APPROVAL_SCOPE_DIGEST}`;
    await vi.waitFor(async () => {
      const cursor = JSON.parse(await readFile(
        path.join(context.transportAudit, "gateway-events.jsonl.delivery.json"),
        "utf8",
      )) as { sequence: number };
      expect(cursor.sequence).toBe(2);
    });
    const firstSubmission = firstClient.send(approvalResponse(responseId)).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(async () => expect((await firstWorker.health()).state).toBe("failed"));
    await firstClient.close();
    expect(await firstSubmission).toBeInstanceOf(Error);
    await firstWorker.stop();

    const compactingGatewayJournal = new FileTransportEventJournal({
      filePath: path.join(context.transportAudit, "gateway-events.jsonl"),
      lockManager: new ResourceLockManager({
        rootDirectory: path.join(context.transportAudit, "gateway-locks"),
      }),
      maxRetainedDeliveredEvents: 1,
    });
    const compactingEvent = {
      eventId: "44444444-4444-4444-8444-444444444444",
      sequence: 3,
      occurredAt: new Date().toISOString(),
      message: {
        kind: "rpc-notification" as const,
        rpc: {
          method: "item/agentMessage/delta" as const,
          params: {
            threadId: "unrelated-thread",
            turnId: "unrelated-turn",
            itemId: "unrelated-item",
            delta: "unrelated progress",
          },
        },
      },
    };
    const compactingClientJournal = new FileTransportEventJournal({
      filePath: path.join(context.transportAudit, "test-client-events.jsonl"),
      lockManager: new ResourceLockManager({
        rootDirectory: path.join(context.transportAudit, "test-client-locks"),
      }),
      maxRetainedDeliveredEvents: 1,
    });
    await compactingGatewayJournal.append(compactingEvent);
    await compactingGatewayJournal.markDelivered(compactingEvent);
    await compactingClientJournal.append(compactingEvent);
    await compactingClientJournal.markDelivered(compactingEvent);
    expect((await compactingGatewayJournal.readEvents()).map((event) => event.sequence)).toEqual([3]);
    expect((await compactingClientJournal.readEvents()).map((event) => event.sequence)).toEqual([3]);

    await writeFile(fakeServer, [
      'import { createInterface } from "node:readline";',
      'const lines = createInterface({ input: process.stdin });',
      'const write = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
      'lines.on("line", (line) => {',
      '  const rpc = JSON.parse(line);',
      '  if (!rpc.method) write({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "recovered approval" } });',
      '  else write({ id: rpc.id, result: {} });',
      '});',
    ].join("\n"), { mode: 0o600 });
    const restartedWorker = gateway();
    await restartedWorker.start();
    const restartedClient = transport(restartedWorker);
    try {
      await restartedClient.connect();
      await expect(restartedClient.send(approvalResponse(responseId))).resolves.toBeUndefined();
      await restartedClient.send(initializeRequest("initialize-after-stale-response"));
      const next = await nextEvent(restartedClient);
      expect(next.value).toMatchObject({
        message: {
          kind: "rpc-response",
          rpc: { id: "initialize-after-stale-response", result: {} },
        },
      });
      const durableEvents = (await readFile(
        path.join(context.transportAudit, "gateway-events.jsonl"),
        "utf8",
      )).trim().split("\n").map((line) => JSON.parse(line) as {
        payload: { message: { kind: string; rpc: { method?: string; params?: { threadId?: string } } } };
      });
      expect(durableEvents.filter((entry) =>
        entry.payload.message.kind === "rpc-notification"
        && entry.payload.message.rpc.method === "item/agentMessage/delta"
        && entry.payload.message.rpc.params?.threadId === "thread-1"
      )).toHaveLength(0);
    } finally {
      await restartedClient.close();
      await restartedWorker.stop();
    }
  }, PROCESS_RECOVERY_TEST_TIMEOUT_MS);
});
