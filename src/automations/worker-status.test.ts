import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  automationWorkerReadinessProbe,
  readAutomationWorkerStatus,
  writeAutomationWorkerStatus,
} from "@/automations/worker-status";

const roots: string[] = [];

async function root() {
  const value = await mkdtemp(path.join(tmpdir(), "aibrain-automation-worker-status-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("automation worker status", () => {
  it("reports a fresh worker as ready and fails closed after its heartbeat expires", async () => {
    const dataRoot = await root();
    const startedAt = Date.parse("2026-08-29T08:00:00.000Z");
    await writeAutomationWorkerStatus(dataRoot, {
      workerId: "automation-test-worker",
      processId: process.pid,
      heartbeatAt: new Date(startedAt).toISOString(),
      intervalMs: 30_000,
    });

    expect(await readAutomationWorkerStatus(dataRoot, startedAt + 89_999)).toMatchObject({ online: true });
    expect(await automationWorkerReadinessProbe(dataRoot, () => startedAt + 89_999).check(new AbortController().signal))
      .toEqual({ status: "ready", code: "OK" });
    expect(await automationWorkerReadinessProbe(dataRoot, () => startedAt + 90_001).check(new AbortController().signal))
      .toEqual({ status: "unavailable", code: "AUTOMATION_WORKER_OFFLINE" });
    expect(await automationWorkerReadinessProbe(dataRoot, () => startedAt - 15_001).check(new AbortController().signal))
      .toEqual({ status: "unavailable", code: "AUTOMATION_WORKER_OFFLINE" });
  });
});
