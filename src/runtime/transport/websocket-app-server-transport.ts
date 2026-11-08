import { randomUUID } from "node:crypto";
import {
  type AppServerEvent,
  type AppServerRequest,
  type AppServerTransport,
  type ReplayCursor,
  type TransportEventJournal,
  type TransportHealth,
  type TransportState,
} from "@/runtime/transport/contracts";
import {
  APP_SERVER_TRANSPORT_PROTOCOL_VERSION,
} from "@/runtime/transport/contracts";
import {
  parseServerFrame,
  serializeClientFrame,
  TransportProtocolError,
  type WorkerClientFrame,
  type WorkerServerFrame,
} from "@/runtime/transport/wire-protocol";
import {
  buildWebSocketAuth,
  validatePrivateWebSocketEndpoint,
  type PrivateEndpointPolicy,
  type WebSocketAuth,
  type WebSocketFactory,
  type WebSocketLike,
} from "@/runtime/transport/websocket-types";
import { validateAppServerRequest } from "@/runtime/transport/wire-protocol";

import { ServerFrameAssembler } from './bounded-server-frames';

const SOCKET_OPEN = 1;

type PendingSubmission = {
  canonical: string;
  message: AppServerRequest;
  state: "queued" | "sent";
  resolve: () => void;
  reject: (error: Error) => void;
  promise: Promise<void>;
};

export type WebSocketAppServerTransportOptions = {
  endpoint: string;
  socketFactory: WebSocketFactory;
  auth: WebSocketAuth;
  endpointPolicy?: PrivateEndpointPolicy;
  /** Required: callers must choose an explicit durable journal in production. */
  journal: TransportEventJournal;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  readyTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectJitterRatio?: number;
  maxReconnectAttempts?: number;
  maxBufferedBytes?: number;
  maxFrameBytes?: number;
  maxEventBuffer?: number;
  maxPendingRequests?: number;
  acceptedRequestCacheSize?: number;
  random?: () => number;
  now?: () => number;
};

export class TransportClosedError extends Error {
  readonly code = "TRANSPORT_CLOSED";
}

export class TransportRequestRejectedError extends Error {
  readonly code = "TRANSPORT_REQUEST_REJECTED";

  constructor(
    message: string,
    readonly rpcCode: number,
  ) {
    super(message);
  }
}

/** Proven local rejection of a new request before queueing or socket.send. */
export class TransportRequestTooLargeError extends Error {
  readonly code = "TRANSPORT_REQUEST_TOO_LARGE";
  constructor(readonly clientRequestId: string, readonly bytes: number, readonly maxBytes: number) {
    super("WebSocket request exceeds the configured safety limit before sending.");
    this.name = "TransportRequestTooLargeError";
  }
}

export class TransportBackpressureError extends Error {
  readonly code = "TRANSPORT_BACKPRESSURE";
}

class AsyncEventQueue implements AsyncIterable<AppServerEvent> {
  private readonly values: AppServerEvent[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<AppServerEvent>) => void;
    reject: (error: Error) => void;
  }> = [];
  private ended = false;
  private failure: Error | null = null;
  private readonly responseSignals = new Set<{ resolve(): void; reject(error: Error): void }>();

  constructor(private readonly capacity: number) {}

  hasCapacity() {
    return this.waiters.length > 0 || this.values.length < this.capacity;
  }

  push(value: AppServerEvent) {
    if (this.ended) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
    if (value.message.kind === "rpc-response") {
      for (const signal of [...this.responseSignals]) signal.resolve();
    }
    return true;
  }

  /** Wake without removing an event: losing a race against journal I/O must
   * never steal or duplicate the RPC response. Notifications remain in FIFO. */
  waitForResponse(signal: AbortSignal): Promise<void> {
    if (this.values.some(value => value.message.kind === "rpc-response")) return Promise.resolve();
    if (this.ended) return Promise.reject(this.failure ?? new TransportClosedError("Transport event queue ended."));
    if (signal.aborted) return Promise.reject(new Error("Response wait cancelled."));
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.responseSignals.delete(waiter); signal.removeEventListener("abort", cancel); };
      const waiter = { resolve: () => { cleanup(); resolve(); }, reject: (error: Error) => { cleanup(); reject(error); } };
      const cancel = () => waiter.reject(new Error("Response wait cancelled."));
      this.responseSignals.add(waiter);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  takeResponse() {
    const index = this.values.findIndex(value => value.message.kind === "rpc-response");
    return index < 0 ? undefined : this.values.splice(index, 1)[0];
  }

  close(error?: Error) {
    if (this.ended) return;
    this.ended = true;
    this.failure = error ?? null;
    for (const signal of [...this.responseSignals]) signal.reject(error ?? new TransportClosedError("Transport event queue ended."));
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AppServerEvent> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ done: false as const, value });
        if (this.failure) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ done: true as const, value: undefined });
        return new Promise<IteratorResult<AppServerEvent>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function eventData(event: unknown) {
  if (!event || typeof event !== "object" || !("data" in event)) return null;
  return (event as { data: unknown }).data;
}

