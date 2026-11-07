import { describe, expect, it, vi } from "vitest";
import { createChatEventFrameDispatcher } from "@/ui/frame-event-dispatcher";
import { applyChatStreamEvent, type ChatMessage, type ChatStreamEvent } from "@/lib/chat-contract";
import { buildTurnTimeline } from "@/ui/turn-timeline";

describe("chat event frame dispatcher", () => {
  it("keeps mixed public activity separate from final text through replay and snapshot replacement", () => {
    let message: ChatMessage = {
      id: "answer", role: "assistant", content: "", status: "streaming",
      createdAt: "2026-09-04T00:00:00Z", activity: [], plan: [],
      approvals: [], diff: "", attachments: [], artifacts: [], toolResults: [],
    };
    const dispatcher = createChatEventFrameDispatcher((event) => {
      message = applyChatStreamEvent(message, event);
    }, { request: () => 1, cancel: vi.fn() });
    const commentary: ChatStreamEvent = { type: "activity", item: {
      id: "commentary", kind: "reasoning", label: "Actualización de trabajo",
      detail: "Estoy consultando la fuente.", status: "complete", sequence: 1,
    } };
    const tool: ChatStreamEvent = { type: "toolResult", item: {
      id: "tool", kind: "command", title: "Consulta", status: "complete",
      summary: "Fuente consultada", output: "", sourceIds: [], sequence: 2,
      createdAt: "2026-09-04T00:00:01Z",
    } };
    dispatcher.dispatch(commentary);
    dispatcher.dispatch(tool);
    dispatcher.dispatch({ type: "delta", value: "Respuesta" });
    dispatcher.dispatch({ type: "delta", value: " parcial" });
    const snapshot = { ...message, content: "Respuesta final" };
    dispatcher.dispatch({ type: "snapshot", message: snapshot });
    dispatcher.dispatch(commentary);
    dispatcher.dispatch(tool);
    dispatcher.dispatch({ type: "snapshot", message: snapshot });
    dispatcher.dispatch({ type: "done" });
    dispatcher.close();
    expect(message.content).toBe("Respuesta final");
    expect(message.status).toBe("complete");
    expect(buildTurnTimeline(message.activity, message.toolResults ?? []).map((entry) => entry.key))
      .toEqual(["activity:commentary", "tool:tool"]);
    expect(message.content).not.toContain("consultando");
  });

  it("applies the first delta immediately, then coalesces per frame and preserves ordering", () => {
    let scheduledFrame: (() => void) | null = null;
    let scheduledFallback: (() => void) | null = null;
    const events = vi.fn();
    const scheduler = {
      request: vi.fn((callback: () => void) => { scheduledFrame = callback; return 1; }),
      cancel: vi.fn(),
      setTimeout: vi.fn((callback: () => void) => { scheduledFallback = callback; return 2 as unknown as ReturnType<typeof setTimeout>; }),
      clearTimeout: vi.fn(),
    };
    const dispatcher = createChatEventFrameDispatcher(events, scheduler);

    dispatcher.dispatch({ type: "delta", value: "Hola" });
    dispatcher.dispatch({ type: "delta", value: " mundo" });
    expect(events).toHaveBeenCalledOnce();
    expect(events).toHaveBeenLastCalledWith({ type: "delta", value: "Hola" });
    expect(scheduler.request).toHaveBeenCalledTimes(1);
    (scheduledFrame as (() => void) | null)?.();
    expect(events).toHaveBeenLastCalledWith({ type: "delta", value: " mundo" });
    expect(scheduler.clearTimeout).toHaveBeenCalled();

    dispatcher.dispatch({ type: "delta", value: "." });
    dispatcher.dispatch({ type: "activity", item: { id: "activity-1", kind: "system", label: "Listo", status: "complete" } });
    expect(events.mock.calls.map(([event]) => event.type)).toEqual(["delta", "delta", "delta", "activity"]);
    expect(events.mock.calls[2]?.[0]).toEqual({ type: "delta", value: "." });
    dispatcher.close();
    dispatcher.dispatch({ type: "done" });
    expect(events).toHaveBeenCalledTimes(4);
    expect(scheduledFallback).not.toBeNull();
  });

  it("flushes through the bounded fallback when animation frames are throttled", () => {
    let fallback: (() => void) | null = null;
    const events = vi.fn();
    const dispatcher = createChatEventFrameDispatcher(events, {
      request: vi.fn(() => 1),
      cancel: vi.fn(),
      setTimeout: vi.fn((callback) => { fallback = callback; return 2 as unknown as ReturnType<typeof setTimeout>; }),
      clearTimeout: vi.fn(),
    });
    dispatcher.dispatch({ type: "delta", value: "A" });
    for (let index = 0; index < 10_000; index += 1) dispatcher.dispatch({ type: "delta", value: "x" });
    expect(events).toHaveBeenCalledOnce();
    (fallback as (() => void) | null)?.();
    expect(events).toHaveBeenCalledTimes(2);
    expect(events.mock.calls[1]?.[0]).toEqual({ type: "delta", value: "x".repeat(10_000) });
    (fallback as (() => void) | null)?.();
    expect(events).toHaveBeenCalledTimes(2);
    dispatcher.close();
    expect(events).toHaveBeenCalledTimes(2);
  });

  it("delivers a large first chunk immediately and drains subsequent chunks in one frame", () => {
    let scheduledFrame: (() => void) | null = null;
    const events = vi.fn();
    const dispatcher = createChatEventFrameDispatcher(events, {
      request: vi.fn((callback) => { scheduledFrame = callback; return 1; }),
      cancel: vi.fn(),
    });

    dispatcher.dispatch({ type: "delta", value: "abcdefghijklmnopqrstuvwxyz012345" });
    expect(events).toHaveBeenLastCalledWith({ type: "delta", value: "abcdefghijklmnopqrstuvwxyz012345" });
    expect(scheduledFrame).toBeNull();
    dispatcher.dispatch({ type: "delta", value: "🙂".repeat(10_000) });
    (scheduledFrame as (() => void) | null)?.();
    expect(events).toHaveBeenLastCalledWith({ type: "delta", value: "🙂".repeat(10_000) });

    dispatcher.dispatch({ type: "delta", value: "exact suffix" });
    dispatcher.dispatch({ type: "done" });
    expect(events.mock.calls.map(([event]) => event)).toEqual([
      { type: "delta", value: "abcdefghijklmnopqrstuvwxyz012345" },
      { type: "delta", value: "🙂".repeat(10_000) },
      { type: "delta", value: "exact suffix" },
      { type: "done" },
    ]);
  });
});
