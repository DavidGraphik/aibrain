import { readdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { ResourceLockManager } from "@/storage";
import type { ResourceLockLease } from "@/storage/resource-lock";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import type { InstallationConfig } from "@/config/installation-schema";
import { FileLocalUserStore } from "@/auth/local-user-store";
import type { JsonValue } from "./transport";
import { readExistingWorkerLaunchContext } from "./workers/provisioner";
import type { WorkerLaunchContext } from "./workers/types";
import { stopOwnedWorkerProcess } from "./workers/owned-process";
import { acquireWorkerKernelLease, currentWorkerExecutionOrigin, type WorkerExecutionOrigin, type WorkerKernelLease } from "./workers/kernel-ownership";
import { readQueueTerminal } from "./model-turn-queue-recovery";

const UNAVAILABLE = "Isolated queue metadata reader is unavailable.";
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
type ChildFactory = (context: WorkerLaunchContext, ownership?: WorkerKernelLease) => ChildProcessWithoutNullStreams;
type ReaderOptions = { timeoutMs?: number; processFactory?: ChildFactory; origin?: WorkerExecutionOrigin; lockCommand?: readonly string[] };

/** A separate official App Server inside the existing employee sandbox. It
 * never attaches to the live gateway or shares its registry/client lifecycle.
 * No account/login, inference, resume, connector action or server-request reply.
 */
export async function readIsolatedQueueTerminal(config: Readonly<InstallationConfig>, userId: string,
  threadId: string, turnId: string, options: ReaderOptions = {}) {
  const localUser = await new FileLocalUserStore(config.paths.usersRoot).read(userId);
  if (!localUser?.enabled) throw new Error(UNAVAILABLE);
  const context = await readExistingWorkerLaunchContext(config, userId);
  if (options.origin) {
    const ownership = await acquireWorkerKernelLease(context.transportAudit, options.origin.generation, "exclusive", { expected: options.origin, lockCommand: options.lockCommand });
    try { return await readMetadataProcess(context, threadId, turnId, options, ownership); }
    finally { await ownership.close(); }
  }
  return withColdMetadataBoundary(context, () => readMetadataProcess(context, threadId, turnId, options));
}

/** A separate App Server cannot prove that a different process has stopped
 * executing an unfinished rollout. Hold every existing role's gateway owner
 * lease for this user, including the two installed roles, throughout the read.
 * A live/uncertain gateway stays untouched and its reservation remains unknown. */
async function withColdMetadataBoundary<T>(context: WorkerLaunchContext, read: () => Promise<T>, skipCurrentRole = false): Promise<T> {
  const instancesRoot = path.join(context.transportAudit, "runtime-instances");
  const roles = new Set(["app", "automation-worker", process.env.AIBRAIN_RUNTIME_INSTANCE?.trim() || "app"]);
  try {
    const metadata = await lstat(instancesRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(instancesRoot) !== instancesRoot) throw new Error(UNAVAILABLE);
    for (const role of await readdir(instancesRoot, { withFileTypes: true })) {
      if (!role.isDirectory() || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(role.name)) throw new Error(UNAVAILABLE);
      roles.add(role.name);
    }
  } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  if (roles.size > 32 || [...roles].some(role => !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(role))) throw new Error(UNAVAILABLE);
  const leases: ResourceLockLease[] = [];
  try {
    for (const audit of [context.transportAudit, ...[...roles].sort().filter(role => !skipCurrentRole || role !== (process.env.AIBRAIN_RUNTIME_INSTANCE?.trim() || "app")).map(role => path.join(instancesRoot, role))]) {
      try {
        const metadata = await lstat(audit);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(audit) !== audit) throw new Error(UNAVAILABLE);
      } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      leases.push(await new ResourceLockManager({ rootDirectory: path.join(audit, "gateway-locks"),
        // A diagnostic cannot treat an unresponsive/foreign owner as stopped.
        // Existing orphan directory leases require lifecycle/admin evidence;
        // no TTL-based lock stealing is permitted by this observer.
        staleAfterMs: Number.MAX_SAFE_INTEGER, heartbeatIntervalMs: 10_000 })
        .acquire("worker-journal-owner", { timeoutMs: 0 }));
    }
    return await read();
  } finally { for (const lease of leases.reverse()) await lease.release(); }
}

