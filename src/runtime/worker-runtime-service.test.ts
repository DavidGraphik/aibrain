import { withColdThreadRecoveryDeadline } from "@/runtime/cold-thread-recovery";
import { validateAppServerRequest } from "@/runtime/transport/wire-protocol";
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { loadInstallationConfig } from "@/config/installation";
import { FileLocalUserStore } from "@/auth/local-user-store";

vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({
  getSigningSecret: () => "test-signing-secret-with-at-least-thirty-two-bytes",
}));
import type {
  AppServerEvent,
  AppServerRequest,
  AppServerTransport,
  JsonValue,
  TransportHealth,
} from "@/runtime/transport";
import { MaintenanceCoordinator } from "@/operations/maintenance";
import {
  registerWorkerTurnCancellation,
  requestPendingWorkerTurnCancellation,
  WorkerAppServerClient,
  configuredWorkerTransport,
  workerAppServerForUser,
  workerExistingMetadataRequest,
  stopWorkerRuntimeForUser,
} from "@/runtime/worker-runtime-service";
import type { WorkerRuntimeHandle, WorkerRoots } from "@/runtime/workers/types";
import { WeeklyTokenBudgetStore } from "@/usage/weekly-token-budget";
import { RuntimeProjectionAdmissionDeferred } from "@/runtime/transport/projection-readiness";

it("selects direct stdio by default and requires an explicit valid compatibility mode", () => {
  expect(configuredWorkerTransport({})).toBe("stdio");
  expect(configuredWorkerTransport({ AIBRAIN_CODEX_TRANSPORT: "gateway" })).toBe("gateway");
  expect(configuredWorkerTransport({ AIBRAIN_CODEX_TRANSPORT: "stdio" })).toBe("stdio");
  expect(() => configuredWorkerTransport({ AIBRAIN_CODEX_TRANSPORT: "websocket" })).toThrow();
});

class AsyncEvents implements AsyncIterable<AppServerEvent> {
  private values: AppServerEvent[] = [];
  private waiters: Array<(value: IteratorResult<AppServerEvent>) => void> = [];

  push(value: AppServerEvent) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  [Symbol.asyncIterator](): AsyncIterator<AppServerEvent> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { done: false, value };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

class FakeTransport implements AppServerTransport {
  readonly sent: AppServerRequest[] = [];
  readonly stream = new AsyncEvents();
  sequence = 0;
  private readonly blockedMethods = new Map<string, Promise<void>>();

  constructor(
    private readonly alreadyInitialized = false,
    private readonly accountResults: JsonValue[] = [],
    private readonly rejectProactiveRefresh = false,
  ) {}

  block(method: string) {
    let release!: () => void;
    this.blockedMethods.set(method, new Promise<void>((resolve) => { release = resolve; }));
    return () => {
      this.blockedMethods.delete(method);
      release();
    };
  }

  async connect() {}

  async send(message: AppServerRequest) {
    this.sent.push(message);
    if (message.kind !== "rpc-request") return;
    const blocker = this.blockedMethods.get(message.rpc.method);
    if (blocker) await blocker;
    if (message.rpc.method === "initialize" && this.alreadyInitialized) {
      this.sequence += 1;
      this.stream.push({
        eventId: `event-${this.sequence}`,
        sequence: this.sequence,
        occurredAt: new Date().toISOString(),
        message: {
          kind: "rpc-response",
          rpc: { id: message.rpc.id, error: { code: -32600, message: "Already initialized" } },
        },
      });
      return;
    }
    const result = (() => {
      switch (message.rpc.method) {
        case "initialize": return { userAgent: "codex-test" };
        case "account/read":
          if (this.rejectProactiveRefresh && (message.rpc.params as { refreshToken?: boolean })?.refreshToken) return { account: null, requiresOpenaiAuth: true };
          return this.accountResults.shift()
          ?? { account: { type: "chatgpt", planType: "team" } };
        case "model/list": return {
          data: [{
            model: "gpt-test",
            displayName: "GPT Test",
            isDefault: true,
            inputModalities: ["text", "image"],
            supportedReasoningEfforts: [],
          }],
        };
        case "skills/list": return { data: [] };
        case "modelProvider/capabilities/read": return { webSearch: true, imageGeneration: false };
        case "account/rateLimits/read": return { rateLimits: { primary: { usedPercent: 12 } } };
        case "account/usage/read": return { summary: { lifetimeTokens: 42 } };
        case "thread/start":
        case "thread/resume": return { thread: { id: "runtime-thread-1", turns: [] } };
        default: return {};
      }
    })() as JsonValue;
    this.sequence += 1;
    this.stream.push({
      eventId: `event-${this.sequence}`,
      sequence: this.sequence,
      occurredAt: new Date().toISOString(),
      message: { kind: "rpc-response", rpc: { id: message.rpc.id, result } },
    });
  }

