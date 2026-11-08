import { performance } from "node:perf_hooks";
import type { ChatStreamEvent } from "../src/lib/chat-contract";
import { ClientTurnPerformance } from "../src/ui/client-turn-performance";
import {
  CHAT_DELTA_MAX_BATCH_WAIT_MS,
  createChatEventFrameDispatcher,
} from "../src/ui/frame-event-dispatcher";

type Scheduled = { at: number; callback: () => void };

class ControlledBrowserScheduler {
  nowMs = 0;
  private nextHandle = 1;
  private readonly frames = new Map<number, Scheduled>();
  private readonly timers = new Map<number, Scheduled>();

  request = (callback: () => void) => {
    const handle = this.nextHandle++;
    this.frames.set(handle, { at: this.nowMs + 16, callback });
    return handle;
  };

  cancel = (handle: number) => { this.frames.delete(handle); };

  setTimeout = (callback: () => void, delayMs: number) => {
    const handle = this.nextHandle++;
    this.timers.set(handle, { at: this.nowMs + delayMs, callback });
    return handle as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimeout = (handle: ReturnType<typeof setTimeout>) => {
    this.timers.delete(handle as unknown as number);
  };

  advance(milliseconds: number, runFrames = true) {
    this.nowMs += milliseconds;
    this.runDue(this.timers);
    if (runFrames) this.runDue(this.frames);
  }

  private runDue(queue: Map<number, Scheduled>) {
    let due = [...queue.entries()]
      .filter(([, scheduled]) => scheduled.at <= this.nowMs)
      .sort(([, left], [, right]) => left.at - right.at)[0];
    while (due) {
      queue.delete(due[0]);
      due[1].callback();
      due = [...queue.entries()]
        .filter(([, scheduled]) => scheduled.at <= this.nowMs)
        .sort(([, left], [, right]) => left.at - right.at)[0];
    }
  }
}

const scheduler = new ControlledBrowserScheduler();
const applied: ChatStreamEvent[] = [];
let latestReadback = null as ReturnType<ClientTurnPerformance["readback"]> | null;
const metric = new ClientTurnPerformance(
  (readback) => { latestReadback = readback; },
  { now: () => scheduler.nowMs, request: scheduler.request },
  0,
);
const dispatcher = createChatEventFrameDispatcher(
  (event) => applied.push(event),
  scheduler,
  { onEventApplied: (event) => metric.eventApplied(event) },
);

metric.feedbackApplied("local");
scheduler.advance(16);
metric.transportMeasured({
  responseOpenedAtMs: 16,
  responseAcceptedAtMs: 16,
  lastEventAtMs: null,
  idleObservedAtMs: null,
  closedAtMs: null,
  closeCode: null,
  closeReason: null,
  recoveryStartedAtMs: null,
  recoveryAttempts: 0,
  snapshotObservedAtMs: null,
  bannerShownAtMs: null,
});
metric.feedbackApplied("accepted");
scheduler.advance(16);

const firstDeltaArrivedAt = scheduler.nowMs;
dispatcher.dispatch({ type: "delta", value: "first" });
const immediateApplied = applied.length;
scheduler.advance(16);
const firstDeltaPaintedAt = scheduler.nowMs;

const burstStartedAt = performance.now();
for (let index = 0; index < 10_000; index += 1) {
  dispatcher.dispatch({ type: "delta", value: "x" });
}
const burstDispatchCpuMs = performance.now() - burstStartedAt;
const appliedBeforeBurstFrame = applied.length;
scheduler.advance(16);
const appliedAfterBurstFrame = applied.length;
// Observe the paint scheduled by the coalesced burst, then a real terminal
// paint. The resulting cadence readback measures the visible sequence rather
// than treating first-delta latency as a proxy for the whole stream.
scheduler.advance(16);
dispatcher.dispatch({ type: "done" });
scheduler.advance(16);
const visibleStreaming = metric.readback();
dispatcher.close();

const fallbackScheduler = new ControlledBrowserScheduler();
const fallbackApplied: ChatStreamEvent[] = [];
const fallbackDispatcher = createChatEventFrameDispatcher(
  (event) => fallbackApplied.push(event),
  fallbackScheduler,
);
fallbackDispatcher.dispatch({ type: "delta", value: "first" });
fallbackDispatcher.dispatch({ type: "delta", value: "second" });
fallbackScheduler.advance(CHAT_DELTA_MAX_BATCH_WAIT_MS, false);

console.log(JSON.stringify({
  benchmark: "chat-client-pipeline",
  scope: "controlled client scheduling; excludes network, server queue and model latency",
  frameIntervalMs: 16,
  initialFeedbackPaintMs: latestReadback?.sendIntentToFirstFeedbackPaintMs ?? null,
  responseAcceptedToFeedbackPaintMs: latestReadback?.responseAcceptedToFeedbackPaintMs ?? null,
  responseAcceptedFeedbackWithinBudget: latestReadback?.responseAcceptedFeedbackWithinBudget ?? null,
  firstDeltaAppliedSynchronously: immediateApplied === 1,
  firstDeltaArrivalToPaintProxyMs: firstDeltaPaintedAt - firstDeltaArrivedAt,
  visibleStreaming: {
    paintCount: visibleStreaming.paintCount,
    interPaintP50Ms: visibleStreaming.interPaintP50Ms,
    interPaintP95Ms: visibleStreaming.interPaintP95Ms,
    interPaintMaxMs: visibleStreaming.interPaintMaxMs,
    sendIntentToTerminalPaintMs: visibleStreaming.sendIntentToTerminalPaintMs,
    terminal: visibleStreaming.terminal,
  },
  longSequence: {
    inputDeltaCount: 10_000,
    appliedEventsBeforeFrame: appliedBeforeBurstFrame,
    appliedEventsAfterFrame: appliedAfterBurstFrame,
    dispatchCpuMs: Number(burstDispatchCpuMs.toFixed(3)),
  },
  rafFallbackMs: fallbackApplied.length === 2 ? CHAT_DELTA_MAX_BATCH_WAIT_MS : null,
}, null, 2));
