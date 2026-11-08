import { describe, expect, it, vi } from "vitest";
import {
  consumeRecoverableChatStream,
  type ChatStreamRecoveryScheduler,
} from "@/ui/recoverable-chat-stream";
import { createChatReattachRequest } from "@/ui/chat-reattach-request";
import { applyChatStreamEvent, type ChatMessage, type ChatStreamEvent } from "@/lib/chat-contract";

class ControlledScheduler {
  nowMs = 0;
  private nextHandle = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  readonly api: ChatStreamRecoveryScheduler = {
    now: () => this.nowMs,
    setTimeout: (callback, delayMs) => {
      const handle = this.nextHandle++;
      this.timers.set(handle, { at: this.nowMs + delayMs, callback });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => { this.timers.delete(handle as unknown as number); },
    random: () => 0.5,
  };

  advance(milliseconds: number) {
    this.nowMs += milliseconds;
    this.runDue();
  }

  runNext() {
    const next = [...this.timers.entries()].sort(([, left], [, right]) => left.at - right.at)[0];
    if (!next) throw new Error("No timer is pending");
    this.timers.delete(next[0]);
    this.nowMs = Math.max(this.nowMs, next[1].at);
    next[1].callback();
  }

  hasPending() {
    return this.timers.size > 0;
  }

  private runDue() {
    let due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.nowMs)
      .sort(([, left], [, right]) => left.at - right.at)[0];
    while (due) {
      this.timers.delete(due[0]);
      due[1].callback();
      due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.nowMs)
        .sort(([, left], [, right]) => left.at - right.at)[0];
    }
  }
}

const encoder = new TextEncoder();

function response(events: ChatStreamEvent[]) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      events.forEach((event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)));
      controller.close();
    },
  }));
}

