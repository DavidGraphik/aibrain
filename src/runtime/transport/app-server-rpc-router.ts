import { createHash, randomUUID } from "node:crypto";
import type { ClientNotification } from "../../../contracts/codex/0.162.1/types/ClientNotification";
import type { ClientRequest } from "../../../contracts/codex/0.162.1/types/ClientRequest";
import type { ServerNotification } from "../../../contracts/codex/0.162.1/types/ServerNotification";
import type { ServerRequest } from "../../../contracts/codex/0.162.1/types/ServerRequest";
import type {
  AppServerEvent,
  AppServerTransport,
  JsonRpcFailure,
  JsonRpcSuccess,
  JsonValue,
} from "@/runtime/transport/contracts";
import { RuntimeProjectionAdmissionDeferred } from "@/runtime/transport/projection-readiness";

type PendingRequest = {
  method: ClientRequest["method"];
  requestId: string | number;
  startedAt: number;
  acceptedAt: number | null;
  activeTurnsAtStart: number;
  pendingRequestsAtStart: number;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  rejectSubmissionDeadline: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  beforeResolve?: (value: JsonValue, event: AppServerEvent) => void | Promise<void>;
  resolveLate: (value: JsonValue) => void;
  rejectLate: (error: Error) => void;
};

type TimedOutRequest = {
  pending: PendingRequest;
  cleanup: ReturnType<typeof setTimeout>;
};

export type AppServerRequestMetric = Readonly<{
  method: ClientRequest["method"];
  requestId: string | number;
  outcome: "completed" | "error" | "timeout" | "connect_error" | "send_error" | "router_closed";
  requestAcceptedMs: number | null;
  totalMs: number;
  activeTurnsAtStart: number;
  pendingRequestsAtStart: number;
}>;

export type AppServerRpcRouterOptions = Readonly<{
  now?: () => number;
  onRequestMetric?: (metric: AppServerRequestMetric) => void;
  /** Durable observers run independently of tool/turn handlers, before ACK. */
  onNotification?: (notification: ServerNotification, event: AppServerEvent) => void | Promise<void>;
  onTurnBound?: (threadId: string, turnId: string) => void;
}>;

export class AppServerRequestTimeoutError extends Error {
  constructor(
    readonly method: ClientRequest["method"],
    readonly requestId: string | number,
    readonly timeoutMs: number,
    readonly lateResponse: Promise<JsonValue> | null = null,
  ) {
    super(`App Server request timed out: ${method}.`);
    this.name = "AppServerRequestTimeoutError";
  }
}

/** A correlated remote response, distinct from transport/initialization failures. */
export class AppServerRpcResponseError extends Error {
  readonly code: number;
  readonly data?: JsonValue;
  constructor(
    readonly method: ClientRequest["method"],
    readonly requestId: string | number,
    error: JsonRpcFailure["error"],
  ) {
    super(error.message);
    this.name = "AppServerRpcResponseError";
    this.code = error.code;
    if (error.data !== undefined) this.data = error.data;
  }
}

export type AppServerTurnHandlers = {
  onNotification(notification: ServerNotification, event: AppServerEvent): void | Promise<void>;
  onServerRequest(request: ServerRequest, event: AppServerEvent): JsonValue | Promise<JsonValue>;
  onFailure(error: Error): void;
};

export type AppServerTurnRegistration = {
  readonly threadId: string;
  readonly localTurnId: string;
  bindRuntimeTurn(turnId: string): void;
  dispose(): void;
};

type TurnRegistrationState = {
  threadId: string;
  localTurnId: string;
  runtimeTurnId: string | null;
  runtimeTurnBinding: Promise<string | null>;
  resolveRuntimeTurnBinding: (turnId: string | null) => void;
  handlers: AppServerTurnHandlers;
};

type ReceivedTurnOwner = {
  threadId: string;
  state: TurnRegistrationState;
};

