import { isChatStreamEvent, type ChatStreamEvent } from "@/lib/chat-contract";

export const DURABLE_UI_EVENT_SCHEMA_VERSION = 1 as const;

export type DurableUiEventEnvelope = {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  occurredAt: string;
  projectId: string;
  threadId: string;
  turnId: string;
  itemId: string | null;
  payload: ChatStreamEvent;
};

export type DurableUiEventCursor = Pick<DurableUiEventEnvelope, "eventId" | "sequence">;
export type DurableUiEventScope = Pick<DurableUiEventEnvelope, "projectId" | "threadId" | "turnId">;
export type DurableUiConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "closing" | "closed";

export type DurableUiEventResult =
  | { kind: "applied"; cursor: DurableUiEventCursor }
  | { kind: "duplicate"; cursor: DurableUiEventCursor }
  | { kind: "stale"; cursor: DurableUiEventCursor | null }
  | { kind: "gap"; expectedSequence: number; receivedSequence: number; cursor: DurableUiEventCursor | null };

export class DurableUiEventProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableUiEventProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isSafeOpaqueId(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isUtcTimestamp(value: unknown) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value));
}

export function parseDurableUiEventEnvelope(value: unknown): DurableUiEventEnvelope {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "eventId", "sequence", "occurredAt", "projectId", "threadId", "turnId", "itemId", "payload",
  ])) {
    throw new DurableUiEventProtocolError("El evento durable no tiene el formato esperado.");
  }
  if (value.schemaVersion !== DURABLE_UI_EVENT_SCHEMA_VERSION) {
    throw new DurableUiEventProtocolError("La versión del evento durable no es compatible.");
  }
  if (!isSafeOpaqueId(value.eventId) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 ||
    !isUtcTimestamp(value.occurredAt) || !isSafeOpaqueId(value.projectId) || !isSafeOpaqueId(value.threadId) ||
    !isSafeOpaqueId(value.turnId) || (value.itemId !== null && !isSafeOpaqueId(value.itemId)) ||
    !isChatStreamEvent(value.payload)) {
    throw new DurableUiEventProtocolError("El evento durable contiene campos no válidos.");
  }
  return value as DurableUiEventEnvelope;
}

function sameScope(scope: DurableUiEventScope, event: DurableUiEventEnvelope) {
  return scope.projectId === event.projectId && scope.threadId === event.threadId && scope.turnId === event.turnId;
}

export class DurableChatEventAdapter {
  private stateValue: DurableUiConnectionState = "idle";
  private cursorValue: DurableUiEventCursor | null;
  private readonly eventSequences = new Map<string, number>();
  private replayRequestedFor: number | null = null;
  private terminal = false;
  private onEvent: ((event: ChatStreamEvent, envelope: DurableUiEventEnvelope) => void) | null;
  private onReplayRequired: ((cursor: DurableUiEventCursor | null) => void) | null;

  constructor(private readonly scope: DurableUiEventScope, options: {
    cursor?: DurableUiEventCursor | null;
    onEvent: (event: ChatStreamEvent, envelope: DurableUiEventEnvelope) => void;
    onReplayRequired: (cursor: DurableUiEventCursor | null) => void;
  }) {
    if (options.cursor && (!isSafeOpaqueId(options.cursor.eventId) || !Number.isSafeInteger(options.cursor.sequence) || options.cursor.sequence < 1)) {
      throw new DurableUiEventProtocolError("El cursor durable inicial no es válido.");
    }
    this.cursorValue = options.cursor ? { ...options.cursor } : null;
    if (options.cursor) this.eventSequences.set(options.cursor.eventId, options.cursor.sequence);
    this.onEvent = options.onEvent;
    this.onReplayRequired = options.onReplayRequired;
  }

  get state() {
    return this.stateValue;
  }

  get cursor() {
    return this.cursorValue ? { ...this.cursorValue } : null;
  }

  markConnecting() {
    this.assertOpen();
    this.stateValue = "connecting";
  }

  markConnected() {
    this.assertOpen();
    this.stateValue = "connected";
  }

  markReconnecting() {
    this.assertOpen();
    this.stateValue = "reconnecting";
  }

  receive(raw: unknown): DurableUiEventResult {
    const event = parseDurableUiEventEnvelope(raw);
    const existingSequence = this.eventSequences.get(event.eventId);
    if (existingSequence !== undefined) {
      if (existingSequence !== event.sequence) {
        throw new DurableUiEventProtocolError("Un eventId durable se ha reutilizado con otra secuencia.");
      }
      return { kind: "duplicate", cursor: this.cursor ?? { eventId: event.eventId, sequence: event.sequence } };
    }
    this.assertOpen();
    if (this.stateValue !== "connected" && this.stateValue !== "reconnecting") {
      throw new DurableUiEventProtocolError("El adapter durable no está conectado.");
    }
    if (this.terminal) throw new DurableUiEventProtocolError("El turno ya ha alcanzado un estado terminal.");
    if (!sameScope(this.scope, event)) {
      throw new DurableUiEventProtocolError("El evento durable no pertenece al proyecto, conversación y turno activos.");
    }

    const currentSequence = this.cursorValue?.sequence ?? 0;
    if (event.sequence <= currentSequence) return { kind: "stale", cursor: this.cursor };
    const expectedSequence = currentSequence + 1;
    if (event.sequence !== expectedSequence) {
      this.stateValue = "reconnecting";
      if (this.replayRequestedFor !== expectedSequence) {
        this.replayRequestedFor = expectedSequence;
        this.onReplayRequired?.(this.cursor);
      }
      return { kind: "gap", expectedSequence, receivedSequence: event.sequence, cursor: this.cursor };
    }

    this.onEvent?.(event.payload, event);
    this.eventSequences.set(event.eventId, event.sequence);
    this.cursorValue = { eventId: event.eventId, sequence: event.sequence };
    this.replayRequestedFor = null;
    if (event.payload.type === "done" || event.payload.type === "stopped" || event.payload.type === "error") {
      this.terminal = true;
    }
    return { kind: "applied", cursor: { ...this.cursorValue } };
  }

  close() {
    if (this.stateValue === "closed") return;
    this.stateValue = "closing";
    this.eventSequences.clear();
    this.onEvent = null;
    this.onReplayRequired = null;
    this.stateValue = "closed";
  }

  private assertOpen() {
    if (this.stateValue === "closing" || this.stateValue === "closed") {
      throw new DurableUiEventProtocolError("El adapter durable está cerrado.");
    }
  }
}
