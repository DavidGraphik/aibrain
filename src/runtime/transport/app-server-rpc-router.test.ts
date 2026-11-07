import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  AppServerEvent,
  AppServerRequest,
  AppServerTransport,
  TransportHealth,
} from "@/runtime/transport/contracts";
import {
  AppServerRequestTimeoutError,
  AppServerRpcResponseError,
  AppServerRpcRouter,
} from "@/runtime/transport/app-server-rpc-router";
import { RuntimeProjectionAdmissionDeferred } from "@/runtime/transport/projection-readiness";

class EventQueue implements AsyncIterable<AppServerEvent> {
  private values: AppServerEvent[] = [];
  private waiters: Array<(value: IteratorResult<AppServerEvent>) => void> = [];
  private closed = false;
  push(value: AppServerEvent) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  get pending() { return this.values.length; }
  [Symbol.asyncIterator](): AsyncIterator<AppServerEvent> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

class FakeTransport implements AppServerTransport {
  readonly sent: AppServerRequest[] = [];
  readonly acknowledged: AppServerEvent[] = [];
  readonly queue = new EventQueue();
  async connect() {}
  async send(request: AppServerRequest) { this.sent.push(request); }
  events() { return this.queue; }
  async acknowledge(event: AppServerEvent) { this.acknowledged.push(event); }
  async health(): Promise<TransportHealth> {
    return {
      healthy: true,
      state: "connected",
      endpoint: "ws://127.0.0.1",
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

function event(sequence: number, message: AppServerEvent["message"]): AppServerEvent {
  return {
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: "2026-08-27T00:00:00.000Z",
    message,
  };
}

describe("AppServerRpcRouter", () => {
  it("defers admission until contiguous projection, keeps draining, and rechecks a reconnect watermark", async () => {
    let target = 2;
    const transport = Object.assign(new FakeTransport(), {
      deliverySequenceStart: () => 1,
      projectionSequenceTarget: () => target,
    });
    const closed = vi.spyOn(transport, "close");
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const observed: number[] = [];
    const router = new AppServerRpcRouter(transport, {onNotification:async (_notification,event) => {
      if(event.sequence === 1) await blocked;
      observed.push(event.sequence);
    }});
    await router.start();
    const history = (sequence: number) => event(sequence,{kind:"rpc-notification",rpc:{method:"warning",params:{threadId:null,message:"retained"}}});
    transport.queue.push(history(1)); transport.queue.push(history(2));
    await expect(router.assertProjectionReady()).rejects.toBeInstanceOf(RuntimeProjectionAdmissionDeferred);
    // Explicit recovery/Stop replies are still routed during the deferral.
    const read = router.request({id:"safe-read",method:"thread/read",params:{threadId:"current",includeTurns:false}},1000);
    transport.queue.push(event(3,{kind:"rpc-response",rpc:{id:"safe-read",result:{thread:{id:"current"}}}}));
    await expect(read).resolves.toEqual({thread:{id:"current"}});
    expect(transport.acknowledged).toEqual([]);
    release();
    await vi.waitFor(()=>expect(transport.acknowledged).toHaveLength(3));
    await expect(router.assertProjectionReady()).resolves.toBeUndefined();
    expect(observed).toEqual([1,2]);
    target = 4; // the same transport reconnects; no consumer restart
    await expect(router.assertProjectionReady()).rejects.toBeInstanceOf(RuntimeProjectionAdmissionDeferred);
    transport.queue.push(history(4));
    await vi.waitFor(()=>expect(transport.acknowledged).toHaveLength(4));
    await expect(router.assertProjectionReady()).resolves.toBeUndefined();
    expect(closed).not.toHaveBeenCalled();
    await router.close();
  });
  it("batches durable replay ACKs so an end-of-backlog tool is not throttled by one fsync per event", async () => {
    const transport = new FakeTransport();
    let writes = 0;
    const persist = async (events: AppServerEvent[]) => {
      writes++;
      await new Promise(resolve => setTimeout(resolve, 2)); // bounded durable-I/O latency
      transport.acknowledged.push(...events);
    };
    transport.acknowledge = event => persist([event]);
    Object.assign(transport, { acknowledgeBatch: persist });
    const router = new AppServerRpcRouter(transport);
    const effect = vi.fn(async () => ({ success: true }));
    router.registerTurn("current", "local", {onNotification:vi.fn(),onServerRequest:effect,onFailure:vi.fn()}).bindRuntimeTurn("turn");
    await router.start();
    const started = performance.now();
    for (let sequence=1; sequence<=1024; sequence++) transport.queue.push(event(sequence, {
      kind:"rpc-notification",rpc:{method:"item/agentMessage/delta",params:{threadId:"history",turnId:"old",itemId:"message",delta:"."}},
    }));
    transport.queue.push(event(1025,{kind:"rpc-request",rpc:{id:0,method:"item/tool/call",params:{
      threadId:"current",turnId:"turn",callId:"one-effect",namespace:"synthetic",tool:"write",arguments:{},
    }}}));
    await vi.waitFor(() => expect(transport.acknowledged).toHaveLength(1025), {timeout:5000,interval:5});
    process.stdout.write(JSON.stringify({fixture:"1024 historical deltas + one tool",elapsedMs:Math.round(performance.now()-started),durableWrites:writes})+"\n");
    expect(effect).toHaveBeenCalledOnce();
    expect(transport.acknowledged.map(event=>event.sequence)).toEqual(Array.from({length:1025},(_,i)=>i+1));
    expect(writes).toBeLessThanOrEqual(16);
    await router.close();
  });

  it("rejects an invalid delivery floor before consuming or acknowledging any event", async () => {
    const transport=Object.assign(new FakeTransport(),{deliverySequenceStart:()=>0});const router=new AppServerRpcRouter(transport);
    await expect(router.start()).rejects.toThrow("Invalid transport delivery start");
    expect(transport.acknowledged).toEqual([]);expect(transport.sent).toEqual([]);await router.close();
  });

  it("retains the exact method and identity on a correlated multiline RPC rejection", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    const message = "Invalid request: unknown variant ``\nin apps._default.approvals_reviewer";
    const rejected = router.request({ method: "thread/start", id: "exact-thread-create", params: {} });
    const observed = rejected.catch(error => error);
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    transport.queue.push(event(1, { kind: "rpc-response", rpc: { id: "exact-thread-create", error: { code: -32600, message } } }));
    const error = await observed;
    expect(error).toBeInstanceOf(AppServerRpcResponseError);
    expect(error).toMatchObject({ method: "thread/start", requestId: "exact-thread-create", code: -32600, message });
    await vi.waitFor(() => expect(transport.acknowledged).toHaveLength(1));
    expect(transport.sent).toHaveLength(1);
    await router.close();
  });

  it("observes unregistered usage durably without blocking the independent RPC response lane", async () => {
    const transport = new FakeTransport();
    let release!: () => void;
    const observer = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const router = new AppServerRpcRouter(transport, { onNotification: observer });
    const reading = router.request({ method: "thread/read", id: "read", params: { threadId: "child", includeTurns: true } });
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    const counts = { totalTokens: 50, inputTokens: 40, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 };
    transport.queue.push(event(1, { kind: "rpc-notification", rpc: { method: "thread/tokenUsage/updated", params: {
      threadId: "unregistered-child", turnId: "child-turn", tokenUsage: { total: counts, last: counts, modelContextWindow: null },
    } } }));
    transport.queue.push(event(2, { kind: "rpc-response", rpc: { id: "read", result: { thread: { id: "child" } } } }));
    await expect(reading).resolves.toEqual({ thread: { id: "child" } });
    expect(observer).toHaveBeenCalledOnce();
    expect(transport.acknowledged).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(transport.acknowledged.map(({ sequence }) => sequence)).toEqual([1, 2]));
    await router.close();
  });

  it("observes usage while a preceding same-thread tool is still awaiting a result", async () => {
    const transport = new FakeTransport();
    const observer = vi.fn();
    const router = new AppServerRpcRouter(transport, { onNotification: observer });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const tool = vi.fn(async () => { await blocked; return {}; });
    router.registerTurn("parent", "local", { onNotification: vi.fn(), onServerRequest: tool, onFailure: vi.fn() }).bindRuntimeTurn("turn");
    await router.start();
    transport.queue.push(event(1, { kind: "rpc-request", rpc: { method: "item/tool/call", id: "tool", params: {
      threadId: "parent", turnId: "turn", callId: "tool", namespace: "aibrain_horaria", tool: "run", arguments: {},
    } } }));
    transport.queue.push(event(2, { kind: "rpc-notification", rpc: { method: "turn/started", params: {
      threadId: "parent", turn: { id: "turn", status: "inProgress", items: [], error: null, itemsView: "full", rootTurnId: null, startedAt: null, completedAt: null, durationMs: null },
    } } }));
    await vi.waitFor(() => expect(observer).toHaveBeenCalledOnce());
    expect(tool).toHaveBeenCalledOnce();
    expect(transport.acknowledged).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(transport.acknowledged).toHaveLength(2));
    await router.close();
  });

  it("keeps a later turn in the same conversation usable while a disposed turn's tool is blocked", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const oldTool = vi.fn(async () => { await blocked; return { old: true }; });
    const oldNotification = vi.fn();
    const old = router.registerTurn("same-chat", "old-local", {
      onNotification: oldNotification, onServerRequest: oldTool, onFailure: vi.fn(),
    });
    old.bindRuntimeTurn("old-runtime");
    await router.start();
    transport.queue.push(event(1, { kind: "rpc-request", rpc: { method: "item/tool/call", id: "old-tool", params: {
      threadId: "same-chat", turnId: "old-runtime", callId: "old-call", namespace: "aibrain_company_files", tool: "search", arguments: {},
    } } }));
    await vi.waitFor(() => expect(oldTool).toHaveBeenCalledOnce());
    // An already received notification retains its old owner, even after a
    // follow-up replaces the disposed registration.
    transport.queue.push(event(2, { kind: "rpc-notification", rpc: { method: "thread/status/changed", params: {
      threadId: "same-chat", status: { type: "idle" },
    } } }));
    await vi.waitFor(() => expect(transport.queue.pending).toBe(0));
    old.dispose();
    const newTool = vi.fn(async () => ({ productionRevision: 693 }));
    const newNotification = vi.fn();
    router.registerTurn("same-chat", "new-local", {
      onNotification: newNotification, onServerRequest: newTool, onFailure: vi.fn(),
    }).bindRuntimeTurn("new-runtime");
    transport.queue.push(event(3, { kind: "rpc-request", rpc: { method: "item/tool/call", id: "new-tool", params: {
      threadId: "same-chat", turnId: "new-runtime", callId: "new-call", namespace: "aibrain_g03_production", tool: "read", arguments: {},
    } } }));
    await vi.waitFor(() => expect(transport.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "rpc-response", rpc: { id: "new-tool", result: { productionRevision: 693 } } }),
    ])));
    expect(newTool).toHaveBeenCalledOnce();
    expect(newNotification).not.toHaveBeenCalled();
    expect(transport.acknowledged).toEqual([]);
    release();
    await vi.waitFor(() => expect(transport.acknowledged.map(({ sequence }) => sequence)).toEqual([1, 2, 3]));
    expect(oldNotification).not.toHaveBeenCalled();
    expect(newNotification).not.toHaveBeenCalled();
    await router.close();
  });

  it("does not acknowledge usage when its durable observer fails", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport, { onNotification: () => { throw new Error("Ledger unavailable"); } });
    await router.start();
    transport.queue.push(event(1, { kind: "rpc-notification", rpc: { method: "turn/started", params: {
      threadId: "child", turn: { id: "turn", status: "inProgress", items: [], error: null, itemsView: "full", rootTurnId: null, startedAt: null, completedAt: null, durationMs: null },
    } } }));
    await vi.waitFor(() => expect(router.failed).toBe(true));
    expect(transport.acknowledged).toHaveLength(0);
    await router.close();
  });

  it("drains a large calculation stream while its parent tool is awaiting that calculation", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    let completeCalculation!: () => void;
    const calculation = new Promise<void>(resolve => { completeCalculation = resolve; });
    const tool = vi.fn(async () => { await calculation; return { success: true }; });
    router.registerTurn("parent", "local-parent", {
      onNotification: vi.fn(), onServerRequest: tool, onFailure: vi.fn(),
    }).bindRuntimeTurn("parent-turn");
    const childNotification = vi.fn((notification) => {
      if (notification.method === "turn/completed") completeCalculation();
    });
    router.registerTurn("calculation", "local-calculation", {
      onNotification: childNotification, onServerRequest: vi.fn(), onFailure: vi.fn(),
    }).bindRuntimeTurn("calculation-turn");
    await router.start();
    transport.queue.push(event(1, { kind: "rpc-request", rpc: { method: "item/tool/call", id: "draft", params: {
      threadId: "parent", turnId: "parent-turn", callId: "draft", namespace: "aibrain_horaria", tool: "run", arguments: {},
    } } }));
    for (let sequence = 2; sequence <= 1401; sequence++) transport.queue.push(event(sequence, {
      kind: "rpc-notification", rpc: { method: "item/agentMessage/delta", params: {
        threadId: "calculation", turnId: "calculation-turn", itemId: "schedule", delta: ".",
      } },
    }));
    transport.queue.push(event(1402, { kind: "rpc-notification", rpc: { method: "turn/completed", params: {
      threadId: "calculation", turn: { id: "calculation-turn", status: "completed", items: [], error: null,
        itemsView: "full", rootTurnId: null, startedAt: null, completedAt: null, durationMs: null },
    } } }));
    try {
      await vi.waitFor(() => expect(transport.acknowledged).toHaveLength(1402), { timeout: 2_000 });
      expect(childNotification).toHaveBeenCalledTimes(1401);
      expect(tool).toHaveBeenCalledOnce();
      expect(transport.acknowledged.map(({ sequence }) => sequence)).toEqual(Array.from({ length: 1402 }, (_, i) => i + 1));
    } finally { completeCalculation(); await router.close(); }
  });

  it("stays failed after an unexpected EOF so a cached initializer cannot mask a dead transport", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    const failed = vi.fn();
    await router.start();
    router.registerTurn("thread-a", "local-a", {
      onNotification: vi.fn(),
      onServerRequest: vi.fn(),
      onFailure: failed,
    });

    transport.queue.close();
    await vi.waitFor(() => expect(router.failed).toBe(true));

    expect(failed).toHaveBeenCalledOnce();
    expect(router.hasActiveTurn("thread-a", "local-a")).toBe(false);
    await expect(router.start()).rejects.toThrow("event stream closed unexpectedly");
    await expect(router.request({ method: "account/read", id: "after-eof", params: { refreshToken: false } }))
      .rejects.toThrow("event stream closed unexpectedly");
    await router.close();
  });

  it("returns a typed timeout so callers can recover without resubmitting a turn", async () => {
    const transport = new FakeTransport();
    const metrics = vi.fn();
    const router = new AppServerRpcRouter(transport, { onRequestMetric: metrics });
    const result = router.request(
      { method: "turn/start", id: "slow-turn", params: { threadId: "thread-a", input: [] } },
      5,
    );

    await expect(result).rejects.toMatchObject({
      name: "AppServerRequestTimeoutError",
      method: "turn/start",
      requestId: "slow-turn",
      timeoutMs: 5,
    } satisfies Partial<AppServerRequestTimeoutError>);
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({
      method: "turn/start",
      requestId: "slow-turn",
      outcome: "timeout",
      requestAcceptedMs: expect.any(Number),
      totalMs: expect.any(Number),
      activeTurnsAtStart: 0,
      pendingRequestsAtStart: 0,
    }));
    await router.close();
  });

  it("delivers a late response to the original timeout without dispatching a second request", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    const result = router.request(
      { method: "thread/read", id: "late-read", params: { threadId: "thread-a", includeTurns: true } },
      5,
    );
    const timeout = await result.catch((error: unknown) => error);
    expect(timeout).toBeInstanceOf(AppServerRequestTimeoutError);
    expect(transport.sent).toHaveLength(1);
    await expect(router.request(
      { method: "thread/read", id: "late-read", params: { threadId: "thread-a", includeTurns: true } },
      50,
    )).rejects.toThrow(/late response/u);
    expect(transport.sent).toHaveLength(1);

    transport.queue.push(event(1, {
      kind: "rpc-response",
      rpc: { id: "late-read", result: { thread: { id: "thread-a", turns: [] } } },
    }));

    await expect((timeout as AppServerRequestTimeoutError).lateResponse).resolves.toEqual({
      thread: { id: "thread-a", turns: [] },
    });
    expect(transport.sent).toHaveLength(1);
    await vi.waitFor(() => expect(transport.acknowledged).toHaveLength(1));
    await router.close();
  });

  it("applies the request deadline while the private worker is still connecting", async () => {
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    class BlockedConnectTransport extends FakeTransport {
      override async connect() { await connectGate; }
    }
    const transport = new BlockedConnectTransport();
    const metrics = vi.fn();
    const router = new AppServerRpcRouter(transport, { onRequestMetric: metrics });
    const result = router.request(
      { method: "thread/read", id: "blocked-connect", params: { threadId: "thread-a", includeTurns: true } },
      5,
    );

    await expect(result).rejects.toBeInstanceOf(AppServerRequestTimeoutError);
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "blocked-connect",
      outcome: "timeout",
      requestAcceptedMs: null,
    }));
    releaseConnect();
    await router.close();
  });

  it("enforces the request timeout even when transport admission itself is blocked", async () => {
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    class BlockedAdmissionTransport extends FakeTransport {
      override async send(request: AppServerRequest) {
        this.sent.push(request);
        await sendGate;
      }
    }
    const transport = new BlockedAdmissionTransport();
    const router = new AppServerRpcRouter(transport);
    const result = router.request(
      { method: "thread/read", id: "blocked-admission", params: { threadId: "thread-a", includeTurns: true } },
      5,
    );

    await expect(result).rejects.toMatchObject({
      name: "AppServerRequestTimeoutError",
      method: "thread/read",
      requestId: "blocked-admission",
    });
    releaseSend();
    await router.close();
  });

  it("releases a blocked transport admission when the router closes", async () => {
    const sendGate = new Promise<void>(() => undefined);
    class BlockedAdmissionTransport extends FakeTransport {
      override async send(request: AppServerRequest) {
        this.sent.push(request);
        await sendGate;
      }
    }
    const transport = new BlockedAdmissionTransport();
    const router = new AppServerRpcRouter(transport);
    const result = router.request(
      { method: "thread/read", id: "close-blocked-admission", params: { threadId: "thread-a", includeTurns: true } },
      30_000,
    );
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));

    await router.close();

    await expect(result).rejects.toThrow("App Server router closed");
  });

  it("resolves concurrent RPC responses by id even when they arrive out of order", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    const first = router.request({ method: "thread/read", id: "request-one", params: { threadId: "thread-a", includeTurns: false } });
    const second = router.request({ method: "thread/read", id: "request-two", params: { threadId: "thread-b", includeTurns: false } });
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));

    transport.queue.push(event(1, { kind: "rpc-response", rpc: { id: "request-two", result: { thread: { id: "thread-b" } } } }));
    transport.queue.push(event(2, { kind: "rpc-response", rpc: { id: "request-one", result: { thread: { id: "thread-a" } } } }));
    await expect(second).resolves.toEqual({ thread: { id: "thread-b" } });
    await expect(first).resolves.toEqual({ thread: { id: "thread-a" } });
    await vi.waitFor(() => expect(transport.acknowledged).toHaveLength(2));
    await router.close();
  });

  it("does not resolve or ACK an RPC response until its durable projection hook completes", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    let releaseProjection!: () => void;
    const projectionGate = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const projected = vi.fn(async () => projectionGate);
    const result = router.request(
      { method: "thread/read", id: "durable-response", params: { threadId: "thread-a", includeTurns: false } },
      30_000,
      projected,
    );
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    transport.queue.push(event(1, {
      kind: "rpc-response",
      rpc: { id: "durable-response", result: { thread: { id: "thread-a" } } },
    }));
    await vi.waitFor(() => expect(projected).toHaveBeenCalledOnce());
    expect(transport.acknowledged).toHaveLength(0);
    releaseProjection();
    await expect(result).resolves.toEqual({ thread: { id: "thread-a" } });
    await vi.waitFor(() => expect(transport.acknowledged).toHaveLength(1));
    await router.close();
  });

  it("keeps the request deadline active while durable response projection is blocked", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    let releaseProjection!: () => void;
    const projectionGate = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const projected = vi.fn(async () => projectionGate);
    const result = router.request(
      { method: "thread/read", id: "projection-timeout", params: { threadId: "thread-a", includeTurns: false } },
      500,
      projected,
    );
    const timedOut = expect(result).rejects.toBeInstanceOf(AppServerRequestTimeoutError);
    const timeoutError = result.then(() => { throw new Error("Expected a timeout"); }, (error: unknown) => error as AppServerRequestTimeoutError);
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    transport.queue.push(event(1, {
      kind: "rpc-response",
      rpc: { id: "projection-timeout", result: { thread: { id: "thread-a" } } },
    }));
    await vi.waitFor(() => expect(projected).toHaveBeenCalledOnce());

    await timedOut;
    expect(transport.acknowledged).toHaveLength(0);
    releaseProjection();
    await vi.waitFor(() => expect(transport.acknowledged).toHaveLength(1));
    await expect((await timeoutError).lateResponse).resolves.toEqual({ thread: { id: "thread-a" } });
    expect(transport.sent).toHaveLength(1);
    await router.close();
  });

  it("keeps another thread responsive while one response projection is blocked", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    let releaseProjection!: () => void;
    const projectionGate = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const first = router.request(
      { method: "thread/read", id: "blocked-thread-a", params: { threadId: "thread-a", includeTurns: true } },
      30_000,
      async () => projectionGate,
    );
    const second = router.request(
      { method: "thread/read", id: "free-thread-b", params: { threadId: "thread-b", includeTurns: true } },
      1_000,
    );
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
    transport.queue.push(event(1, {
      kind: "rpc-response",
      rpc: { id: "blocked-thread-a", result: { thread: { id: "thread-a", turns: [] } } },
    }));
    transport.queue.push(event(2, {
      kind: "rpc-response",
      rpc: { id: "free-thread-b", result: { thread: { id: "thread-b", turns: [] } } },
    }));

    await expect(second).resolves.toEqual({ thread: { id: "thread-b", turns: [] } });
    expect(transport.acknowledged).toHaveLength(0);
    releaseProjection();
    await expect(first).resolves.toEqual({ thread: { id: "thread-a", turns: [] } });
    await vi.waitFor(() => expect(transport.acknowledged.map(({ sequence }) => sequence)).toEqual([1, 2]));
    await router.close();
  });

  it("projects a duplicated response once while its first projection is still pending", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const project = vi.fn(async () => gate);
    const result = router.request({ method: "thread/read", id: "duplicated-read", params: {
      threadId: "thread-a", includeTurns: true,
    } }, 1_000, project);
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    const message = { kind: "rpc-response" as const, rpc: {
      id: "duplicated-read", result: { thread: { id: "thread-a", turns: [] } },
    } };
    transport.queue.push(event(1, message));
    await vi.waitFor(() => expect(project).toHaveBeenCalledOnce());
    transport.queue.push(event(2, message));
    await vi.waitFor(() => expect(transport.queue.pending).toBe(0));
    expect(project).toHaveBeenCalledOnce();
    expect(transport.acknowledged).toHaveLength(0);
    release();
    await expect(result).resolves.toEqual(message.rpc.result);
    await vi.waitFor(() => expect(transport.acknowledged.map(({ sequence }) => sequence)).toEqual([1, 2]));
    expect(project).toHaveBeenCalledOnce();
    await router.close();
  });

  it("routes notifications and server approvals only to their bound thread and turn", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    await router.start();
    const aNotification = vi.fn();
    const bNotification = vi.fn();
    const aApproval = vi.fn(async () => ({ decision: "accept" }));
    const bApproval = vi.fn(async () => ({ decision: "decline" }));
    const first = router.registerTurn("thread-a", "local-a", {
      onNotification: aNotification,
      onServerRequest: aApproval,
      onFailure: vi.fn(),
    });
    const second = router.registerTurn("thread-b", "local-b", {
      onNotification: bNotification,
      onServerRequest: bApproval,
      onFailure: vi.fn(),
    });
    first.bindRuntimeTurn("turn-a");
    second.bindRuntimeTurn("turn-b");

    transport.queue.push(event(1, {
      kind: "rpc-notification",
      rpc: { method: "item/agentMessage/delta", params: { threadId: "thread-b", turnId: "turn-b", itemId: "item-b", delta: "B" } },
    }));
    transport.queue.push(event(2, {
      kind: "rpc-request",
      rpc: {
        method: "item/commandExecution/requestApproval",
        id: "approval-a",
        params: {
          kind: "command",
          threadId: "thread-a",
          turnId: "turn-a",
          itemId: "item-a",
          startedAtMs: 1,
          environmentId: null,
          command: "pwd",
        },
      },
    }));
    await vi.waitFor(() => expect(transport.acknowledged).toHaveLength(2));
    expect(aNotification).not.toHaveBeenCalled();
    expect(bNotification).toHaveBeenCalledOnce();
    expect(aApproval).toHaveBeenCalledOnce();
    expect(bApproval).not.toHaveBeenCalled();
    const scopeDigest = createHash("sha256")
      .update(JSON.stringify(["thread-a", "turn-a"]))
      .digest("hex");
    expect(transport.sent.at(-1)).toMatchObject({
      clientRequestId: `server-response:event-2:${scopeDigest}`,
      kind: "rpc-response",
      rpc: { id: "approval-a", result: { decision: "accept" } },
    });
    first.dispose();
    second.dispose();
    await router.close();
  });

  it("rejects unowned server requests without exposing them to another active turn", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    await router.start();
    const handler = vi.fn(async () => ({ decision: "accept" }));
    router.registerTurn("thread-a", "local-a", {
      onNotification: vi.fn(),
      onServerRequest: handler,
      onFailure: vi.fn(),
    });
    transport.queue.push(event(1, {
      kind: "rpc-request",
      rpc: {
        method: "item/fileChange/requestApproval",
        id: "approval-other",
        params: {
          threadId: "thread-other",
          turnId: "turn-other",
          itemId: "item-other",
          reason: null,
          grantRoot: null,
          startedAtMs: 1,
        },
      },
    }));
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(handler).not.toHaveBeenCalled();
    expect(transport.sent[0]).toMatchObject({
      kind: "rpc-response",
      rpc: { id: "approval-other", error: { code: -32602 } },
    });
    await router.close();
  });

  it("returns an explicit error for a server request from the wrong turn on an owned thread", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    await router.start();
    const handler = vi.fn(async () => ({ decision: "accept" }));
    router.registerTurn("thread-a", "local-a", {
      onNotification: vi.fn(),
      onServerRequest: handler,
      onFailure: vi.fn(),
    }).bindRuntimeTurn("turn-a");
    transport.queue.push(event(1, {
      kind: "rpc-request",
      rpc: {
        method: "item/fileChange/requestApproval",
        id: "approval-wrong-turn",
        params: {
          threadId: "thread-a",
          turnId: "turn-b",
          itemId: "item-other",
          reason: null,
          grantRoot: null,
          startedAtMs: 1,
        },
      },
    }));
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(handler).not.toHaveBeenCalled();
    expect(transport.sent[0]).toMatchObject({
      kind: "rpc-response",
      rpc: { id: "approval-wrong-turn", error: { code: -32602, message: expect.stringContaining("does not own") } },
    });
    await router.close();
  });

  it("does not rebind a new local turn to a delayed notification from the previous runtime turn", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    await router.start();
    let releasePrevious!: () => void;
    const previousGate = new Promise<void>((resolve) => { releasePrevious = resolve; });
    const previousNotification = vi.fn(async () => previousGate);
    const previous = router.registerTurn("thread-sequential", "local-old", {
      onNotification: previousNotification,
      onServerRequest: vi.fn(),
      onFailure: vi.fn(),
    });
    previous.bindRuntimeTurn("turn-old");

    transport.queue.push(event(1, {
      kind: "rpc-notification",
      rpc: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-sequential",
          turnId: "turn-old",
          itemId: "item-old-1",
          delta: "old",
        },
      },
    }));
    await vi.waitFor(() => expect(previousNotification).toHaveBeenCalledOnce());
    transport.queue.push(event(2, {
      kind: "rpc-notification",
      rpc: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-sequential",
          turnId: "turn-old",
          itemId: "item-old-2",
          delta: "late-old",
        },
      },
    }));
    await vi.waitFor(() => expect(transport.queue.pending).toBe(0));

    previous.dispose();
    const currentNotification = vi.fn();
    const current = router.registerTurn("thread-sequential", "local-new", {
      onNotification: currentNotification,
      onServerRequest: vi.fn(),
      onFailure: vi.fn(),
    });
    releasePrevious();
    await vi.waitFor(() => expect(transport.acknowledged.map((item) => item.sequence)).toEqual([1, 2]));

    expect(previousNotification).toHaveBeenCalledOnce();
    expect(currentNotification).not.toHaveBeenCalled();
    expect(() => current.bindRuntimeTurn("turn-new")).not.toThrow();
    current.dispose();
    await router.close();
  });

  it("waits for the explicit turn/start binding before routing post-resume turn notifications", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    await router.start();
    const notification = vi.fn();
    const registration = router.registerTurn("thread-resumed", "local-current", {
      onNotification: notification,
      onServerRequest: vi.fn(),
      onFailure: vi.fn(),
    });

    transport.queue.push(event(1, {
      kind: "rpc-notification",
      rpc: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-resumed",
          turnId: "turn-previous",
          tokenUsage: {
            total: { totalTokens: 10, inputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
            last: { totalTokens: 10, inputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
            modelContextWindow: 1000,
          },
        },
      },
    }));
    await vi.waitFor(() => expect(transport.queue.pending).toBe(0));
    expect(transport.acknowledged).toHaveLength(0);

    // The binding comes from the RPC response, which arrives after the old
    // turn's usage event on a real resumed conversation.
    const started = router.request({
      method: "turn/start", id: "start-current", params: { threadId: "thread-resumed", input: [] },
    }, 1_000, () => registration.bindRuntimeTurn("turn-current"));
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    transport.queue.push(event(2, {
      kind: "rpc-response", rpc: { id: "start-current", result: { turn: { id: "turn-current" } } },
    }));
    await expect(started).resolves.toEqual({ turn: { id: "turn-current" } });
    await vi.waitFor(() => expect(transport.acknowledged.map((item) => item.sequence)).toEqual([1, 2]));
    expect(notification).not.toHaveBeenCalled();

    transport.queue.push(event(3, {
      kind: "rpc-notification",
      rpc: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-resumed",
          turnId: "turn-current",
          itemId: "item-current",
          delta: "current",
        },
      },
    }));
    await vi.waitFor(() => expect(notification).toHaveBeenCalledOnce());
    registration.dispose();
    await router.close();
  });

  it("lets a same-thread recovery read complete while a tool handler waits for it", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    await router.start();
    const handler = vi.fn(async () => {
      await router.request({ method: "thread/read", id: "recover-tool", params: {
        threadId: "thread-a", includeTurns: true,
      } }, 1_000);
      return { success: true };
    });
    router.registerTurn("thread-a", "local-a", {
      onNotification: vi.fn(), onServerRequest: handler, onFailure: vi.fn(),
    }).bindRuntimeTurn("turn-a");
    transport.queue.push(event(1, { kind: "rpc-request", rpc: {
      method: "item/tool/call", id: "tool-a", params: {
        threadId: "thread-a", turnId: "turn-a", callId: "tool-a",
        namespace: "aibrain_company_files", tool: "search", arguments: { query: "test" },
      },
    } }));
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    transport.queue.push(event(2, { kind: "rpc-response", rpc: {
      id: "recover-tool", result: { thread: { id: "thread-a", turns: [] } },
    } }));
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
    expect(transport.sent[1]).toMatchObject({ kind: "rpc-response", rpc: { id: "tool-a", result: { success: true } } });
    await vi.waitFor(() => expect(transport.acknowledged.map(({ sequence }) => sequence)).toEqual([1, 2]));
    await router.close();
  });

  it("keeps another thread streaming while an approval is pending and ACKs in order", async () => {
    const transport = new FakeTransport();
    const router = new AppServerRpcRouter(transport);
    await router.start();
    let releaseApproval!: () => void;
    const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
    const otherNotification = vi.fn();
    router.registerTurn("thread-approval", "local-approval", {
      onNotification: vi.fn(),
      onServerRequest: async () => {
        await approvalGate;
        return { decision: "accept" };
      },
      onFailure: vi.fn(),
    }).bindRuntimeTurn("turn-approval");
    router.registerTurn("thread-stream", "local-stream", {
      onNotification: otherNotification,
      onServerRequest: vi.fn(),
      onFailure: vi.fn(),
    }).bindRuntimeTurn("turn-stream");

    transport.queue.push(event(1, {
      kind: "rpc-request",
      rpc: {
        method: "item/commandExecution/requestApproval",
        id: "approval-pending",
        params: {
          kind: "command",
          threadId: "thread-approval",
          turnId: "turn-approval",
          itemId: "item-approval",
          startedAtMs: 1,
          environmentId: null,
          command: "pwd",
        },
      },
    }));
    transport.queue.push(event(2, {
      kind: "rpc-notification",
      rpc: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-stream",
          turnId: "turn-stream",
          itemId: "item-stream",
          delta: "continues",
        },
      },
    }));

    await vi.waitFor(() => expect(otherNotification).toHaveBeenCalledOnce());
    expect(transport.acknowledged).toHaveLength(0);
    releaseApproval();
    await vi.waitFor(() => expect(transport.acknowledged.map((item) => item.sequence)).toEqual([1, 2]));
    await router.close();
  });

  it("runs three chats and opens a fourth while one tool is blocked, then remains usable after a read timeout", async () => {
    const transport = new FakeTransport();
    const metrics = vi.fn();
    const router = new AppServerRpcRouter(transport, { onRequestMetric: metrics });
    await router.start();
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
    const notifications = [vi.fn(), vi.fn(), vi.fn()];
    ["thread-a", "thread-b", "thread-c"].forEach((threadId, index) => {
      router.registerTurn(threadId, `local-${threadId}`, {
        onNotification: notifications[index]!,
        onServerRequest: index === 0
          ? async () => { await toolGate; return { success: true }; }
          : vi.fn(async () => ({ success: true })),
        onFailure: vi.fn(),
      }).bindRuntimeTurn(`turn-${threadId.at(-1)}`);
    });

    transport.queue.push(event(1, {
      kind: "rpc-request",
      rpc: {
        method: "item/tool/call",
        id: "tool-create",
        params: {
          threadId: "thread-a",
          turnId: "turn-a",
          callId: "tool-create",
          namespace: "aibrain_documents",
          tool: "create",
          arguments: {},
        },
      },
    }));
    transport.queue.push(event(2, {
      kind: "rpc-notification",
      rpc: { method: "item/agentMessage/delta", params: { threadId: "thread-b", turnId: "turn-b", itemId: "b", delta: "B" } },
    }));
    transport.queue.push(event(3, {
      kind: "rpc-notification",
      rpc: { method: "item/agentMessage/delta", params: { threadId: "thread-c", turnId: "turn-c", itemId: "c", delta: "C" } },
    }));
    await vi.waitFor(() => {
      expect(notifications[1]).toHaveBeenCalledOnce();
      expect(notifications[2]).toHaveBeenCalledOnce();
    });

    const newChat = router.request({
      method: "thread/start",
      id: "new-chat",
      params: { cwd: "/private/workspace", approvalPolicy: "never", sandbox: "read-only" },
    }, 1_000);
    await vi.waitFor(() => expect(transport.sent.some(({ clientRequestId }) => clientRequestId === "new-chat")).toBe(true));
    transport.queue.push(event(4, {
      kind: "rpc-response",
      rpc: { id: "new-chat", result: { thread: { id: "thread-d" } } },
    }));
    await expect(newChat).resolves.toEqual({ thread: { id: "thread-d" } });

    await expect(router.request({
      method: "thread/read",
      id: "bounded-read",
      params: { threadId: "missing", includeTurns: true },
    }, 5)).rejects.toBeInstanceOf(AppServerRequestTimeoutError);
    const trivial = router.request({ method: "account/read", id: "trivial", params: { refreshToken: false } }, 1_000);
    await vi.waitFor(() => expect(transport.sent.some(({ clientRequestId }) => clientRequestId === "trivial")).toBe(true));
    transport.queue.push(event(5, {
      kind: "rpc-response",
      rpc: { id: "trivial", result: { account: { type: "chatgpt" } } },
    }));
    await expect(trivial).resolves.toEqual({ account: { type: "chatgpt" } });

    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ requestId: "bounded-read", outcome: "timeout" }));
    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({ requestId: "trivial", outcome: "completed" }));
    releaseTool();
    await vi.waitFor(() => expect(transport.acknowledged.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]));
    await router.close();
  });
});