  events() { return this.stream; }
  async acknowledge() {}
  async health(): Promise<TransportHealth> {
    return {
      healthy: true,
      state: "connected",
      endpoint: "ws://127.0.0.1:1/app-server",
      reconnectAttempt: 0,
      pendingRequests: 0,
      lastEventId: null,
      lastEventSequence: null,
      lastConnectedAt: null,
      lastMessageAt: null,
      lastHeartbeatAt: null,
      lastError: null,
    };
  }
  async close() {}
}

function handle(transport: AppServerTransport): WorkerRuntimeHandle {
  const roots = Object.fromEntries([
    "userRoot", "runtimeRoot", "codexHome", "home", "xdgRoot", "xdgCache",
    "xdgConfig", "xdgData", "xdgState", "workspace", "staging", "stagingTemp",
    "artifacts", "browserRoot", "browserProfile", "browserDownloads", "auditRoot",
    "transportAudit", "manifest",
  ].map((key) => [key, `/private/${key}`])) as WorkerRoots;
  return Object.freeze({
    installationId: "qa-company",
    userId: "00000000-0000-4000-8000-000000000001",
    workerId: "worker-00000000-0000-4000-8000-000000000001",
    roots,
    transport,
  });
}

describe("worker App Server client", () => {
  it("keeps the initialized client draining across projection deferrals without model dispatch or restart", async () => {
    const transport = Object.assign(new FakeTransport(), {
      deliverySequenceStart: () => 1, projectionSequenceTarget: () => 1,
    });
    transport.sequence = 1;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {release=resolve;});
    const acked: number[]=[];
    transport.acknowledge = async (event?: AppServerEvent) => {
      if(event?.sequence === 1) await blocked;
      if(event) acked.push(event.sequence);
    };
    const close = vi.spyOn(transport,"close");
    transport.stream.push({eventId:"history-1",sequence:1,occurredAt:"2026-10-28T00:00:00.000Z",
      message:{kind:"rpc-notification",rpc:{method:"warning",params:{threadId:null,message:"retained"}}}});
    const client = new WorkerAppServerClient(handle(transport));
    await client.initialize();
    for(let retry=0;retry<2;retry++) await expect(client.assertProjectionReady()).rejects.toBeInstanceOf(RuntimeProjectionAdmissionDeferred);
    expect(transport.sent.filter(event=>event.kind === "rpc-request" && event.rpc.method === "initialize")).toHaveLength(1);
    expect(transport.sent.some(event=>event.kind === "rpc-request" && event.rpc.method === "turn/start")).toBe(false);
    expect(close).not.toHaveBeenCalled();
    release();
    await vi.waitFor(()=>expect(acked).toEqual([1,2,3]));
    await expect(client.assertProjectionReady()).resolves.toBeUndefined();
    await client.request("turn/start",{threadId:"synthetic"},"one-turn");
    expect(transport.sent.filter(event=>event.kind === "rpc-request" && event.rpc.method === "turn/start")).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
    await client.close();
  });
  it("metadata reads never initialize a cold client or admit non-read methods", async () => {
    const transport = new FakeTransport();
    const client = new WorkerAppServerClient(handle(transport));
    const initialize = vi.spyOn(client, "initialize");
    try {
      await expect(client.requestExistingMetadata("thread/read", {threadId:"thread"}, "queue-cold")).rejects.toThrow("unavailable");
      await expect(client.requestExistingMetadata("turn/interrupt", {threadId:"thread",turnId:"turn"}, "queue-forbidden")).rejects.toThrow("unavailable");
      expect(initialize).not.toHaveBeenCalled();
      expect(transport.sent).toEqual([]);
    } finally { initialize.mockRestore(); await client.close(); }
  });

  it.each([false, true])("queue metadata reads never restart or close an existing worker on read failure: %s", async (readFails) => {
    const config = await loadInstallationConfig();
    const globals = globalThis as typeof globalThis & { __aibrainWorkerRuntimeService?: unknown };
    const previous = globals.__aibrainWorkerRuntimeService;
    const transport = new FakeTransport();
    const existingHandle = handle(transport);
    const client = new WorkerAppServerClient(existingHandle);
    await client.initialize();
    const registry = {get:vi.fn(()=>existingHandle),start:vi.fn(),stop:vi.fn(),close:vi.fn()};
    globals.__aibrainWorkerRuntimeService = {config,registry,clients:new Map([[existingHandle.userId,client]])};
    const read = vi.spyOn(FileLocalUserStore.prototype,"read").mockResolvedValue({enabled:true} as Awaited<ReturnType<FileLocalUserStore["read"]>>);
    const initialize = vi.spyOn(client,"initialize").mockRejectedValue(new Error("must never initialize"));
    const close = vi.spyOn(client,"close");
    const request = vi.spyOn(client.router,"request");
    if(readFails) request.mockRejectedValueOnce(new Error("metadata unavailable"));
    else request.mockResolvedValueOnce({thread:{id:"thread"}});
    try {
      const result=workerExistingMetadataRequest(existingHandle.userId,"thread/read",{threadId:"thread",includeTurns:false},"queue-read");
      if(readFails) await expect(result).rejects.toThrow("metadata unavailable");
      else await expect(result).resolves.toEqual({thread:{id:"thread"}});
      expect(initialize).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
      expect(registry.start).not.toHaveBeenCalled();expect(registry.stop).not.toHaveBeenCalled();expect(registry.close).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][0]).toMatchObject({method:"thread/read",params:{threadId:"thread",includeTurns:false}});
    } finally {read.mockRestore();initialize.mockRestore();close.mockRestore();request.mockRestore();globals.__aibrainWorkerRuntimeService=previous;await client.close();}
  });

  it("does not initialize the service when no cached metadata client exists", async () => {
    const globals = globalThis as typeof globalThis & { __aibrainWorkerRuntimeService?: unknown };
    const previous = globals.__aibrainWorkerRuntimeService;
    delete globals.__aibrainWorkerRuntimeService;
    try { await expect(workerExistingMetadataRequest("00000000-0000-4000-8000-000000000001","thread/read",{threadId:"thread"},"queue-cold")).rejects.toThrow("unavailable");
      expect(globals.__aibrainWorkerRuntimeService).toBeUndefined();
    } finally { globals.__aibrainWorkerRuntimeService=previous; }
  });

  it("looks up the exact original creation without dispatch, including after client restart", async () => {
    const transport = new FakeTransport();
    const params = { cwd: "/private/workspace", ephemeral: false };
    const purpose = "thread-start:00000000-0000-4000-8000-000000000041";
    const recoverResponse = vi.fn(async (request: AppServerRequest) => ({ id: request.clientRequestId,
      result: { thread: { id: "original-thread", turns: [] } } }));
    for (let restart = 0; restart < 2; restart += 1) {
      const boundTransport = Object.assign(restart ? new FakeTransport() : transport, { recoverResponse });
      const client = new WorkerAppServerClient(handle(boundTransport));
      expect(await client.recoverThreadStart(params, purpose)).toEqual({ thread: { id: "original-thread", turns: [] } });
      expect(client.canReuseLoadedThread("original-thread", true)).toBe(false);
      await client.router.close();
    }
    expect(recoverResponse).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(recoverResponse.mock.calls[0][0])).toBe(JSON.stringify({
      clientRequestId: purpose, kind: "rpc-request", rpc: { method: "thread/start", id: purpose, params },
    }));
    expect(transport.sent.some(request => request.kind === "rpc-request" && request.rpc.method === "thread/start")).toBe(false);
  });

  it("recovers a completed thread creation rejection with exact RPC provenance and no new creation", async () => {
    const transport = new FakeTransport();
    const purpose = "thread-start:00000000-0000-4000-8000-000000000041";
    const message = "Invalid request: unknown variant ``\nin apps._default.approvals_reviewer";
    const recoverResponse = vi.fn(async () => ({ id: purpose, error: { code: -32600, message } }));
    const client = new WorkerAppServerClient(handle(Object.assign(transport, { recoverResponse })));
    await expect(client.recoverThreadStart({}, purpose)).rejects.toMatchObject({ name: "AppServerRpcResponseError", method: "thread/start", requestId: purpose, code: -32600, message });
    expect(transport.sent.some(request => request.kind === "rpc-request" && request.rpc.method === "thread/start")).toBe(false);
    await client.router.close();
  });

  it("never dispatches when the recovery receipt is missing or mismatched", async () => {
    const transport = new FakeTransport();
    const recoverResponse = vi.fn(async (): Promise<{ id: string; result: JsonValue } | null> => null);
    const client = new WorkerAppServerClient(handle(Object.assign(transport, { recoverResponse })));
    const purpose = "thread-start:00000000-0000-4000-8000-000000000041";
    expect(await client.recoverThreadStart({}, purpose)).toBeNull();
    recoverResponse.mockResolvedValue({ id: "another-users-request", result: {} });
    await expect(client.recoverThreadStart({}, purpose)).rejects.toThrow("identity changed");
    expect(transport.sent.some(request => request.kind === "rpc-request" && request.rpc.method === "thread/start")).toBe(false);
    await client.router.close();
  });

  it("blocks both inference entry points while preserving read, stop and recovery requests", async () => {
    const config = await loadInstallationConfig();
    const transport = new FakeTransport();
    const client = new WorkerAppServerClient(handle(transport), null, {
      ...config, usageLimits: { weeklyTokens: 7_500_000, timeZone: "Europe/Madrid" },
    });
    const unavailable = vi.spyOn(WeeklyTokenBudgetStore.prototype, "assertAvailable").mockRejectedValue(
      Object.assign(new Error("Weekly limit reached"), { code: "WEEKLY_TOKEN_BUDGET_EXHAUSTED" }),
    );
    try {
      await expect(client.request("turn/start", { threadId: "thread", input: [] }, "start"))
        .rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_EXHAUSTED" });
      await expect(client.request("turn/steer", { threadId: "thread", expectedTurnId: "turn", input: [] }, "steer"))
        .rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_EXHAUSTED" });
      await expect(client.request("turn/interrupt", { threadId: "thread", turnId: "turn" }, "stop")).resolves.toEqual({});
      await expect(client.request("thread/read", { threadId: "thread", includeTurns: true }, "recover")).resolves.toEqual({});
      expect(unavailable).toHaveBeenCalledTimes(2);
      expect(transport.sent.filter((message) => message.kind === "rpc-request" &&
        (message.rpc.method === "turn/start" || message.rpc.method === "turn/steer"))).toHaveLength(0);
    } finally { unavailable.mockRestore(); await client.close(); }
  });

  it.each([false, true])("coalesces concurrent failed initialization and cleans a failed retry (%s)", async (retryFails) => {
    const config = await loadInstallationConfig();
    const fingerprint = createHash("sha256").update(JSON.stringify({
      schemaVersion: config.schemaVersion,
      installationId: config.installationId,
      usersRoot: config.paths.usersRoot,
      companyContextRoot: config.paths.companyContextRoot,
      sourceReadRoot: config.paths.sourceReadRoot,
      publishWriteRoot: config.paths.publishWriteRoot,
    })).digest("hex");
    const globals = globalThis as typeof globalThis & { __aibrainWorkerRuntimeService?: unknown };
    const previous = globals.__aibrainWorkerRuntimeService;
    const first = handle(new FakeTransport());
    const second = handle(new FakeTransport());
    const registry = {
      get: vi.fn(() => first),
      start: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second),
      stop: vi.fn().mockResolvedValue(true),
    };
    const clients = new Map();
    const admissions = new Map();
    globals.__aibrainWorkerRuntimeService = {
      fingerprint, config, registry, clients, clientAdmissions: admissions,
      maintenance: new MaintenanceCoordinator(), activeTurnCancellations: new Map(),
    };
    const userRead = vi.spyOn(FileLocalUserStore.prototype, "read").mockResolvedValue(
      { enabled: true } as Awaited<ReturnType<FileLocalUserStore["read"]>>,
    );
    let failInitial!: (error: Error) => void;
    const initial = new Promise<void>((_resolve, reject) => { failInitial = reject; });
    const initialize = vi.spyOn(WorkerAppServerClient.prototype, "initialize")
      .mockImplementationOnce(() => initial);
    if (retryFails) initialize.mockRejectedValue(new Error("fixture retry failed"));
    else initialize.mockResolvedValue(undefined);
    const close = vi.spyOn(WorkerAppServerClient.prototype, "close").mockResolvedValue(undefined);
    try {
      const pending = Promise.allSettled([
        workerAppServerForUser(first.userId), workerAppServerForUser(first.userId),
        workerAppServerForUser(first.userId),
      ]);
      await vi.waitFor(() => expect(userRead).toHaveBeenCalledTimes(3));
      failInitial(new Error("fixture initialization failed"));
      const results = await pending;
      expect(initialize).toHaveBeenCalledTimes(2);
      expect(registry.start).toHaveBeenCalledTimes(2);
      expect(registry.stop).toHaveBeenCalledTimes(retryFails ? 2 : 1);
      expect(close).toHaveBeenCalledTimes(retryFails ? 2 : 1);
      expect(results.map(({ status }) => status)).toEqual(Array(3).fill(retryFails ? "rejected" : "fulfilled"));
      if (!retryFails) {
        const values = results.filter((result) => result.status === "fulfilled").map((result) => result.value.client);
        expect(new Set(values).size).toBe(1);
      }
      expect(clients.size).toBe(retryFails ? 0 : 1);
      expect(admissions.size).toBe(0);
    } finally {
      globals.__aibrainWorkerRuntimeService = previous;
      userRead.mockRestore(); initialize.mockRestore(); close.mockRestore();
    }
  });

  it("does not publish a replacement service while its previous registry cannot clean up", async () => {
    const globals = globalThis as typeof globalThis & { __aibrainWorkerRuntimeService?: unknown };
    const previous = globals.__aibrainWorkerRuntimeService;
    const close = vi.fn().mockRejectedValue(new Error("owned process still alive"));
    const old = { fingerprint: "different-configuration", clients: new Map(), registry: { close } };
    globals.__aibrainWorkerRuntimeService = old;
    try {
      await expect(workerAppServerForUser("00000000-0000-4000-8000-000000000001")).rejects.toThrow("owned process still alive");
      expect(globals.__aibrainWorkerRuntimeService).toBe(old);
      await expect(workerAppServerForUser("00000000-0000-4000-8000-000000000001")).rejects.toThrow("owned process still alive");
      expect(close).toHaveBeenCalledTimes(2);
    } finally { globals.__aibrainWorkerRuntimeService = previous; }
  });

  it.each([false, true])("does not recover an admission invalidated by stopping its user (initialize fails: %s)", async (initializeFails) => {
    const config = await loadInstallationConfig();
    const fingerprint = createHash("sha256").update(JSON.stringify({ schemaVersion: config.schemaVersion, installationId: config.installationId, usersRoot: config.paths.usersRoot, companyContextRoot: config.paths.companyContextRoot, sourceReadRoot: config.paths.sourceReadRoot, publishWriteRoot: config.paths.publishWriteRoot })).digest("hex");
    const globals = globalThis as typeof globalThis & { __aibrainWorkerRuntimeService?: unknown };
    const previous = globals.__aibrainWorkerRuntimeService;
    const first = handle(new FakeTransport());
    const otherId = "00000000-0000-4000-8000-000000000002";
    const otherClose = vi.fn();
    const registry = { get: vi.fn(() => first), start: vi.fn().mockResolvedValue(first), stop: vi.fn().mockResolvedValue(true) };
    const clients = new Map<string, unknown>([[otherId, { close: otherClose }]]);
    globals.__aibrainWorkerRuntimeService = { fingerprint, config, registry, clients, clientAdmissions: new Map(), maintenance: new MaintenanceCoordinator(), activeTurnCancellations: new Map() };
    let settleInitialize!: () => void;
    const initialize = vi.spyOn(WorkerAppServerClient.prototype, "initialize").mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      settleInitialize = () => initializeFails ? reject(new Error("initialization interrupted")) : resolve();
    })).mockResolvedValue(undefined);
    const close = vi.spyOn(WorkerAppServerClient.prototype, "close").mockResolvedValue(undefined);
    const read = vi.spyOn(FileLocalUserStore.prototype, "read").mockResolvedValue({ enabled: true } as Awaited<ReturnType<FileLocalUserStore["read"]>>);
    try {
      const admission = workerAppServerForUser(first.userId).catch((error: unknown) => error);
      await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
      const stopping = stopWorkerRuntimeForUser(first.userId);
      settleInitialize();
      await stopping;
      expect(await admission).toBeInstanceOf(Error);
      expect(registry.start).toHaveBeenCalledTimes(1);
      expect(clients.has(first.userId)).toBe(false);
      expect(otherClose).not.toHaveBeenCalled();
      expect(registry.stop).toHaveBeenCalledWith(first.userId);
      await workerAppServerForUser(first.userId); // a later explicit admission is a new generation
      expect(registry.start).toHaveBeenCalledTimes(2);
      await stopWorkerRuntimeForUser(first.userId);
    } finally { read.mockRestore(); initialize.mockRestore(); close.mockRestore(); globals.__aibrainWorkerRuntimeService = previous; }
  });

  it("admits another same-user request while optional metadata is still blocked", async () => {
    const transport = new FakeTransport();
    const client = new WorkerAppServerClient(handle(transport));
    const release = transport.block("model/list");
    const catalog = client.connection("/private/workspace/project-one");
    try {
      await vi.waitFor(() => expect(transport.sent.some((item) => item.kind === "rpc-request" && item.rpc.method === "model/list")).toBe(true));
      await expect(client.request("thread/start", { config: { web_search: "live" } }, "other-chat:start", 500))
        .resolves.toMatchObject({ thread: { id: "runtime-thread-1" } });
      await expect(client.connectionSummary()).resolves.toMatchObject({ connected: true });
    } finally {
      release(); await catalog; await client.close();
    }
  });

  it("carries an immediate stop intent into the worker once its App Server thread is registered", () => {
    const runtimeGlobals = globalThis as typeof globalThis & {
      __aibrainWorkerRuntimeService?: unknown;
      __aibrainPendingWorkerTurnCancellations?: Map<string, number>;
    };
    const previousService = runtimeGlobals.__aibrainWorkerRuntimeService;
    const previousPending = runtimeGlobals.__aibrainPendingWorkerTurnCancellations;
    delete runtimeGlobals.__aibrainWorkerRuntimeService;
    runtimeGlobals.__aibrainPendingWorkerTurnCancellations = new Map();
    const userId = "00000000-0000-4000-8000-000000000001";
    const localTurnId = "00000000-0000-4000-8000-000000000041";

    try {
      expect(requestPendingWorkerTurnCancellation(userId, localTurnId)).toBe(true);
      runtimeGlobals.__aibrainWorkerRuntimeService = {
        clients: new Map([[userId, {}]]),
        activeTurnCancellations: new Map(),
      };
      const cancel = vi.fn();
      registerWorkerTurnCancellation(userId, "runtime-thread-1", localTurnId, cancel);
      expect(cancel).toHaveBeenCalledWith(false);
    } finally {
      if (previousService === undefined) delete runtimeGlobals.__aibrainWorkerRuntimeService;
      else runtimeGlobals.__aibrainWorkerRuntimeService = previousService;
      if (previousPending === undefined) delete runtimeGlobals.__aibrainPendingWorkerTurnCancellations;
      else runtimeGlobals.__aibrainPendingWorkerTurnCancellations = previousPending;
    }
  });

  it.each([false,true])("routes a real pending Stop to cold metadata admission without an outer HTTP abort (beforeRegistration=%s)",async beforeRegistration=>{
    const globals=globalThis as typeof globalThis & {__aibrainWorkerRuntimeService?:unknown;__aibrainPendingWorkerTurnCancellations?:Map<string,number>};
    const previous=globals.__aibrainWorkerRuntimeService,previousPending=globals.__aibrainPendingWorkerTurnCancellations;
    const user="00000000-0000-4000-8000-000000000001",turn="00000000-0000-4000-8000-000000000041";
    const controller=new AbortController(),bootstrap=vi.fn(),dispatch=vi.fn();let unregister=()=>{};
    try {
      globals.__aibrainWorkerRuntimeService={clients:new Map([[user,{}]]),activeTurnCancellations:new Map()};globals.__aibrainPendingWorkerTurnCancellations=new Map();
      if(beforeRegistration)expect(requestPendingWorkerTurnCancellation(user,turn)).toBe(true);
      unregister=registerWorkerTurnCancellation(user,"old-native-thread",turn,()=>controller.abort());
      const result=withColdThreadRecoveryDeadline(async()=>{await new Promise(()=>{});bootstrap();dispatch();},()=>{},90_000,controller.signal);
      const rejected=expect(result).rejects.toMatchObject({name:"AbortError"});
      if(!beforeRegistration)expect(requestPendingWorkerTurnCancellation(user,turn)).toBe(true);
      await rejected;expect(bootstrap).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
    } finally {unregister();if(previous===undefined)delete globals.__aibrainWorkerRuntimeService;else globals.__aibrainWorkerRuntimeService=previous;if(previousPending===undefined)delete globals.__aibrainPendingWorkerTurnCancellations;else globals.__aibrainPendingWorkerTurnCancellations=previousPending;}
  });

  it("initializes exactly once and reads the catalog over the scoped transport", async () => {
    const transport = new FakeTransport();
    const client = new WorkerAppServerClient(handle(transport));
    await Promise.all([client.initialize(), client.initialize(), client.initialize()]);
    const connection = await client.connection("/private/workspace/projects/example");

    expect(transport.sent.filter((item) =>
      item.kind === "rpc-request" && item.rpc.method === "initialize")).toHaveLength(1);
    expect(transport.sent.find((item) =>
      item.kind === "rpc-request" && item.rpc.method === "initialize")).toMatchObject({
      rpc: {
        params: {
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
      },
    });
    expect(transport.sent.filter((item) =>
      item.kind === "rpc-notification" && item.rpc.method === "initialized")).toHaveLength(1);
    expect(connection).toMatchObject({
      connected: true,
      planType: "team",
      processWarm: true,
      webSearch: true,
      imageGeneration: false,
      models: [{ id: "gpt-test", isDefault: true }],
    });
    await client.close();
  });

  it("keeps a valid account connected when proactive renewal would reject a reused refresh token", async () => {
    const transport = new FakeTransport(false, [], true);
    const client = new WorkerAppServerClient(handle(transport));
    await expect(client.connectionSummary()).resolves.toMatchObject({ connected: true });
    await expect(client.connectionSummary()).resolves.toMatchObject({ connected: true });
    const reads = transport.sent.filter((item) => item.kind === "rpc-request" && item.rpc.method === "account/read");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ rpc: { params: { refreshToken: false } } });
    await client.close();
  });

  it("sends parameterless usage reads through the strict JSON contract", async () => {
    const transport = new FakeTransport();
    const client = new WorkerAppServerClient(handle(transport));
    await client.connection("/private/test-workspace");
    const reads = transport.sent.filter(r => r.kind === "rpc-request" && ["account/rateLimits/read", "account/usage/read"].includes(r.rpc.method));
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(() => validateAppServerRequest(read)).not.toThrow();
      expect(Object.hasOwn(read.rpc, "params")).toBe(false);
    }
    await client.close();
  });

  it("reports the verified account without waiting for the optional catalog", async () => {
    const transport = new FakeTransport();
    const client = new WorkerAppServerClient(handle(transport));

    await expect(client.connectionSummary()).resolves.toMatchObject({
      connected: true,
      planType: "team",
      processWarm: true,
      models: [],
      skills: [],
    });
    expect(transport.sent.filter((item) =>
      item.kind === "rpc-request" && [
        "model/list",
        "skills/list",
        "modelProvider/capabilities/read",
        "account/rateLimits/read",
        "account/usage/read",
      ].includes(item.rpc.method),
    )).toHaveLength(0);
    await client.close();
  });

  it("rechecks one transiently missing cold-start account without relogin", async () => {
    const transport = new FakeTransport(false, [
      { account: null },
      { account: { type: "chatgpt", planType: "team" } },
    ]);
    const client = new WorkerAppServerClient(handle(transport));

    await expect(client.connectionSummary()).resolves.toMatchObject({
      connected: true,
      authMode: "chatgpt",
      planType: "team",
    });
    expect(transport.sent.filter((item) =>
      item.kind === "rpc-request" && item.rpc.method === "account/read",
    )).toHaveLength(2);
    expect(transport.sent.filter((item) =>
      item.kind === "rpc-request" && item.rpc.method === "account/read",
    ).map((item) => item.kind === "rpc-request" ? item.rpc.params : null)).toEqual([
      { refreshToken: false },
      { refreshToken: false },
    ]);
    await client.close();
  });

  it("coalesces concurrent cold-start account summaries onto the bounded recheck", async () => {
    const transport = new FakeTransport(false, [
      { account: null },
      { account: { type: "chatgpt", planType: "team" } },
    ]);
    const client = new WorkerAppServerClient(handle(transport));
    await client.initialize();
    const release = transport.block("account/read");
    const first = client.connectionSummary();
    await vi.waitFor(() => expect(transport.sent.filter((item) =>
      item.kind === "rpc-request" && item.rpc.method === "account/read",
    )).toHaveLength(2));
    const second = client.connectionSummary();
    let secondSettled = false;
    void second.finally(() => { secondSettled = true; });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ connected: true, authMode: "chatgpt" }),
      expect.objectContaining({ connected: true, authMode: "chatgpt" }),
    ]);
    expect(transport.sent.filter((item) =>
      item.kind === "rpc-request" && item.rpc.method === "account/read",
    )).toHaveLength(2);
    await client.close();
  });

  it("fails closed during cooldown and recovers a later provider reconnect without restarting", async () => {
    const clock = vi.spyOn(Date, "now");
    let now = 10_000;
    clock.mockImplementation(() => now);
    const transport = new FakeTransport(false, [
      { account: null },
      { account: null },
      { account: { type: "chatgpt", planType: "team" } },
    ]);
    const client = new WorkerAppServerClient(handle(transport));
    const reads = () => transport.sent.filter((item) =>
      item.kind === "rpc-request" && item.rpc.method === "account/read");
    try {
      await expect(client.connectionSummary()).resolves.toMatchObject({ connected: false });
      now += 4_999;
      await expect(client.connectionSummary()).resolves.toMatchObject({ connected: false });
      expect(reads()).toHaveLength(2);
      now += 1;
      const release = transport.block("account/read");
      const first = client.connectionSummary();
      await vi.waitFor(() => expect(reads()).toHaveLength(3));
      const second = client.connectionSummary();
      release();
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ connected: true }),
        expect.objectContaining({ connected: true }),
      ]);
      now += 10_000;
      await expect(client.connectionSummary()).resolves.toMatchObject({ connected: true });
      expect(reads()).toHaveLength(3);
      expect(reads().every((item) => item.kind === "rpc-request"
        && (item.rpc.params as { refreshToken: boolean }).refreshToken === false)).toBe(true);
    } finally {
      clock.mockRestore();
      await client.close();
    }
  });

  it("bounds a failed account read and retries after the cooldown", async () => {
    const transport = new FakeTransport(false, [{ account: null }]);
    const client = new WorkerAppServerClient(handle(transport));
    await client.initialize();
    let now = 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const request = vi.spyOn(client.router, "request").mockRejectedValueOnce(new Error("Provider temporarily unavailable"));
    try {
      await expect(client.connectionSummary()).rejects.toThrow("Provider temporarily unavailable");
      now += 4_999;
      await expect(client.connectionSummary()).resolves.toMatchObject({ connected: false });
      expect(request).toHaveBeenCalledTimes(1);
      now += 1;
      await expect(client.connectionSummary()).resolves.toMatchObject({ connected: true });
      expect(request).toHaveBeenCalledTimes(2);
      for (const [rpc] of request.mock.calls) {
        expect(rpc).toMatchObject({ method: "account/read", params: { refreshToken: false } });
      }
    } finally {
      request.mockRestore();
      clock.mockRestore();
      await client.close();
    }
  });

  it("invalidates a fresh disconnected catalog when the account reconnects", async () => {
    let now = 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const transport = new FakeTransport(false, [
      { account: null },
      { account: null },
      { account: { type: "chatgpt", planType: "team" } },
    ]);
    const client = new WorkerAppServerClient(handle(transport));
    const workspace = "/private/workspace/projects/reconnected";
    try {
      await expect(client.connection(workspace)).resolves.toMatchObject({ connected: false });
      await expect(client.connectionSummary()).resolves.toMatchObject({ connected: false });
      now += 5_000;
      await expect(client.connectionSummary()).resolves.toMatchObject({ connected: true });
      await expect(client.connection(workspace)).resolves.toMatchObject({ connected: true, planType: "team" });
      expect(transport.sent.filter((item) => item.kind === "rpc-request"
        && item.rpc.method === "model/list")).toHaveLength(2);
    } finally {
      clock.mockRestore();
      await client.close();
    }
  });

  it("prewarms the catalog so the first turn can reuse it without more RPCs", async () => {
    const transport = new FakeTransport();
    const client = new WorkerAppServerClient(handle(transport));
    const workspace = "/private/workspace/projects/example";

    await client.connectionSummary();
    client.prewarmConnection(workspace);
    await vi.waitFor(() => {
      expect(transport.sent.filter((item) =>
        item.kind === "rpc-request" && item.rpc.method === "model/list",
      )).toHaveLength(1);
    });
    await client.connection(workspace);

    expect(transport.sent.filter((item) =>
      item.kind === "rpc-request" && [
        "model/list",
        "skills/list",
        "account/rateLimits/read",
        "account/usage/read",
      ].includes(item.rpc.method),
    )).toHaveLength(4);
    await client.close();
  });

  it("reuses only threads loaded by this App Server client with matching web configuration", async () => {
    const client = new WorkerAppServerClient(handle(new FakeTransport()));

    expect(client.canReuseLoadedThread("runtime-thread-1", false)).toBe(false);
    await client.request("thread/start", {
      config: { web_search: "disabled" },
    }, "thread-start:test");
    expect(client.canReuseLoadedThread("runtime-thread-1", false)).toBe(true);
    expect(client.canReuseLoadedThread("runtime-thread-1", true)).toBe(false);

    await client.request("thread/resume", {
      threadId: "runtime-thread-1",
      config: { web_search: "live" },
    }, "thread-resume:test");
    expect(client.canReuseLoadedThread("runtime-thread-1", true)).toBe(true);
    await client.close();
  });

  it("serves a stale catalog immediately while refreshing it in the background", async () => {
    let now = 1_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const transport = new FakeTransport();
    const client = new WorkerAppServerClient(handle(transport));
    const workspace = "/private/workspace/projects/example";

    try {
      const initial = await client.connection(workspace);
      now += 6 * 60_000;
      const releaseModelRefresh = transport.block("model/list");

      await expect(client.connection(workspace)).resolves.toBe(initial);
      expect(transport.sent.filter((item) =>
        item.kind === "rpc-request" && item.rpc.method === "model/list",
      )).toHaveLength(2);

      releaseModelRefresh();
      await client.connection(workspace, true);
    } finally {
      dateNow.mockRestore();
      await client.close();
    }
  });

  it("reads the live web-search capability without loading the full catalog", async () => {
    const transport = new FakeTransport();
    const client = new WorkerAppServerClient(handle(transport));

    await expect(client.capabilities()).resolves.toEqual({
      webSearch: true,
      imageGeneration: false,
    });
    expect(transport.sent.filter((item) =>
      item.kind === "rpc-request" && item.rpc.method === "modelProvider/capabilities/read",
    )).toHaveLength(1);
    expect(transport.sent.some((item) =>
      item.kind === "rpc-request" && [
        "model/list",
        "skills/list",
        "account/rateLimits/read",
        "account/usage/read",
      ].includes(item.rpc.method),
    )).toBe(false);
    await client.close();
  });

  it("reuses a persistent App Server that was initialized by an earlier client", async () => {
    const transport = new FakeTransport(true);
    const client = new WorkerAppServerClient(handle(transport));

    await expect(client.connectionSummary()).resolves.toMatchObject({
      connected: true,
      planType: "team",
      processWarm: true,
    });
    expect(transport.sent.filter((item) =>
      item.kind === "rpc-notification" && item.rpc.method === "initialized")).toHaveLength(0);
    expect(transport.sent.some((item) =>
      item.kind === "rpc-request" && item.rpc.method === "account/read")).toBe(true);
    await client.close();
  });

  it("requires an admitted maintenance lease before sending turn/start to the gateway", async () => {
    const transport = new FakeTransport();
    const maintenance = new MaintenanceCoordinator();
    const client = new WorkerAppServerClient(handle(transport), maintenance);

    await expect(client.request("turn/start", {}, "turn-without-lease"))
      .rejects.toMatchObject({ code: "MAINTENANCE_ACTIVE" });
    expect(transport.sent).toEqual([]);

    const lease = maintenance.acquire("turn");
    const draining = maintenance.enter({ timeoutMs: 1_000 });
    await expect(client.request("turn/start", {}, "turn-with-lease", 1_000, undefined, lease))
      .resolves.toEqual({});
    expect(transport.sent.some((message) =>
      message.kind === "rpc-request" && message.rpc.method === "turn/start")).toBe(true);

    lease.release();
    await expect(draining).resolves.toMatchObject({ phase: "maintenance", activeActivities: 0 });
    await client.close();
  });
});