function closeCode(event: unknown) {
  if (!event || typeof event !== "object" || !("code" in event)) return null;
  const code = (event as { code: unknown }).code;
  return typeof code === "number" && Number.isInteger(code) ? code : null;
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "WebSocket transport failed.";
  return message
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [REDACTED]")
    .replace(/aibrain\.auth\.[^.\s]+\.[^\s,]+/giu, "aibrain.auth.[REDACTED]");
}

export class WebSocketAppServerTransport implements AppServerTransport {
  private readonly options: Required<Pick<
    WebSocketAppServerTransportOptions,
    | "heartbeatIntervalMs"
    | "heartbeatTimeoutMs"
    | "readyTimeoutMs"
    | "reconnectBaseDelayMs"
    | "reconnectMaxDelayMs"
    | "reconnectJitterRatio"
    | "maxReconnectAttempts"
    | "maxBufferedBytes"
    | "maxFrameBytes"
    | "maxEventBuffer"
    | "maxPendingRequests"
    | "acceptedRequestCacheSize"
  >> & WebSocketAppServerTransportOptions;
  private readonly journal: TransportEventJournal;
  private readonly eventQueue: AsyncEventQueue;
  private readonly random: () => number;
  private readonly now: () => number;
  private state: TransportState = "idle";
  private socket: WebSocketLike | null = null;
  private endpoint: string;
  private sessionId: string | undefined;
  private connectionId: string | undefined;
  private cursor: ReplayCursor | null = null;
  private cursorLoaded = false;
  private deliveryLoaded = false;
  private firstUnprojectedSequence: number | undefined;
  private durableBacklogTargetSequence = 0;
  private durableBacklogYieldedThrough = 0;
  private projectionTargetSequence = 0;
  private reconnectAttempt = 0;
  private runtimeFailureReconnects = 0;
  private pendingReconnectFloorMs = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private outstandingPing: { nonce: string; sentAt: number } | null = null;
  private connectWaiter: ReturnType<typeof deferred<void>> | null = null;
  private closeRequested = false;
  private opening = false;
  private messageChain: Promise<void> = Promise.resolve();
  private readonly frameAssembler = new ServerFrameAssembler();
  private readonly pending = new Map<string, PendingSubmission>();
  private readonly accepted = new Map<string, string>();
  private lastConnectedAt: string | null = null;
  private lastMessageAt: string | null = null;
  private lastHeartbeatAt: string | null = null;
  private lastError: string | null = null;

