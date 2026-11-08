import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryTransportEventJournal,
  type AppServerEvent,
  type AppServerRequest,
  type TransportEventJournal,
} from "@/runtime/transport/contracts";
import { AppServerRpcRouter } from "./app-server-rpc-router";
import { WebSocketAppServerTransport, TransportRequestTooLargeError } from "@/runtime/transport/websocket-app-server-transport";
import {
  StandardWebSocketFactory,
  validatePrivateWebSocketEndpoint,
  type WebSocketConnectOptions,
  type WebSocketFactory,
  type WebSocketLike,
} from "@/runtime/transport/websocket-types";

type Listener = (event: unknown) => void;

class FakeSocket implements WebSocketLike {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: unknown[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  send(data: string) {
    if (this.readyState !== 1) throw new Error("fake socket is not open");
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "open" | "message" | "close" | "error", listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(frame: unknown) {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  receiveBinary() {
    this.emit("message", { data: new Uint8Array([1, 2, 3]) });
  }

  private emit(type: string, event: unknown) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

class FakeSocketFactory implements WebSocketFactory {
  readonly supportsAuthorizationHeaders = true;
  readonly sockets: FakeSocket[] = [];
  readonly calls: Array<{ url: string; options: WebSocketConnectOptions }> = [];

  create(url: string, options: WebSocketConnectOptions) {
    this.calls.push({ url, options });
    const socket = new FakeSocket();
    this.sockets.push(socket);
    return socket;
  }
}

class MemoryJournal implements TransportEventJournal {
  readonly events: Array<{ eventId: string; sequence: number }> = [];

  constructor(
    private cursor: { eventId: string; sequence: number } | null = null,
    private readonly backlog: AppServerEvent[] = [],
  ) {}

  async loadCursor() {
    return this.cursor;
  }

  async loadDeliveryCursor() {
    return this.backlog.length > 0 ? null : this.cursor;
  }

  async append(event: { eventId: string; sequence: number }) {
    if (this.events.some(({ eventId }) => eventId === event.eventId)) return false;
    this.events.push({ eventId: event.eventId, sequence: event.sequence });
    this.cursor = { eventId: event.eventId, sequence: event.sequence };
    return true;
  }

  async readUndelivered(limit: number, afterSequence = 0) {
    return this.backlog.filter((event) => event.sequence > afterSequence).slice(0, limit);
  }

  async markDelivered(_event: AppServerEvent) {}
}

const credentialProvider = {
  async getCredential() {
    return {
      kind: "capability-token" as const,
      token: "0123456789abcdef0123456789abcdef",
    };
  },
};

function createTransport(
  factory: FakeSocketFactory,
  overrides: Partial<ConstructorParameters<typeof WebSocketAppServerTransport>[0]> = {},
) {
  return new WebSocketAppServerTransport({
    endpoint: "ws://127.0.0.1:4500/worker",
    socketFactory: factory,
    auth: { placement: "authorization-header", credentialProvider },
    journal: new InMemoryTransportEventJournal(),
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 30_000,
    reconnectBaseDelayMs: 100,
    reconnectMaxDelayMs: 1_000,
    reconnectJitterRatio: 0,
    random: () => 0.5,
    ...overrides,
  });
}

const request: AppServerRequest = {
  clientRequestId: "request-1",
  kind: "rpc-request",
      rpc: { method: "thread/list", id: "request-1", params: { cursor: null, limit: null, sortKey: null } },
};

function ready(socket: FakeSocket, sessionId = "session-1") {
  socket.receive({
    protocolVersion: 1,
    type: "ready",
    sessionId,
    replaySupported: true,
  });
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WebSocketAppServerTransport contract", () => {
  it("binds recovery health to the gateway session and a fresh connection handshake",async()=>{
    vi.useFakeTimers();const factory=new FakeSocketFactory();const transport=createTransport(factory,{reconnectBaseDelayMs:10,reconnectMaxDelayMs:10,reconnectJitterRatio:0});
    const connecting=transport.connect();await settle();factory.sockets[0].open();ready(factory.sockets[0],"gateway-session-one");await connecting;
    const first=await transport.health();expect(first.sessionId).toBe("gateway-session-one");expect(first.connectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(transport.projectionSequenceTarget()).toBe(0);
    factory.sockets[0].receive({protocolVersion:1,type:"event",event:{eventId:"retained-1",sequence:1,
      occurredAt:"2026-10-28T00:00:00.000Z",message:{kind:"rpc-notification",rpc:{method:"warning",params:{threadId:null,message:"retained"}}}}});
    await vi.waitFor(async()=>expect((await transport.health()).lastEventSequence).toBe(1));
    factory.sockets[0].close(1006,"connection lost");await vi.advanceTimersByTimeAsync(20);factory.sockets[1].open();ready(factory.sockets[1],"gateway-session-two");await settle();
    expect(transport.projectionSequenceTarget()).toBe(1);
    const second=await transport.health();expect(second.sessionId).toBe("gateway-session-two");expect(second.connectionId).not.toBe(first.connectionId);await transport.close();
  });
  it("rejects an oversized new request before connecting, queueing or socket.send", async () => {
    const factory = new FakeSocketFactory();
    const transport = createTransport(factory, { maxFrameBytes: 1024 });
    const oversized: AppServerRequest = { clientRequestId: "oversized-turn", kind: "rpc-request", rpc: {
      id: "oversized-turn", method: "turn/start", params: { threadId: "synthetic", input: [
        { type: "text", text: "x".repeat(2048), text_elements: [] },
      ] },
    } };
    await expect(transport.send(oversized)).rejects.toBeInstanceOf(TransportRequestTooLargeError);
    await expect(transport.send(oversized)).rejects.toMatchObject({ clientRequestId: "oversized-turn", maxBytes: 1024 });
    expect(factory.calls).toHaveLength(0);
    expect((await transport.health()).pendingRequests).toBe(0);
    await transport.close();
  });

  it("does not revive after close during cursor loading", async () => {
    const factory = new FakeSocketFactory();
    const journal = new InMemoryTransportEventJournal();
    let release!: () => void;
    vi.spyOn(journal, "loadCursor").mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return null;
    });
    const transport = createTransport(factory, { journal });
    const connecting = transport.connect().catch((error: unknown) => error);
    await transport.close();
    release();
    expect(await connecting).toMatchObject({ code: "TRANSPORT_CLOSED" });
    expect(factory.calls).toHaveLength(0);
    expect((await transport.health()).state).toBe("closed");
  });

  it("does not revive after close during the ready handshake", async () => {
    const factory = new FakeSocketFactory();
    const journal = new InMemoryTransportEventJournal();
    let release!: () => void;
    vi.spyOn(journal, "loadDeliveryCursor").mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return null;
    });
    const transport = createTransport(factory, { journal });
    const connecting = transport.connect().catch((error: unknown) => error);
    await settle();
    factory.sockets[0].open();
    ready(factory.sockets[0]);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await transport.close();
    release();
    await settle();
    expect(await connecting).toMatchObject({ code: "TRANSPORT_CLOSED" });
    expect((await transport.health()).state).toBe("closed");
    expect(factory.calls).toHaveLength(1);
  });

  it("authenticates in the handshake, waits for acceptance, and dedupes clientRequestId", async () => {
    const factory = new FakeSocketFactory();
    const transport = createTransport(factory);
    const connecting = transport.connect();
    await settle();

    const socket = factory.sockets[0];
    expect(factory.calls[0].options).toEqual({
      headers: { Authorization: "Bearer 0123456789abcdef0123456789abcdef" },
    });
    expect(factory.calls[0].url).not.toContain("0123456789abcdef");
    socket.open();
    expect(socket.sent[0]).toEqual({
      protocolVersion: 1,
      type: "resume",
      afterEventId: null,
      afterSequence: null,
    });
    ready(socket);
    await connecting;

    const sending = transport.send(request);
    expect(socket.sent.at(-1)).toEqual({ protocolVersion: 1, type: "request", request });
    socket.receive({ protocolVersion: 1, type: "accepted", clientRequestId: "request-1" });
    await sending;

    const sentCount = socket.sent.length;
    await transport.send(request);
    expect(socket.sent).toHaveLength(sentCount);
    await expect(transport.send({
      ...request,
      rpc: { method: "thread/list", id: "request-1", params: { limit: 1 } },
    })).rejects.toThrow("different payload");
    await transport.close();
  });

  it("durably journals, acknowledges, dedupes, and resumes events after reconnect", async () => {
    const factory = new FakeSocketFactory();
    const journal = new MemoryJournal({ eventId: "event-40", sequence: 40 });
    const transport = createTransport(factory, { journal });
    const connecting = transport.connect();
    await settle();
    const first = factory.sockets[0];
    first.open();
    expect(first.sent[0]).toMatchObject({
      type: "resume",
      afterEventId: "event-40",
      afterSequence: 40,
    });
    ready(first);
    await connecting;

    const iterator = transport.events()[Symbol.asyncIterator]();
    const next = iterator.next();
    const event = {
      eventId: "event-41",
      sequence: 41,
      occurredAt: "2026-08-26T12:00:00.000Z",
      message: {
        kind: "rpc-notification",
        rpc: { method: "warning", params: { message: "fixture" } },
      },
    };
    first.receive({ protocolVersion: 1, type: "event", event });
    await expect(next).resolves.toEqual({ done: false, value: event });
    expect(journal.events).toEqual([{ eventId: "event-41", sequence: 41 }]);
    expect(first.sent.at(-1)).toEqual({
      protocolVersion: 1,
      type: "event-ack",
      eventId: "event-41",
      sequence: 41,
    });

    first.receive({ protocolVersion: 1, type: "event", event });
    await settle();
    expect(journal.events).toHaveLength(1);
    expect(first.sent.filter((frame) => (frame as { type?: string }).type === "event-ack")).toHaveLength(2);

    first.close(1006, "network lost");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const second = factory.sockets[1];
    second.open();
    expect(second.sent[0]).toMatchObject({
      type: "resume",
      afterEventId: "event-41",
      afterSequence: 41,
    });
    ready(second, "session-2");
    await settle();
    await transport.close();
  });

  it("allows one durable replay reconnect, then fails pending submissions when the worker remains terminated", async () => {
    const factory = new FakeSocketFactory();
    const transport = createTransport(factory);
    const connecting = transport.connect();
    await settle();
    const socket = factory.sockets[0];
    socket.open();
    ready(socket);
    await connecting;

    const sending = transport.send(request);
    socket.close(1011, "Worker runtime failure");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const replaySocket = factory.sockets[1];
    replaySocket.open();
    ready(replaySocket, "failed-runtime-replay");
    replaySocket.close(1011, "Worker runtime still failed");

    await expect(sending).rejects.toMatchObject({ code: "TRANSPORT_CLOSED" });
    await expect(transport.health()).resolves.toMatchObject({
      healthy: false,
      state: "closed",
      pendingRequests: 0,
      lastError: expect.stringContaining("fresh worker transport"),
    });
    expect(factory.sockets).toHaveLength(2);
  });

  it.each([[0, false], [2, false], [0, true]] as const)("routes a live initialize reply while backlog after sequence %s is blocked (release race: %s), without skipping old delivery", async (blockedAfter, releaseWithResponse) => {
    const factory=new FakeSocketFactory();
    const backlog=Array.from({length:5},(_,index):AppServerEvent=>({eventId:`backlog-${index+1}`,sequence:index+1,occurredAt:"2026-08-28T00:00:00.000Z",message:{kind:"rpc-notification",rpc:{method:"warning",params:{threadId:null,message:"retained historical activity"}}}}));
    const journal=new MemoryJournal({eventId:"backlog-5",sequence:5},backlog);
    let unblock!:()=>void;const blocked=new Promise<void>(resolve=>{unblock=resolve;});
    const original=journal.readUndelivered.bind(journal);
    const read=vi.spyOn(journal,"readUndelivered").mockImplementation(async(limit,after=0)=>{if(after>=blockedAfter)await blocked;return original(limit,after);});
    const delivered:number[]=[];
    vi.spyOn(journal,"markDelivered").mockImplementation(async(event:AppServerEvent)=>{expect(event.sequence).toBe(delivered.length+1);delivered.push(event.sequence);});
    const transport=createTransport(factory,{journal,maxEventBuffer:2});const router=new AppServerRpcRouter(transport);
    const starting=router.start();await settle();const socket=factory.sockets[0];socket.open();ready(socket);await starting;
    await vi.waitFor(()=>expect(read.mock.calls.some(([,after])=>after===blockedAfter)).toBe(true));
    const initialize=router.request({method:"initialize",id:"initialize-control",params:{clientInfo:{name:"qa",title:null,version:"1"},capabilities:null}},200);
    void initialize.catch(()=>{});
    try {
      await vi.waitFor(()=>expect(socket.sent.some((frame)=>typeof frame==="object"&&frame!==null&&"type"in frame&&frame.type==="request")).toBe(true));
      socket.receive({protocolVersion:1,type:"accepted",clientRequestId:"initialize-control"});
      socket.receive({protocolVersion:1,type:"event",event:{eventId:"live-warning-6",sequence:6,occurredAt:"2026-08-28T00:00:01.000Z",message:{kind:"rpc-notification",rpc:{method:"warning",params:{threadId:null,message:"live activity retains its order"}}}}});
      socket.receive({protocolVersion:1,type:"event",event:{eventId:"live-init-7",sequence:7,occurredAt:"2026-08-28T00:00:01.000Z",message:{kind:"rpc-response",rpc:{id:"initialize-control",result:{userAgent:"qa"}}}}});
      if(releaseWithResponse)unblock();
      await expect(initialize).resolves.toEqual({userAgent:"qa"});
      expect(journal.events).toContainEqual({eventId:"live-init-7",sequence:7});
      expect(journal.events.filter(event=>event.sequence===7)).toHaveLength(1);
      if(!releaseWithResponse)expect(delivered).not.toContain(7);
      unblock();await vi.waitFor(()=>expect(delivered).toEqual([1,2,3,4,5,6,7]));
    } finally {unblock();await router.close();await transport.close();}
  });

  it("streams a durable backlog larger than the live event buffer", async () => {
    const factory = new FakeSocketFactory();
    const backlog = Array.from({ length: 5 }, (_, index): AppServerEvent => ({
      eventId: `backlog-${index + 1}`,
      sequence: index + 1,
      occurredAt: "2026-08-28T00:00:00.000Z",
      message: {
        kind: "rpc-notification",
        rpc: { method: "warning", params: { threadId: null, message: `event ${index + 1}` } },
      },
    }));
    const journal = new MemoryJournal(
      { eventId: "backlog-5", sequence: 5 },
      backlog,
    );
    const transport = createTransport(factory, { journal, maxEventBuffer: 2 });
    const connecting = transport.connect();
    await settle();
    const socket = factory.sockets[0];
    socket.open();
    ready(socket);
    await connecting;

    const received: number[] = [];
    for await (const event of transport.events()) {
      received.push(event.sequence);
      if (received.length === backlog.length) break;
    }
    expect(received).toEqual([1, 2, 3, 4, 5]);
    expect(socket.closeCalls).toEqual([]);
    await transport.close();
  });

  it("rejects a replay gap when no durable cursor exists", async () => {
    const factory = new FakeSocketFactory();
    const transport = createTransport(factory);
    const connecting = transport.connect();
    await settle();
    const socket = factory.sockets[0];
    socket.open();
    ready(socket);
    await connecting;

    socket.receive({
      protocolVersion: 1,
      type: "event",
      event: {
        eventId: "event-2",
        sequence: 2,
        occurredAt: "2026-08-27T00:00:00.000Z",
        message: { kind: "rpc-notification", rpc: { method: "warning", params: {} } },
      },
    });
    await vi.waitFor(() => expect(socket.closeCalls.at(-1)?.code).toBe(1002));
    await transport.close();
  });

  it("retries only unaccepted submissions with exponential backoff and the same id", async () => {
    vi.useFakeTimers();
    const factory = new FakeSocketFactory();
    const transport = createTransport(factory);
    const connecting = transport.connect();
    await settle();
    const first = factory.sockets[0];
    first.open();
    ready(first);
    await connecting;
    const sending = transport.send(request);

    first.receive({ protocolVersion: 1, type: "overloaded", retryAfterMs: 500 });
    await settle();
    await vi.advanceTimersByTimeAsync(499);
    expect(factory.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(factory.sockets).toHaveLength(2);

    const second = factory.sockets[1];
    second.open();
    ready(second, "session-2");
    await settle();
    expect(second.sent.at(-1)).toEqual({ protocolVersion: 1, type: "request", request });
    second.receive({ protocolVersion: 1, type: "accepted", clientRequestId: "request-1" });
    await sending;
    await transport.close();
  });

  it("queues a request when the socket closes just before submission and sends it after reconnect", async () => {
    vi.useFakeTimers();
    const factory = new FakeSocketFactory();
    const transport = createTransport(factory);
    const connecting = transport.connect();
    await settle();
    const first = factory.sockets[0];
    first.open();
    ready(first);
    await connecting;

    first.readyState = 3;
    const sending = transport.send(request);
    await vi.advanceTimersByTimeAsync(100);
    expect(factory.sockets).toHaveLength(2);
    const second = factory.sockets[1];
    second.open();
    ready(second, "session-2");
    await settle();
    expect(second.sent.at(-1)).toEqual({ protocolVersion: 1, type: "request", request });
    second.receive({ protocolVersion: 1, type: "accepted", clientRequestId: "request-1" });
    await sending;
    await transport.close();
  });

  it("uses application heartbeat and reconnects after a missing pong", async () => {
    vi.useFakeTimers();
    const factory = new FakeSocketFactory();
    let now = 0;
    const transport = createTransport(factory, {
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 10,
      reconnectBaseDelayMs: 30,
      now: () => now,
    });
    const connecting = transport.connect();
    await settle();
    const first = factory.sockets[0];
    first.open();
    ready(first);
    await connecting;

    now = 20;
    await vi.advanceTimersByTimeAsync(20);
    expect(first.sent.at(-1)).toMatchObject({ type: "ping" });
    now = 40;
    await vi.advanceTimersByTimeAsync(20);
    expect(first.closeCalls.at(-1)?.code).toBe(1002);
    await vi.advanceTimersByTimeAsync(30);
    expect(factory.sockets).toHaveLength(2);
    await transport.close();
  });

  it("does not self-close, reconnect, or heartbeat before a three-second idle boundary", async () => {
    vi.useFakeTimers();
    const factory = new FakeSocketFactory();
    let now = 0;
    const transport = new WebSocketAppServerTransport({
      endpoint: "ws://127.0.0.1:4500/worker",
      socketFactory: factory,
      auth: { placement: "authorization-header", credentialProvider },
      journal: new InMemoryTransportEventJournal(),
      reconnectBaseDelayMs: 250,
      reconnectJitterRatio: 0,
      random: () => 0.5,
      now: () => now,
    });
    const connecting = transport.connect();
    await settle();
    const first = factory.sockets[0];
    first.open();
    ready(first);
    await connecting;

    now = 3_000;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(first.sent.filter((frame) => (frame as { type?: string }).type === "ping")).toHaveLength(0);
    expect(first.closeCalls).toEqual([]);
    expect((await transport.health())).toMatchObject({
      healthy: true,
      state: "connected",
      reconnectAttempt: 0,
      lastEventId: null,
      lastEventSequence: null,
    });
    await transport.close();
  });

  it("fails closed on malformed or binary frames", async () => {
    vi.useFakeTimers();
    const factory = new FakeSocketFactory();
    const transport = createTransport(factory);
    const connecting = transport.connect();
    await settle();
    const socket = factory.sockets[0];
    socket.open();
    ready(socket);
    await connecting;

    socket.receive({ protocolVersion: 1, type: "ready", sessionId: "again", replaySupported: true, extra: true });
    await settle();
    expect(socket.closeCalls.at(-1)?.code).toBe(1002);
    await transport.close();

    const binaryFactory = new FakeSocketFactory();
    const binaryTransport = createTransport(binaryFactory);
    const binaryConnecting = binaryTransport.connect();
    await settle();
    const binarySocket = binaryFactory.sockets[0];
    binarySocket.open();
    ready(binarySocket);
    await binaryConnecting;
    binarySocket.receiveBinary();
    await settle();
    expect(binarySocket.closeCalls.at(-1)?.code).toBe(1002);
    await binaryTransport.close();
  });

  it("bounds pending submissions and does not retain a failed send", async () => {
    const factory = new FakeSocketFactory();
    const transport = createTransport(factory, { maxPendingRequests: 1 });
    const connecting = transport.connect();
    await settle();
    const socket = factory.sockets[0];
    socket.open();
    ready(socket);
    await connecting;

    const first = transport.send(request);
    await expect(transport.send({
      clientRequestId: "request-2",
      kind: "rpc-request",
      rpc: { method: "thread/list", id: "request-2", params: { cursor: null, limit: null, sortKey: null } },
    })).rejects.toMatchObject({ code: "TRANSPORT_BACKPRESSURE" });
    socket.receive({ protocolVersion: 1, type: "accepted", clientRequestId: "request-1" });
    await first;
    await transport.close();
  });

  it("validates RPC params against the generated Codex schema", async () => {
    const factory = new FakeSocketFactory();
    const transport = createTransport(factory);
    await expect(transport.send({
      clientRequestId: "invalid-request",
      kind: "rpc-request",
      rpc: { method: "thread/read", id: "invalid-request", params: {} },
    } as AppServerRequest)).rejects.toThrow("Codex 0.162.1 schema");
    await transport.close();
  });
});

describe("private WebSocket boundary", () => {
  it("rejects public endpoints, credentials in URLs, and non-allowlisted service DNS", async () => {
    await expect(validatePrivateWebSocketEndpoint("wss://8.8.8.8/worker", {})).rejects.toThrow("private network");
    await expect(validatePrivateWebSocketEndpoint("ws://127.0.0.1/worker?token=secret", {})).rejects.toThrow("query parameters");
    await expect(validatePrivateWebSocketEndpoint("ws://worker-1:4500/worker", {})).rejects.toThrow("allowlist");
  });

  it("validates allowlisted Docker DNS and requires explicit private plaintext", async () => {
    const lookup = async () => [{ address: "172.18.0.7", family: 4 }];
    await expect(validatePrivateWebSocketEndpoint("ws://worker-1:4500/worker", {
      allowedHosts: ["worker-1"],
      lookup,
    })).rejects.toThrow("private plaintext");
    await expect(validatePrivateWebSocketEndpoint("ws://worker-1:4500/worker", {
      allowedHosts: ["worker-1"],
      allowPrivatePlaintext: true,
      lookup,
    })).resolves.toBe("ws://worker-1:4500/worker");
  });

  it("documents the standard Node/WebSocket Authorization-header limitation in behavior", async () => {
    const transport = new WebSocketAppServerTransport({
      endpoint: "ws://127.0.0.1:4500/worker",
      socketFactory: new StandardWebSocketFactory(),
      auth: { placement: "authorization-header", credentialProvider },
      journal: new InMemoryTransportEventJournal(),
      maxReconnectAttempts: 0,
    });
    await expect(transport.connect()).rejects.toThrow("cannot send the required Authorization header");
    await transport.close();
  });
});
