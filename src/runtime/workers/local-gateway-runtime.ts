import { gatewayFailureDiagnostic, type GatewayFailureStage } from "./gateway-failure-diagnostics";
import { acquireWorkerKernelLease, type WorkerKernelLease } from "./kernel-ownership";
import { atomicWriteFile } from "@/storage/atomic-file";
import { takeAppServerOutputBatch } from "./app-server-output-buffer";
import { assertCodexServerNotification } from "@/runtime/transport/codex-contract-validation";
import { parseAppServerStdoutJson } from "./app-server-output-json";
import { encodeServerFrames, MAX_SERVER_MESSAGE_BYTES } from '../transport/bounded-server-frames';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stopOwnedWorkerProcess } from "./owned-process";
import { createServer, type Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import path from "node:path";
import { stat } from "node:fs/promises";
import WebSocket, { WebSocketServer } from "ws";
import type {
  AppServerEvent,
  AppServerRequest,
  AppServerTransport,
  JsonValue,
  JsonRpcSuccess,
  JsonRpcFailure,
  TransportHealth,
} from "@/runtime/transport";
import {
  APP_SERVER_TRANSPORT_PROTOCOL_VERSION,
  FileTransportEventJournal,
  WebSocketAppServerTransport,
  validateAppServerRequest,
} from "@/runtime/transport";
import type {
  WebSocketConnectOptions,
  WebSocketFactory,
  WebSocketLike,
} from "@/runtime/transport/websocket-types";
import type {
  ManagedWorkerRuntime,
  WorkerControllerHealth,
  WorkerLaunchContext,
  WorkerRuntimeFactory,
} from "@/runtime/workers/types";
import { quotaToolPermissionConfigOverrides } from "@/runtime/quota-tool-permissions";
import { installationOwnerAuthSocket, readInstallationOwnerAccess } from "@/runtime/installation-owner-auth";
import type { SharedAuthProvider, SharedAuthTokens } from "./shared-auth-broker";
import {
  defineVersionedSchema,
  expectIsoDate,
  expectOneOf,
  expectString,
  FileJournal,
  ResourceLockManager,
  type ResourceLockLease,
  type StorageSchema,
} from "@/storage";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_STDIO_LINE_BYTES = MAX_SERVER_MESSAGE_BYTES - 1024;
const DEFAULT_RETAINED_COMPLETED_REQUESTS = 4_096;
const DEFAULT_RETAINED_OBSERVATION_BYTES = 4 * 1024 * 1024;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EGRESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;
const RUNTIME_INSTANCE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export function workerTransportAuditRoot(
  transportAudit: string,
  runtimeInstanceId = process.env.AIBRAIN_RUNTIME_INSTANCE?.trim() || "app",
) {
  if (!RUNTIME_INSTANCE_ID.test(runtimeInstanceId)) {
    throw new Error("Worker runtime instance id is invalid.");
  }
  return path.join(transportAudit, "runtime-instances", runtimeInstanceId);
}

export function workerEgressEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const base = environment.AIBRAIN_EGRESS_PROXY_URL?.trim();
  const token = environment.AIBRAIN_EGRESS_WORKER_TOKEN?.trim();
  if (!base && !token && environment.NODE_ENV !== "production") return Object.freeze({});
  if (!base || !token || !EGRESS_TOKEN_PATTERN.test(token)) {
    throw new Error("Worker egress gateway URL and strong worker token are required.");
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch (error) {
    throw new Error("Worker egress gateway URL is invalid.", { cause: error });
  }
  const port = url.port ? Number(url.port) : 80;
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || !url.hostname || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Worker egress gateway must be a credential-free HTTP origin.");
  }
  url.username = "aibrain";
  url.password = token;
  const authenticatedProxy = url.toString();
  const noProxy = "127.0.0.1,localhost,::1";
  return Object.freeze({
    HTTP_PROXY: authenticatedProxy,
    HTTPS_PROXY: authenticatedProxy,
    ALL_PROXY: authenticatedProxy,
    NO_PROXY: noProxy,
    // reqwest (used by Codex for ChatGPT token renewal) reads the lowercase
    // forms. Keep both spellings so browser/Node tools and the App Server use
    // the same authenticated, allowlisted worker channel.
    http_proxy: authenticatedProxy,
    https_proxy: authenticatedProxy,
    all_proxy: authenticatedProxy,
    no_proxy: noProxy,
  });
}

type GatewayRequestRecord = {
  schemaVersion: 1;
  clientRequestId: string;
  canonicalHash: string;
  status: "accepted" | "completed";
  responseJson: string | null;
  occurredAt: string;
};

const gatewayRequestSchema = defineVersionedSchema<GatewayRequestRecord>({
  name: "GatewayRequestRecord",
  schemaVersion: 1,
  keys: ["clientRequestId", "canonicalHash", "status", "responseJson", "occurredAt"],
  parse(record, context) {
    const status = expectOneOf(record.status, ["accepted", "completed"] as const, context.at("status"));
    const responseJson = record.responseJson === null
      ? null
      : expectString(record.responseJson, context.at("responseJson"), { maxLength: MAX_SERVER_MESSAGE_BYTES });
    if ((status === "accepted") !== (responseJson === null)) {
      context.at("responseJson").fail("accepted requests cannot contain a response and completed requests require one");
    }
    return {
      schemaVersion: 1,
      clientRequestId: expectString(record.clientRequestId, context.at("clientRequestId"), {
        pattern: CLIENT_REQUEST_ID,
      }),
      canonicalHash: expectString(record.canonicalHash, context.at("canonicalHash"), { pattern: SHA256 }),
      status,
      responseJson,
      occurredAt: expectIsoDate(record.occurredAt, context.at("occurredAt")),
    };
  },
});

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "Worker gateway failure")
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/(token|secret|password)=\S+/giu, "$1=[REDACTED]");
}