it("invalidates loaded-thread reuse when unsubscribe is sent, including an uncertain response",async()=>{
 const client=new WorkerAppServerClient(handle(new FakeTransport()));
 try{
  await client.request("thread/start",{config:{web_search:"live"}},"writer-start");expect(client.canReuseLoadedThread("runtime-thread-1",true)).toBe(true);
  const request=vi.spyOn(client.router,"request").mockRejectedValueOnce(Error("Unsubscribe ack lost"));
  await expect(client.request("thread/unsubscribe",{threadId:"runtime-thread-1"},"writer-release-1")).rejects.toThrow("ack lost");
  expect(client.canReuseLoadedThread("runtime-thread-1",true)).toBe(false);request.mockRestore();
  await client.request("thread/resume",{threadId:"runtime-thread-1",config:{web_search:"live"}},"writer-resume");expect(client.canReuseLoadedThread("runtime-thread-1",true)).toBe(true);
  await client.request("thread/unsubscribe",{threadId:"runtime-thread-1"},"writer-release-2");expect(client.canReuseLoadedThread("runtime-thread-1",true)).toBe(false);
 }finally{await client.close();}
});


it("awaits the exact turn preparation before any worker startup and stops on a failed proof",async()=>{
 const config=await loadInstallationConfig();
 const fingerprint=createHash("sha256").update(JSON.stringify({schemaVersion:config.schemaVersion,installationId:config.installationId,usersRoot:config.paths.usersRoot,companyContextRoot:config.paths.companyContextRoot,sourceReadRoot:config.paths.sourceReadRoot,publishWriteRoot:config.paths.publishWriteRoot})).digest("hex");
 const globals=globalThis as typeof globalThis & {__aibrainWorkerRuntimeService?:unknown};const previous=globals.__aibrainWorkerRuntimeService;
 const first=handle(new FakeTransport());const registry={get:vi.fn(()=>null),start:vi.fn().mockResolvedValue(first),stop:vi.fn()};
 globals.__aibrainWorkerRuntimeService={fingerprint,config,registry,clients:new Map(),clientAdmissions:new Map(),maintenance:new MaintenanceCoordinator(),activeTurnCancellations:new Map()};
 const userRead=vi.spyOn(FileLocalUserStore.prototype,"read").mockResolvedValue({enabled:true} as Awaited<ReturnType<FileLocalUserStore["read"]>>);
 const initialize=vi.spyOn(WorkerAppServerClient.prototype,"initialize").mockResolvedValue(undefined);
 let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
 const prepare=vi.fn(async({config:bound,roots})=>{expect(bound.installationId).toBe(config.installationId);expect(roots.userRoot).toBe(config.paths.usersRoot+"/"+first.userId);await barrier;});
 try {
  const pending=workerAppServerForUser(first.userId,undefined,prepare);
  await vi.waitFor(()=>expect(prepare).toHaveBeenCalledTimes(1));expect(registry.start).not.toHaveBeenCalled();expect(initialize).not.toHaveBeenCalled();
  release();await pending;expect(registry.start).toHaveBeenCalledTimes(1);expect(initialize).toHaveBeenCalledTimes(1);
  await expect(workerAppServerForUser(first.userId,undefined,async()=>{throw Error("proof refused");})).rejects.toThrow("proof refused");
  expect(registry.start).toHaveBeenCalledTimes(1);expect(initialize).toHaveBeenCalledTimes(1);
 } finally {release();userRead.mockRestore();initialize.mockRestore();globals.__aibrainWorkerRuntimeService=previous;}
});
