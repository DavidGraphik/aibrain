import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

type WorkerEvent = { event: string; userId: string; processId: number; code?: string };
type Worker = ChildProcessByStdio<null, Readable, Readable>;
const roots: string[] = [];
const children = new Set<Worker>();
const worker = path.join(process.cwd(), "tests", "fixtures", "document-conversion-worker.ts");
const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");

function start(root: string, userId: string, mode: "hold" | "crash", holdMs: number, maximum = 2) {
  const child = spawn(tsx, [worker, root, userId, mode, String(holdMs), String(maximum)], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  const events: WorkerEvent[] = [];
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line) events.push(JSON.parse(line) as WorkerEvent);
  });
  const waitFor = async (name: string, timeoutMs = 3_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = events.find((event) => event.event === name);
      if (found) return found;
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stderr = child.stderr.read()?.toString() ?? "";
    throw new Error(`Worker did not emit ${name}; events=${JSON.stringify(events)} stderr=${stderr}`);
  };
  return { child, waitFor };
}

function waitForExit(child: Worker) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map(waitForExit));
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("document conversion admission across real processes", () => {
  it("shares two slots across users, rejects overflow and recovers a crashed owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-conversion-process-"));
    roots.push(root);
    const first = start(root, "user-a", "crash", 0);
    const second = start(root, "user-b", "crash", 0);
    const firstAcquired = await first.waitFor("acquired");
    const secondAcquired = await second.waitFor("acquired");
    expect(firstAcquired.processId).not.toBe(secondAcquired.processId);

    const overflow = start(root, "user-c", "hold", 0);
    await expect(overflow.waitFor("failed")).resolves.toMatchObject({
      userId: "user-c",
      code: "DOCUMENT_CONVERSION_BACKPRESSURE",
    });
    expect((await waitForExit(overflow.child)).code).toBe(1);

    process.kill(firstAcquired.processId, "SIGKILL");
    await waitForExit(first.child);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const recovered = start(root, "user-c", "hold", 0);
    await expect(recovered.waitFor("acquired")).resolves.toMatchObject({ userId: "user-c" });
    expect((await waitForExit(recovered.child)).code).toBe(0);

    process.kill(secondAcquired.processId, "SIGKILL");
    await waitForExit(second.child);
  });
});