function sameSecret(received: string, expected: string) {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function parseAppServerOutput(value: unknown): AppServerEvent["message"] {
  if (!isRecord(value)) throw new Error("Codex App Server emitted a non-object message.");
  if ((typeof value.id === "string" || typeof value.id === "number") && typeof value.method === "string") {
    return { kind: "rpc-request", rpc: value as never };
  }
  if (typeof value.method === "string" && value.id === undefined) {
    return { kind: "rpc-notification", rpc: value as never };
  }
  if (typeof value.id === "string" || typeof value.id === "number") {
    if ("result" in value) return { kind: "rpc-response", rpc: { id: value.id, result: asJsonValue(value.result) } };
    if (isRecord(value.error) && Number.isSafeInteger(value.error.code) && typeof value.error.message === "string") {
      return {
        kind: "rpc-response",
        rpc: {
          id: value.id,
          error: {
            code: value.error.code as number,
            message: value.error.message,
            ...(value.error.data === undefined ? {} : { data: asJsonValue(value.error.data) }),
          },
        },
      };
    }
  }
  throw new Error("Codex App Server emitted an unsupported JSON-RPC message.");
}

type AppServerScope = { threadId: string; turnId: string | null };

function appServerScope(message: AppServerEvent["message"]): AppServerScope | null {
  if (message.kind === "rpc-response") return null;
  const rawParams: unknown = message.rpc.params;
  const params = isRecord(rawParams) ? rawParams : null;
  if (!params || typeof params.threadId !== "string") return null;
  let turnId = typeof params.turnId === "string" ? params.turnId : null;
  if (!turnId && isRecord(params.turn) && typeof params.turn.id === "string") {
    turnId = params.turn.id;
  }
  return { threadId: params.threadId, turnId };
}

function appServerScopeDigest(scope: AppServerScope) {
  return sha256(JSON.stringify([scope.threadId, scope.turnId]));
}

function serverResponseClientRequestId(event: AppServerEvent) {
  const scope = appServerScope(event.message);
  return `server-response:${event.eventId}:${scope ? appServerScopeDigest(scope) : "unscoped"}`;
}

function encodedResponseScopeDigest(clientRequestId: string) {
  if (!clientRequestId.startsWith("server-response:")) return undefined;
  const suffix = clientRequestId.slice(clientRequestId.lastIndexOf(":") + 1);
  if (suffix === "unscoped") return null;
  return SHA256.test(suffix) ? suffix : undefined;
}

class GatewayRequestLedger {
  private readonly journal: FileJournal<GatewayRequestRecord>;
  private completedSinceCompaction = 0;
  private observationBytesSinceCompaction = 0;

  constructor(
    private readonly filePath: string,
    lockManager: ResourceLockManager,
    private readonly now: () => number,
    private readonly maxRetainedCompletedRequests: number,
    private readonly maxRetainedObservationBytes: number,
  ) {
    if (!Number.isSafeInteger(maxRetainedCompletedRequests) ||
        maxRetainedCompletedRequests < 1 || maxRetainedCompletedRequests > 65_536) {
      throw new Error("Completed request retention must be between 1 and 65536.");
    }
    if (!Number.isSafeInteger(maxRetainedObservationBytes) || maxRetainedObservationBytes < 1) {
      throw new Error("Observation byte retention must be positive.");
    }
    this.journal = new FileJournal({
      filePath,
      lockManager,
      payloadSchema: gatewayRequestSchema,
      keyOf: record => record.clientRequestId,
      now,
    });
  }

  async latest(clientRequestId: string) {
    return (await this.journal.findLastByKey(clientRequestId))?.payload ?? null;
  }

  async accept(clientRequestId: string, canonicalHash: string) {
    const existing = await this.latest(clientRequestId);
    if (existing) {
      if (existing.canonicalHash !== canonicalHash) {
        throw new Error("clientRequestId was reused with a different payload.");
      }
      return { existing: true, record: existing };
    }
    const record: GatewayRequestRecord = {
      schemaVersion: 1,
      clientRequestId,
      canonicalHash,
      status: "accepted",
      responseJson: null,
      occurredAt: new Date(this.now()).toISOString(),
    };
    await this.journal.append(record);
    return { existing: false, record };
  }

  async complete(clientRequestId: string, response: unknown) {
    const existing = await this.latest(clientRequestId);
    if (!existing) throw new Error("Cannot complete an unknown gateway request.");
    if (existing.status === "completed") return existing;
    const responseJson = JSON.stringify(response);
    if (Buffer.byteLength(responseJson, "utf8") > MAX_STDIO_LINE_BYTES) {
      throw new Error("Codex response exceeds the gateway safety limit.");
    }
    const completed: GatewayRequestRecord = {
      ...existing,
      status: "completed",
      responseJson,
      occurredAt: new Date(this.now()).toISOString(),
    };
    await this.journal.append(completed);
    this.completedSinceCompaction += 1;
    if (/^(?:thread-resume|thread-resume-recover|thread-resume-retry|turn-completion-reconcile):/u.test(clientRequestId)) {
      this.observationBytesSinceCompaction += Buffer.byteLength(responseJson ?? "", "utf8");
    }
    await this.compact(false);
    return completed;
  }

  async compact(force = true) {
    // Startup checks historical pressure once. An irreducible protected receipt
    // can exceed the observation budget forever: do not rescan it for every RPC.
    if (!force && this.completedSinceCompaction < this.maxRetainedCompletedRequests &&
        this.observationBytesSinceCompaction < this.maxRetainedObservationBytes) return;
    let bytes = 0;
    try { bytes = (await stat(this.filePath)).size; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await this.journal.compactSelected(async (entries) => {
      const bytePressure = bytes > this.maxRetainedObservationBytes * 2;
      type Receipt = { sequence: number; clientRequestId: string; status: GatewayRequestRecord["status"]; bytes: number };
      const latest = new Map<string, Receipt>();
      let count = 0;
      for await (const entry of entries) {
        const record = entry.payload;
        count += 1;
        latest.delete(record.clientRequestId);
        latest.set(record.clientRequestId, { sequence: entry.sequence, clientRequestId: record.clientRequestId,
          status: record.status, bytes: Buffer.byteLength(record.responseJson ?? "", "utf8") });
      }
      if (count <= this.maxRetainedCompletedRequests * 2 && !bytePressure) return undefined;
      const records = [...latest.values()];
      const selected = new Set(records.filter(record => record.status === "accepted").map(record => record.sequence));
      const completed = records.filter(record => record.status === "completed");
      const countRetained = new Set(completed.slice(-this.maxRetainedCompletedRequests).map(record => record.sequence));
      let observationBytes = 0;
      for (const record of completed.toReversed()) {
        // Creation and effect receipts survive regardless of byte/count pressure.
        if (/^(?:thread-start|turn-start|server-response):/u.test(record.clientRequestId)) {
          selected.add(record.sequence); continue;
        }
        if (!countRetained.has(record.sequence)) continue;
        const observation = /^(?:thread-resume|thread-resume-recover|thread-resume-retry|turn-completion-reconcile):/u.test(record.clientRequestId);
        if (bytePressure && observation) {
          if (observationBytes + record.bytes > this.maxRetainedObservationBytes) continue;
          observationBytes += record.bytes;
        }
        selected.add(record.sequence);
      }
      return selected.size < count ? selected : undefined;
    });
    this.completedSinceCompaction = 0;
    this.observationBytesSinceCompaction = 0;
  }
}

export type PrivateWorkerGatewayOptions = {
  context: WorkerLaunchContext;
  kernelOwnershipRoot?: string;
  kernelLockCommand?: readonly string[];
  sharedAuth?: SharedAuthProvider;
  processFactory?: (context: WorkerLaunchContext) => ChildProcessWithoutNullStreams;
  configOverrides?: readonly string[];
  now?: () => number;
  maxRetainedCompletedRequests?: number;
  maxRetainedObservationBytes?: number;
  maxRetainedDeliveredEvents?: number;
};

/**
 * Loopback-only authenticated gateway for one employee worker.
 *
 * It owns exactly one Codex App Server stdio process. The Next.js runtime talks
 * to this boundary only through the versioned private WebSocket envelope.
 */
export class PrivateWorkerGateway {
  readonly context: WorkerLaunchContext;
  readonly token: string;
  readonly sessionId = randomUUID();
  endpoint: string | null = null;

  private readonly now: () => number;
  private readonly sharedAuth?: SharedAuthProvider;
  private authTokens: SharedAuthTokens | null = null;
  private readonly privateRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly processFactory: NonNullable<PrivateWorkerGatewayOptions["processFactory"]>;
  private readonly locks: ResourceLockManager;
  private readonly events: FileTransportEventJournal;
  private readonly requests: GatewayRequestLedger;
  private journalOwner: ResourceLockLease | null = null;
  private kernelOwner: WorkerKernelLease | null = null;
  private readonly kernelOwnershipRoot?: string;
  private readonly kernelLockCommand?: readonly string[];
  private startupJournalWork: Promise<unknown> | null = null;
  private server: HttpServer | null = null;
  private readonly connections = new Set<Socket>();
  private sockets: WebSocketServer | null = null;
  private activeSocket: WebSocket | null = null;
  // One contiguous durable delivery cursor per connection. Live appends extend
  // this drain instead of bypassing a replay that is awaiting I/O.
  private readonly socketDeliveries = new WeakMap<WebSocket, {
    sequence: number; through: number; ready: boolean; draining: Promise<void> | null;
  }>();
  private readonly eventDeliveryDrains = new Set<Promise<void>>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly ownsProcessGroup: boolean;
  private stopPromise: Promise<void> | null = null;
  // One gateway is one process generation. A stopped generation never revives,
  // including when journal repair finishes after its owner has timed out.
  private retired = false;
  private listenPromise: Promise<void> | null = null;
  private lines: Interface | null = null;
  private stopping = false;
  private state: WorkerControllerHealth["state"] = "stopped";
  private lastError: string | null = null;
  private diagnosticWrite = Promise.resolve();
  // App Server stdout can contain a long stream of durable deltas. Client
  // control frames travel in the opposite direction and must never queue
  // behind that persistence work: doing so made one busy turn block
  // thread/start, thread/read and turn/interrupt for every chat of the user.
  private appServerOutputChain = Promise.resolve();
  private readonly appServerOutputLines: string[] = [];
  private drainingAppServerOutput = false;
  private clientFrameChain = Promise.resolve();
  private eventAcknowledgementChain = Promise.resolve();
  private eventRecordChain = Promise.resolve();
  private readonly inFlightRequests = new Set<string>();
  private readonly pendingResponseConfirmations = new Map<string, string>();
  private readonly currentServerResponses = new Map<string, string | number>();

  constructor(options: PrivateWorkerGatewayOptions) {
    this.context = options.context;
    this.kernelOwnershipRoot = options.kernelOwnershipRoot;
    this.kernelLockCommand = options.kernelLockCommand;
    this.sharedAuth = options.sharedAuth;
    this.now = options.now ?? Date.now;
    this.token = randomBytes(32).toString("base64url");
    this.locks = new ResourceLockManager({
      rootDirectory: path.join(options.context.transportAudit, "gateway-locks"),
    });
    this.events = new FileTransportEventJournal({
      filePath: path.join(options.context.transportAudit, "gateway-events.jsonl"),
      lockManager: this.locks,
      maxRetainedDeliveredEvents: options.maxRetainedDeliveredEvents,
    });
    this.requests = new GatewayRequestLedger(
      path.join(options.context.transportAudit, "gateway-requests.jsonl"),
      this.locks,
      this.now,
      options.maxRetainedCompletedRequests ?? DEFAULT_RETAINED_COMPLETED_REQUESTS,
      options.maxRetainedObservationBytes ?? DEFAULT_RETAINED_OBSERVATION_BYTES,
    );
    // Injected factories retain direct-child semantics: never assume that an
    // arbitrary child PID is a process group owned by this gateway.
    this.ownsProcessGroup = !options.processFactory && process.platform !== "win32";
    this.processFactory = options.processFactory ?? ((context) => spawn(/* turbopackIgnore: true */
      process.env.CODEX_BIN?.trim() || "codex",
      ["app-server", "--stdio", ...(options.configOverrides ?? []).flatMap((value) => ["-c", value])],
      {
        cwd: context.workspace,
        env: {
          NODE_ENV: process.env.NODE_ENV ?? "production",
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          LC_ALL: process.env.LC_ALL,
          LC_CTYPE: process.env.LC_CTYPE,
          TZ: process.env.TZ,
          SSL_CERT_FILE: process.env.SSL_CERT_FILE,
          SSL_CERT_DIR: process.env.SSL_CERT_DIR,
          NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
          ...workerEgressEnvironment(),
          ...context.environment,
          ...(this.kernelOwner ? { AIBRAIN_WORKER_LOCK_FD: "3" } : {}),
        },
        stdio: this.kernelOwner ? ["pipe", "pipe", "pipe", this.kernelOwner.fd] : ["pipe", "pipe", "pipe"],
        detached: this.ownsProcessGroup,
      },
    ) as ChildProcessWithoutNullStreams);
  }

  async start() {
    if (this.retired) throw new Error("Worker gateway startup was cancelled.");
    if (this.state === "running") return;
    if (this.state === "starting") throw new Error("Worker gateway is already starting.");
    this.state = "starting";
    this.stopping = false;
    try {
      // A stable role is a replay identity, not permission for two live
      // processes to consume it. Reject operator/duplicate starts before any
      // journal repair, cursor advancement or child process creation.
      const owner = await this.locks.acquire("worker-journal-owner", { timeoutMs: 0 });
      if (this.retired) {
        await owner.release();
        throw new Error("Worker gateway startup was cancelled.");
      }
      this.journalOwner = owner;
      if (this.kernelOwnershipRoot) {
        this.kernelOwner = await acquireWorkerKernelLease(this.kernelOwnershipRoot, owner.token, "shared", { lockCommand: this.kernelLockCommand });
        await atomicWriteFile(path.join(owner.lockPath, "kernel.json"), JSON.stringify({ generation: owner.token,
          instanceId: path.basename(this.context.transportAudit), dev: this.kernelOwner.dev, ino: this.kernelOwner.ino }), { mode: 0o600 });
      }
      this.startupJournalWork = (async () => {
        await this.events.verifyAndRepair();
        await this.requests.compact();
      })();
      await this.startupJournalWork;
      if (this.retired) throw new Error("Worker gateway startup was cancelled.");
      this.child = this.processFactory(this.context);
      this.child.once("error", (error) => { if (!this.retired) this.fail(error, "child-error"); });
      this.child.once("exit", (code, signal) => {
        if (!this.retired && !this.stopping) this.fail(new Error(`Codex App Server exited (${code ?? signal ?? "unknown"}).`), "child-exit", {code, signal});
      });
      // spawn duplicated fd3 into the sandbox monitor. The parent must not
      // keep an extra shared fd after handoff: a crashed App Server must be
      // recoverable even while this Node service and other workers stay alive.
      await this.kernelOwner?.close();
      this.kernelOwner = null;
      if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error("Codex App Server exited during ownership handoff.");
      this.lines = createInterface({ input: this.child.stdout });
      this.lines.on("line", (line) => {
        if (Buffer.byteLength(line, "utf8") > MAX_STDIO_LINE_BYTES) {
          this.fail(new Error("Codex App Server line exceeds the safety limit."), "stdout-limit");
          return;
        }
        // Secret-bearing login/refresh RPCs use a private stdio lane. They
        // must never enter either the gateway or client durable journals.
        if (this.consumePrivateAuthLine(line)) return;
        this.appServerOutputLines.push(line);
        if (this.drainingAppServerOutput) return;
        this.drainingAppServerOutput = true;
        this.appServerOutputChain = this.appServerOutputChain.then(async () => {
          let batch: string[];
          while ((batch = takeAppServerOutputBatch(this.appServerOutputLines)).length) {
            if (batch.length === 1) await this.receiveAppServerLine(batch[0]);
            else await this.receiveAppServerNotifications(batch);
          }
        }).catch((error: unknown) => {
          this.appServerOutputLines.length = 0;
          this.fail(error, "stdout-processing");
        }).finally(() => { this.drainingAppServerOutput = false; });
      });
      this.child.stderr.resume();


      if (this.sharedAuth) {
        await this.privateRequest("initialize", { clientInfo: { name: "aibrain_workbench", version: "0.4.0" }, capabilities: { experimentalApi: true } });
        await this.writePrivateRpc({ method: "initialized" });
        this.authTokens = await this.sharedAuth();
        const login = await this.privateRequest("account/login/start", { type: "chatgptAuthTokens", ...this.authTokens });
        if (!isRecord(login) || login.type !== "chatgptAuthTokens") throw new Error("Shared external authentication was not accepted.");
      }

      this.server = createServer((_, response) => {
        response.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        response.end("Not found");
      });
      this.server.on("connection", (socket) => {
        // Own TCP connections before the WebSocket upgrade. A reconnect
        // interrupted before HTTP headers complete is absent from ws.clients.
        if (this.retired) { socket.destroy(); return; }
        this.connections.add(socket);
        socket.once("close", () => this.connections.delete(socket));
      });
      this.sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
      this.server.on("upgrade", (request, socket, head) => {
        if (this.retired) { socket.destroy(); return; }
        const expected = `Bearer ${this.token}`;
        const received = request.headers.authorization ?? "";
        const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        if (requestPath !== "/app-server" || !sameSecret(received, expected)) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        this.sockets?.handleUpgrade(request, socket, head, (webSocket) => {
          this.sockets?.emit("connection", webSocket, request);
        });
      });
      this.sockets.on("connection", (socket) => this.attach(socket));
      const server = this.server;
      this.listenPromise = new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", onError);
          resolve();
        });
      });
      await this.listenPromise;
      if (this.retired) throw new Error("Worker gateway startup was cancelled.");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Worker gateway did not bind a TCP port.");
      this.endpoint = `ws://127.0.0.1:${address.port}/app-server`;
      this.state = "running";
      this.lastError = null;
    } catch (error) {
      // stop owns cleanup once retired. Never recurse into stop from a late
      // start continuation or overwrite stopped health with a stale failure.
      if (this.retired) throw error;
      this.state = "failed";
      this.lastError = safeError(error);
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async health(): Promise<WorkerControllerHealth> {
    return {
      healthy: this.state === "running" && Boolean(this.endpoint && this.child && this.server),
      state: this.state,
      ...(this.lastError ? { detail: this.lastError } : {}),
    };
  }

  /** Read an exact completed receipt in this worker's private ledger without sending an RPC. */
  async recoverResponse(request: AppServerRequest): Promise<JsonRpcSuccess | JsonRpcFailure | null> {
    validateAppServerRequest(request);
    if (request.kind !== "rpc-request") throw new Error("Only RPC requests have recoverable responses.");
    const record = await this.requests.latest(request.clientRequestId);
    if (!record) return null;
    if (record.canonicalHash !== sha256(JSON.stringify(request))) {
      throw new Error("Recovery request does not match its durable receipt.");
    }
    if (record.status !== "completed" || !record.responseJson) return null;
    const message = parseAppServerOutput(JSON.parse(record.responseJson));
    if (message.kind !== "rpc-response" || message.rpc.id !== request.rpc.id) {
      throw new Error("Recovery response does not match its original request.");
    }
    return message.rpc;
  }

  private async writePrivateRpc(rpc: unknown) {
    if (this.retired || !this.child?.stdin.writable) throw new Error("Private authentication channel is unavailable.");
    const child = this.child;
    await new Promise<void>((resolve, reject) => child.stdin.write(`${JSON.stringify(rpc)}\n`, error => error ? reject(new Error("Private authentication write failed.")) : resolve()));
  }

  private async privateRequest(method: string, params: unknown) {
    const id = `private-auth:${randomUUID()}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.privateRequests.delete(id); reject(new Error("Private authentication request timed out.")); }, 8_000);
      this.privateRequests.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      void this.writePrivateRpc({ id, method, params }).catch(error => {
        const pending = this.privateRequests.get(id); this.privateRequests.delete(id); pending?.reject(error);
      });
    });
  }

  private consumePrivateAuthLine(line: string) {
    if (!this.sharedAuth) return false;
    let rpc: Record<string, unknown>;
    try { rpc = JSON.parse(line); } catch { return false; }
    if (!isRecord(rpc)) return false;
    if (typeof rpc.id === "string" && rpc.id.startsWith("private-auth:")) {
      const pending = this.privateRequests.get(rpc.id);
      this.privateRequests.delete(rpc.id);
      if (rpc.error) pending?.reject(new Error("Private authentication was rejected.")); else pending?.resolve(rpc.result);
      return true;
    }
    if (rpc.method !== "account/chatgptAuthTokens/refresh") return false;
    const id = rpc.id;
    const params = rpc.params;
    if ((typeof id !== "string" && typeof id !== "number") || !isRecord(params) || params.reason !== "unauthorized" ||
        (params.previousAccountId != null && typeof params.previousAccountId !== "string")) {
      this.fail(new Error("Private authentication refresh request is invalid."), "auth-refresh");
      return true;
    }
    // Do not block the output lane while the sole credential owner renews.
    void this.sharedAuth(params.previousAccountId as string | null | undefined, this.authTokens?.accessToken).then(async tokens => {
      this.authTokens = tokens;
      await this.writePrivateRpc({ id, result: tokens });
    }).catch(async () => {
      await this.writePrivateRpc({ id, error: { code: -32603, message: "La sesión requiere reconexión del administrador." } }).catch(() => undefined);
    });
    return true;
  }

  async stop() {
    this.retired = true;
    for (const pending of this.privateRequests.values()) pending.reject(new Error("Private authentication channel closed."));
    this.privateRequests.clear();
    if (this.stopPromise) return this.stopPromise;
    if (this.state === "stopped") return;
    this.stopPromise = this.stopOnce().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  private async stopOnce() {
    this.stopping = true;
    this.state = "stopping";
    // Node can still bind after close() if listen is pending. Drain that owned
    // side effect before closing the server and releasing process ownership.
    await this.listenPromise?.catch(() => undefined);
    this.activeSocket?.terminate();
    this.activeSocket = null;
    // The durable cursor owns replay. Do not wait for a disconnected client
    // to finish a WebSocket close handshake before stopping our process.
    for (const client of this.sockets?.clients ?? []) client.terminate();
    // HTTP server.close() waits for incomplete handshakes. Retiring prevents
    // new ownership; terminate only the sockets created by this gateway.
    for (const connection of this.connections) connection.destroy();
    await new Promise<void>((resolve) => {
      if (!this.sockets) return resolve();
      this.sockets.close(() => resolve());
    });
    this.sockets = null;
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    this.lines?.close();
    this.lines = null;
    const child = this.child;
    if (child) await stopOwnedWorkerProcess(child, this.ownsProcessGroup);
    this.child = null;
    await this.kernelOwner?.close();
    this.kernelOwner = null;
    await Promise.all([
      this.appServerOutputChain.catch(() => undefined),
      this.clientFrameChain.catch(() => undefined),
    ]);
    // Those producers can enqueue durable ACK/event work while they drain.
    // Capture their dependent lanes only after no producer can add more work;
    // a single concurrent snapshot could release ownership before a late ACK.
    await Promise.all([
      this.eventAcknowledgementChain.catch(() => undefined),
      this.eventRecordChain.catch(() => undefined),
      this.diagnosticWrite,
    ]);
    await Promise.all([...this.eventDeliveryDrains].map(drain => drain.catch(() => undefined)));
    this.endpoint = null;
    await this.startupJournalWork?.catch(() => undefined);
    await this.journalOwner?.release();
    this.journalOwner = null;
    this.state = "stopped";
    this.stopping = false;
  }

  private attach(socket: WebSocket) {
    this.activeSocket?.close(1012, "Replaced by a reconnected backend");
    this.activeSocket = socket;
    let resumed = false;
    socket.on("message", (data, isBinary) => {
      if (this.retired) return;
      const frame = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
      if (isBinary || frame.byteLength > MAX_FRAME_BYTES) {
        socket.close(1003, "Text frame required");
        return;
      }
      this.clientFrameChain = this.clientFrameChain
        .then(async () => {
          const value: unknown = JSON.parse(frame.toString("utf8"));
          if (!isRecord(value) || value.protocolVersion !== APP_SERVER_TRANSPORT_PROTOCOL_VERSION) {
            throw new Error("Unsupported worker gateway protocol.");
          }
          if (!resumed) {
            if (value.type !== "resume") throw new Error("First worker frame must be resume.");
            resumed = true;
            await this.resume(socket, value.afterEventId, value.afterSequence);
            return;
          }
          if (value.type === "event-ack") {
            const acknowledgement = this.eventAcknowledgementChain
              .then(() => this.handleClientFrame(socket, value));
            this.eventAcknowledgementChain = acknowledgement.catch(() => undefined);
            void acknowledgement.catch(() => socket.close(1002, "Protocol error"));
            return;
          }
          await this.handleClientFrame(socket, value);
        })
        .catch(() => socket.close(1002, "Protocol error"));
    });
    socket.on("close", () => {
      if (this.activeSocket === socket) this.activeSocket = null;
    });
  }

  private send(socket: WebSocket, frame: unknown) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const serialized = JSON.stringify(frame);
    for (const part of encodeServerFrames(serialized)) {
      if (Buffer.byteLength(part, "utf8") > MAX_FRAME_BYTES) throw new Error("Gateway frame exceeds safety limit.");
      socket.send(part);
    }
  }

  private async resume(socket: WebSocket, afterEventId: unknown, afterSequence: unknown) {
    const cursor = await this.events.loadCursor();
    let sequence = 0;
    if (afterEventId !== null || afterSequence !== null) {
      if (typeof afterEventId !== "string" || !Number.isSafeInteger(afterSequence) || (afterSequence as number) < 1) {
        throw new Error("Replay cursor is invalid.");
      }
      const matching = (await this.events.readEvents((afterSequence as number) - 1, 1))[0];
      if (!matching || matching.sequence !== afterSequence || matching.eventId !== afterEventId) {
        throw new Error("Replay cursor is not present in the worker journal.");
      }
      sequence = afterSequence as number;
      await this.events.reconcileDeliveryCursor(afterEventId, sequence);
    }
    if (cursor && sequence > cursor.sequence) throw new Error("Replay cursor is ahead of the worker journal.");
    const delivery = { sequence, through: sequence, ready: false, draining: null as Promise<void> | null };
    this.socketDeliveries.set(socket, delivery);
    // Register before the fresh read: appends during this await extend through,
    // while appends just before registration are covered by the durable cursor.
    delivery.through = Math.max(delivery.through, (await this.events.loadCursor())?.sequence ?? 0);
    this.send(socket, { protocolVersion: APP_SERVER_TRANSPORT_PROTOCOL_VERSION, type: "ready",
      sessionId: this.sessionId, replaySupported: true });
    delivery.ready = true;
    await this.drainSocketEvents(socket, delivery);
  }

  private drainSocketEvents(socket: WebSocket, delivery: {
    sequence: number; through: number; ready: boolean; draining: Promise<void> | null;
  }): Promise<void> {
    if (!delivery.ready || delivery.sequence >= delivery.through) return Promise.resolve();
    if (delivery.draining) return delivery.draining;
    const drain = async () => {
      try {
        while (delivery.sequence < delivery.through && socket.readyState === WebSocket.OPEN) {
          const through = delivery.through;
          const page = await this.events.readEvents(delivery.sequence, 256, 4 * 1024 * 1024);
          if (!page.length) throw new Error("Replay history does not reach its durable cursor.");
          for (const event of page) {
            if (event.sequence > through) break; // fresh appends belong to the next contiguous drain
            if (socket.readyState !== WebSocket.OPEN) return;
            const frame = { protocolVersion: APP_SERVER_TRANSPORT_PROTOCOL_VERSION, type: "event", event };
            // Enqueue a complete event synchronously: unrelated control frames
            // must never interleave its integrity-checked chunks. Drain its
            // writes before loading more history, keeping ws memory bounded.
            await Promise.all(encodeServerFrames(JSON.stringify(frame)).map(part =>
              new Promise<void>((resolve, reject) => socket.send(part, error => error ? reject(error) : resolve()))));
            delivery.sequence = event.sequence;
          }
        }
      } finally { delivery.draining = null; }
    };
    const pending = drain();
    delivery.draining = pending;
    this.eventDeliveryDrains.add(pending);
    void pending.finally(() => this.eventDeliveryDrains.delete(pending)).catch(() => undefined);
    return pending;
  }

  private async handleClientFrame(socket: WebSocket, value: Record<string, unknown>) {
    if (value.type === "ping") {
      if (typeof value.nonce !== "string") throw new Error("Heartbeat nonce is invalid.");
      this.send(socket, {
        protocolVersion: APP_SERVER_TRANSPORT_PROTOCOL_VERSION,
        type: "pong",
        nonce: value.nonce,
        receivedAt: new Date(this.now()).toISOString(),
      });
      return;
    }
    if (value.type === "event-ack") {
      if (typeof value.eventId !== "string" || !Number.isSafeInteger(value.sequence)) {
        throw new Error("Event acknowledgement is invalid.");
      }
      await this.events.markDeliveredIdentity(value.eventId, value.sequence as number);
      return;
    }
    if (value.type !== "request") throw new Error("Unsupported client frame.");
    validateAppServerRequest(value.request);
    await this.acceptRequest(socket, value.request);
  }

  private async acceptRequest(socket: WebSocket, request: AppServerRequest) {
    const canonical = JSON.stringify(request);
    const canonicalHash = sha256(canonical);
    const prior = await this.requests.latest(request.clientRequestId);
    if (
      request.kind === "rpc-response"
      && prior?.status === "completed"
      && prior.canonicalHash !== canonicalHash
      && encodedResponseScopeDigest(request.clientRequestId) !== undefined
    ) {
      // The response has already produced durable progress in Codex. During
      // client-journal recovery the original turn route may no longer exist,
      // so the router cannot reproduce the exact approval decision. Re-ACK
      // the completed idempotency key without dispatching the replacement.
      this.sendAccepted(socket, request.clientRequestId);
      return;
    }
    if (
      request.kind === "rpc-response"
      && encodedResponseScopeDigest(request.clientRequestId) !== undefined
      && !this.currentServerResponses.has(request.clientRequestId)
    ) {
      // This response belongs to a server request emitted by an earlier Codex
      // process. A recovered router may no longer own that turn and therefore
      // cannot reproduce the original decision. Re-injecting the replacement
      // response into a fresh App Server cannot complete the old request; it
      // instead blocks the durable delivery cursor and every later RPC. Keep
      // the accepted receipt uncertain, do not replay an effect, and let the
      // historical server-request event drain from the client journal. If the
      // response had not reached the previous child, retain its first receipt
      // as uncertain rather than losing it or treating it as completed.
      if (!prior) await this.requests.accept(request.clientRequestId, canonicalHash);
      this.sendAccepted(socket, request.clientRequestId);
      return;
    }
    const accepted = await this.requests.accept(request.clientRequestId, canonicalHash);
    if (accepted.existing && accepted.record.status === "accepted") {
      if (request.kind === "rpc-response") {
        const scopeDigest = await this.responseScopeDigest(request, true);
        if (scopeDigest) this.pendingResponseConfirmations.set(request.clientRequestId, scopeDigest);
        try {
          await this.dispatchAppServerInput(request);
        } catch (error) {
          this.pendingResponseConfirmations.delete(request.clientRequestId);
          throw error;
        }
        if (!scopeDigest) await this.completeUnscopedResponse(socket, request.clientRequestId);
        return;
      }
      if (this.inFlightRequests.has(request.clientRequestId)) {
        // The identical request was dispatched by this live App Server
        // process. ACK a reconnecting client without dispatching it twice;
        // the original output will arrive through the durable event journal.
        this.sendAccepted(socket, request.clientRequestId);
        return;
      }
      // An accepted record left by a previous App Server process is genuinely
      // uncertain: ACKing it would leave the caller waiting forever, while
      // redispatching it could duplicate side effects.
      this.send(socket, {
        protocolVersion: APP_SERVER_TRANSPORT_PROTOCOL_VERSION,
        type: "rejected",
        clientRequestId: request.clientRequestId,
        error: {
          code: 40901,
          message: "The previous request outcome is uncertain; recover thread state before retrying.",
          retryable: false,
        },
      });
      return;
    }
    if (accepted.existing) {
      this.sendAccepted(socket, request.clientRequestId);
      if (accepted.record.responseJson && request.kind === "rpc-request") {
        await this.recordAppServerOutput(JSON.parse(accepted.record.responseJson));
      }
      return;
    }
    const responseScopeDigest = request.kind === "rpc-response"
      ? await this.responseScopeDigest(request, false)
      : undefined;
    if (responseScopeDigest) {
      // Register before writing to App Server. With independent input/output
      // lanes the child may emit durable progress before stdin's callback
      // fires; pre-registration prevents losing that exactly-once receipt.
      this.pendingResponseConfirmations.set(request.clientRequestId, responseScopeDigest);
    }
    if (request.kind !== "rpc-response") this.inFlightRequests.add(request.clientRequestId);
    try {
      await this.dispatchAppServerInput(request);
    } catch (error) {
      this.inFlightRequests.delete(request.clientRequestId);
      this.pendingResponseConfirmations.delete(request.clientRequestId);
      throw error;
    }
    if (request.kind === "rpc-response") {
      if (!responseScopeDigest) {
        await this.completeUnscopedResponse(socket, request.clientRequestId);
      }
      return;
    }
    if (request.kind === "rpc-notification") {
      await this.requests.complete(request.clientRequestId, { id: request.clientRequestId, result: null });
      this.inFlightRequests.delete(request.clientRequestId);
    }
    this.sendAccepted(socket, request.clientRequestId);
  }

  private async dispatchAppServerInput(request: AppServerRequest) {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error("Codex App Server input is unavailable.");
    }
    const output = request.rpc;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(output)}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  private sendAccepted(socket: WebSocket, clientRequestId: string) {
    this.send(socket, {
      protocolVersion: APP_SERVER_TRANSPORT_PROTOCOL_VERSION,
      type: "accepted",
      clientRequestId,
    });
  }

  private async responseScopeDigest(request: Extract<AppServerRequest, { kind: "rpc-response" }>, replay: boolean) {
    const encoded = encodedResponseScopeDigest(request.clientRequestId);
    if (replay && encoded !== undefined) return encoded;
    let matching: AppServerEvent | undefined;
    let afterSequence = 0;
    for (;;) {
      const page = await this.events.readEvents(afterSequence, 256, 4 * 1024 * 1024);
      if (!page.length) break;
      for (const event of page) {
        if (event.message.kind === "rpc-request" && event.message.rpc.id === request.rpc.id) matching = event;
        afterSequence = event.sequence;
      }
    }
    const scope = matching ? appServerScope(matching.message) : null;
    if (!matching) {
      throw new Error("Server response does not match a durable scoped App Server request.");
    }
    const actual = scope ? appServerScopeDigest(scope) : null;
    if (encoded !== undefined && encoded !== actual) {
      throw new Error("Server response clientRequestId does not match its durable request scope.");
    }
    return actual;
  }

  private async completeUnscopedResponse(socket: WebSocket, clientRequestId: string) {
    await this.requests.complete(clientRequestId, {
      id: clientRequestId,
      result: { processedAfterEventId: null },
    });
    this.currentServerResponses.delete(clientRequestId);
    this.sendAccepted(socket, clientRequestId);
  }

  private async receiveAppServerLine(line: string) {
    if (Buffer.byteLength(line, "utf8") > MAX_STDIO_LINE_BYTES) {
      throw new Error("Codex App Server line exceeds the safety limit.");
    }
    const value: unknown = parseAppServerStdoutJson(line);
    if (isRecord(value) && value.method === "account/chatgptAuthTokens/refresh"
        && (typeof value.id === "string" || typeof value.id === "number")
        && installationOwnerAuthSocket(this.context.installationId)) {
      // Provider auth is a backend control exchange, not a model tool or a
      // replayable turn event. Never journal access tokens or send them to UI.
      const previousAccountId = isRecord(value.params) && typeof value.params.previousAccountId === "string"
        ? value.params.previousAccountId : undefined;
      let response: object;
      try { response = { id: value.id, result: await readInstallationOwnerAccess(this.context.installationId, previousAccountId) }; }
      catch { response = { id: value.id, error: { code: -32000, message: "Installation owner authentication is unavailable." } }; }
      const child = this.child;
      if (!child?.stdin.writable) throw new Error("Codex App Server input is unavailable.");
      await new Promise<void>((resolve, reject) => child.stdin.write(`${JSON.stringify(response)}\n`, (error) => error ? reject(error) : resolve()));
      return;
    }
    if (isRecord(value) && typeof value.id === "string" && ("result" in value || "error" in value)) {
      await this.requests.complete(value.id, value);
      this.inFlightRequests.delete(value.id);
    }
    const event = await this.recordAppServerOutput(value);
    const scope = appServerScope(event.message);
    if (scope) await this.confirmServerResponses(scope, event.eventId);
  }

  private async receiveAppServerNotifications(lines: readonly string[]) {
    const messages: ReturnType<typeof parseAppServerOutput>[] = [];
    let invalid: unknown = null;
    for (const line of lines) {
      try {
        const message = parseAppServerOutput(parseAppServerStdoutJson(line));
        if (message.kind !== "rpc-notification") throw new Error("Invalid stdout notification batch.");
        assertCodexServerNotification(message.rpc);
        messages.push(message);
      } catch (error) { invalid = error; break; }
    }
    if (!messages.length) throw invalid;
    const recorded = this.eventRecordChain.then(async () => {
      const cursor = await this.events.loadCursor();
      const events: AppServerEvent[] = messages.map((message, index) => ({
        eventId: randomUUID(), sequence: (cursor?.sequence ?? 0) + index + 1,
        occurredAt: new Date(this.now()).toISOString(), message,
      }));
      await this.events.appendBatch(events);
      for (const event of events) {
        this.publishedAppServerEvent(event);
        const scope = appServerScope(event.message);
        if (scope) await this.confirmServerResponses(scope, event.eventId);
      }
    });
    this.eventRecordChain = recorded.then(() => undefined, () => undefined);
    await recorded;
    if (invalid) throw invalid;
  }

  private recordAppServerOutput(value: unknown) {
    const recorded = this.eventRecordChain.then(() => this.recordAppServerOutputSerially(value));
    this.eventRecordChain = recorded.then(() => undefined, () => undefined);
    return recorded;
  }

  /**
   * App Server stdout and recovered request responses are intentionally fed by
   * independent lanes.  The durable event journal itself still needs one
   * writer so cursor allocation and append remain atomic across both lanes.
   */
  private async recordAppServerOutputSerially(value: unknown) {
    const cursor = await this.events.loadCursor();
    const event: AppServerEvent = {
      eventId: randomUUID(),
      sequence: (cursor?.sequence ?? 0) + 1,
      occurredAt: new Date(this.now()).toISOString(),
      message: parseAppServerOutput(value),
    };
    await this.events.append(event);
    this.publishedAppServerEvent(event);
    return event;
  }

  private publishedAppServerEvent(event: AppServerEvent) {
    if (event.message.kind === "rpc-request") {
      this.currentServerResponses.set(
        serverResponseClientRequestId(event),
        event.message.rpc.id,
      );
    }
    const socket = this.activeSocket;
    const delivery = socket ? this.socketDeliveries.get(socket) : undefined;
    if (socket && delivery) {
      delivery.through = Math.max(delivery.through, event.sequence);
      // Persistence remains independent of a slow or replaying client. The
      // per-socket drain reads every sequence once, in order, from the journal.
      void this.drainSocketEvents(socket, delivery).catch(error => {
        this.recordDiagnostic(error, "event-delivery");
        socket.close(1011, "Worker event delivery failed");
      });
    }
  }

  private async confirmServerResponses(scope: AppServerScope, evidenceEventId: string) {
    const actualScopeDigest = appServerScopeDigest(scope);
    for (const [clientRequestId, expectedScopeDigest] of this.pendingResponseConfirmations) {
      if (actualScopeDigest !== expectedScopeDigest) continue;
      await this.requests.complete(clientRequestId, {
        id: clientRequestId,
        result: { processedAfterEventId: evidenceEventId },
      });
      this.pendingResponseConfirmations.delete(clientRequestId);
      this.currentServerResponses.delete(clientRequestId);
      const socket = this.activeSocket;
      if (socket) this.sendAccepted(socket, clientRequestId);
    }
  }

  private recordDiagnostic(error:unknown,stage:GatewayFailureStage,exit?:{code:number|null;signal:NodeJS.Signals|null}) {
    if (stage === "event-delivery" && (this.retired || this.stopping || this.state === "failed")) return;
    const diagnostic = gatewayFailureDiagnostic(stage,error,this.now(),exit);
    this.diagnosticWrite = this.diagnosticWrite.then(() => atomicWriteFile(
      path.join(this.context.transportAudit, "gateway-last-failure.json"), JSON.stringify(diagnostic), {mode:0o600},
    )).catch(() => undefined); // Diagnostic I/O must never replace the real failure.
  }

  private fail(error: unknown, stage:GatewayFailureStage, exit?:{code:number|null;signal:NodeJS.Signals|null}) {
    if (this.retired || this.state === "failed") return;
    this.recordDiagnostic(error,stage,exit);
    for (const pending of this.privateRequests.values()) pending.reject(new Error("Private authentication channel failed."));
    this.privateRequests.clear();
    this.lastError = safeError(error);
    this.state = "failed";
    this.activeSocket?.close(1011, "Worker runtime failure");
  }
}

export class NodeWebSocketFactory implements WebSocketFactory {
  readonly supportsAuthorizationHeaders = true;

  create(url: string, options: WebSocketConnectOptions): WebSocketLike {
    return new WebSocket(
      url,
      options.protocols ? [...options.protocols] : undefined,
      { headers: options.headers ? { ...options.headers } : undefined },
    ) as unknown as WebSocketLike;
  }
}

class DeferredAppServerTransport implements AppServerTransport {
  private inner: AppServerTransport | null = null;
  private recover: AppServerTransport["recoverResponse"];
  private closed = false;
  private resolveInner!: (transport: AppServerTransport | null) => void;
  private readonly innerReady = new Promise<AppServerTransport | null>((resolve) => {
    this.resolveInner = resolve;
  });

  configure(transport: AppServerTransport, recover?: AppServerTransport["recoverResponse"]) {
    if (this.closed) throw new Error("Worker transport is closed.");
    if (this.inner) throw new Error("Worker transport was already configured.");
    this.inner = transport;
    this.recover = recover;
    this.resolveInner(transport);
  }

  private async ready() {
    const inner = this.inner ?? await this.innerReady;
    if (this.closed || !inner) throw new Error("Worker transport is closed.");
    return inner;
  }

  async connect() { return (await this.ready()).connect(); }
  async send(message: AppServerRequest) { return (await this.ready()).send(message); }
  async recoverResponse(request: AppServerRequest) {
    await this.ready();
    return this.recover ? this.recover(request) : null;
  }
  deliverySequenceStart() {
    if (!this.inner) throw new Error("Worker transport has not connected.");
    return this.inner.deliverySequenceStart?.();
  }
  projectionSequenceTarget() { return this.inner?.projectionSequenceTarget?.(); }
  async *events() { for await (const event of (await this.ready()).events()) yield event; }
  async acknowledge(event: AppServerEvent) {
    return (await this.ready()).acknowledge?.(event);
  }
  async acknowledgeBatch(events: readonly AppServerEvent[]) {
    const inner = await this.ready();
    if (inner.acknowledgeBatch) await inner.acknowledgeBatch(events);
    else for (const event of events) await inner.acknowledge?.(event);
  }
  async health(): Promise<TransportHealth> {
    if (!this.inner) {
      return {
        healthy: false,
        state: this.closed ? "closed" : "idle",
        endpoint: "pending://worker-gateway",
        reconnectAttempt: 0,
        pendingRequests: 0,
        lastEventId: null,
        lastEventSequence: null,
        lastConnectedAt: null,
        lastMessageAt: null,
        lastHeartbeatAt: null,
        lastError: null,
      };
    }
    return this.inner.health();
  }
  async close() {
    this.closed = true;
    this.resolveInner(null);
    if (this.inner) await this.inner.close();
  }
}

export type LocalGatewayWorkerRuntimeFactoryOptions = {
  kernelLockCommand?: readonly string[];
  sharedAuth?: SharedAuthProvider;
  processFactory?: PrivateWorkerGatewayOptions["processFactory"];
  quotaToolPrivacy?: boolean;
  now?: () => number;
  maxRetainedCompletedRequests?: number;
  maxRetainedDeliveredEvents?: number;
  runtimeInstanceId?: string;
};

class LocalGatewayManagedRuntime implements ManagedWorkerRuntime {
  readonly transport = new DeferredAppServerTransport();
  private gateway: PrivateWorkerGateway | null = null;
  private retired = false;
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly context: WorkerLaunchContext,
    private readonly options: LocalGatewayWorkerRuntimeFactoryOptions,
  ) {}

  async start() {
    if (this.retired) throw new Error("Worker runtime startup was cancelled.");
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce();
    return this.startPromise;
  }

  private async startOnce() {
    if (this.gateway) return;
    // Profile identity uses the employee's base roots, shared by every service
    // role. App Server must retain these definitions across settings updates.
    const configOverrides = this.options.quotaToolPrivacy
      ? quotaToolPermissionConfigOverrides({
        codexHome: this.context.environment.CODEX_HOME,
        transportAudit: this.context.transportAudit,
      })
      : undefined;
    // The web app and the detached automation worker deliberately run
    // independent Codex App Server processes.  Their replay/ledger journals
    // must therefore be durable per service role, never shared: otherwise one
    // process can replay the other's responses and leave both RPC routers
    // waiting forever.  The stable role keeps restart recovery intact.
    const isolatedContext = {
      ...this.context,
      transportAudit: workerTransportAuditRoot(
        this.context.transportAudit,
        this.options.runtimeInstanceId,
      ),
    };
    const gateway = new PrivateWorkerGateway({
      context: isolatedContext,
      kernelOwnershipRoot: this.options.processFactory ? undefined : this.context.transportAudit,
      kernelLockCommand: this.options.kernelLockCommand,
      sharedAuth: this.options.sharedAuth,
      processFactory: this.options.processFactory,
      configOverrides,
      now: this.options.now,
      maxRetainedCompletedRequests: this.options.maxRetainedCompletedRequests,
      maxRetainedDeliveredEvents: this.options.maxRetainedDeliveredEvents,
    });
    this.gateway = gateway;
    await gateway.start();
    if (this.retired) throw new Error("Worker runtime startup was cancelled.");
    if (!gateway.endpoint) throw new Error("Worker gateway endpoint is unavailable.");
    const clientLocks = new ResourceLockManager({
      rootDirectory: path.join(isolatedContext.transportAudit, "client-locks"),
    });
    const journal = new FileTransportEventJournal({
      filePath: path.join(isolatedContext.transportAudit, "client-events.jsonl"),
      lockManager: clientLocks,
      maxRetainedDeliveredEvents: this.options.maxRetainedDeliveredEvents,
    });
    this.transport.configure(new WebSocketAppServerTransport({
      endpoint: gateway.endpoint,
      socketFactory: new NodeWebSocketFactory(),
      auth: {
        placement: "authorization-header",
        credentialProvider: {
          async getCredential() {
            return { kind: "capability-token" as const, token: gateway.token };
          },
        },
      },
      journal,
    }), request => gateway.recoverResponse(request));
  }

  async health() {
    return this.gateway?.health() ?? {
      healthy: false,
      state: "stopped" as const,
      detail: "Worker gateway has not started.",
    };
  }

  async stop() {
    this.retired = true;
    const gateway = this.gateway;
    // Closing before configuration also wakes callers awaiting ready().
    await Promise.all([this.transport.close(), gateway?.stop()]);
    if (this.gateway === gateway) this.gateway = null;
  }
}

export class LocalGatewayWorkerRuntimeFactory implements WorkerRuntimeFactory {
  constructor(private readonly options: LocalGatewayWorkerRuntimeFactoryOptions = {}) {}

  create(context: WorkerLaunchContext): ManagedWorkerRuntime {
    return new LocalGatewayManagedRuntime(context, this.options);
  }
}
