import { BackgroundModelAdmissionDeferred } from "@/runtime/model-turn-queue";
import { WorkerTurnRecoveryPendingError } from "@/runtime/worker-turn-recovery-error";
import { hostname } from "node:os";
import type { AutomationRun } from "@/automations/contracts";
import { AutomationStoreError, type FileAutomationStore, type ClaimedAutomation } from "@/automations/store";

export type AutomationExecution = (
  claim: ClaimedAutomation,
  existingThreadId: string | null,
  onThreadPrepared: (threadId: string) => Promise<void>,
  signal: AbortSignal,
) => Promise<{ threadId: string | null; deadlineAt?: number; finalize?: (persist: () => Promise<void>) => Promise<void> }>;

type AutomationRunnerOptions = {
  store: FileAutomationStore;
  execute: AutomationExecution;
  ownerId?: string;
  now?: () => number;
  limit?: number;
  concurrency?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
  /** Bounds cancellation latency while keeping the durable lease fresh. */
  leaseRenewalMs?: number;
};

export async function runAutomationSweep(options: AutomationRunnerOptions) {
  const ownerId = options.ownerId ?? `${hostname()}-${process.pid}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);
  const claims = await options.store.claimDue(ownerId, options.limit ?? 10);
  return executeClaims(options, claims);
}

/** Execute an already fenced store claim without reserving any additional work. */
export async function runClaimedAutomation(options: AutomationRunnerOptions & { claim: ClaimedAutomation }) {
  return (await executeClaims(options, [options.claim]))[0];
}

async function executeClaims(options: AutomationRunnerOptions, claims: ClaimedAutomation[]) {
  const now = options.now ?? Date.now;
  const results: { taskId: string; runKey: string; status: "succeeded" | "failed" | "deferred"; error: string | null }[] = [];
  const maxAttempts = options.maxAttempts ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const leaseRenewalMs = Math.max(1_000, options.leaseRenewalMs ?? 15_000);
  const executeClaim = async (claim: ClaimedAutomation) => {
    const previous = await options.store.latestRun(claim.runKey);
    if (previous?.status === "succeeded" || previous?.status === "failed") {
      // A failed entry is only terminal after its retry budget was exhausted.
      // A retryAt on the task tells claimDue to replay the same run key.
      if (previous.status === "failed" && claim.task.retryAt) {
        // Continue below with a fresh attempt.
      } else {
      await options.store.settle(claim, { status: previous.status, error: previous.error });
      results.push({ taskId: claim.task.id, runKey: claim.runKey, status: previous.status, error: previous.error });
      return;
      }
    }
    const attempt = previous ? previous.attempt + (previous.status==="running"&&claim.task.retryAt?0:1) : 1;
    const startedAt = new Date(now()).toISOString();
    let threadId = previous?.threadId ?? null;
    await options.store.appendRun({
      schemaVersion: 1,
      runKey: claim.runKey,
      taskId: claim.task.id,
      installationId: claim.task.installationId,
      userId: claim.task.userId,
      scheduledFor: claim.scheduledFor,
      status: "running",
      attempt,
      startedAt,
      finishedAt: null,
      threadId,
      error: null,
    });
    const controller = new AbortController();
    let leaseLost = false;
    let cancellationRequested = false;
    let renewal = Promise.resolve();
    const renew = () => {
      renewal = renewal.then(async () => {
        try {
          await options.store.renewLease(claim);
        } catch (error) {
          if (error instanceof AutomationStoreError && error.code === "AUTOMATION_CANCELLED") {
            cancellationRequested = true;
            controller.abort(error);
            return;
          }
          leaseLost = true;
          controller.abort(new Error("La concesión de automatización se ha perdido."));
        }
      });
      return renewal;
    };
    const renewTimer = setInterval(() => { void renew(); }, leaseRenewalMs);
    renewTimer.unref?.();
    const timeoutTimer = setTimeout(() => controller.abort(new Error("La automatización excedió el tiempo máximo de ejecución.")), timeoutMs);
    timeoutTimer.unref?.();
    try {
      // An expired claim may have been edited/cancelled before recovery. Fence
      // it before reusing deterministic message IDs with changed instructions.
      await renew();
      if (controller.signal.aborted) throw controller.signal.reason;
      // The executor creates or reuses a persistent conversation. Its message
      // ids are derived from runKey, so a recovered lease replays one turn.
      const execution = await options.execute(claim, threadId, async (preparedThreadId) => {
        if (threadId === preparedThreadId) return;
        threadId = preparedThreadId;
        await options.store.appendRun({
          schemaVersion: 1,
          runKey: claim.runKey,
          taskId: claim.task.id,
          installationId: claim.task.installationId,
          userId: claim.task.userId,
          scheduledFor: claim.scheduledFor,
          status: "running",
          attempt,
          startedAt,
          finishedAt: null,
          threadId,
          error: null,
        });
      }, controller.signal);
      await renew();
      if (leaseLost || controller.signal.aborted) throw controller.signal.reason ?? new Error("La automatización se ha cancelado.");
      if (execution.deadlineAt !== undefined && now() >= execution.deadlineAt) throw Error("HOST_TERMINAL_TIMEOUT");
      threadId = execution.threadId;
      const run: AutomationRun = {
        schemaVersion: 1,
        runKey: claim.runKey,
        taskId: claim.task.id,
        installationId: claim.task.installationId,
        userId: claim.task.userId,
        scheduledFor: claim.scheduledFor,
        status: "succeeded",
        attempt,
        startedAt,
        finishedAt: new Date(now()).toISOString(),
        threadId,
        error: null,
      };
      const persist = async () => {
        await options.store.appendRun(run);
        await options.store.settle(claim, { status: "succeeded" });
      };
      if (execution.finalize) await execution.finalize(persist); else await persist();
      results.push({ taskId: claim.task.id, runKey: claim.runKey, status: "succeeded", error: null });
    } catch (error) {
      // An edit can arrive after preflight but before an executor failure. Read
      // that cancellation before retry() could clear it and replay an old turn.
      await renew();
      const terminalError = cancellationRequested ? controller.signal.reason : error;
      const detail = terminalError instanceof Error ? terminalError.message.slice(0, 2_000) : "Error de ejecución";
      if (leaseLost) {
        // A stale process no longer owns either the task or its journal. Its
        // successor will recover the deterministic turn and write the only
        // terminal record. Appending here could overwrite the observable
        // outcome after the newer worker has already succeeded.
        results.push({ taskId: claim.task.id, runKey: claim.runKey, status: "failed", error: detail });
        return;
      }
      if((error instanceof BackgroundModelAdmissionDeferred || error instanceof WorkerTurnRecoveryPendingError) && !cancellationRequested && !controller.signal.aborted){
        // Admission has no model effect; recovery retains the same admitted
        // turn and deterministic IDs. Neither is a failed business/model result.
        // No failed journal entry, cursor advance or attempt budget is consumed.
        await options.store.deferAdmission(claim,new Date(now()+retryBaseMs).toISOString());
        results.push({taskId:claim.task.id,runKey:claim.runKey,status:"deferred",error:null});
        return;
      }
      await options.store.appendRun({
        schemaVersion: 1,
        runKey: claim.runKey,
        taskId: claim.task.id,
        installationId: claim.task.installationId,
        userId: claim.task.userId,
        scheduledFor: claim.scheduledFor,
        status: "failed",
        attempt,
        startedAt,
        finishedAt: new Date(now()).toISOString(),
        threadId,
        error: detail,
      });
      if (cancellationRequested) {
        // The same valid lease owns this terminal record. A cancellation must
        // never be retried or revive a paused/deleted recurrence.
        await options.store.settle(claim, { status: "failed", error: detail });
        results.push({ taskId: claim.task.id, runKey: claim.runKey, status: "failed", error: detail });
      } else if (attempt < (claim.task.schedule.kind === "external" ? 1 : maxAttempts)) {
        const delay = retryBaseMs * (2 ** (attempt - 1));
        await options.store.retry(claim, { error: detail, retryAt: new Date(now() + delay).toISOString() });
        results.push({ taskId: claim.task.id, runKey: claim.runKey, status: "failed", error: detail });
      } else {
        await options.store.settle(claim, { status: "failed", error: detail });
        results.push({ taskId: claim.task.id, runKey: claim.runKey, status: "failed", error: detail });
      }
    } finally {
      clearInterval(renewTimer);
      clearTimeout(timeoutTimer);
    }
  };
  // Worker concurrency is intentionally bounded. Claims/leases are durable,
  // while distinct employee App Server handles preserve user-local CODEX_HOME.
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, claims.length || 1));
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < claims.length) {
      const claim = claims[cursor++];
      await executeClaim(claim);
    }
  }));
  return results;
}
