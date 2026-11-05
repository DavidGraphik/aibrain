import { constants } from "node:fs";
import { open, lstat, mkdir, realpath, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type WorkerExecutionOrigin = { generation: string; instanceId: string; dev: number; ino: number };
export function validExecutionOrigin(value: unknown): value is WorkerExecutionOrigin {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "dev,generation,ino,instanceId") return false;
  const v = value as WorkerExecutionOrigin;
  return UUID.test(v.generation) && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(v.instanceId) &&
    Number.isSafeInteger(v.dev) && v.dev >= 0 && Number.isSafeInteger(v.ino) && v.ino > 0;
}
export type WorkerKernelLease = { readonly fd: number; readonly dev: number; readonly ino: number; close(): Promise<void> };

/** flock(2) on an app-owned stable inode. The descriptor is opened NOFOLLOW,
 * checked before/after locking, and is never unlinked or replaced on release.
 * A duplicated descriptor inherited by bwrap --sync-fd covers child lifetime
 * even if the Node owner dies. No PID/heartbeat/TTL is proof of release. */
export async function acquireWorkerKernelLease(auditRoot: string, generation: string, mode: "shared" | "exclusive", options: {
  expected?: Pick<WorkerExecutionOrigin, "dev" | "ino">; lockCommand?: readonly string[];
} = {}): Promise<WorkerKernelLease> {
  if (!UUID.test(generation) || !path.isAbsolute(auditRoot)) throw new Error("Invalid worker kernel ownership.");
  const directory = path.join(auditRoot, "kernel-owners");
  if (mode === "shared") {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  }
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0 || await realpath(directory) !== directory) throw new Error("Unsafe worker kernel ownership.");
  const filePath = path.join(directory, `${generation}.lock`);
  const file = await open(filePath, constants.O_RDWR | constants.O_NOFOLLOW | (mode === "shared" ? constants.O_CREAT : 0), 0o600);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0 ||
        (process.getuid && metadata.uid !== process.getuid()) ||
        (options.expected && (metadata.dev !== options.expected.dev || metadata.ino !== options.expected.ino))) throw new Error("Unsafe worker kernel inode.");
    const command = options.lockCommand ?? ["/usr/bin/flock"];
    await lockDescriptor(file, command, mode);
    const after = await lstat(filePath);
    if (after.isSymbolicLink() || after.dev !== metadata.dev || after.ino !== metadata.ino || after.nlink !== 1) throw new Error("Worker kernel inode changed.");
    return { fd: file.fd, dev: metadata.dev, ino: metadata.ino, close: () => file.close() };
  } catch (error) { await file.close(); throw error; }
}
async function lockDescriptor(file: FileHandle, command: readonly string[], mode: "shared" | "exclusive") {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), mode === "shared" ? "--shared" : "--exclusive", "--nonblock", "3"],
      { stdio: ["ignore", "ignore", "ignore", file.fd] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Worker kernel lock is unavailable.")); }, 3_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Worker kernel lock is unavailable.")); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Worker kernel lock is unavailable.")); });
  });
}

/** Only the app process that owns this gateway may attach its generation to a
 * write-ahead model receipt. A role name alone is never an origin identity. */
export async function currentWorkerExecutionOrigin(auditRoot: string): Promise<WorkerExecutionOrigin> {
  const instanceId = process.env.AIBRAIN_RUNTIME_INSTANCE?.trim() || "app";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(instanceId)) throw new Error("Invalid worker instance.");
  const hash = createHash("sha256").update("worker-journal-owner").digest("hex");
  const directory = path.join(auditRoot, "runtime-instances", instanceId, "gateway-locks", `${hash}.lock`);
  const read = async (name: string) => {
    const file = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const s = await file.stat(); if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) !== 0 || s.size > 4096) throw new Error("Unsafe execution owner.");
      return JSON.parse(await file.readFile("utf8"));
    } finally { await file.close(); }
  };
  const [owner, origin] = await Promise.all([read("owner.json"), read("kernel.json")]);
  if (!validExecutionOrigin(origin) || origin.generation !== owner.token || origin.instanceId !== instanceId ||
      owner.processId !== process.pid || owner.hostname !== hostname()) throw new Error("Execution origin is not owned by this process.");
  return origin;
}
