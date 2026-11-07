import { describe, expect, it, vi } from "vitest";
import {
  DurableChatEventAdapter,
  DurableUiEventProtocolError,
  parseDurableUiEventEnvelope,
  type DurableUiEventEnvelope,
} from "@/ui/durable-chat-event-adapter";

const scope = { projectId: "project-opaque", threadId: "thread-opaque", turnId: "turn-opaque" };

function envelope(sequence: number, payload: DurableUiEventEnvelope["payload"], overrides: Partial<DurableUiEventEnvelope> = {}): DurableUiEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: `2026-08-27T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...scope,
    itemId: null,
    payload,
    ...overrides,
  };
}

describe("durable UI event adapter", () => {
  it("preserves scope and IDs while applying a contiguous sequence", () => {
    const applied = vi.fn();
    const replay = vi.fn();
    const adapter = new DurableChatEventAdapter(scope, { onEvent: applied, onReplayRequired: replay });
    adapter.markConnecting();
    adapter.markConnected();

    const first = envelope(1, { type: "activity", item: { id: "item-1", kind: "tool", label: "Comprobar", status: "running" } }, { itemId: "item-1" });
    expect(adapter.receive(first)).toEqual({ kind: "applied", cursor: { eventId: "event-1", sequence: 1 } });
    expect(applied).toHaveBeenCalledWith(first.payload, first);
    expect(adapter.cursor).toEqual({ eventId: "event-1", sequence: 1 });
    expect(replay).not.toHaveBeenCalled();
  });

  it("deduplicates replay, pauses on a gap and resumes only after the missing event", () => {
    const applied = vi.fn();
    const replay = vi.fn();
    const adapter = new DurableChatEventAdapter(scope, { onEvent: applied, onReplayRequired: replay });
    adapter.markConnected();
    const first = envelope(1, { type: "delta", value: "A" });
    const second = envelope(2, { type: "delta", value: "B" });
    const third = envelope(3, { type: "done" });

    adapter.receive(first);
    expect(adapter.receive(first)).toEqual({ kind: "duplicate", cursor: { eventId: "event-1", sequence: 1 } });
    expect(adapter.receive(third)).toEqual({ kind: "gap", expectedSequence: 2, receivedSequence: 3, cursor: { eventId: "event-1", sequence: 1 } });
    expect(adapter.state).toBe("reconnecting");
    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledWith({ eventId: "event-1", sequence: 1 });
    adapter.receive(third);
    expect(replay).toHaveBeenCalledTimes(1);

    expect(adapter.receive(second).kind).toBe("applied");
    expect(adapter.receive(third).kind).toBe("applied");
    expect(applied.mock.calls.map(([event]) => event)).toEqual([first.payload, second.payload, third.payload]);
  });

  it("fails closed for unknown schemas, cross-scope events, event-id reuse and updates after terminal", () => {
    expect(() => parseDurableUiEventEnvelope({ ...envelope(1, { type: "done" }), schemaVersion: 2 })).toThrow(DurableUiEventProtocolError);
    expect(() => parseDurableUiEventEnvelope({ ...envelope(1, { type: "done" }), extra: true })).toThrow(DurableUiEventProtocolError);

    const adapter = new DurableChatEventAdapter(scope, { onEvent: () => undefined, onReplayRequired: () => undefined });
    adapter.markConnected();
    expect(() => adapter.receive(envelope(1, { type: "done" }, { threadId: "another-thread" }))).toThrow(DurableUiEventProtocolError);
    adapter.receive(envelope(1, { type: "done" }));
    expect(() => adapter.receive(envelope(2, { type: "delta", value: "late" }))).toThrow(DurableUiEventProtocolError);

    const reuse = new DurableChatEventAdapter(scope, { onEvent: () => undefined, onReplayRequired: () => undefined });
    reuse.markConnected();
    reuse.receive(envelope(1, { type: "delta", value: "A" }));
    expect(() => reuse.receive(envelope(2, { type: "delta", value: "B" }, { eventId: "event-1" }))).toThrow(DurableUiEventProtocolError);
  });

  it("cleans callbacks and buffered identity state when closed", () => {
    const applied = vi.fn();
    const adapter = new DurableChatEventAdapter(scope, { onEvent: applied, onReplayRequired: () => undefined });
    adapter.markConnected();
    adapter.receive(envelope(1, { type: "delta", value: "A" }));
    adapter.close();
    expect(adapter.state).toBe("closed");
    expect(() => adapter.receive(envelope(2, { type: "done" }))).toThrow(DurableUiEventProtocolError);
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it("treats an explicitly stopped turn as terminal", () => {
    const adapter = new DurableChatEventAdapter(scope, { onEvent: () => undefined, onReplayRequired: () => undefined });
    adapter.markConnected();
    adapter.receive(envelope(1, { type: "stopped" }));
    expect(() => adapter.receive(envelope(2, { type: "delta", value: "late" })))
      .toThrow(DurableUiEventProtocolError);
  });
});
