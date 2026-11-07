import { spawn, type ChildProcessByStdio } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { FileDocumentTemporaryMaintenance } from "@/documents/maintenance";

type WorkerEvent = { event: string; processId: number; mode: string; temporaryPath: string };
type Worker = ChildProcessByStdio<null, Readable, Readable>;
const USER_ID = "00000000-0000-4000-8000-000000000001";
const roots: string[] = [];
const children = new Set<Worker>();
const worker = path.join(process.cwd(), "tests", "fixtures", "document-temporary-crash-worker.ts");
const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");

function start(userRoot: string, mode: "upload" | "preview") {
  const child = spawn(tsx, [worker, userRoot, mode], {
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
  const ready = async () => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const found = events.find(({ event }) => event === "temporary-ready");
      if (found) return found;
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stderr = child.stderr.read()?.toString() ?? "";
    throw new Error(`Temporary worker did not become ready; events=${JSON.stringify(events)} stderr=${stderr}`);
  };
  return { child, ready };
}

function waitForExit(child: Worker) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function exists(target: string) {
  return lstat(target).then(() => true).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  });
}

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map(waitForExit));
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("document temporary crash recovery", () => {
  it("reclaims an upload and preview abandoned by SIGKILL without touching durable files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-document-temporary-crash-"));
    roots.push(root);
    const dataRoot = path.join(root, "data");
    const usersRoot = path.join(dataRoot, "users");
    const userRoot = path.join(usersRoot, USER_ID);
    await mkdir(userRoot, { recursive: true, mode: 0o700 });
    await Promise.all([dataRoot, usersRoot, userRoot].map((directory) => chmod(directory, 0o700)));

    const upload = start(userRoot, "upload");
    const preview = start(userRoot, "preview");
    const [uploadReady, previewReady] = await Promise.all([upload.ready(), preview.ready()]);
    expect(await Promise.all([exists(uploadReady.temporaryPath), exists(previewReady.temporaryPath)]))
      .toEqual([true, true]);

    process.kill(uploadReady.processId, "SIGKILL");
    process.kill(previewReady.processId, "SIGKILL");
    await Promise.all([waitForExit(upload.child), waitForExit(preview.child)]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const stale = new Date(Date.now() - 2_000);
    await Promise.all([
      utimes(uploadReady.temporaryPath, stale, stale),
      utimes(previewReady.temporaryPath, stale, stale),
    ]);

    const report = await new FileDocumentTemporaryMaintenance({
      dataRoot,
      usersRoot,
      gracePeriodMs: 1_000,
      documentLockOptions: {
        staleAfterMs: 120,
        heartbeatIntervalMs: 25,
        retryDelayMs: 5,
        maxRetryDelayMs: 10,
      },
    }).run({ dryRun: false });
    expect(report).toMatchObject({ candidates: 2, scannedUsers: 1 });
    expect(report.removed.map(({ kind }) => kind).sort()).toEqual(["incoming-upload", "preview-work"]);
    expect(report.skippedLocked).toEqual([]);
    expect(report.skippedUnsafe).toEqual([]);
    expect(await Promise.all([exists(uploadReady.temporaryPath), exists(previewReady.temporaryPath)]))
      .toEqual([false, false]);
  });
});
