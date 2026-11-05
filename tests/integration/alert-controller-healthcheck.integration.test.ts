import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const script = path.resolve("infra/hetzner/app/alert-controller-healthcheck.mjs");
const roots: string[] = [];

async function statusFile(delivery: Record<string, unknown>, evaluatedAt = new Date().toISOString()) {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-alert-health-"));
  roots.push(root);
  const file = path.join(root, "status.json");
  await writeFile(file, `${JSON.stringify({ operation: "alerts", evaluatedAt, delivery })}\n`, { mode: 0o600 });
  return file;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("alert controller healthcheck", () => {
  it("accepts a fresh status without exhausted or stale pending work", async () => {
    const file = await statusFile({
      pending: 1,
      retryable: 0,
      deferred: 1,
      exhausted: 0,
      oldestCreatedAt: new Date(Date.now() - 30_000).toISOString(),
    });
    await expect(execFile(process.execPath, [script], {
      env: { ...process.env, AIBRAIN_ALERT_STATUS_FILE: file },
    })).resolves.toMatchObject({ stderr: "" });
  });

  it("reports delivery degradation without failing controller liveness", async () => {
    const exhausted = await statusFile({
      pending: 1,
      retryable: 0,
      deferred: 0,
      exhausted: 1,
      oldestCreatedAt: new Date().toISOString(),
    });
    await expect(execFile(process.execPath, [script], {
      env: { ...process.env, AIBRAIN_ALERT_STATUS_FILE: exhausted },
    })).resolves.toMatchObject({ stdout: expect.stringContaining('"delivery":"degraded"') });

    const stale = await statusFile({
      pending: 1,
      retryable: 1,
      deferred: 0,
      exhausted: 0,
      oldestCreatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await expect(execFile(process.execPath, [script], {
      env: {
        ...process.env,
        AIBRAIN_ALERT_STATUS_FILE: stale,
        AIBRAIN_ALERT_PENDING_WARN_AGE_MS: "1000",
      },
    })).resolves.toMatchObject({ stdout: expect.stringContaining('"delivery":"degraded"') });
  });

  it("fails only when the controller status itself is stale", async () => {
    const file = await statusFile({
      pending: 0,
      retryable: 0,
      deferred: 0,
      exhausted: 0,
      oldestCreatedAt: null,
    }, new Date(Date.now() - 60_000).toISOString());
    await expect(execFile(process.execPath, [script], {
      env: {
        ...process.env,
        AIBRAIN_ALERT_STATUS_FILE: file,
        AIBRAIN_ALERT_HEALTH_MAX_AGE_MS: "1000",
      },
    })).rejects.toMatchObject({ code: 1 });
  });
});
