import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { atomicWriteFile } from "@/storage/atomic-file";
import { ResourceLockManager, type ResourceLockLease } from "@/storage";
import type { AppServerEvent, AppServerRequest, AppServerTransport, TransportHealth } from "../transport/contracts";
import { validateAppServerRequest } from "../transport/wire-protocol";
import { assertCodexServerNotification, assertCodexServerRequest } from "../transport/codex-contract-validation";
import { MAX_SERVER_MESSAGE_BYTES } from "../transport/bounded-server-frames";
import { TransportRequestTooLargeError } from "../transport/websocket-app-server-transport";
import { quotaToolPermissionConfigOverrides } from "../quota-tool-permissions";
import { installationOwnerAuthSocket, readInstallationOwnerAccess } from "../installation-owner-auth";
import { acquireWorkerKernelLease, type WorkerKernelLease } from "./kernel-ownership";
import { stopOwnedWorkerProcess } from "./owned-process";
import { spawnCodexWorker, workerTransportAuditRoot } from "./worker-launch";
import { PrivateStdioAuthLane } from "./private-stdio-auth";
import { parseAppServerOutput } from "./codex-stdio-protocol";
import { parseAppServerStdoutJson } from "./app-server-output-json";
import type { SharedAuthProvider } from "./shared-auth-broker";
import type { ManagedWorkerRuntime, WorkerLaunchContext, WorkerRuntimeFactory } from "./types";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_EVENTS = 4096;
const MAX_IN_FLIGHT_REQUESTS = 512;

export class LiveStdioClosedError extends Error { readonly code = "TRANSPORT_LIVE_CLOSED"; }
export class LiveStdioDuplicateSubmissionError extends Error { readonly code = "TRANSPORT_LIVE_DUPLICATE_SUBMISSION"; }

