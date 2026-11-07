import { describe, expect, it, vi } from "vitest";
import { ClientTurnPerformance } from "@/ui/client-turn-performance";
import { createChatEventFrameDispatcher } from "@/ui/frame-event-dispatcher";
import type { ChatMessage } from "@/lib/chat-contract";

class ControlledFrames {
  nowMs = 0;
  private nextHandle = 1;
  private readonly callbacks = new Map<number, () => void>();

  request = (callback: () => void) => {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  };

  cancel = (handle: number) => {
    this.callbacks.delete(handle);
  };

  advance(milliseconds: number) {
    this.nowMs += milliseconds;
  }

  paint() {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback());
  }
}

function snapshot(): ChatMessage {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    role: "assistant",
    content: "texto que jamás debe entrar en el artefacto de métricas",
    status: "streaming",
    createdAt: "2026-08-28T12:00:00.000Z",
    activity: [],
    plan: [],
    approvals: [],
    diff: "",
    attachments: [],
    artifacts: [],
    sources: [],
    toolResults: [],
  };
}

describe("client turn performance", () => {
  it("records only post-paint durations from an empty baseline through reconnect catch-up", () => {
    const frames = new ControlledFrames();
    const readbacks = vi.fn();
    const metric = new ClientTurnPerformance(readbacks, {
      now: () => frames.nowMs,
      request: frames.request,
    }, 0);
    const events = vi.fn();
    const dispatcher = createChatEventFrameDispatcher(events, {
      request: frames.request,
      cancel: frames.cancel,
    }, { onEventApplied: (event) => metric.eventApplied(event) });

    expect(metric.readback()).toMatchObject({
      sendIntentToFirstFeedbackPaintMs: null,
      responseAcceptedToFeedbackPaintMs: null,
      sendIntentToFirstDeltaPaintMs: null,
      paintCount: 0,
      sendIntentToTerminalPaintMs: null,
      reconnectToSnapshotVisibleP95Ms: null,
    });

    metric.feedbackApplied("local");
    frames.advance(6);
    metric.transportMeasured({
      responseOpenedAtMs: 6,
      responseAcceptedAtMs: 6,
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
    frames.advance(10);
    frames.paint();

    dispatcher.dispatch({ type: "delta", value: "contenido sensible" });
    frames.advance(16);
    frames.paint(); // the immediate delta is now observed after rAF

    dispatcher.dispatch({ type: "delta", value: " que no se exporta" });
    frames.advance(8);
    frames.paint(); // dispatcher applies the coalesced delta
    frames.advance(16);
    frames.paint(); // the delta is now observed after rAF

    metric.reconnectStarted();
    dispatcher.dispatch({ type: "snapshot", message: snapshot() });
    frames.advance(7);
    frames.paint();

    dispatcher.dispatch({ type: "done" });
    frames.advance(5);
    frames.paint();

    const readback = metric.readback();
    expect(readback).toMatchObject({
      schemaVersion: 2,
      sendIntentToFirstFeedbackPaintMs: 16,
      responseAcceptedToFeedbackPaintMs: 10,
      responseAcceptedFeedbackWithinBudget: true,
      sendIntentToFirstDeltaPaintMs: 32,
      paintCount: 2,
      interPaintP50Ms: 24,
      interPaintP95Ms: 24,
      interPaintMaxMs: 24,
      terminal: "completed",
      sendIntentToTerminalPaintMs: 68,
      reconnectCount: 1,
      reconnectToSnapshotVisibleP95Ms: 7,
      reconnectToCaughtUpP95Ms: 7,
    });
    const artifact = JSON.stringify(readback);
    expect(artifact).not.toContain("contenido sensible");
    expect(artifact).not.toContain("jamás debe entrar");
    expect(artifact).not.toContain("00000000-0000-4000-8000-000000000001");
    expect(readbacks.mock.calls.length).toBeGreaterThanOrEqual(6);
  });
});
