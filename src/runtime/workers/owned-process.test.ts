import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { stopOwnedWorkerProcess } from "./owned-process";

function fixture(source: string) {
  return spawn(process.execPath, ["-e", source], {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function exists(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function descendant(child: ChildProcessWithoutNullStreams) {
  const [chunk] = await once(child.stdout, "data");
  return Number(String(chunk).trim());
}

describe.skipIf(process.platform === "win32")("owned worker process group", () => {
  it("escalates an uncooperative tree without killing another worker", async () => {
    const other = fixture("setInterval(() => {}, 1000)");
    const worker = fixture(`
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'inherit'] });
      setInterval(() => {}, 1000);
    `);
    try {
      const childPid = await descendant(worker);
      await stopOwnedWorkerProcess(worker, true, 30, 2_000);
      expect(exists(childPid)).toBe(false);
      expect(exists(worker.pid!)).toBe(false);
      expect(exists(other.pid!)).toBe(true);
    } finally {
      await stopOwnedWorkerProcess(worker, true, 10, 2_000);
      await stopOwnedWorkerProcess(other, true, 10, 2_000);
    }
  });

  it("cleans surviving descendants even after the leader exits normally", async () => {
    const worker = fixture(`
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
      child.unref();
    `);
    try {
      const childPid = await descendant(worker);
      await vi.waitFor(() => expect(worker.exitCode).toBe(0));
      expect(exists(childPid)).toBe(true);
      await stopOwnedWorkerProcess(worker, true, 30, 2_000);
      expect(exists(childPid)).toBe(false);
    } finally {
      await stopOwnedWorkerProcess(worker, true, 10, 2_000);
    }
  });
});
