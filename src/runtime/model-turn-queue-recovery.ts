import type { WorkerExecutionOrigin } from "./workers/kernel-ownership";
import type { WorkerAppServerClient } from "./worker-runtime-service";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { DurableTurnSubmission } from "./turn-submission-store";
import type { ModelQueueReconciler } from "./model-turn-queue";
import { resolveWorkerOwnedPath } from "./workers/provisioner";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Terminal = "completed" | "failed" | "interrupted";
export type QueueTurnStatusReader = (userId: string, runtimeThreadId: string, runtimeTurnId: string, origin: WorkerExecutionOrigin | null) => Promise<Terminal | null>;

/** Backend-only: opaque queue keys resolve against app-owned durable receipts,
 * never user-supplied paths. No conversation content leaves this service. */
export function modelQueueReconciler(input: {
  installationId: string; usersRoot: string; readTerminal: QueueTurnStatusReader;
}): ModelQueueReconciler {
  return async (ticket, release) => {
    try {
      const users = await readdir(input.usersRoot, { withFileTypes: true });
      let inspected = 0;
      for (const user of users) {
        if (++inspected > 20_000) return;
        if (!user.isDirectory() || !UUID.test(user.name)) continue;
        const userRoot = path.join(input.usersRoot, user.name);
        let threads;
        try {
          const root = await resolveWorkerOwnedPath(userRoot, "state/turn-submissions");
          threads = await readdir(root, { withFileTypes: true });
        } catch { continue; }
        for (const thread of threads) {
          if (++inspected > 20_000) return;
          if (!thread.isDirectory() || !UUID.test(thread.name)) continue;
          const root = await resolveWorkerOwnedPath(userRoot, `state/turn-submissions/${thread.name}`);
          for (const file of await readdir(root, { withFileTypes: true })) {
            if (++inspected > 20_000) return;
            const turnId = file.name.replace(/\.json$/, "");
            if (!file.isFile() || !file.name.endsWith(".json") || !UUID.test(turnId)) continue;
            const key = createHash("sha256").update(JSON.stringify([input.installationId, user.name, thread.name, turnId])).digest("hex");
            if (key !== ticket.key) continue;
            // Same cross-process lease as an active runner. A live runner or
            // concurrent recovery retains its reservation without a probe.
            await DurableTurnSubmission.reconcileExisting({ userRoot, installationId: input.installationId,
              userId: user.name, threadId: thread.name, assistantMessageId: turnId }, async submission => {
              if (submission.terminal) { await release(); return; }
              // With the runner lease held, a durable pre-dispatch phase
              // proves no model request crossed the write-ahead fence.
              if (submission.modelTurnNotDispatched) { await release(); return; }
              if (!submission.hasPendingModelTurn || !submission.runtimeThreadId || !submission.runtimeTurnId) return;
              const terminal = await input.readTerminal(user.name, submission.runtimeThreadId, submission.runtimeTurnId, await submission.executionOrigin());
              if (!terminal || !["completed", "failed", "interrupted"].includes(terminal)) return;
              await submission.observeTerminal(submission.runtimeTurnId, terminal);
              await release();
            });
            return;
          }
        }
      }
    } catch {
      // Missing, disabled, inaccessible, active or uncertain stays reserved.
      // Queue availability must never turn a failed read into dispatch/replay.
    }
  };
}

/** Only an exact provider turn in its requested thread is authoritative.
 * Missing/truncated history, inProgress and malformed replies stay unknown. */
export function exactQueueTerminal(result: unknown, threadId: string, turnId: string): Terminal | null {
  if (!result || typeof result !== "object" || !("thread" in result)) return null;
  const thread = result.thread;
  if (!thread || typeof thread !== "object" || !("id" in thread) || thread.id !== threadId || !("turns" in thread) || !Array.isArray(thread.turns)) return null;
  const matches = thread.turns.filter(turn => turn && typeof turn === "object" && turn.id === turnId);
  if (matches.length !== 1) return null;
  const status = matches[0].status;
  return ["completed", "failed", "interrupted"].includes(status) ? status : null;
}

/** Metadata-only provider reads, bounded by one deadline and eight pages. */
export async function readQueueTerminal(client: Pick<WorkerAppServerClient, "request">, threadId: string, turnId: string,
  purpose: string, timeoutMs = 5_000, options: { requireLoaded?: boolean } = {}): Promise<Terminal | null> {
  const deadline = Date.now() + timeoutMs;
  const result = await client.request("thread/read", { threadId, includeTurns: false }, purpose, timeoutMs);
  if (!result || typeof result !== "object" || !("thread" in result)) return null;
  const thread = result.thread;
  if (!thread || typeof thread !== "object" || !("id" in thread) || thread.id !== threadId) return null;
  if (options.requireLoaded && (!("status" in thread) || !thread.status || typeof thread.status !== "object" ||
      !("type" in thread.status) || !["idle", "active"].includes(String(thread.status.type)))) {
    throw new Error("Provider process does not own the recovered thread.");
  }
  const legacy = exactQueueTerminal(result, threadId, turnId);
  if (legacy) return legacy;
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let index = 0; index < 8; index++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const page = await client.request("thread/turns/list", { threadId, cursor, limit: 25, sortDirection: "desc", itemsView: "summary" },
      `${purpose}:p${index}`, remaining);
    if (!page || typeof page !== "object" || !("data" in page) || !Array.isArray(page.data)) return null;
    const matches = page.data.filter(turn => turn && typeof turn === "object" && "id" in turn && turn.id === turnId);
    if (matches.length) return exactQueueTerminal({ thread: { id: threadId, turns: matches } }, threadId, turnId);
    if (!("nextCursor" in page) || page.nextCursor === null) return null;
    if (typeof page.nextCursor !== "string" || seen.has(page.nextCursor)) return null;
    cursor = page.nextCursor;
    seen.add(cursor);
  }
  return null;
}
