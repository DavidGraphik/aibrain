import type { LocalSessionRecord } from "@/auth/local-session-store";
import type { FileLocalUserStore } from "@/auth/local-user-store";
import { readSupportAccessPolicy } from "@/auth/support-access-policy";
/** Rechecked at UI authentication and before/after each server-bound tool call. */
export async function isSupportSessionAuthorized(record: LocalSessionRecord,
  installation: { installationId: string; paths: { dataRoot: string } }, users: FileLocalUserStore) {
  if (!record.support) return true;
  try {
    const policy = await readSupportAccessPolicy(installation.paths.dataRoot, installation.installationId);
    if (record.installationId !== installation.installationId
      || !policy || policy.operatorUserId !== record.support.actorUserId
      || record.idleExpiresAt <= Date.now() || record.absoluteExpiresAt <= Date.now()) return false;
    const target = await users.read(record.userId);
    if (!target?.enabled || await users.hasInitialPasswordMarker(record.userId)) return false;
    const actor = await users.read(record.support.actorUserId);
    return Boolean(actor?.enabled && actor.email === record.support.actorEmail);
  } catch { return false; }
}
