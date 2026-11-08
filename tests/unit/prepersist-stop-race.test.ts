import { afterEach, expect, it, vi } from "vitest";
import { PendingTurnStop, readTurnTerminalAfterStop, stopControlAccepted } from "@/ui/pending-turn-stop";
import { consumeRecoverableChatStream } from "@/ui/recoverable-chat-stream";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
const scheduler = { now: () => Date.now(), setTimeout, clearTimeout, random: () => 0.5 };

it("a rejected Stop before admission pauses retries and never establishes a terminal result", async () => {
  const sendControl = vi.fn(async () => false), onPause = vi.fn(), onBusy = vi.fn();
  const stop = new PendingTurnStop({ sendControl, onPause, onBusy });
  await stop.requestStop();
  expect(stop.retriesPaused).toBe(true); expect(stop.terminalObserved).toBe(false);
  expect(onPause).toHaveBeenCalledOnce(); expect(sendControl).toHaveBeenCalledOnce();
  expect(onBusy.mock.calls).toEqual([[true], [false]]);
});

it.each([false, true])("late admission while control is in flight schedules at most one bound follow-up (first accepted=%s)", async accepted => {
  const first = deferred<boolean>();
  const sender = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(false);
  const stop = new PendingTurnStop({ sendControl: sender, onPause: vi.fn(), onBusy: vi.fn() });
  const pending = stop.requestStop(); await flush();
  stop.confirmAdmission(); stop.confirmAdmission();
  first.resolve(accepted); await pending; await flush();
  expect(sender).toHaveBeenCalledTimes(accepted ? 1 : 2);
  expect(stop.retriesPaused).toBe(false); expect(stop.terminalObserved).toBe(false);
});

it("each Stop request records admission at dispatch, even when the first response arrives after admission", async () => {
  const first = deferred<boolean>();
  const sender = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(false);
  const stop = new PendingTurnStop({ sendControl: sender, onPause: vi.fn(), onBusy: vi.fn() });
  const pending = stop.requestStop(); await flush();
  expect(sender.mock.calls).toEqual([[{ admissionConfirmed: false }]]);
  stop.confirmAdmission();
  first.resolve(false); await pending; await flush();
  expect(sender.mock.calls).toEqual([[{ admissionConfirmed: false }], [{ admissionConfirmed: true }]]);
  expect(stop.terminalObserved).toBe(false);
});

it("late admission after a failed control retries once; a failed follow-up never loops or invents Stop", async () => {
  const sender = vi.fn(async () => false);
  const stop = new PendingTurnStop({ sendControl: sender, onPause: vi.fn(), onBusy: vi.fn() });
  await stop.requestStop(); stop.confirmAdmission(); await flush();
  expect(sender).toHaveBeenCalledTimes(2); expect(stop.terminalObserved).toBe(false);
  stop.confirmAdmission(); await flush(); expect(sender).toHaveBeenCalledTimes(2);
});

it("duplicate clicks coalesce, and terminal/disposal races do not dispatch a stale control", async () => {
  const sender = vi.fn(async () => true);
  const stop = new PendingTurnStop({ sendControl: sender, onPause: vi.fn(), onBusy: vi.fn() });
  const pending = stop.requestStop(); stop.requestStop(); stop.observeTerminal(); await pending;
  expect(sender).not.toHaveBeenCalled(); expect(stop.terminalObserved).toBe(true);
  const stale = new PendingTurnStop({ sendControl: sender, onPause: vi.fn(), onBusy: vi.fn() });
  const queued = stale.requestStop(); stale.dispose(); stale.confirmAdmission(); await queued;
  expect(sender).not.toHaveBeenCalled();
});

it("two turn coordinators cannot transfer a pending Stop to another turn", async () => {
  const senderA = vi.fn(async () => false), senderB = vi.fn(async () => true);
  const a = new PendingTurnStop({ sendControl: senderA, onPause: vi.fn(), onBusy: vi.fn() });
  const b = new PendingTurnStop({ sendControl: senderB, onPause: vi.fn(), onBusy: vi.fn() });
  await a.requestStop(); b.confirmAdmission(); await flush();
  expect(senderA).toHaveBeenCalledOnce(); expect(senderB).not.toHaveBeenCalled();
  a.dispose(); a.confirmAdmission(); await flush(); expect(senderA).toHaveBeenCalledOnce();
});

it("503 before persistence plus Stop blocks every further POST, including retry wakeups; stored terminal ends observation without resubmission", async () => {
  const controller = new AbortController();
  const response = deferred<Response>(); const states: unknown[] = [];
  const stop = new PendingTurnStop({ sendControl: async () => false, onPause: vi.fn(), onBusy: vi.fn() });
  const request = vi.fn(() => response.promise); let wake!: () => void;
  const run = consumeRecoverableChatStream({ request, signal: controller.signal, pendingStop: stop, scheduler,
    onEvent: vi.fn(), onMeasurement: vi.fn(), onRecoveryState: state => states.push(state),
    waitForRetry: signal => new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error("observer aborted"));
      signal.addEventListener("abort", abort, { once: true });
      wake = () => { signal.removeEventListener("abort", abort); resolve(); };
    }) });
  await stop.requestStop(); response.resolve(Response.json({ error: "synthetic persistence failure" }, { status: 503 }));
  // Response JSON consumption uses native streams; wait for the actual pause.
  for (let index = 0; index < 50 && !wake; index++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(states).toContainEqual({ state: "paused", admissionUnconfirmed: true });
  expect(request).toHaveBeenCalledOnce(); wake(); await flush();
  expect(request).toHaveBeenCalledOnce(); expect(stop.terminalObserved).toBe(false);
  stop.observeTerminal(); wake(); await run;
  expect(request).toHaveBeenCalledOnce(); expect(states.at(-1)).toEqual({ state: "idle" });
});

