import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
export const SUPPORT_ENABLE_MAX_MS = 2 * 60 * 60 * 1000;
export const SUPPORT_ENABLE_FILE = "support-access-enable.json";
export type SupportAccessPolicy = { schemaVersion: 1; installationId: string; operatorUserId: string; expiresAt: number };
/** Explicit temporary root-operator opt-in; no runtime configuration drift or restart. */
export async function readSupportAccessPolicy(dataRoot: string, installationId: string, now = Date.now()): Promise<SupportAccessPolicy | null> {
  if (!path.isAbsolute(dataRoot)) return null;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path.join(dataRoot, "locks", SUPPORT_ENABLE_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
    // Validate the opened inode, rather than a racy path stat. Marker contains no credentials.
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.nlink !== 1 || stat.size > 2048) return null;
    const item: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "expiresAt,installationId,operatorUserId,schemaVersion"
      || record.schemaVersion !== 1 || record.installationId !== installationId
      || typeof record.operatorUserId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.operatorUserId)
      || !Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) <= now || (record.expiresAt as number) > now + SUPPORT_ENABLE_MAX_MS) return null;
    return record as SupportAccessPolicy;
  } catch { return null; }
  finally { await handle?.close(); }
}