function controlledResponse() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({ start(next) { controller = next; } });
  return {
    response: new Response(body),
    emit(event: ChatStreamEvent) { controller?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); },
    close() { controller?.close(); },
    heartbeat() { controller?.enqueue(encoder.encode("\n")); },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("recoverable chat stream", () => {
  it.each(["complete", "stopped", "error"] as const)("accepts a terminal %s snapshot without another reattach", async (status) => {
    const scheduler = new ControlledScheduler();
    const request = vi.fn(async () => response([{ type: "snapshot", message: {
      id: "assistant-turn", role: "assistant", content: "Persisted answer", status,
      createdAt: "2026-08-28T12:00:00.000Z", activity: [], plan: [], approvals: [],
      diff: "", attachments: [], artifacts: [], sources: [], toolResults: [],
    } }]));
    const states: unknown[] = [];
    const run = consumeRecoverableChatStream({ request, signal: new AbortController().signal,
      onEvent: () => undefined, onRecoveryState: (state) => states.push(state),
      onMeasurement: () => undefined, scheduler: scheduler.api });
    // Baseline schedules recovery despite already receiving a durable terminal.
    await vi.waitFor(() => expect(states.length).toBeGreaterThan(0));
    expect(states).toEqual([{ state: "idle" }]);
    await run;
    expect(request).toHaveBeenCalledOnce();
    expect(scheduler.hasPending()).toBe(false);
  });
  it("observes idle beyond three seconds without showing recovery or closing a healthy stream", async () => {
    const scheduler = new ControlledScheduler();
    const source = controlledResponse();
    const measurements: unknown[] = [];
    const states: unknown[] = [];
    const accepted = vi.fn();
    let receivedDelta: (() => void) | null = null;
    const received = new Promise<void>((resolve) => { receivedDelta = resolve; });
    const run = consumeRecoverableChatStream({
      request: vi.fn(async () => source.response),
      signal: new AbortController().signal,
      onEvent: (event) => { if (event.type === "delta") receivedDelta?.(); },
      onAccepted: accepted,
      onRecoveryState: (state) => states.push(state),
      onMeasurement: (measurement) => measurements.push(measurement),
      scheduler: scheduler.api,
      startedAt: 0,
    });
    source.emit({ type: "delta", value: "visible only in the message" });
    await received;
    scheduler.advance(3_001);
    expect(states).toEqual([]);
    expect(accepted).toHaveBeenCalledOnce();
    expect(measurements.at(-1)).toMatchObject({ responseAcceptedAtMs: 0, idleObservedAtMs: 3001, recoveryAttempts: 0, bannerShownAtMs: null });

    source.emit({ type: "done" });
    source.close();
    await run;
  });

  it("treats an EOF at about three seconds as recovery and reattaches through a snapshot", async () => {
    const scheduler = new ControlledScheduler();
    const first = controlledResponse();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => fetcher.mock.calls.length === 1
      ? first.response
      : response([{ type: "snapshot", message: {
        id: "assistant-turn", role: "assistant", content: "snapshot text", status: "streaming", createdAt: "2026-08-28T12:00:00.000Z",
        activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [], sources: [], toolResults: [],
      } }, { type: "done" }]));
    const request = createChatReattachRequest(JSON.stringify({ threadId: "thread-current", assistantMessageId: "assistant-turn", userMessageId: "user-current" }), fetcher);
    const measurements: unknown[] = [];
    const states: unknown[] = [];
    const events: ChatStreamEvent[] = [];
    const accepted = vi.fn();
    const run = consumeRecoverableChatStream({
      request,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      onAccepted: accepted,
      onRecoveryState: (state) => states.push(state),
      onMeasurement: (measurement) => measurements.push(measurement),
      scheduler: scheduler.api,
      startedAt: 0,
    });
    first.emit({ type: "delta", value: "first fragment" });
    await flush();
    scheduler.advance(3_000);
    first.close();
    await flush();
    expect(measurements.at(-1)).toMatchObject({ closedAtMs: 3000, closeCode: null, closeReason: "stream-ended", recoveryAttempts: 1 });
    scheduler.runNext();
    await run;

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(accepted).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.map(([, init]) => init?.body)).toEqual([
      fetcher.mock.calls[0]?.[1]?.body,
      fetcher.mock.calls[0]?.[1]?.body,
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      threadId: "thread-current", assistantMessageId: "assistant-turn", userMessageId: "user-current",
    });
    expect(events.map((event) => event.type)).toEqual(["delta", "snapshot", "done"]);
    const initialMessage: ChatMessage = {
      id: "assistant-turn", role: "assistant", content: "", status: "streaming", createdAt: "2026-08-28T12:00:00.000Z",
      activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [], sources: [], toolResults: [],
    };
    const projected = events.reduce(applyChatStreamEvent, initialMessage);
    expect(projected.content).toBe("snapshot text");
    expect(projected.content).not.toContain("first fragmentfirst fragment");
    expect(states).toContainEqual({ state: "recovering", attempt: 1 });
    expect(states).toContainEqual({ state: "recovered" });
    expect(states).toContainEqual({ state: "idle" });
    expect(JSON.stringify(measurements.at(-1))).not.toContain("snapshot text");
  });

  it("backs off a retryable worker-restart response without sharing state between consumers", async () => {
    const schedulerA = new ControlledScheduler();
    const schedulerB = new ControlledScheduler();
    const first = vi.fn(async () => first.mock.calls.length === 1
      ? new Response("restart", { status: 503 })
      : response([{ type: "snapshot", message: {
        id: "turn-a", role: "assistant", content: "a", status: "streaming", createdAt: "2026-08-28T12:00:00.000Z",
        activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [], sources: [], toolResults: [],
      } }, { type: "done" }]));
    const second = vi.fn(async () => response([{ type: "done" }]));
    const eventsA: ChatStreamEvent[] = [];
    const eventsB: ChatStreamEvent[] = [];
    const runA = consumeRecoverableChatStream({ request: first, signal: new AbortController().signal, onEvent: (event) => eventsA.push(event), onRecoveryState: () => undefined, onMeasurement: () => undefined, scheduler: schedulerA.api, startedAt: 0 });
    const runB = consumeRecoverableChatStream({ request: second, signal: new AbortController().signal, onEvent: (event) => eventsB.push(event), onRecoveryState: () => undefined, onMeasurement: () => undefined, scheduler: schedulerB.api, startedAt: 0 });
    await flush();
    schedulerA.runNext();
    // A separate active identity/turn has its own runner and is never touched by A's retry.
    await runB;
    await runA;
    expect(first).toHaveBeenCalledTimes(2);
    expect(eventsA.map((event) => event.type)).toEqual(["snapshot", "done"]);
    expect(eventsB).toEqual([{ type: "done" }]);
  });

  it("preserves a sanitized server error after retrying a temporary HTTP failure", async () => {
    const scheduler = new ControlledScheduler();
    const states: unknown[] = [];
    const request = vi.fn(async () => Response.json({
      error: "Servicio sintético no disponible.",
      internal: "must not be shown",
    }, { status: 503 }));
    const run = consumeRecoverableChatStream({
      request,
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onRecoveryState: state => states.push(state),
      onMeasurement: () => undefined,
      scheduler: scheduler.api,
      startedAt: 0,
    });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await vi.waitFor(() => expect(states).toContainEqual({ state: "recovering", attempt: attempt + 1 }));
      scheduler.runNext();
    }

    await expect(run).rejects.toThrow("Servicio sintético no disponible.");
    expect(request).toHaveBeenCalledTimes(9);
  });

  it.each([400, 403])("returns a non-retryable HTTP %s error immediately", async status => {
    const scheduler = new ControlledScheduler();
    const request = vi.fn(async () => Response.json({ error: "La petición no es válida.", retryable: true }, { status }));
    const run = consumeRecoverableChatStream({
      request,
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onRecoveryState: () => undefined,
      onMeasurement: () => undefined,
      scheduler: scheduler.api,
      startedAt: 0,
    });

    await expect(run).rejects.toThrow("La petición no es válida.");
    expect(request).toHaveBeenCalledTimes(1);
    expect(scheduler.hasPending()).toBe(false);
  });

  it("surfaces a permanent pre-admission 503 once without reconnecting or admitting a turn", async () => {
    const scheduler = new ControlledScheduler();
    const request = vi.fn(async () => Response.json({ error: "Revisa la configuración.", retryable: false }, { status: 503 }));
    const accepted = vi.fn(), states = vi.fn(), events = vi.fn();
    const run = consumeRecoverableChatStream({ request, signal: new AbortController().signal,
      onEvent: events, onAccepted: accepted, onRecoveryState: states, onMeasurement: () => undefined,
      scheduler: scheduler.api, startedAt: 0 });
    await expect(run).rejects.toThrow("Revisa la configuración.");
    expect(request).toHaveBeenCalledTimes(1);
    expect(accepted).not.toHaveBeenCalled();
    expect(states).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(scheduler.hasPending()).toBe(false);
  });
});

