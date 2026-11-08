import type { ChatStreamEvent } from "@/lib/chat-contract";
import type { ChatStreamRecoveryMeasurement } from "@/ui/recoverable-chat-stream";

const MAX_PAINT_GAPS = 128;

export type ClientTurnPerformanceTerminal = "completed" | "error" | "stopped";

export type ClientTurnPerformanceReadback = Readonly<{
  schemaVersion: 2;
  sendIntentToFirstFeedbackPaintMs: number | null;
  responseAcceptedToFeedbackPaintMs: number | null;
  responseAcceptedFeedbackWithinBudget: boolean | null;
  sendIntentToFirstDeltaPaintMs: number | null;
  paintCount: number;
  interPaintP50Ms: number | null;
  interPaintP95Ms: number | null;
  interPaintMaxMs: number | null;
  terminal: ClientTurnPerformanceTerminal | null;
  sendIntentToTerminalPaintMs: number | null;
  reconnectCount: number;
  reconnectToSnapshotVisibleP50Ms: number | null;
  reconnectToSnapshotVisibleP95Ms: number | null;
  reconnectToSnapshotVisibleMaxMs: number | null;
  reconnectToCaughtUpP50Ms: number | null;
  reconnectToCaughtUpP95Ms: number | null;
  reconnectToCaughtUpMaxMs: number | null;
  transport: ChatStreamRecoveryMeasurement;
}>;

export type ClientPaintScheduler = Readonly<{
  now: () => number;
  request: (callback: () => void) => number;
}>;

const browserScheduler: ClientPaintScheduler = {
  now: () => performance.now(),
  request: (callback) => window.requestAnimationFrame(callback),
};

export const CLIENT_TURN_PERFORMANCE_BUDGET_MS = Object.freeze({
  acceptedFeedbackPaint: 1_000,
});

function percentile(values: readonly number[], ratio: number) {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? null;
}

function summary(values: readonly number[]) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  };
}