function safeError(error: unknown) {
  return new Error((error instanceof Error ? error.message : "App Server routing failed.")
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/(token|secret|password)=\S+/giu, "$1=[REDACTED]"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function eventScope(rpc: ServerNotification | ServerRequest) {
  const params: Record<string, unknown> | null = isRecord(rpc.params)
    ? rpc.params as unknown as Record<string, unknown>
    : null;
  if (!params || typeof params.threadId !== "string") return null;
  let turnId = typeof params.turnId === "string" ? params.turnId : null;
  if (!turnId && isRecord(params.turn) && typeof params.turn.id === "string") {
    turnId = params.turn.id;
  }
  return { threadId: params.threadId, turnId };
}

function serverResponseClientRequestId(event: AppServerEvent, request: ServerRequest) {
  const scope = eventScope(request);
  const scopeDigest = scope
    ? createHash("sha256").update(JSON.stringify([scope.threadId, scope.turnId])).digest("hex")
    : "unscoped";
  return `server-response:${event.eventId}:${scopeDigest}`;
}

/**
 * Multiplexes one employee's hot App Server transport without mutable global
 * handlers. A worker may run different threads concurrently, while each
 * thread owns at most one active turn registration.
 */
export class AppServerRpcRouter {
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly timedOut = new Map<string | number, TimedOutRequest>();
  private readonly reservedRequestIds = new Set<string | number>();
  private readonly turns = new Map<string, TurnRegistrationState>();
  private startPromise: Promise<void> | null = null;
  private consumePromise: Promise<void> | null = null;
  private readonly scopeChains = new Map<string, Promise<void>>();
  private readonly inFlightEvents = new Set<Promise<void>>();
  private readonly readyToAcknowledge = new Map<number, AppServerEvent>();
  private nextAcknowledgementSequence: number | null = null;
  private acknowledgementFlush: Promise<void> | null = null;
  private closed = false;
  private fatalError: Error | null = null;
  private readonly now: () => number;
  private readonly onRequestMetric: ((metric: AppServerRequestMetric) => void) | null;
  private readonly onNotification: AppServerRpcRouterOptions["onNotification"];
  private readonly onTurnBound: AppServerRpcRouterOptions["onTurnBound"];
  private observationChain = Promise.resolve();

  constructor(readonly transport: AppServerTransport, options: AppServerRpcRouterOptions = {}) {
    this.now = options.now ?? performance.now.bind(performance);
    this.onRequestMetric = options.onRequestMetric ?? null;
    this.onNotification = options.onNotification;
    this.onTurnBound = options.onTurnBound;
    transport.setIdleGuard?.(() => !this.closed && !this.fatalError && this.turns.size === 0
      && this.pending.size === 0 && this.timedOut.size === 0 && this.reservedRequestIds.size === 0
      && this.inFlightEvents.size === 0 && this.scopeChains.size === 0);
  }

  start() {
    if (this.closed) return Promise.reject(new Error("App Server router is closed."));
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (!this.startPromise) {
      this.startPromise = this.transport.connect().then(() => {
        const deliveryStart = this.transport.capabilities?.delivery === "live" ? undefined : this.transport.deliverySequenceStart?.();
        if (deliveryStart !== undefined) {
          if (!Number.isSafeInteger(deliveryStart) || deliveryStart < 1) throw new Error("Invalid transport delivery start.");
          this.nextAcknowledgementSequence = deliveryStart;
        }
        this.consumePromise = this.consume();
      });
    }
    return this.startPromise.then(() => {
      if (this.fatalError) throw this.fatalError;
    });
  }

  get failed() {
    return this.fatalError !== null;
  }

  async assertProjectionReady() {
    await this.start();
    if (this.transport.capabilities?.delivery === "live") return;
    // Reconnect has its own received watermark. Keep explicit reads/Stop and
    // the existing consumer usable while admission is deferred.
    await this.transport.connect();
    if (this.closed || this.fatalError) throw this.fatalError ?? new Error("App Server router is closed.");
    const target = this.transport.projectionSequenceTarget?.();
    if (target === undefined) return;
    if (!Number.isSafeInteger(target) || target < 0) throw new Error("Invalid projection target.");
    if (target > 0 && (this.nextAcknowledgementSequence === null || this.nextAcknowledgementSequence <= target)) {
      throw new RuntimeProjectionAdmissionDeferred();
    }
  }

  registerTurn(
    threadId: string,
    localTurnId: string,
    handlers: AppServerTurnHandlers,
  ): AppServerTurnRegistration {
    if (!threadId || !localTurnId || this.closed || this.fatalError) throw new Error("Turn registration scope is invalid.");
    if (this.turns.has(threadId)) throw new Error("A thread already has an active turn.");
    let resolveRuntimeTurnBinding!: (turnId: string | null) => void;
    const runtimeTurnBinding = new Promise<string | null>((resolve) => {
      resolveRuntimeTurnBinding = resolve;
    });
    const state: TurnRegistrationState = {
      threadId,
      localTurnId,
      runtimeTurnId: null,
      runtimeTurnBinding,
      resolveRuntimeTurnBinding,
      handlers,
    };
    this.turns.set(threadId, state);
    return Object.freeze({
      threadId,
      localTurnId,
      bindRuntimeTurn: (turnId: string) => {
        if (!turnId || this.turns.get(threadId) !== state) throw new Error("Turn registration is no longer active.");
        if (state.runtimeTurnId && state.runtimeTurnId !== turnId) {
          throw new Error("Turn registration cannot be rebound to another runtime turn.");
        }
        if (!state.runtimeTurnId) {
          this.onTurnBound?.(threadId, turnId);
          state.runtimeTurnId = turnId;
          state.resolveRuntimeTurnBinding(turnId);
        }
      },
      dispose: () => {
        if (this.turns.get(threadId) === state) {
          this.turns.delete(threadId);
          state.resolveRuntimeTurnBinding(null);
        }
      },
    });
  }

  hasActiveTurn(threadId: string, localTurnId?: string) {
    const turn = this.turns.get(threadId);
    return Boolean(turn && (localTurnId === undefined || turn.localTurnId === localTurnId));
  }

  async request(
    rpc: ClientRequest,
    timeoutMs = 30_000,
    beforeResolve?: (value: JsonValue, event: AppServerEvent) => void | Promise<void>,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) {
      throw new Error("App Server request timeout is invalid.");
    }
    if (this.reservedRequestIds.has(rpc.id) || this.timedOut.has(rpc.id)) {
      throw new Error("App Server request id is already pending or awaiting a late response.");
    }
    this.reservedRequestIds.add(rpc.id);
    const startedAt = this.now();
    const activeTurnsAtStart = this.turns.size;
    const pendingRequestsAtStart = this.pending.size;
    let resolveLate!: (value: JsonValue) => void;
    let rejectLate!: (error: Error) => void;
    const lateResponse = new Promise<JsonValue>((resolvePromise, rejectPromise) => {
      resolveLate = resolvePromise;
      rejectLate = rejectPromise;
    });
    // Most requests finish within their primary deadline and never expose the
    // late promise. Suppress an unhandled rejection while still allowing a
    // timeout-aware caller to await the same, already-dispatched request.
    void lateResponse.catch(() => undefined);
    const timeoutError = new AppServerRequestTimeoutError(rpc.method, rpc.id, timeoutMs, lateResponse);
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_resolve, rejectPromise) => {
      rejectDeadline = rejectPromise;
    });
    const timeout = setTimeout(() => {
      const pending = this.pending.get(rpc.id);
      if (pending) {
        this.pending.delete(rpc.id);
        const cleanup = setTimeout(() => {
          const late = this.timedOut.get(rpc.id);
          if (late?.pending !== pending) return;
          this.timedOut.delete(rpc.id);
          pending.rejectLate(timeoutError);
        }, Math.max(60_000, Math.min(5 * 60_000, timeoutMs * 2)));
        cleanup.unref?.();
        this.timedOut.set(rpc.id, { pending, cleanup });
        this.emitPendingMetric(pending, "timeout");
        pending.reject(timeoutError);
      } else {
        this.emitRequestMetric({
          method: rpc.method,
          requestId: rpc.id,
          outcome: "timeout",
          requestAcceptedMs: null,
          totalMs: this.elapsed(startedAt),
          activeTurnsAtStart,
          pendingRequestsAtStart,
        });
        rejectLate(timeoutError);
      }
      rejectDeadline(timeoutError);
    }, timeoutMs);
    timeout.unref?.();
    const start = this.start();
    try {
      await Promise.race([start, deadline]);
    } catch (error) {
      if (error instanceof AppServerRequestTimeoutError) {
        void start.catch(() => undefined);
        this.reservedRequestIds.delete(rpc.id);
        throw error;
      }
      clearTimeout(timeout);
      this.reservedRequestIds.delete(rpc.id);
      this.emitRequestMetric({
        method: rpc.method,
        requestId: rpc.id,
        outcome: this.closed || this.fatalError ? "router_closed" : "connect_error",
        requestAcceptedMs: null,
        totalMs: this.elapsed(startedAt),
        activeTurnsAtStart,
        pendingRequestsAtStart,
      });
      rejectLate(safeError(error));
      throw error;
    }
    let resolve!: (value: JsonValue) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<JsonValue>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const pending: PendingRequest = {
      method: rpc.method,
      requestId: rpc.id,
      startedAt,
      acceptedAt: null,
      activeTurnsAtStart,
      pendingRequestsAtStart,
      resolve,
      reject,
      rejectSubmissionDeadline: rejectDeadline,
      timeout,
      beforeResolve,
      resolveLate,
      rejectLate,
    };
    this.pending.set(rpc.id, pending);
    const submission = Promise.resolve().then(() => this.transport.send({
      clientRequestId: String(rpc.id),
      kind: "rpc-request",
      rpc,
    }));
    try {
      await Promise.race([submission, deadline]);
      if (this.transport.capabilities?.delivery !== "live") pending.acceptedAt ??= this.now();
    } catch (error) {
      if (error instanceof AppServerRequestTimeoutError) {
        void submission.catch(() => undefined);
        void result.catch(() => undefined);
        this.reservedRequestIds.delete(rpc.id);
        throw error;
      }
      void result.catch(() => undefined);
      clearTimeout(timeout);
      if (this.pending.get(rpc.id) === pending) {
        this.pending.delete(rpc.id);
        this.emitPendingMetric(pending, "send_error");
      }
      this.reservedRequestIds.delete(rpc.id);
      rejectLate(safeError(error));
      throw error;
    }
    return result.finally(() => this.reservedRequestIds.delete(rpc.id));
  }

  async notify(rpc: ClientNotification, clientRequestId = `notification:${randomUUID()}`) {
    await this.start();
    await this.transport.send({ clientRequestId, kind: "rpc-notification", rpc });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("App Server router closed.");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      this.emitPendingMetric(pending, "router_closed");
      pending.reject(error);
      pending.rejectSubmissionDeadline(error);
      pending.rejectLate(error);
    }
    this.pending.clear();
    for (const { pending, cleanup } of this.timedOut.values()) {
      clearTimeout(cleanup);
      pending.rejectLate(error);
    }
    this.timedOut.clear();
    for (const turn of this.turns.values()) {
      turn.resolveRuntimeTurnBinding(null);
      turn.handlers.onFailure(error);
    }
    this.turns.clear();
  }

  private async consume() {
    try {
      for await (const event of this.transport.events()) {
        if (this.closed) break;
        this.dispatch(event);
        if (this.inFlightEvents.size >= 512) {
          await Promise.race(this.inFlightEvents);
        }
      }
      await Promise.all(this.inFlightEvents);
      if (!this.closed) throw new Error("App Server transport event stream closed unexpectedly.");
    } catch (error) {
      if (!this.closed) this.fail(safeError(error));
    }
  }

  private scopeKey(event: AppServerEvent, owner: ReceivedTurnOwner | null) {
    if (event.message.kind === "rpc-response") {
      // A post-resume notification can wait for the runtime turn identity
      // supplied by turn/start. Putting that response behind the notification
      // deadlocks both. Recovery/interrupt RPCs must also remain reachable
      // while a same-thread handler is awaiting them. Serialize duplicates
      // per request, independently of ordered thread notifications/tools;
      // durable ACKs still advance only through contiguous completed events.
      const id = event.message.rpc.id;
      return `response:${typeof id}:${id}`;
    }
    const scope = eventScope(event.message.rpc);
    // Ordering belongs to one admitted local turn, not the lifetime of a
    // conversation. A cancelled/disposed turn can still have an in-flight
    // provider tool; it must not hold later turns in that same chat hostage.
    // Captured ownership is still revalidated by route(), and ACKs remain
    // contiguous even when the next turn finishes before that old tool.
    return scope ? JSON.stringify(["thread", scope.threadId, owner?.state.localTurnId ?? null]) : null;
  }

  private dispatch(event: AppServerEvent) {
    if (this.transport.capabilities?.delivery !== "live") this.nextAcknowledgementSequence ??= event.sequence;
    const receivedTurnOwner = this.turnOwnerAtReceipt(event);
    const key = this.scopeKey(event, receivedTurnOwner);
    const previous = key ? this.scopeChains.get(key) ?? Promise.resolve() : Promise.resolve();
    // Accounting must not wait behind a tool that is awaiting a child turn,
    // or a notification waiting for its turn/start reply to bind the turn.
    // Responses keep their independent lane, including quota interruptions.
    let observed = Promise.resolve();
    if (event.message.kind === "rpc-notification" && this.onNotification) {
      const notification = event.message.rpc;
      observed = this.observationChain.then(() => this.onNotification!(notification, event));
      this.observationChain = observed;
    }
    const routed = Promise.all([previous, observed]).then(() => this.route(event, receivedTurnOwner));
    if (key) {
      this.scopeChains.set(key, routed);
      void routed.finally(() => {
        if (this.scopeChains.get(key) === routed) this.scopeChains.delete(key);
      }).catch(() => undefined);
    }
    const completed = routed
      .then(() => this.queueAcknowledgement(event))
      .catch((error: unknown) => {
        if (!this.closed) this.fail(safeError(error));
      });
    this.inFlightEvents.add(completed);
    void completed.finally(() => this.inFlightEvents.delete(completed));
    return completed;
  }

  /**
   * Event routing can be delayed behind another event for the same runtime
   * turn. Capture the active registration when the event is received so a
   * delayed notification from a disposed turn can never attach itself to the
   * next local turn registered on the same thread.
   */
  private turnOwnerAtReceipt(event: AppServerEvent): ReceivedTurnOwner | null {
    if (event.message.kind === "rpc-response") return null;
    const scope = eventScope(event.message.rpc);
    if (!scope) return null;
    const state = this.turns.get(scope.threadId);
    return state ? { threadId: scope.threadId, state } : null;
  }

  private async queueAcknowledgement(event: AppServerEvent) {
    if (this.transport.capabilities?.delivery === "live") return;
    this.readyToAcknowledge.set(event.sequence, event);
    if (this.acknowledgementFlush) return this.acknowledgementFlush;
    const flush = Promise.resolve().then(async () => {
      while (this.nextAcknowledgementSequence !== null) {
        const batch: AppServerEvent[] = [];
        for (let sequence = this.nextAcknowledgementSequence; batch.length < 256; sequence++) {
          const next = this.readyToAcknowledge.get(sequence);
          if (!next) break;
          batch.push(next);
        }
        if (!batch.length) break;
        if (this.transport.acknowledgeBatch) await this.transport.acknowledgeBatch(batch);
        else for (const next of batch) await this.transport.acknowledge?.(next);
        for (const next of batch) this.readyToAcknowledge.delete(next.sequence);
        this.nextAcknowledgementSequence += batch.length;
      }
    });
    this.acknowledgementFlush = flush;
    void flush.then(() => {
      this.acknowledgementFlush = null;
      const next = this.nextAcknowledgementSequence === null ? undefined
        : this.readyToAcknowledge.get(this.nextAcknowledgementSequence);
      // A handler may finish between the last empty check and this cleanup.
      if (next && !this.closed && !this.fatalError) void this.queueAcknowledgement(next).catch(error => this.fail(safeError(error)));
    }, () => { this.acknowledgementFlush = null; });
    await flush;
  }

  private async route(event: AppServerEvent, receivedTurnOwner: ReceivedTurnOwner | null) {
    if (event.message.kind === "rpc-response") {
      const response = event.message.rpc;
      const pending = this.pending.get(response.id);
      const late = pending ? null : this.timedOut.get(response.id) ?? null;
      const request = pending ?? late?.pending;
      if (!request) return;
      if (late) {
        clearTimeout(late.cleanup);
        this.timedOut.delete(response.id);
      }
      if ("error" in response) {
        const error = new AppServerRpcResponseError(request.method, response.id, response.error);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(response.id);
          this.emitPendingMetric(pending, "error");
          pending.reject(error);
        }
        request.rejectLate(error);
      }
      else {
        try {
          await request.beforeResolve?.(response.result, event);
          // The request deadline includes its durable projection hook. If it
          // expired while persistence was blocked, the projection still
          // finishes and the event can be ACKed, but the caller must recover
          // from the typed timeout instead of receiving a late success.
          if (pending) {
            if (this.pending.get(response.id) !== pending) {
              // The deadline may have moved this very response into timedOut
              // while beforeResolve was persisting it. Complete its recovery
              // promise now; no second response will arrive to do that for us.
              const timedOut = this.timedOut.get(response.id);
              if (timedOut?.pending === pending) {
                clearTimeout(timedOut.cleanup);
                this.timedOut.delete(response.id);
                pending.resolveLate(response.result);
              }
              return;
            }
            clearTimeout(pending.timeout);
            this.pending.delete(response.id);
            this.emitPendingMetric(pending, "completed");
            pending.resolve(response.result);
          }
          request.resolveLate(response.result);
        } catch (error) {
          const safe = safeError(error);
          if (pending && this.pending.get(response.id) === pending) {
            clearTimeout(pending.timeout);
            this.pending.delete(response.id);
            this.emitPendingMetric(pending, "error");
            pending.reject(safe);
          }
          request.rejectLate(safe);
          throw error;
        }
      }
      return;
    }

    if (event.message.kind === "rpc-notification") {
      const notification = event.message.rpc;
      const scope = eventScope(notification);
      const turn = scope && receivedTurnOwner?.threadId === scope.threadId &&
          this.turns.get(scope.threadId) === receivedTurnOwner.state
        ? receivedTurnOwner.state
        : null;
      if (turn && scope?.turnId) {
        const runtimeTurnId = turn.runtimeTurnId ?? await turn.runtimeTurnBinding;
        if (runtimeTurnId !== scope.turnId) return;
      }
      if (turn) await turn.handlers.onNotification(notification, event);
      return;
    }

    const request = event.message.rpc;
    const scope = eventScope(request);
    const turn = scope && receivedTurnOwner?.threadId === scope.threadId &&
        this.turns.get(scope.threadId) === receivedTurnOwner.state
      ? receivedTurnOwner.state
      : null;
    let turnScopeMismatch = false;
    if (turn && scope?.turnId) {
      const runtimeTurnId = turn.runtimeTurnId ?? await turn.runtimeTurnBinding;
      turnScopeMismatch = runtimeTurnId !== scope.turnId;
    }
    const response: JsonRpcSuccess | JsonRpcFailure = turn && !turnScopeMismatch
      ? await Promise.resolve(turn.handlers.onServerRequest(request, event)).then(
          (result) => ({ id: request.id, result }),
          (error: unknown) => ({ id: request.id, error: { code: -32603, message: safeError(error).message } }),
        )
      : {
          id: request.id,
          error: {
            code: -32602,
            message: turnScopeMismatch
              ? "The active thread route does not own this runtime turn."
              : "No active user/thread/turn route owns this server request.",
          },
        };
    await this.transport.send({
      clientRequestId: serverResponseClientRequestId(event, request),
      kind: "rpc-response",
      rpc: response,
    });
  }

  private fail(error: Error) {
    if (this.fatalError || this.closed) return;
    this.fatalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      this.emitPendingMetric(pending, "router_closed");
      pending.reject(error);
      pending.rejectSubmissionDeadline(error);
      pending.rejectLate(error);
    }
    this.pending.clear();
    for (const { pending, cleanup } of this.timedOut.values()) {
      clearTimeout(cleanup);
      pending.rejectLate(error);
    }
    this.timedOut.clear();
    for (const turn of this.turns.values()) {
      turn.resolveRuntimeTurnBinding(null);
      turn.handlers.onFailure(error);
    }
    this.turns.clear();
  }

  private elapsed(startedAt: number) {
    return Math.max(0, Math.round(this.now() - startedAt));
  }

  private emitPendingMetric(
    pending: PendingRequest,
    outcome: AppServerRequestMetric["outcome"],
  ) {
    this.emitRequestMetric({
      method: pending.method,
      requestId: pending.requestId,
      outcome,
      requestAcceptedMs: pending.acceptedAt === null
        ? null
        : Math.max(0, Math.round(pending.acceptedAt - pending.startedAt)),
      totalMs: this.elapsed(pending.startedAt),
      activeTurnsAtStart: pending.activeTurnsAtStart,
      pendingRequestsAtStart: pending.pendingRequestsAtStart,
    });
  }

  private emitRequestMetric(metric: AppServerRequestMetric) {
    try {
      this.onRequestMetric?.(metric);
    } catch {
      // Operational telemetry must never change App Server request semantics.
    }
  }
}