describe("bounded transport recovery without replaying work", () => {
  const saved = (content = "Saved result", status: ChatMessage["status"] = "complete"): ChatMessage => ({
    id: "same-assistant", role: "assistant", content, status, createdAt: "2026-09-08T00:00:00.000Z",
    activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [], sources: [], toolResults: [],
  });
  it("survives a twelve-second outage using exactly the same turn identity", async () => {
    const scheduler = new ControlledScheduler();
    const states: Array<{ state: string; attempt?: number }> = [];
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body);
      if (scheduler.nowMs < 12_000) throw new TypeError("network unavailable");
      return response([{ type: "snapshot", message: saved() }]);
    });
    const events: ChatStreamEvent[] = [];
    const run = consumeRecoverableChatStream({ request: createChatReattachRequest('{"assistantMessageId":"same-assistant"}', fetcher),
      signal: new AbortController().signal, scheduler: scheduler.api,
      onEvent: event => events.push(event), onRecoveryState: state => states.push(state), onMeasurement: () => undefined });
    for (let attempt = 1; attempt <= 4; attempt++) {
      await vi.waitFor(() => expect(states).toContainEqual({ state: "recovering", attempt }));
      scheduler.runNext();
    }
    await run;
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(new Set(bodies).size).toBe(1);
    expect(events).toEqual([{ type: "snapshot", message: saved() }]);
  });

  it("pauses after a bounded retry window and resumes on explicit retry without inventing a failed result", async () => {
    const scheduler = new ControlledScheduler();
    const states: Array<{ state: string; attempt?: number }> = [];
    const events: ChatStreamEvent[] = [];
    let restored = false;
    let resume!: () => void;
    const request = vi.fn(async () => {
      if (restored) return response([{ type: "snapshot", message: saved() }]);
      if (request.mock.calls.length === 1) return response([{ type: "snapshot", message: saved("Partial", "streaming") }]);
      throw new TypeError("offline");
    });
    const run = consumeRecoverableChatStream({ request, signal: new AbortController().signal,
      scheduler: scheduler.api, onEvent: event => events.push(event), onMeasurement: () => undefined,
      onRecoveryState: state => states.push(state), waitForRetry: () => new Promise(resolve => { resume = resolve; }) });
    for (let attempt = 1; attempt <= 8; attempt++) {
      await vi.waitFor(() => expect(states).toContainEqual({ state: "recovering", attempt }));
      scheduler.runNext();
    }
    await vi.waitFor(() => expect(states).toContainEqual({ state: "paused" }));
    scheduler.advance(300_000);
    expect(request).toHaveBeenCalledTimes(9);
    expect(events.some(event => event.type === "error")).toBe(false);
    restored = true;
    resume();
    await flush();
    scheduler.runNext();
    await run;
    expect(events.at(-1)).toEqual({ type: "snapshot", message: saved() });
  });

  it("bounds a request that never opens and aborts only that transport attempt", async () => {
    const scheduler = new ControlledScheduler();
    const states: unknown[] = [];
    let timedOut = false;
    const parent = new AbortController();
    const request = vi.fn((signal: AbortSignal) => request.mock.calls.length === 1
      ? new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => { timedOut = true; reject(signal.reason); }, { once: true }))
      : Promise.resolve(response([{ type: "snapshot", message: saved() }])));
    const run = consumeRecoverableChatStream({ request, signal: parent.signal, scheduler: scheduler.api,
      onEvent: () => undefined, onRecoveryState: state => states.push(state), onMeasurement: () => undefined });
    scheduler.advance(40_000);
    await vi.waitFor(() => expect(states).toContainEqual({ state: "recovering", attempt: 1 }));
    expect(timedOut).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    scheduler.runNext();
    await run;
  });

  it("keeps a quiet stream with heartbeat bytes and completes without waiting for EOF", async () => {
    const scheduler = new ControlledScheduler();
    const source = controlledResponse();
    const accepted = vi.fn();
    const states: unknown[] = [];
    const request = vi.fn(async () => source.response);
    const run = consumeRecoverableChatStream({ request, signal: new AbortController().signal, scheduler: scheduler.api,
      onAccepted: accepted, onEvent: () => undefined, onRecoveryState: state => states.push(state), onMeasurement: () => undefined });
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    for (let i = 0; i < 3; i++) { scheduler.advance(30_000); source.heartbeat(); await flush(); }
    expect(states).toEqual([]);
    source.emit({ type: "done" }); // Deliberately no EOF.
    await run;
    expect(request).toHaveBeenCalledOnce();
    expect(scheduler.hasPending()).toBe(false);
  });

  it("reattaches a silently dead stream after missing heartbeats", async () => {
    const scheduler = new ControlledScheduler();
    const source = controlledResponse();
    const accepted = vi.fn();
    const states: unknown[] = [];
    const request = vi.fn(async () => request.mock.calls.length === 1 ? source.response
      : response([{ type: "snapshot", message: saved() }]));
    const run = consumeRecoverableChatStream({ request, signal: new AbortController().signal, scheduler: scheduler.api,
      onAccepted: accepted, onEvent: () => undefined, onRecoveryState: state => states.push(state), onMeasurement: () => undefined });
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    scheduler.advance(45_000);
    await vi.waitFor(() => expect(states).toContainEqual({ state: "recovering", attempt: 1 }));
    scheduler.runNext();
    await run;
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("pauses repeated silent snapshots instead of renewing the recovery budget forever", async () => {
    const scheduler = new ControlledScheduler();
    const states: Array<{ state: string }> = [];
    const parent = new AbortController();
    const request = vi.fn(async () => {
      const stream = controlledResponse();
      stream.emit({ type: "snapshot", message: saved("Partial", "streaming") });
      return stream.response;
    });
    const run = consumeRecoverableChatStream({ request, signal: parent.signal, scheduler: scheduler.api,
      onEvent: () => undefined, onRecoveryState: state => states.push(state), onMeasurement: () => undefined,
      waitForRetry: signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))) });
    const rejected = expect(run).rejects.toThrow("test complete");
    for (let i = 0; i < 20 && !states.some(s => s.state === "paused"); i++) {
      await flush();
      if (scheduler.hasPending()) scheduler.runNext();
    }
    await vi.waitFor(() => expect(states).toContainEqual({ state: "paused" }));
    expect(request.mock.calls.length).toBeLessThan(6);
    const count = request.mock.calls.length;
    scheduler.advance(300_000);
    expect(request).toHaveBeenCalledTimes(count);
    parent.abort(new Error("test complete"));
    await rejected;
  });

  it("bounds repeated recovery-pending snapshots with keepalives and resumes all 13 admitted attachments", async () => {
    const scheduler = new ControlledScheduler();
    const states: Array<{ state: string; attempt?: number }> = [];
    const events: ChatStreamEvent[] = [];
    const streams: ReturnType<typeof controlledResponse>[] = [];
    const admittedBody = JSON.stringify({
      threadId: "same-thread", userMessageId: "same-user-message", assistantMessageId: "same-assistant",
      message: "Review these invoices", options: { documentUploadIds: Array.from({ length: 13 }, (_, i) => `invoice-${i}`) },
    });
    let restored = false;
    let resume!: () => void;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      if (restored) return response([{ type: "snapshot", message: saved() }]);
      const source = controlledResponse();
      source.emit({ type: "snapshot", message: saved("", "streaming") });
      source.emit({ type: "activity", item: { id: "runtime-thread", kind: "system", label: "Recuperant la conversa", status: "running" } });
      streams.push(source);
      return source.response;
    });
    const run = consumeRecoverableChatStream({
      request: createChatReattachRequest(admittedBody, fetcher), signal: new AbortController().signal,
      scheduler: scheduler.api, onEvent: event => events.push(event), onMeasurement: () => undefined,
      onRecoveryState: state => states.push(state), waitForRetry: () => new Promise(resolve => { resume = resolve; }),
    });
    for (let index = 0; index < 6; index++) {
      await vi.waitFor(() => expect(streams).toHaveLength(index + 1));
      scheduler.advance(30_000);
      streams[index].heartbeat();
      await flush();
      streams[index].close(); // Worker recovery remains pending; no terminal result.
      await vi.waitFor(() => expect(states.at(-1)?.state === "paused" || states.some(state => state.state === "recovering" && state.attempt === index + 1)).toBe(true));
      if (states.at(-1)?.state === "paused") break;
      scheduler.runNext();
    }
    expect(states.at(-1)).toEqual({ state: "paused" });
    const count = fetcher.mock.calls.length;
    scheduler.advance(300_000);
    expect(fetcher).toHaveBeenCalledTimes(count);
    expect(events.some(event => event.type === "error")).toBe(false);
    restored = true;
    resume();
    await flush();
    scheduler.runNext();
    await run;
    expect(events.at(-1)).toEqual({ type: "snapshot", message: saved() });
    expect(fetcher.mock.calls.every(([, init]) => init?.body === admittedBody)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(count + 1);
  });

  it.each([401, 503])("pauses a non-retryable HTTP %s after uncertain admission without fabricating a terminal error", async status => {
    const scheduler = new ControlledScheduler();
    const events: ChatStreamEvent[] = [];
    const states: unknown[] = [];
    const parent = new AbortController();
    const request = vi.fn(async () => {
      if (request.mock.calls.length === 1) throw new TypeError("lost admission response");
      return Response.json({ error: "Request cannot be retried automatically", retryable: false }, { status });
    });
    const run = consumeRecoverableChatStream({ request, signal: parent.signal, scheduler: scheduler.api,
      onEvent: event => events.push(event), onRecoveryState: state => states.push(state), onMeasurement: () => undefined,
      waitForRetry: signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))) });
    const rejected = expect(run).rejects.toThrow("test complete");
    await vi.waitFor(() => expect(states).toContainEqual({ state: "recovering", attempt: 1 }));
    scheduler.runNext();
    await vi.waitFor(() => expect(states).toContainEqual({ state: "paused" }));
    expect(events).toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
    parent.abort(new Error("test complete"));
    await rejected;
  });

});