it("a 200 admission arriving after Stop keeps server events authoritative and uses the same pending intent", async () => {
  const response = deferred<Response>(), sender = vi.fn(async () => false), events: unknown[] = [];
  const stop = new PendingTurnStop({ sendControl: sender, onPause: vi.fn(), onBusy: vi.fn() });
  const run = consumeRecoverableChatStream({ request: () => response.promise, signal: new AbortController().signal,
    pendingStop: stop, scheduler, onAccepted: () => stop.confirmAdmission(), onEvent: event => events.push(event),
    onMeasurement: vi.fn(), onRecoveryState: vi.fn() });
  await stop.requestStop();
  response.resolve(new Response(`${JSON.stringify({ type: "done" })}\n`));
  await run; await flush();
  expect(sender).toHaveBeenCalledTimes(2); expect(events).toEqual([{ type: "done" }]);
  expect(events).not.toContainEqual({ type: "stopped" });
});


it.each([null, { ok: true }, { ok: false, action: "stop", idempotent: false },
  { ok: true, action: "steer", idempotent: false }, { ok: true, action: "stop", idempotent: "true" }])(
  "HTTP success without a valid Stop receipt is still an unconfirmed control %#", payload => {
    expect(stopControlAccepted(payload)).toBe(false);
  },
);
it("validates an accepted/idempotent control receipt without treating it as terminal Stop", () => {
  expect(stopControlAccepted({ ok: true, action: "stop", idempotent: true })).toBe(true);
  expect(stopControlAccepted({ ok: true, action: "stop", idempotent: false })).toBe(true);
});

const stopIdentity = { threadId: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222", assistantMessageId: "33333333-3333-4333-8333-333333333333" };
function stoppedSnapshot(status: "stopped" | "complete" | "error" | "streaming" = "stopped") {
  return { thread: { id: stopIdentity.threadId, projectId: stopIdentity.projectId, title: "Stop test", status: "active", pinned: false,
    createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:01.000Z", messages: [{ id: stopIdentity.assistantMessageId,
      role: "assistant", status, content: status === "error" ? "Actual server failure" : "", createdAt: "2026-11-05T00:00:00.000Z",
      activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [] }] } };
}
it.each(["stopped", "complete", "error"] as const)("a lost Stop reply resolves only to the actual exact-turn server terminal (%s)", async status => {
  const read = vi.fn<typeof fetch>(async () => Response.json(stoppedSnapshot(status))); vi.stubGlobal("fetch", read);
  const terminal = await readTurnTerminalAfterStop(stopIdentity);
  expect(terminal?.status).toBe(status);
  expect(terminal?.content).toBe(status === "error" ? "Actual server failure" : "");
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]).toEqual([`/api/threads/${stopIdentity.threadId}`, expect.objectContaining({ method: "GET", cache: "no-store", signal: expect.any(AbortSignal) })]);
});
it.each(["streaming", "different-thread", "different-project", "different-message", "user-message", "malformed", "forbidden", "transport"])(
  "a Stop failure remains unconfirmed for %s; no retry or synthetic terminal", async fault => {
    const payload = stoppedSnapshot();
    if (fault === "streaming") payload.thread.messages[0].status = "streaming";
    if (fault === "different-thread") payload.thread.id = "44444444-4444-4444-8444-444444444444";
    if (fault === "different-project") payload.thread.projectId = "44444444-4444-4444-8444-444444444444";
    if (fault === "different-message") payload.thread.messages[0].id = "44444444-4444-4444-8444-444444444444";
    if (fault === "user-message") Object.assign(payload.thread.messages[0], { role: "user" });
    const read = vi.fn(async () => {
      if (fault === "transport") throw new Error("offline");
      return Response.json(fault === "malformed" ? { thread: { messages: [{ status: "stopped" }] } } : payload, { status: fault === "forbidden" ? 403 : 200 });
    }); vi.stubGlobal("fetch", read);
    expect(await readTurnTerminalAfterStop(stopIdentity)).toBeNull(); expect(read).toHaveBeenCalledOnce();
  },
);
it("a terminal stream/snapshot arriving during an unavailable Stop request prevents a late control failure from reopening retries", async () => {
  const control = deferred<boolean>(); const sender = vi.fn(() => control.promise);
  const stop = new PendingTurnStop({ sendControl: sender, onPause: vi.fn(), onBusy: vi.fn() });
  stop.confirmAdmission(); const run = stop.requestStop(); await flush();
  stop.observeTerminal(); control.resolve(false); await run; stop.confirmAdmission(); await stop.requestStop();
  expect(sender).toHaveBeenCalledOnce(); expect(stop.terminalObserved).toBe(true); expect(stop.retriesPaused).toBe(false);
});