/** The warm owner is authoritative only while no other process role could be
 * running that turn. Its own already-cached client remains exclusively owned by
 * the service; this observer neither connects nor takes its gateway lease. */
export async function withExistingQueueMetadataBoundary<T>(config: Readonly<InstallationConfig>, userId: string, read: () => Promise<T>, origin?: WorkerExecutionOrigin | null) {
  const localUser = await new FileLocalUserStore(config.paths.usersRoot).read(userId);
  if (!localUser?.enabled) throw new Error(UNAVAILABLE);
  const context = await readExistingWorkerLaunchContext(config, userId);
  if (origin) {
    const current = await currentWorkerExecutionOrigin(context.transportAudit);
    if (current.generation !== origin.generation || current.instanceId !== origin.instanceId || current.dev !== origin.dev || current.ino !== origin.ino) throw new Error(UNAVAILABLE);
    return read();
  }
  return withColdMetadataBoundary(context, read, true);
}

async function readMetadataProcess(context: WorkerLaunchContext, threadId: string, turnId: string,
  options: ReaderOptions, ownership?: WorkerKernelLease) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  // Test factories keep direct-child semantics; only our detached production
  // child owns a process group. Existing worker PIDs are never signal targets.
  const ownsProcessGroup = !options.processFactory && process.platform !== "win32";
  const child = options.processFactory ? options.processFactory(context, ownership) : (spawn(/* turbopackIgnore: true */
    process.env.CODEX_BIN?.trim() || "codex", ["app-server", "--stdio"], {
      cwd: context.workspace, detached: ownsProcessGroup,
      stdio: ownership ? ["pipe", "pipe", "pipe", ownership.fd] : ["pipe", "pipe", "pipe"],
      env: { NODE_ENV: process.env.NODE_ENV ?? "production", PATH: process.env.PATH,
        LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE, TZ: process.env.TZ,
        SSL_CERT_FILE: process.env.SSL_CERT_FILE, SSL_CERT_DIR: process.env.SSL_CERT_DIR,
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS, ...context.environment,
        ...(ownership ? { AIBRAIN_WORKER_LOCK_FD: "3" } : {}) },
    }) as ChildProcessWithoutNullStreams);
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  let outputBytes = 0;
  let failed = false;
  const pending = new Map<string, { resolve: (result: JsonValue) => void; reject: (error: Error) => void }>();
  const fail = () => { failed = true; for (const waiter of pending.values()) waiter.reject(new Error(UNAVAILABLE)); pending.clear(); };
  child.stderr.resume(); // Never log child output or provider errors/content.
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  child.stdout.on("data", (bytes: Buffer) => {
    outputBytes += bytes.length;
    if (outputBytes > MAX_OUTPUT_BYTES) { fail(); return; }
    buffer += decoder.write(bytes);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const rpc = JSON.parse(line);
        // A request from Codex would require work beyond metadata reading.
        if (rpc.method && rpc.id !== undefined) { fail(); return; }
        const waiter = pending.get(rpc.id);
        if (!waiter) continue;
        pending.delete(rpc.id);
        if (rpc.error || !("result" in rpc)) waiter.reject(new Error(UNAVAILABLE));
        else waiter.resolve(rpc.result);
      } catch { fail(); return; }
    }
  });
  const request = (method: string, params: unknown, remaining = deadline - Date.now()) => new Promise<JsonValue>((resolve, reject) => {
    if (failed || remaining <= 0 || !["initialize", "thread/read", "thread/turns/list"].includes(method)) { reject(new Error(UNAVAILABLE)); return; }
    const id = `queue-metadata:${randomUUID()}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(UNAVAILABLE)); }, remaining);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => { if (error) fail(); });
  });
  try {
    await request("initialize", { clientInfo: { name: "aibrain_queue_metadata", version: "1" }, capabilities: { experimentalApi: true } }, Math.max(0, deadline - Date.now()));
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return await readQueueTerminal({ request: (method, params, _purpose, remaining) =>
      request(method, params, Math.min(remaining ?? timeoutMs, deadline - Date.now())) }, threadId, turnId,
    `queue-metadata:${randomUUID()}`, Math.max(0, deadline - Date.now()));
  } finally {
    fail();
    child.stdin.end();
    await stopOwnedWorkerProcess(child, ownsProcessGroup, 100, 1_000);
  }
}