export type DirectStdioWorkerRuntimeFactoryOptions = {
  kernelLockCommand?: readonly string[];
  sharedAuth?: SharedAuthProvider;
  authForContext?: (context: WorkerLaunchContext) => SharedAuthProvider | undefined;
  processFactory?: (context: WorkerLaunchContext) => ChildProcessWithoutNullStreams;
  quotaToolPrivacy?: boolean;
  now?: () => number;
  runtimeInstanceId?: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function nativeIds(message: AppServerEvent["message"]): NonNullable<AppServerEvent["nativeIds"]> {
  const rpc = message.rpc;
  const ids: NonNullable<AppServerEvent["nativeIds"]> = {};
  if ("id" in rpc) ids.requestId = rpc.id;
  const params: Record<string, unknown> = "params" in rpc && record(rpc.params) ? rpc.params : "result" in rpc && record(rpc.result) ? rpc.result : {};
  if (typeof params.threadId === "string") ids.threadId = params.threadId;
  else if (record(params.thread) && typeof params.thread.id === "string") ids.threadId = params.thread.id;
  if (typeof params.turnId === "string") ids.turnId = params.turnId;
  else if (record(params.turn) && typeof params.turn.id === "string") ids.turnId = params.turn.id;
  if (typeof params.itemId === "string") ids.itemId = params.itemId;
  else if (record(params.item) && typeof params.item.id === "string") ids.itemId = params.item.id;
  return ids;
}

/** In-memory live delivery only. Failure requires native thread readback; no
 * accepted/replay protocol, event journal or promise of exactly-once effects. */
export class DirectStdioTransport implements AppServerTransport {
  readonly capabilities = Object.freeze({ delivery: "live" as const, epoch: randomUUID() });
  private readonly context: WorkerLaunchContext;
  private readonly auth: PrivateStdioAuthLane;
  private readonly ownsProcessGroup: boolean;
  private readonly queue: Array<{ event: AppServerEvent; bytes: number }> = [];
  private readonly waiters: Array<{ resolve(value: IteratorResult<AppServerEvent>): void; reject(error: Error): void }> = [];
  private readonly pendingRequests = new Set<string>();
  private readonly serverRequests = new Set<string | number>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private owner: ResourceLockLease | null = null;
  private kernel: WorkerKernelLease | null = null;
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private retired = false;
  private failure: Error | null = null;
  private connected = false;
  private sequence = 0;
  private bufferedBytes = 0;
  private pendingInputBytes = 0;
  private inputChain = Promise.resolve();
  private readonly lineParts: Buffer[] = [];
  private lineBytes = 0;
  private lastMessageAt: string | null = null;
  private connectedAt: string | null = null;

  constructor(private readonly baseContext: WorkerLaunchContext, private readonly options: DirectStdioWorkerRuntimeFactoryOptions = {}) {
    this.context = { ...baseContext, transportAudit: workerTransportAuditRoot(baseContext.transportAudit, options.runtimeInstanceId) };
    const personal = options.authForContext?.(baseContext);
    if (personal && options.sharedAuth) throw new Error("Personal authentication cannot share an installation credential.");
    this.auth = new PrivateStdioAuthLane(personal ?? options.sharedAuth, rpc => this.writePrivate(rpc), () => this.fail());
    this.ownsProcessGroup = !options.processFactory && process.platform !== "win32";
  }

  connect(): Promise<void> {
    if (this.retired || this.failure) return Promise.reject(this.failure ?? new LiveStdioClosedError("Live stdio worker is closed."));
    if (!this.startPromise) this.startPromise = this.start().catch(async () => {
      const failure = this.failure ?? new LiveStdioClosedError("Live stdio startup failed or was cancelled.");
      this.fail();
      await this.cleanup();
      throw failure;
    });
    return this.startPromise;
  }
  private async start() {
    const locks = new ResourceLockManager({ rootDirectory: path.join(this.context.transportAudit, "gateway-locks") });
    // Retain the existing ownership path, not a journal. This prevents overlap
    // with a legacy worker and preserves currentWorkerExecutionOrigin fences.
    const owner = await locks.acquire("worker-journal-owner", { timeoutMs: 0 });
    if (this.retired) { await owner.release(); throw new LiveStdioClosedError("Worker startup was cancelled."); }
    this.owner = owner;
    if (!this.options.processFactory) {
      const kernel = await acquireWorkerKernelLease(this.baseContext.transportAudit, owner.token, "shared", { lockCommand: this.options.kernelLockCommand });
      this.kernel = kernel;
      if (this.retired) throw new LiveStdioClosedError("Worker startup was cancelled.");
      await atomicWriteFile(path.join(owner.lockPath, "kernel.json"), JSON.stringify({ generation: owner.token,
        instanceId: path.basename(this.context.transportAudit), dev: kernel.dev, ino: kernel.ino }), { mode: 0o600 });
    }
    const overrides = this.options.quotaToolPrivacy ? quotaToolPermissionConfigOverrides({
      codexHome: this.baseContext.environment.CODEX_HOME, transportAudit: this.baseContext.transportAudit,
    }) : undefined;
    if (this.retired) throw new LiveStdioClosedError("Worker startup was cancelled.");
    this.child = this.options.processFactory?.(this.context) ?? spawnCodexWorker(this.context, this.kernel, overrides);
    this.child.once("error", () => this.fail());
    this.child.once("exit", () => { if (!this.retired) this.fail(); });
    this.child.stdin.on("error", () => this.fail());
    this.child.stdout.on("data", (chunk: Buffer) => {
      try { this.readChunk(chunk); } catch { this.fail(); }
    });
    this.child.stdout.once("end", () => { if (!this.retired) this.fail(); });
    this.child.stderr.on("error", () => this.fail());
    // Stderr EOF is not protocol EOF: a child may close its diagnostic pipe
    // while stdin/stdout remain usable. Never retain its raw diagnostics.
    this.child.stderr.resume();
    await new Promise<void>((resolve, reject) => {
      this.child!.once("spawn", resolve);
      this.child!.once("error", () => reject(new LiveStdioClosedError("Live worker could not start.")));
    });
    await this.kernel?.close(); this.kernel = null; // The protected child owns inherited fd3.
    if (this.retired) throw new LiveStdioClosedError("Worker startup was cancelled.");
    await this.auth.bootstrap();
    if (this.retired || this.failure) throw new LiveStdioClosedError("Worker startup was cancelled.");
    this.connected = true; this.connectedAt = this.now();
  }

  private now() { return new Date((this.options.now ?? Date.now)()).toISOString(); }
  private readChunk(chunk: Buffer) {
    if (this.retired) return;
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      const part = chunk.subarray(start, newline === -1 ? chunk.length : newline);
      this.lineBytes += part.length;
      if (this.lineBytes > MAX_SERVER_MESSAGE_BYTES - 1024) throw new Error("Live stdout line exceeds the safety limit.");
      if (part.length) this.lineParts.push(part);
      if (newline === -1) break;
      const bytes = Buffer.concat(this.lineParts, this.lineBytes); this.lineParts.length = 0; this.lineBytes = 0;
      this.receiveLine(new TextDecoder("utf-8", { fatal: true }).decode(bytes), bytes.length);
      start = newline + 1;
      if (start === chunk.length) break;
    }
  }
  private receiveLine(line: string, bytes: number) {
    if (this.retired) return;
    if (this.auth.consume(line)) return;
    const value = parseAppServerStdoutJson(line);
    // Preserve the existing private owner refresh boundary; no token event.
    if (installationOwnerAuthSocket(this.context.installationId) && record(value) && value.method === "account/chatgptAuthTokens/refresh") {
      const previous = record(value.params) && typeof value.params.previousAccountId === "string" ? value.params.previousAccountId : undefined;
      void readInstallationOwnerAccess(this.context.installationId, previous).then(tokens => this.writePrivate({ id: value.id, result: tokens }))
        .catch(() => this.writePrivate({ id: value.id, error: { code: -32000, message: "Installation owner authentication is unavailable." } }).catch(() => undefined));
      return;
    }
    const message = parseAppServerOutput(value);
    if (message.kind === "rpc-response") this.pendingRequests.delete(JSON.stringify(message.rpc.id));
    if (message.kind === "rpc-notification") assertCodexServerNotification(message.rpc);
    if (message.kind === "rpc-request") {
      assertCodexServerRequest(message.rpc);
      if (this.serverRequests.size >= 512 || this.serverRequests.has(message.rpc.id)) throw new Error("Invalid live server request.");
      this.serverRequests.add(message.rpc.id);
    }
    this.lastMessageAt = this.now();
    const sequence = ++this.sequence;
    const event: AppServerEvent = { eventId: `${this.capabilities.epoch}:${sequence}`, sequence, occurredAt: this.lastMessageAt,
      delivery: "live", epoch: this.capabilities.epoch, nativeIds: nativeIds(message), message };
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else {
      if (this.queue.length >= MAX_OUTPUT_EVENTS || this.bufferedBytes + bytes > MAX_OUTPUT_BYTES) throw new Error("Live event buffer exceeds the safety limit.");
      this.queue.push({ event, bytes }); this.bufferedBytes += bytes;
    }
  }

  async send(message: AppServerRequest) {
    validateAppServerRequest(message);
    const raw = JSON.stringify(message.rpc) + "\n", bytes = Buffer.byteLength(raw);
    if (bytes > MAX_INPUT_BYTES) throw new TransportRequestTooLargeError(message.clientRequestId, bytes, MAX_INPUT_BYTES);
    await this.connect();
    const requestKey = message.kind === "rpc-request" ? JSON.stringify(message.rpc.id) : null;
    if (requestKey !== null && this.pendingRequests.has(requestKey)) throw new LiveStdioDuplicateSubmissionError("Live RPC is still in flight; read native state before retrying.");
    if (requestKey !== null && this.pendingRequests.size >= MAX_IN_FLIGHT_REQUESTS || this.pendingInputBytes + bytes > MAX_QUEUED_INPUT_BYTES) throw new Error("Live submission capacity reached before dispatch.");
    if (message.kind === "rpc-response" && !this.serverRequests.has(message.rpc.id)) throw new Error("No current live server request owns this response.");
    // Reserve the callback before queuing stdin. Codex may produce the next
    // request before the previous write callback fires; two clients must also
    // never queue different responses to the same outstanding request.
    if (message.kind === "rpc-response") this.serverRequests.delete(message.rpc.id);
    if (requestKey !== null) this.pendingRequests.add(requestKey);
    this.pendingInputBytes += bytes;
    const write = this.inputChain.then(async () => {
      if (this.retired || this.failure || !this.child?.stdin.writable) throw new LiveStdioClosedError("Live write outcome is unknown; recover native thread state.");
      await new Promise<void>((resolve, reject) => this.child!.stdin.write(raw, error => error ? reject(new LiveStdioClosedError("Live write outcome is unknown; recover native thread state.")) : resolve()));
    });
    this.inputChain = write.catch(() => undefined);
    try { await write; } finally { this.pendingInputBytes -= bytes; }
  }
  private async writePrivate(rpc: unknown) {
    if (this.retired || !this.child?.stdin.writable) throw new LiveStdioClosedError("Private authentication channel is unavailable.");
    await new Promise<void>((resolve, reject) => this.child!.stdin.write(JSON.stringify(rpc) + "\n", error => error ? reject(new Error("Private authentication write failed.")) : resolve()));
  }
  events(): AsyncIterable<AppServerEvent> {
    return { [Symbol.asyncIterator]: () => ({ next: () => {
      if (this.failure) return Promise.reject(this.failure);
      const next = this.queue.shift();
      if (next) { this.bufferedBytes -= next.bytes; return Promise.resolve({ value: next.event, done: false as const }); }
      if (this.retired) return Promise.resolve({ value: undefined, done: true as const });
      return new Promise<IteratorResult<AppServerEvent>>((resolve, reject) => this.waiters.push({ resolve, reject }));
    } }) };
  }
  async health(): Promise<TransportHealth> {
    return { healthy: this.connected && !this.retired && !this.failure, state: this.retired ? "closed" : this.connected ? "connected" : this.startPromise ? "connecting" : "idle",
      endpoint: `stdio://${this.context.workerId}`, sessionId: this.capabilities.epoch, reconnectAttempt: 0,
      pendingRequests: this.pendingRequests.size, lastEventId: null, lastEventSequence: null,
      lastConnectedAt: this.connectedAt, lastMessageAt: this.lastMessageAt, lastHeartbeatAt: null,
      lastError: this.failure ? "Live stdio worker failed; recover native state." : null };
  }
  private fail() {
    if (this.failure || this.retired) return;
    this.failure = new LiveStdioClosedError("Live stdio worker failed; recover native state without replaying the request.");
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
    this.queue.length = 0; this.bufferedBytes = 0;
    void this.close().catch(() => undefined);
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.retired = true; this.auth.close();
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
    this.closePromise = (async () => {
      await this.startPromise?.catch(() => undefined);
      await this.cleanup();
      this.queue.length = 0; this.bufferedBytes = 0; this.serverRequests.clear(); this.pendingRequests.clear();
    })();
    return this.closePromise;
  }
  private cleanup(): Promise<void> {
    if (!this.cleanupPromise) this.cleanupPromise = (async () => {
      if (this.child) await stopOwnedWorkerProcess(this.child, this.ownsProcessGroup);
      this.child = null;
      await this.kernel?.close(); this.kernel = null;
      await this.inputChain.catch(() => undefined);
      await this.owner?.release(); this.owner = null;
    })();
    return this.cleanupPromise;
  }
}

/** Runtime selection and any activation remain with the installation service. */
export class DirectStdioWorkerRuntimeFactory implements WorkerRuntimeFactory {
  constructor(private readonly options: DirectStdioWorkerRuntimeFactoryOptions = {}) {}
  create(context: WorkerLaunchContext): ManagedWorkerRuntime {
    const transport = new DirectStdioTransport(context, this.options);
    return { transport, start: () => transport.connect(), stop: () => transport.close(), health: async () => {
      const health = await transport.health();
      return { healthy: health.healthy, state: health.healthy ? "running" : health.state === "connecting" ? "starting" : health.lastError ? "failed" : "stopped" };
    } };
  }
}
