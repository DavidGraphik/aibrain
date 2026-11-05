import type { ClientNotification } from "../../../contracts/codex/0.162.1/types/ClientNotification";
import type { ClientRequest } from "../../../contracts/codex/0.162.1/types/ClientRequest";
import type { RequestId } from "../../../contracts/codex/0.162.1/types/RequestId";
import type { ServerNotification } from "../../../contracts/codex/0.162.1/types/ServerNotification";
import type { ServerRequest } from "../../../contracts/codex/0.162.1/types/ServerRequest";

export const APP_SERVER_TRANSPORT_PROTOCOL_VERSION = 1 as const;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonRpcSuccess = {
  id: RequestId;
  result: JsonValue;
};

export type JsonRpcFailure = {
  id: RequestId;
  error: {
    code: number;
    message: string;
    data?: JsonValue;
  };
};

/**
 * A logical, idempotent submission to the worker gateway. `clientRequestId`
 * identifies the submission across reconnects; it is deliberately separate
 * from a JSON-RPC response id because replies to server-initiated requests
 * reuse the server's id.
 */
export type AppServerRequest =
  | {
      clientRequestId: string;
      kind: "rpc-request";
      rpc: ClientRequest;
    }
  | {
      clientRequestId: string;
      kind: "rpc-notification";
      rpc: ClientNotification;
    }
  | {
      clientRequestId: string;
      kind: "rpc-response";
      rpc: JsonRpcSuccess | JsonRpcFailure;
    };

export type AppServerRpcEvent =
  | { kind: "rpc-response"; rpc: JsonRpcSuccess | JsonRpcFailure }
  | { kind: "rpc-notification"; rpc: ServerNotification }
  | { kind: "rpc-request"; rpc: ServerRequest };

export type AppServerEvent = {
  eventId: string;
  sequence: number;
  occurredAt: string;
  message: AppServerRpcEvent;
};

export type ReplayCursor = {
  eventId: string;
  sequence: number;
};

export type TransportState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closing"
  | "closed";

export type TransportHealth = {
  healthy: boolean;
  state: TransportState;
  endpoint: string;
  /** Authenticated gateway process and this exact WebSocket handshake. */
  sessionId?: string;
  connectionId?: string;
  reconnectAttempt: number;
  pendingRequests: number;
  lastEventId: string | null;
  lastEventSequence: number | null;
  lastConnectedAt: string | null;
  lastMessageAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
};

export interface AppServerTransport {
  connect(): Promise<void>;
  send(message: AppServerRequest): Promise<void>;
  /** Private durable lookup only: never dispatch or replay an uncertain request. */
  recoverResponse?(request: AppServerRequest): Promise<JsonRpcSuccess | JsonRpcFailure | null>;
  /** First sequence not yet projected, captured during connect before live
   * RPC responses can overtake historical replay. No ACK may skip this floor. */
  deliverySequenceStart?(): number | undefined;
  /** Received watermark captured at each connection handshake. New inference
   * waits until every event through this watermark is durably projected. */
  projectionSequenceTarget?(): number | undefined;
  events(): AsyncIterable<AppServerEvent>;
  /** Mark an event processed by the scoped router, after durable projection. */
  acknowledge?(event: AppServerEvent): Promise<void>;
  /** Only a fully processed contiguous prefix; never a cumulative shortcut. */
  acknowledgeBatch?(events: readonly AppServerEvent[]): Promise<void>;
  health(): Promise<TransportHealth>;
  close(): Promise<void>;
}

export interface TransportEventJournal {
  loadCursor(): Promise<ReplayCursor | null>;
  /** Last event durably projected by the application router. */
  loadDeliveryCursor?(): Promise<ReplayCursor | null>;
  /** Must durably append before resolving. Duplicate event ids return false. */
  append(event: AppServerEvent): Promise<boolean>;
  /** Events received durably but not yet acknowledged by the application router. */
  readUndelivered?(limit: number, afterSequence?: number): Promise<AppServerEvent[]>;
  markDelivered?(event: AppServerEvent): Promise<void>;
  markDeliveredBatch?(events: readonly AppServerEvent[]): Promise<void>;
}

export class InMemoryTransportEventJournal implements TransportEventJournal {
  private cursor: ReplayCursor | null = null;
  private deliveryCursor: ReplayCursor | null = null;
  private readonly eventIds = new Set<string>();
  private readonly stored: AppServerEvent[] = [];

  async loadCursor() {
    return this.cursor ? { ...this.cursor } : null;
  }

  async loadDeliveryCursor() {
    return this.deliveryCursor ? { ...this.deliveryCursor } : null;
  }

  async append(event: AppServerEvent) {
    if (this.eventIds.has(event.eventId)) return false;
    this.eventIds.add(event.eventId);
    this.cursor = { eventId: event.eventId, sequence: event.sequence };
    this.stored.push(event);
    return true;
  }

  async readUndelivered(limit: number, afterSequence = 0) {
    const after = Math.max(this.deliveryCursor?.sequence ?? 0, afterSequence);
    return this.stored.filter((event) => event.sequence > after).slice(0, limit);
  }

  async markDelivered(event: AppServerEvent) {
    if (
      this.deliveryCursor && this.deliveryCursor.eventId === event.eventId &&
      this.deliveryCursor.sequence === event.sequence
    ) return;
    const expected = (this.deliveryCursor?.sequence ?? 0) + 1;
    if (event.sequence !== expected || this.stored.find((item) => item.sequence === event.sequence)?.eventId !== event.eventId) {
      throw new Error("Transport delivery acknowledgements must be contiguous and durable.");
    }
    this.deliveryCursor = { eventId: event.eventId, sequence: event.sequence };
  }
}
