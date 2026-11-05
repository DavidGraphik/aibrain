import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "@/storage";
import type { ReadinessComponentProbe, ReadinessComponentResult } from "@/operations/readiness";

export type AutomationWorkerStatus = {
  workerId: string;
  processId: number;
  heartbeatAt: string;
  intervalMs: number;
};

export function automationWorkerStatusPath(dataRoot: string) {
  return path.join(dataRoot, "automations", "worker-status.json");
}

export async function writeAutomationWorkerStatus(dataRoot: string, value: AutomationWorkerStatus) {
  await atomicWriteFile(automationWorkerStatusPath(dataRoot), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function readAutomationWorkerStatus(dataRoot: string, now = Date.now()) {
  try {
    const value: unknown = JSON.parse(await readFile(automationWorkerStatusPath(dataRoot), "utf8"));
    if (!value || typeof value !== "object" || !("workerId" in value) || typeof value.workerId !== "string" ||
      !("processId" in value) || !Number.isInteger(value.processId) || !("heartbeatAt" in value) ||
      typeof value.heartbeatAt !== "string" || Number.isNaN(Date.parse(value.heartbeatAt)) ||
      !("intervalMs" in value) || typeof value.intervalMs !== "number" || !Number.isInteger(value.intervalMs) || value.intervalMs < 1_000) return null;
    const status = value as AutomationWorkerStatus;
    const ageMs = now - new Date(status.heartbeatAt).getTime();
    return {
      ...status,
      // A materially future timestamp can otherwise make a stopped worker look
      // healthy forever after a clock/configuration fault. Allow only a small
      // scheduling skew, then fail closed like a stale heartbeat.
      online: ageMs >= -15_000 && ageMs <= Math.max(15_000, status.intervalMs * 3),
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    return null;
  }
}

/**
 * The web process reads this signal from the shared installation volume. A
 * missing or stale heartbeat is deliberately a readiness failure: the UI can
 * still report it honestly, but the installation is not operationally ready
 * for automations until its supervised worker has recovered.
 */
export function automationWorkerReadinessProbe(
  dataRoot: string,
  now: () => number = Date.now,
  required = true,
): ReadinessComponentProbe {
  return {
    name: "automations-worker",
    required,
    async check(): Promise<ReadinessComponentResult> {
      const status = await readAutomationWorkerStatus(dataRoot, now());
      return status?.online
        ? { status: "ready", code: "OK" }
        : { status: "unavailable", code: "AUTOMATION_WORKER_OFFLINE" };
    },
  };
}
