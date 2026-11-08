import path from "node:path";
import { DurableTurnSubmission } from "@/runtime/turn-submission-store";
import { resolveWorkerOwnedPath } from "@/runtime/workers/provisioner";

type OrphanedTurnStopInput = {
  installationId: string;
  usersRoot: string;
  userId: string;
  threadId: string;
  assistantMessageId: string;
  projectId: string;
};

/** A Stop can close an orphan only with its exclusive runner lease and a
 * durable receipt proving no creation/model intent. Busy or uncertain work
 * follows the existing runtime cancellation/reconciliation path. */
export async function stopOrphanedUnsubmittedTurn(
  input: OrphanedTurnStopInput,
  persistStopped: () => Promise<void>,
) {
  let stopped = false;
  try {
    const userRoot = path.join(input.usersRoot, input.userId);
    const workspace = await resolveWorkerOwnedPath(userRoot, `workspace/projects/${input.projectId}`);
    await DurableTurnSubmission.reconcileExisting({
      userRoot,
      installationId: input.installationId,
      userId: input.userId,
      threadId: input.threadId,
      assistantMessageId: input.assistantMessageId,
    }, async (submission) => {
      // Schema3 stores an opaque request binding, not individual identity fields.
      // The authenticated canonical context, safe exact receipt path and admitted
      // project workspace jointly fence this legacy receipt without inventing IDs.
      if (submission.admittedWorkspace !== workspace || !await submission.cancelBeforeDispatch()) return;
      // Tombstone first. A failed projection/store write can be completed by an
      // identical Stop; no later model admission can cross this durable fence.
      await persistStopped();
      stopped = true;
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT" || code === "STORAGE_LOCK_TIMEOUT") return false;
    throw error;
  }
  return stopped;
}
