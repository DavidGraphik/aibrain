import { readFile } from "node:fs/promises";

const statusPath = "/var/lib/aibrain/data/automations/worker-status.json";

try {
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  if (!status || typeof status !== "object" || typeof status.heartbeatAt !== "string" ||
    !Number.isInteger(status.intervalMs) || status.intervalMs < 1_000 ||
    !Number.isInteger(status.processId) || status.processId < 1) {
    throw new Error("invalid automation worker status");
  }
  const heartbeat = Date.parse(status.heartbeatAt);
  const ageMs = Date.now() - heartbeat;
  if (!Number.isFinite(heartbeat) || ageMs < -15_000 || ageMs > Math.max(15_000, status.intervalMs * 3)) {
    throw new Error("stale automation worker heartbeat");
  }
  process.kill(status.processId, 0);
} catch {
  process.stderr.write("AIBRAIN_AUTOMATION_WORKER_HEALTHCHECK_FAILED\n");
  process.exit(1);
}