function appendBounded(values: number[], value: number, limit: number) {
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

/**
 * Client-only, payload-free paint timing for one visible turn. The readback
 * intentionally contains no prompt, response text, identifiers, tokens or
 * error details, so it is safe to show only within an authenticated session
 * or to export explicitly as a user-owned diagnostic file.
 */
export class ClientTurnPerformance {
  private readonly startedAt: number;
  private firstFeedbackPaintedAt: number | null = null;
  private acceptedFeedbackPaintedAt: number | null = null;
  private firstDeltaPaintedAt: number | null = null;
  private previousPaintedAt: number | null = null;
  private readonly interPaintGaps: number[] = [];
  private terminal: ClientTurnPerformanceTerminal | null = null;
  private terminalPaintedAt: number | null = null;
  private reconnectStartedAt: number | null = null;
  private reconnectCount = 0;
  private readonly reconnectSnapshotVisible: number[] = [];
  private readonly reconnectCaughtUp: number[] = [];
  private transport: ChatStreamRecoveryMeasurement = {
    responseOpenedAtMs: null,
    responseAcceptedAtMs: null,
    lastEventAtMs: null,
    idleObservedAtMs: null,
    closedAtMs: null,
    closeCode: null,
    closeReason: null,
    recoveryStartedAtMs: null,
    recoveryAttempts: 0,
    snapshotObservedAtMs: null,
    bannerShownAtMs: null,
  };

  constructor(
    private readonly onReadback: (readback: ClientTurnPerformanceReadback) => void,
    private readonly scheduler: ClientPaintScheduler = browserScheduler,
    startedAt = scheduler.now(),
  ) {
    this.startedAt = startedAt;
  }

  reconnectStarted(at = this.scheduler.now()) {
    this.reconnectCount += 1;
    this.reconnectStartedAt = at;
    this.publish();
  }

  feedbackApplied(kind: "local" | "accepted") {
    this.scheduler.request(() => {
      const paintedAt = this.scheduler.now();
      const firstFeedback = this.firstFeedbackPaintedAt === null;
      this.firstFeedbackPaintedAt ??= paintedAt;
      if (kind === "accepted") this.acceptedFeedbackPaintedAt ??= paintedAt;
      if (firstFeedback || kind === "accepted") this.publish();
    });
  }

  eventApplied(event: ChatStreamEvent) {
    if (event.type === "delta" && event.value) {
      this.scheduler.request(() => this.deltaPainted());
      return;
    }
    if (event.type === "snapshot" && this.reconnectStartedAt !== null) {
      this.scheduler.request(() => this.snapshotPainted());
      return;
    }
    if (event.type === "done") this.scheduleTerminal("completed");
    else if (event.type === "stopped") this.scheduleTerminal("stopped");
    else if (event.type === "error") this.scheduleTerminal("error");
  }

  terminalStateApplied(terminal: ClientTurnPerformanceTerminal) {
    this.scheduleTerminal(terminal);
  }

  transportMeasured(measurement: ChatStreamRecoveryMeasurement) {
    this.transport = measurement;
  }

  readback(): ClientTurnPerformanceReadback {
    const interPaint = summary(this.interPaintGaps);
    const reconnectSnapshot = summary(this.reconnectSnapshotVisible);
    const reconnectCaughtUp = summary(this.reconnectCaughtUp);
    return {
      schemaVersion: 2,
      sendIntentToFirstFeedbackPaintMs: this.firstFeedbackPaintedAt === null
        ? null
        : Math.max(0, Math.round(this.firstFeedbackPaintedAt - this.startedAt)),
      responseAcceptedToFeedbackPaintMs: this.acceptedFeedbackPaintedAt === null || this.transport.responseAcceptedAtMs === null
        ? null
        : Math.max(0, Math.round(this.acceptedFeedbackPaintedAt - this.startedAt - this.transport.responseAcceptedAtMs)),
      responseAcceptedFeedbackWithinBudget: this.acceptedFeedbackPaintedAt === null || this.transport.responseAcceptedAtMs === null
        ? null
        : this.acceptedFeedbackPaintedAt - this.startedAt - this.transport.responseAcceptedAtMs <=
          CLIENT_TURN_PERFORMANCE_BUDGET_MS.acceptedFeedbackPaint,
      sendIntentToFirstDeltaPaintMs: this.firstDeltaPaintedAt === null
        ? null
        : Math.max(0, Math.round(this.firstDeltaPaintedAt - this.startedAt)),
      paintCount: this.firstDeltaPaintedAt === null ? 0 : this.interPaintGaps.length + 1,
      interPaintP50Ms: interPaint.p50,
      interPaintP95Ms: interPaint.p95,
      interPaintMaxMs: interPaint.max,
      terminal: this.terminal,
      sendIntentToTerminalPaintMs: this.terminalPaintedAt === null
        ? null
        : Math.max(0, Math.round(this.terminalPaintedAt - this.startedAt)),
      reconnectCount: this.reconnectCount,
      reconnectToSnapshotVisibleP50Ms: reconnectSnapshot.p50,
      reconnectToSnapshotVisibleP95Ms: reconnectSnapshot.p95,
      reconnectToSnapshotVisibleMaxMs: reconnectSnapshot.max,
      reconnectToCaughtUpP50Ms: reconnectCaughtUp.p50,
      reconnectToCaughtUpP95Ms: reconnectCaughtUp.p95,
      reconnectToCaughtUpMaxMs: reconnectCaughtUp.max,
      transport: this.transport,
    };
  }

  private deltaPainted() {
    const paintedAt = this.scheduler.now();
    const firstPaint = this.firstDeltaPaintedAt === null;
    this.firstDeltaPaintedAt ??= paintedAt;
    if (this.previousPaintedAt !== null) {
      appendBounded(this.interPaintGaps, Math.max(0, Math.round(paintedAt - this.previousPaintedAt)), MAX_PAINT_GAPS);
    }
    this.previousPaintedAt = paintedAt;
    if (firstPaint) this.publish();
  }

  private snapshotPainted() {
    if (this.reconnectStartedAt === null) return;
    const elapsed = Math.max(0, Math.round(this.scheduler.now() - this.reconnectStartedAt));
    appendBounded(this.reconnectSnapshotVisible, elapsed, MAX_PAINT_GAPS);
    // A server snapshot replaces the current message atomically, so the same
    // paint is the point at which this client has caught up with that snapshot.
    appendBounded(this.reconnectCaughtUp, elapsed, MAX_PAINT_GAPS);
    this.reconnectStartedAt = null;
    this.publish();
  }

  private scheduleTerminal(terminal: ClientTurnPerformanceTerminal) {
    this.scheduler.request(() => {
      if (this.terminal !== null) return;
      this.terminal = terminal;
      this.terminalPaintedAt = this.scheduler.now();
      this.publish();
    });
  }

  private publish() {
    this.onReadback(this.readback());
  }
}
