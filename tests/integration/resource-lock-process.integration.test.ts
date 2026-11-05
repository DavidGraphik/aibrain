import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { readProcessIncarnation } from "../../src/storage/process-incarnation";

type WorkerEvent = { event: string; at: number; code?: string; token?: string; processId?: number };
type LockChild = ChildProcessByStdio<null, Readable, Readable>;
const roots: string[] = [];
const children = new Set<LockChild>();
const workerProcessIds = new Set<number>();
const worker = path.join(process.cwd(), "tests", "fixtures", "resource-lock-worker.ts");
const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");

function start(root: string, mode: "hold" | "crash", holdMs: number, timeoutMs: number) {
  const child = spawn(tsx, [worker, root, "shared-resource", mode, String(holdMs), String(timeoutMs)], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  let buffered = "";
  const events: WorkerEvent[] = [];
  const waiters: Array<{ name: string; resolve: (event: WorkerEvent) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const parsed = JSON.parse(line) as WorkerEvent;
      events.push(parsed);
      if (parsed.processId) workerProcessIds.add(parsed.processId);
      for (const waiter of [...waiters]) {
        if (waiter.name !== parsed.event) continue;
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(parsed);
      }
    }
  });
  child.once("exit", (code, signal) => {
    const stderr = child.stderr.read()?.toString() ?? "";
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(
        `Worker exited before ${waiter.name}; code=${code} signal=${signal} events=${JSON.stringify(events)} stderr=${stderr}`,
      ));
    }
  });
  const waitFor = (name: string, timeout = 3_000) => {
    const existing = events.find((event) => event.event === name);
    if (existing) return Promise.resolve(existing);
    return new Promise<WorkerEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const stderr = child.stderr.read()?.toString() ?? "";
        reject(new Error(`Timed out waiting for ${name}; stderr=${stderr}`));
      }, timeout);
      waiters.push({ name, resolve, reject, timer });
    });
  };
  return { child, waitFor };
}

function waitForExit(child: LockChild) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

afterEach(async () => {
  for (const processId of workerProcessIds) {
    try {
      process.kill(processId, "SIGKILL");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map(waitForExit));
  children.clear();
  workerProcessIds.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resource locks across real processes", () => {
  it("serializes two independent Node processes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-lock-process-"));
    roots.push(root);
    const first = start(root, "hold", 250, 2_000);
    await first.waitFor("acquired");
    const second = start(root, "hold", 0, 2_000);
    const [leaving, acquired] = await Promise.all([
      first.waitFor("leaving-critical-section"),
      second.waitFor("acquired"),
    ]);
    expect(acquired.at).toBeGreaterThanOrEqual(leaving.at);
    await Promise.all([waitForExit(first.child), waitForExit(second.child)]);
  });

  it("does not steal a heartbeat-protected owner after the stale threshold", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-lock-live-process-"));
    roots.push(root);
    const owner = start(root, "crash", 0, 2_000);
    const acquired = await owner.waitFor("acquired");
    const contender = start(root, "hold", 0, 180);
    const failure = await contender.waitFor("failed");
    expect(failure.code).toBe("STORAGE_LOCK_TIMEOUT");
    expect((await waitForExit(contender.child)).code).toBe(1);
    process.kill(acquired.processId!, "SIGKILL");
    await waitForExit(owner.child);
    expect(() => process.kill(acquired.processId!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("recovers the abandoned lease after an owner process is killed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-lock-crash-process-"));
    roots.push(root);
    const abandoned = start(root, "crash", 0, 2_000);
    const acquired = await abandoned.waitFor("acquired");
    process.kill(acquired.processId!, "SIGKILL");
    await waitForExit(abandoned.child);
    expect(() => process.kill(acquired.processId!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const recovered = start(root, "hold", 0, 2_000);
    await recovered.waitFor("acquired");
    expect((await waitForExit(recovered.child)).code).toBe(0);
  });

  it("does not steal a suspended live process after its heartbeat becomes stale", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-lock-paused-process-"));
    roots.push(root);
    const owner = start(root, "crash", 0, 2_000);
    const acquired = await owner.waitFor("acquired");
    process.kill(acquired.processId!, "SIGSTOP");
    await new Promise((resolve) => setTimeout(resolve, 180));
    const contender = start(root, "hold", 0, 180);
    expect((await contender.waitFor("failed")).code).toBe("STORAGE_LOCK_TIMEOUT");
    expect((await waitForExit(contender.child)).code).toBe(1);
    const hash = createHash("sha256").update("shared-resource").digest("hex");
    const record = JSON.parse(await readFile(path.join(root, `${hash}.lock`, "owner.json"), "utf8"));
    expect(record.token).toBe(acquired.token);
    process.kill(acquired.processId!, "SIGKILL");
    await waitForExit(owner.child);
  });

  it.skipIf(process.platform !== "linux")("recovers an old incarnation despite a real live reused PID", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-lock-reused-process-"));
    roots.push(root);
    const actualIdentity = await readProcessIncarnation(process.pid);
    // This test requires readable Linux procfs; fail rather than silently
    // treating missing identity support as proof of recovery.
    expect(actualIdentity).not.toBeNull();
    const oldIdentity = actualIdentity!.replace(/:\d+$/, ":0");
    expect(oldIdentity).not.toBe(actualIdentity);
    const resourceHash = createHash("sha256").update("shared-resource").digest("hex");
    const lockPath = path.join(root, `${resourceHash}.lock`);
    const token = randomUUID();
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      schemaVersion: 1, token, resourceHash, hostname: hostname(),
      processId: process.pid, acquiredAt: new Date(Date.now() - 5_000).toISOString(),
    }));
    await writeFile(path.join(lockPath, "process.json"), JSON.stringify({
      schemaVersion: 1, token, identity: oldIdentity,
    }));
    const staleTime = new Date(Date.now() - 5_000);
    await utimes(lockPath, staleTime, staleTime);
    const recovered = start(root, "hold", 0, 1_000);
    expect((await recovered.waitFor("acquired")).token).not.toBe(token);
    expect((await waitForExit(recovered.child)).code).toBe(0);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });
});
