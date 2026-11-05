import { setTimeout as delay } from "node:timers/promises";
import { ResourceLockManager } from "../../src/storage/resource-lock";

const [rootDirectory, resourceKey, mode, holdValue, timeoutValue] = process.argv.slice(2);
if (!rootDirectory || !resourceKey || !mode) {
  process.stderr.write("resource-lock-worker requires root, resource, mode, hold and timeout\n");
  process.exit(64);
}

const holdMs = Number(holdValue ?? "0");
const timeoutMs = Number(timeoutValue ?? "2000");
const manager = new ResourceLockManager({
  rootDirectory,
  staleAfterMs: 120,
  heartbeatIntervalMs: 25,
  defaultTimeoutMs: timeoutMs,
  retryDelayMs: 2,
  maxRetryDelayMs: 10,
  jitterRatio: 0,
});

function event(name: string, extra: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ event: name, at: Date.now(), ...extra })}\n`);
}

async function main() {
  try {
    const lease = await manager.acquire(resourceKey, { timeoutMs });
    event("acquired", { token: lease.token, processId: process.pid });
    if (mode === "crash") {
      await new Promise(() => {
        setInterval(() => undefined, 1_000);
      });
    }
    await delay(holdMs);
    event("leaving-critical-section");
    await lease.release();
    event("released");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "UNKNOWN";
    event("failed", { code });
    process.exitCode = 1;
  }
}

void main();
