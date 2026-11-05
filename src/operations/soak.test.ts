import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkerReplaySoak } from "@/operations/soak";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("worker replay soak harness", () => {
  it("measures concurrent workers, streaming, durable replay, restarts and resource cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-soak-test-"));
    roots.push(root);
    const report = await runWorkerReplaySoak({
      workRoot: root,
      durationMs: 30_000,
      maxCycles: 2,
      concurrency: 2,
      restartEveryCycles: 1,
      sampleIntervalMs: 10,
      cycleDelayMs: 0,
      requestTimeoutMs: 10_000,
    });

    expect(report.status).toBe("pass");
    expect(report.workload).toMatchObject({
      cycles: 2,
      requests: 8,
      streamedEvents: 8,
      replayedEvents: 4,
      correlatedEvents: 12,
      restarts: 4,
    });
    expect(report.latency).toMatchObject({ count: 8, sampled: 8 });
    expect(report.latency.p95Ms).toBeGreaterThan(0);
    expect(report.samples.peak.cpu.userMicros).toBeGreaterThan(0);
    expect(report.samples.peak.io.fsWrite).toBeGreaterThanOrEqual(0);
    expect(report.samples.steadyStart.resources.childProcesses).toBeGreaterThanOrEqual(
      report.samples.beforeStart.resources.childProcesses + 2,
    );
    expect(report.growth).toMatchObject({
      leakedSockets: 0,
      leakedListeners: 0,
      leakedChildProcesses: 0,
      leakedProcessListeners: 0,
      leakedHandleListeners: 0,
      journalFilesPerWorker: 3,
    });
    expect(report.samples.afterClose.journals).toMatchObject({ files: 6 });
    expect(report.samples.afterClose.journals.records).toBeGreaterThanOrEqual(20);
    expect(report.failures).toEqual([]);
  }, 60_000);

  it("rejects unbounded or unsafe configuration before starting workers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-soak-invalid-"));
    roots.push(root);
    await expect(runWorkerReplaySoak({
      workRoot: root,
      durationMs: 0,
      maxCycles: 1,
    })).rejects.toThrow("durationMs must be an integer");
    await expect(runWorkerReplaySoak({
      workRoot: "relative/path",
      durationMs: 1,
      maxCycles: 1,
    })).rejects.toThrow("workRoot must be absolute");
  });

  it("fails the report when a measured resource exceeds a configured gate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-soak-gate-"));
    roots.push(root);
    const report = await runWorkerReplaySoak({
      workRoot: root,
      durationMs: 30_000,
      maxCycles: 1,
      concurrency: 1,
      restartEveryCycles: 10,
      sampleIntervalMs: 10,
      cycleDelayMs: 0,
      thresholds: { maxJournalFilesPerWorker: 2, maxJournalRecordsPerWorker: 0 },
    });
    expect(report.status).toBe("fail");
    expect(report.failures).toContainEqual({
      code: "JOURNAL_FILE_LEAK",
      actual: 3,
      limit: 2,
    });
    expect(report.failures).toContainEqual({
      code: "JOURNAL_RECORDS_EXCEEDED",
      actual: expect.any(Number),
      limit: 0,
    });
  }, 30_000);
});