  constructor(options: WebSocketAppServerTransportOptions) {
    this.options = {
      ...options,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 10_000,
      readyTimeoutMs: options.readyTimeoutMs ?? 10_000,
      reconnectBaseDelayMs: options.reconnectBaseDelayMs ?? 250,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? 30_000,
      reconnectJitterRatio: options.reconnectJitterRatio ?? 0.2,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY,
      maxBufferedBytes: options.maxBufferedBytes ?? 1_048_576,
      maxFrameBytes: options.maxFrameBytes ?? 8_388_608,
      maxEventBuffer: options.maxEventBuffer ?? 1_024,
      maxPendingRequests: options.maxPendingRequests ?? 256,
      acceptedRequestCacheSize: options.acceptedRequestCacheSize ?? 4_096,
    };
    if (this.options.heartbeatIntervalMs < 10 || this.options.heartbeatTimeoutMs < 10) {
      throw new Error("Heartbeat intervals must be at least 10ms.");
    }
    if (this.options.reconnectBaseDelayMs < 0 || this.options.reconnectMaxDelayMs < this.options.reconnectBaseDelayMs) {
      throw new Error("Reconnect delay configuration is invalid.");
    }
    if (this.options.reconnectJitterRatio < 0 || this.options.reconnectJitterRatio > 1) {
      throw new Error("Reconnect jitter ratio must be between 0 and 1.");
    }
    for (const [name, value] of [
      ["maxBufferedBytes", this.options.maxBufferedBytes],
      ["maxFrameBytes", this.options.maxFrameBytes],
      ["maxEventBuffer", this.options.maxEventBuffer],
      ["maxPendingRequests", this.options.maxPendingRequests],
      ["acceptedRequestCacheSize", this.options.acceptedRequestCacheSize],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive safe integer.`);
      }
    }
    if (
      this.options.maxReconnectAttempts !== Number.POSITIVE_INFINITY
      && (!Number.isSafeInteger(this.options.maxReconnectAttempts) || this.options.maxReconnectAttempts < 0)
    ) {
      throw new Error("maxReconnectAttempts must be a non-negative safe integer or Infinity.");
    }
    this.journal = options.journal;
    this.eventQueue = new AsyncEventQueue(this.options.maxEventBuffer);
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.endpoint = options.endpoint;
  }

  async connect() {
    if (this.state === "connected") return;
    if (this.closeRequested || this.state === "closed" || this.state === "closing") {
      throw new TransportClosedError("Transport is closed.");
    }
    if (!this.connectWaiter) this.connectWaiter = deferred<void>();
    const waiter = this.connectWaiter;
    // close can reject this while journal I/O is still pending. Attach now,
    // then return the same waiter; never dereference a cleared/replaced one.
    void waiter.promise.catch(() => undefined);
    if (!this.cursorLoaded) {
      this.cursor = await this.journal.loadCursor();
      this.cursorLoaded = true;
    }
    if (this.closeRequested) throw new TransportClosedError("Transport is closed.");
    if (!this.opening && !this.reconnectTimer) void this.openConnection();
    return waiter.promise;
  }

  private async loadDurableDeliveryBacklog() {
    this.projectionTargetSequence = Math.max(this.projectionTargetSequence, this.cursor?.sequence ?? 0);
    if (!this.deliveryLoaded && this.journal.loadDeliveryCursor) {
      const delivered = await this.journal.loadDeliveryCursor();
      const receivedSequence = this.cursor?.sequence ?? 0;
      if ((delivered?.sequence ?? 0) > receivedSequence) throw new TransportProtocolError("Delivery cursor is ahead of received history.");
      this.firstUnprojectedSequence = (delivered?.sequence ?? 0) + 1;
      this.durableBacklogTargetSequence = (delivered?.sequence ?? 0) < receivedSequence
        ? receivedSequence
        : 0;
    }
    this.deliveryLoaded = true;
  }

  async send(message: AppServerRequest) {
    validateAppServerRequest(message);
    if (this.closeRequested || this.state === "closed" || this.state === "closing") {
      throw new TransportClosedError("Transport is closed.");
    }
    const canonical = JSON.stringify(message);
    const accepted = this.accepted.get(message.clientRequestId);
    if (accepted !== undefined) {
      if (accepted !== canonical) throw new TransportProtocolError("clientRequestId was reused with a different payload.");
      return;
    }
    const existing = this.pending.get(message.clientRequestId);
    if (existing) {
      if (existing.canonical !== canonical) throw new TransportProtocolError("clientRequestId was reused with a different payload.");
      return existing.promise;
    }
    const bytes = Buffer.byteLength(serializeClientFrame({
      protocolVersion: APP_SERVER_TRANSPORT_PROTOCOL_VERSION, type: "request", request: message,
    }), "utf8");
    if (bytes > this.options.maxFrameBytes) throw new TransportRequestTooLargeError(message.clientRequestId, bytes, this.options.maxFrameBytes);
    if (this.pending.size >= this.options.maxPendingRequests) {
      throw new TransportBackpressureError("Transport has reached its pending request safety limit.");
    }
    const waiter = deferred<void>();
    const submission: PendingSubmission = {
      canonical,
      message,
      state: "queued",
      resolve: () => waiter.resolve(undefined),
      reject: waiter.reject,
      promise: waiter.promise,
    };
    this.pending.set(message.clientRequestId, submission);
    if (this.state === "connected") {
      try {
        this.sendSubmission(submission);
      } catch (error) {
        this.pending.delete(message.clientRequestId);
        throw error;
      }
    }
    else void this.connect().catch((error: unknown) => this.failPending(new Error(safeErrorMessage(error))));
    return submission.promise;
  }

  deliverySequenceStart() {
    if (!this.deliveryLoaded) throw new TransportProtocolError("Delivery start is unavailable before connect.");
    return this.firstUnprojectedSequence;
  }

  projectionSequenceTarget() { return this.projectionTargetSequence; }

  async *events() {
    if (this.journal.readUndelivered && this.durableBacklogTargetSequence > 0) {
      const pageSize = Math.min(this.options.maxEventBuffer, 256);
      while (this.durableBacklogYieldedThrough < this.durableBacklogTargetSequence) {
        const reading = this.journal.readUndelivered(pageSize, this.durableBacklogYieldedThrough);
        let pageReady = false;
        // A response may be yielded while this read is still blocked by an
        // earlier durable ACK/compaction. Observe rejection immediately, too.
        void reading.then(() => { pageReady = true; }, () => { pageReady = true; });
        while (!pageReady) {
          const response = this.eventQueue.takeResponse();
          if (response) { yield response; continue; }
          const waiting = new AbortController();
          try { await Promise.race([reading, this.eventQueue.waitForResponse(waiting.signal)]); }
          finally { waiting.abort(); }
        }
        const pending = await reading;
        const page = pending.filter((event) => event.sequence <= this.durableBacklogTargetSequence);
        if (page.length === 0) {
          throw new TransportProtocolError(
            "Durable event backlog does not reach the received transport cursor.",
          );
        }
        for (const event of page) {
          // The router already knows the first unprojected sequence from
          // connect, even when the first replay read is still blocked. Only
          // RPC responses can overtake history; notifications/tools stay FIFO.
          const response = this.eventQueue.takeResponse();
          if (response) yield response;
          this.durableBacklogYieldedThrough = event.sequence;
          yield event;
        }
      }
    }
    for await (const event of this.eventQueue) yield event;
  }

  async acknowledge(event: AppServerEvent) {
    await this.journal.markDelivered?.(event);
  }

  async acknowledgeBatch(events: readonly AppServerEvent[]) {
    if (this.journal.markDeliveredBatch) await this.journal.markDeliveredBatch(events);
    else for (const event of events) await this.journal.markDelivered?.(event);
  }

  async health(): Promise<TransportHealth> {
    const heartbeatHealthy = !this.outstandingPing
      || this.now() - this.outstandingPing.sentAt < this.options.heartbeatTimeoutMs;
    return {
      healthy: this.state === "connected" && heartbeatHealthy,
      state: this.state,
      endpoint: this.endpoint,
      sessionId: this.sessionId,
      connectionId: this.connectionId,
      reconnectAttempt: this.reconnectAttempt,
      pendingRequests: this.pending.size,
      lastEventId: this.cursor?.eventId ?? null,
      lastEventSequence: this.cursor?.sequence ?? null,
      lastConnectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError,
    };
  }

  async close() {
    if (this.state === "closed") return;
    this.closeRequested = true;
    this.state = "closing";
    this.clearTimers();
    this.socket?.close(1000, "AiBrain transport closed");
    this.socket = null;
    const error = new TransportClosedError("Transport was closed.");
    this.connectWaiter?.reject(error);
    this.connectWaiter = null;
    this.failPending(error);
    this.eventQueue.close();
    this.state = "closed";
  }

  private async openConnection() {
    if (this.opening || this.closeRequested) return;
    this.opening = true;
    this.state = this.reconnectAttempt === 0 ? "connecting" : "reconnecting";
    try {
      this.endpoint = await validatePrivateWebSocketEndpoint(
        this.options.endpoint,
        this.options.endpointPolicy ?? {},
      );
      const credential = await this.options.auth.credentialProvider.getCredential();
      const auth = buildWebSocketAuth(
        credential,
        this.options.auth.placement,
        this.options.socketFactory,
      );
      if (this.closeRequested) return;
      const socket = await this.options.socketFactory.create(this.endpoint, auth);
      if (this.closeRequested) {
        socket.close(1000, "AiBrain transport closed");
        return;
      }
      this.socket = socket;
      socket.addEventListener("open", this.onOpen);
      socket.addEventListener("message", this.onMessage);
      socket.addEventListener("close", this.onClose);
      socket.addEventListener("error", this.onError);
    } catch (error) {
      this.recordError(error);
      this.scheduleReconnect();
    } finally {
      this.opening = false;
    }
  }

  private readonly onOpen = () => {
    if (!this.socket || this.closeRequested) return;
    try {
      this.sendFrame({
        protocolVersion: APP_SERVER_TRANSPORT_PROTOCOL_VERSION,
        type: "resume",
        afterEventId: this.cursor?.eventId ?? null,
        afterSequence: this.cursor?.sequence ?? null,
      });
    } catch (error) {
      this.protocolFailure(error);
      return;
    }
    this.readyTimer = setTimeout(() => {
      this.protocolFailure(new Error("Worker did not complete the replay handshake in time."));
    }, this.options.readyTimeoutMs);
  };

  private readonly onMessage = (event: unknown) => {
    const data = eventData(event);
    const sourceSocket = this.socket;
    this.messageChain = this.messageChain
      .then(() => {
        if (sourceSocket !== this.socket) return;
        if (typeof data === "string" && Buffer.byteLength(data, "utf8") > this.options.maxFrameBytes) {
          throw new TransportProtocolError("WebSocket frame exceeds the configured safety limit.");
        }
        if (typeof data !== 'string') return this.handleFrame(parseServerFrame(data));
        const complete = this.frameAssembler.accept(data);
        if (complete !== null) return this.handleFrame(parseServerFrame(complete));
      })
      .catch((error: unknown) => this.protocolFailure(error));
  };

  private readonly onClose = (event: unknown) => {
    this.detachSocket();
    if (this.closeRequested) return;
    if (closeCode(event) === 1011) {
      if (this.runtimeFailureReconnects === 0) {
        this.runtimeFailureReconnects += 1;
        this.scheduleReconnect();
        return;
      }
      const error = new TransportClosedError(
        "Worker runtime failed; a fresh worker transport is required.",
      );
      this.recordError(error);
      this.clearTimers();
      this.closeRequested = true;
      this.state = "closed";
      void this.messageChain.finally(() => {
        this.connectWaiter?.reject(error);
        this.connectWaiter = null;
        this.failPending(error);
        this.eventQueue.close(error);
      });
      return;
    }
    this.scheduleReconnect();
  };

  private readonly onError = () => {
    this.recordError(new Error("WebSocket connection error."));
  };

  private async handleFrame(frame: WorkerServerFrame) {
    if (this.closeRequested) return;
    this.lastMessageAt = new Date(this.now()).toISOString();
    if (frame.type === "ready") {
      if (this.state !== "connecting" && this.state !== "reconnecting") {
        throw new TransportProtocolError("Unexpected ready frame.");
      }
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      await this.loadDurableDeliveryBacklog();
      if (this.closeRequested) return;
      this.state = "connected";
      this.sessionId = frame.sessionId;
      this.connectionId = randomUUID();
      this.reconnectAttempt = 0;
      this.pendingReconnectFloorMs = 0;
      this.lastConnectedAt = new Date(this.now()).toISOString();
      this.lastError = null;
      const waiter = this.connectWaiter;
      this.connectWaiter = null;
      waiter?.resolve(undefined);
      this.startHeartbeat();
      for (const submission of this.pending.values()) this.sendSubmission(submission);
      return;
    }
    if (frame.type === "pong") {
      if (!this.outstandingPing || frame.nonce !== this.outstandingPing.nonce) {
        throw new TransportProtocolError("Pong nonce does not match the outstanding heartbeat.");
      }
      this.outstandingPing = null;
      this.lastHeartbeatAt = new Date(this.now()).toISOString();
      return;
    }
    if (this.state !== "connected") throw new TransportProtocolError("Worker sent data before the replay handshake completed.");
    if (frame.type === "accepted") {
      const submission = this.pending.get(frame.clientRequestId);
      if (!submission) {
        if (!this.accepted.has(frame.clientRequestId)) throw new TransportProtocolError("Worker accepted an unknown clientRequestId.");
        return;
      }
      this.pending.delete(frame.clientRequestId);
      this.rememberAccepted(frame.clientRequestId, submission.canonical);
      submission.resolve();
      return;
    }
    if (frame.type === "rejected") {
      const submission = this.pending.get(frame.clientRequestId);
      if (!submission) throw new TransportProtocolError("Worker rejected an unknown clientRequestId.");
      if (!frame.error.retryable) {
        this.pending.delete(frame.clientRequestId);
        submission.reject(new TransportRequestRejectedError(frame.error.message, frame.error.code));
        return;
      }
      submission.state = "queued";
      this.pendingReconnectFloorMs = Math.max(this.pendingReconnectFloorMs, frame.error.retryAfterMs ?? 0);
      this.socket?.close(1013, "Worker requested retry with backoff");
      return;
    }
    if (frame.type === "overloaded") {
      this.pendingReconnectFloorMs = Math.max(this.pendingReconnectFloorMs, frame.retryAfterMs ?? 0);
      this.socket?.close(1013, "Worker overloaded");
      return;
    }
    if (frame.type === "event") {
      await this.acceptEvent(frame.event);
    }
  }

  private async acceptEvent(event: AppServerEvent) {
    if (this.cursor) {
      if (event.eventId === this.cursor.eventId && event.sequence === this.cursor.sequence) {
        this.ackEvent(event);
        return;
      }
      if (event.sequence !== this.cursor.sequence + 1) {
        throw new TransportProtocolError("Worker event sequence contains a gap or an out-of-order event.");
      }
    } else if (event.sequence !== 1) {
      throw new TransportProtocolError("Worker event replay must begin at sequence 1 without a cursor.");
    }
    if (!this.eventQueue.hasCapacity()) {
      throw new Error("Transport event buffer is full; reconnecting before acknowledging more events.");
    }
    const appended = await this.journal.append(event);
    if (!appended) throw new TransportProtocolError("Worker reused an eventId with a different sequence.");
    this.cursor = { eventId: event.eventId, sequence: event.sequence };
    if (!this.eventQueue.push(event)) throw new Error("Transport event queue closed unexpectedly.");
    this.ackEvent(event);
  }

  private ackEvent(event: AppServerEvent) {
    this.sendFrame({
      protocolVersion: APP_SERVER_TRANSPORT_PROTOCOL_VERSION,
      type: "event-ack",
      eventId: event.eventId,
      sequence: event.sequence,
    });
  }

  private sendSubmission(submission: PendingSubmission) {
    if (this.state !== "connected") {
      submission.state = "queued";
      return;
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      submission.state = "queued";
      this.recordError(new Error("WebSocket became unavailable before the request was sent."));
      this.detachSocket();
      socket?.close(1001, "Reconnecting unavailable transport");
      this.scheduleReconnect();
      return;
    }
    this.sendFrame({
      protocolVersion: APP_SERVER_TRANSPORT_PROTOCOL_VERSION,
      type: "request",
      request: submission.message,
    });
    submission.state = "sent";
  }

  private sendFrame(frame: WorkerClientFrame) {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) throw new Error("WebSocket is not open.");
    if ((socket.bufferedAmount ?? 0) > this.options.maxBufferedBytes) {
      socket.close(1013, "Transport backpressure");
      throw new Error("WebSocket send buffer exceeded the safe backpressure threshold.");
    }
    const serialized = serializeClientFrame(frame);
    if (Buffer.byteLength(serialized, "utf8") > this.options.maxFrameBytes) {
      throw new TransportProtocolError("WebSocket frame exceeds the configured safety limit.");
    }
    socket.send(serialized);
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== "connected") return;
      const now = this.now();
      if (this.outstandingPing && now - this.outstandingPing.sentAt >= this.options.heartbeatTimeoutMs) {
        this.protocolFailure(new Error("Worker heartbeat timed out."));
        return;
      }
      if (this.outstandingPing) return;
      const nonce = `${now.toString(36)}-${Math.floor(this.random() * Number.MAX_SAFE_INTEGER).toString(36)}`;
      this.outstandingPing = { nonce, sentAt: now };
      try {
        this.sendFrame({
          protocolVersion: APP_SERVER_TRANSPORT_PROTOCOL_VERSION,
          type: "ping",
          nonce,
          sentAt: new Date(now).toISOString(),
        });
      } catch (error) {
        this.protocolFailure(error);
      }
    }, this.options.heartbeatIntervalMs);
  }

  private protocolFailure(error: unknown) {
    if (this.closeRequested) return;
    this.recordError(error);
    this.socket?.close(1002, "Transport protocol failure");
    if (!this.socket) this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closeRequested || this.reconnectTimer) return;
    this.stopConnectionTimers();
    for (const submission of this.pending.values()) submission.state = "queued";
    this.state = "reconnecting";
    this.reconnectAttempt += 1;
    if (this.reconnectAttempt > this.options.maxReconnectAttempts) {
      const error = new Error(this.lastError ?? "WebSocket reconnect attempts exhausted.");
      this.connectWaiter?.reject(error);
      this.connectWaiter = null;
      this.failPending(error);
      this.eventQueue.close(error);
      this.state = "closed";
      this.closeRequested = true;
      return;
    }
    const exponential = Math.min(
      this.options.reconnectMaxDelayMs,
      this.options.reconnectBaseDelayMs * (2 ** Math.max(0, this.reconnectAttempt - 1)),
    );
    const jitter = exponential * this.options.reconnectJitterRatio * ((this.random() * 2) - 1);
    const delay = Math.max(this.pendingReconnectFloorMs, Math.round(exponential + jitter));
    this.pendingReconnectFloorMs = 0;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openConnection();
    }, delay);
  }

  private rememberAccepted(clientRequestId: string, canonical: string) {
    this.accepted.delete(clientRequestId);
    this.accepted.set(clientRequestId, canonical);
    while (this.accepted.size > this.options.acceptedRequestCacheSize) {
      const oldest = this.accepted.keys().next().value;
      if (oldest === undefined) break;
      this.accepted.delete(oldest);
    }
  }

  private recordError(error: unknown) {
    this.lastError = safeErrorMessage(error);
  }

  private failPending(error: Error) {
    for (const submission of this.pending.values()) submission.reject(error);
    this.pending.clear();
  }

  private detachSocket() {
    this.frameAssembler.reset();
    const socket = this.socket;
    if (!socket) return;
    socket.removeEventListener("open", this.onOpen);
    socket.removeEventListener("message", this.onMessage);
    socket.removeEventListener("close", this.onClose);
    socket.removeEventListener("error", this.onError);
    this.socket = null;
    this.stopConnectionTimers();
  }

  private stopConnectionTimers() {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.readyTimer = null;
    this.heartbeatTimer = null;
    this.outstandingPing = null;
  }

  private clearTimers() {
    this.stopConnectionTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
