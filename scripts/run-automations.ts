import { backgroundModelConcurrency } from "../src/runtime/model-turn-queue";
import { drainG03Receiving } from '../src/g03-products/receiving-service';
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { loadInstallationConfig } from "../src/config/installation";
import type { InstallationConfig } from "../src/config/installation-schema";
import { FileLocalUserStore } from "../src/auth/local-user-store";
import { provisionedAutomationPrincipal } from "../src/automations/principal";
import { FileAutomationStore, type ClaimedAutomation } from "../src/automations/store";
import { runClaimedAutomation } from "../src/automations/runner";
import { AutomationAdmissionPoller } from "../src/automations/admission-poller";
import { executeScheduledTurn } from "../src/automations/executor";
import { writeAutomationWorkerStatus } from "../src/automations/worker-status";
import { drainAutomaticMemoryJobs } from "../src/memory/automatic-extraction";
import { stopWorkerRuntimeForUser } from "../src/runtime/worker-runtime-service";
import { BackgroundMaintenance } from "../src/automations/background-maintenance";

const USER_ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

function positiveInteger(name: string, fallback: number) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} requiere un entero positivo.`);
  return Number(value);
}

async function enabledUsers(usersRoot: string) {
  const store = new FileLocalUserStore(usersRoot);
  const entries = await readdir(usersRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const users = await Promise.all(entries.filter((entry) => entry.isDirectory() && USER_ID.test(entry.name)).map((entry) => store.read(entry.name)));
  return users.filter((user) => user?.enabled === true);
}

type ExecutionResult = Awaited<ReturnType<typeof runClaimedAutomation>>;

async function sweep(workerId: string, installation: Readonly<InstallationConfig>, poller: AutomationAdmissionPoller<ClaimedAutomation, ExecutionResult>, timeoutMs: number, usedRuntimes: Set<string>) {
  const users = await enabledUsers(installation.paths.usersRoot);
  await poller.poll(users.flatMap((user) => {
    if (!user) return [];
    let session: Awaited<ReturnType<typeof provisionedAutomationPrincipal>>;
    const store = new FileAutomationStore({
      installationId: installation.installationId,
      userId: user.userId,
      usersRoot: installation.paths.usersRoot,
    });
    return [{
      userId: user.userId,
      claim: async (availableSlots: number) => {
        session = await provisionedAutomationPrincipal(installation, user.userId);
        return store.claimDue(workerId, availableSlots);
      },
      execute: (claim: ClaimedAutomation) => {
        usedRuntimes.add(user.userId);
        return runClaimedAutomation({store, claim, timeoutMs,
        execute: (claim, existingThreadId, onThreadPrepared, signal) => executeScheduledTurn({
          installation,
          session,
          task: claim.task,
          runKey: claim.runKey,
          existingThreadId,
          onThreadPrepared,
          signal,
        }),
        });
      },
    }];
  }));
  return users.flatMap(user => user ? [user.userId] : []);
}

async function main() {
  const once = process.argv.includes("--once");
  const allowed = new Set(["--once", "--interval-ms", "--concurrency", "--timeout-ms"]);
  const valued = new Set(["--interval-ms", "--concurrency", "--timeout-ms"]);
  for (let index = 2; index < process.argv.length; index += 1) {
    const current = process.argv[index];
    if (!allowed.has(current)) throw new Error(`Argumento desconocido: ${current}`);
    if (valued.has(current)) {
      if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
        throw new Error(`${current} requiere un valor.`);
      }
      index += 1;
    }
  }
  const intervalMs = positiveInteger("--interval-ms", 30_000);
  const concurrency = positiveInteger("--concurrency", 2);
  const globalConcurrency = Number(process.env.AIBRAIN_MODEL_MAX_CONCURRENT ?? 2);
  if (!Number.isSafeInteger(globalConcurrency) || globalConcurrency < 1 || globalConcurrency > 32) throw new Error("Invalid model queue configuration.");
  const timeoutMs = positiveInteger("--timeout-ms", 15 * 60_000);
  const workerId = `automation-${randomUUID()}`;
  const installation = await loadInstallationConfig();
  const report = (results: ExecutionResult[], memory: Awaited<ReturnType<typeof drainAutomaticMemoryJobs>> = []) => {
    process.stdout.write(`${JSON.stringify({operation: "automations", workerId, processed: results.length, results,
      memoryJobs: {processed: memory.length, completed: memory.filter(({status}) => status === "completed").length,
        pending: memory.filter(({status}) => status === "pending").length}})}\n`);
  };
  const poller = new AutomationAdmissionPoller<ClaimedAutomation, ExecutionResult>({concurrency, globalConcurrency:backgroundModelConcurrency(globalConcurrency),
    onResult: result => report([result]),
    onError: (error, userId) => {
      const detail = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof Error ? error.message : "";
      const code = /^[A-Z][A-Z0-9_]+$/.test(detail) ? detail : "AUTOMATION_ADMISSION_FAILED";
      process.stderr.write(`${JSON.stringify({operation:"automations-admission-error",userId,error:code,durableClaimsRemainFenced:true})}\n`);
    },
  });
  const usedRuntimes = new Set<string>();
  const memory = new BackgroundMaintenance(
    (userIds: string[]) => drainAutomaticMemoryJobs(installation, { userIds }),
    results => report([], results),
    () => { process.stderr.write("AUTOMATION_MEMORY_SCAN_FAILED\n"); },
  );
  let receivingDrain:Promise<unknown>|null=null;
  const shutdown = new AbortController();
  const stop = () => { poller.close(); shutdown.abort(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const heartbeat = () => writeAutomationWorkerStatus(installation.paths.dataRoot, {
    workerId,
    processId: process.pid,
    heartbeatAt: new Date().toISOString(),
    intervalMs,
  });
  await heartbeat();
  const heartbeatTimer = setInterval(() => void heartbeat().catch(() => undefined), Math.min(intervalMs, 10_000));
  heartbeatTimer.unref?.();
  try {
    do {
      if(!receivingDrain)receivingDrain=drainG03Receiving(installation).catch(()=>undefined).finally(()=>{receivingDrain=null;});
      const userIds = await sweep(workerId, installation, poller, timeoutMs, usedRuntimes);
      memory.start(userIds);
      await heartbeat();
      report([]);
      if (once || shutdown.signal.aborted) break;
      await delay(intervalMs, undefined, {signal: shutdown.signal}).catch(error => {
        if (!shutdown.signal.aborted) throw error;
      });
    } while (!shutdown.signal.aborted);
  } finally {
    await receivingDrain;
    await memory.stop();
    await poller.stop(); // Finish admitted work; a forced exit retains the durable store leases.
    // Close only this process's employee clients after every admitted runner settled.
    const stopped = await Promise.allSettled([...usedRuntimes].map(userId => stopWorkerRuntimeForUser(userId)));
    if (stopped.some(result => result.status === "rejected")) process.stderr.write("AUTOMATION_RUNTIME_SHUTDOWN_FAILED\n");
    clearInterval(heartbeatTimer);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "El worker de automatizaciones ha fallado."}\n`);
  process.exitCode = 1;
});
