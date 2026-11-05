import "server-only";

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  defineVersionedSchema,
  expectArray,
  expectString,
  ResourceLockManager,
} from "@/storage";

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THREAD_ID = USER_ID;
const MAX_PINNED_THREADS = 500;

type PinnedThreadRecord = {
  schemaVersion: 1;
  threadIds: string[];
};

const pinnedThreadSchema = defineVersionedSchema<PinnedThreadRecord>({
  name: "PinnedThreadPreferences",
  schemaVersion: 1,
  keys: ["threadIds"],
  parse(record, context) {
    const threadIds = expectArray(
      record.threadIds,
      context.at("threadIds"),
      (value, itemContext) => expectString(value, itemContext, {
        minLength: 36,
        maxLength: 36,
        pattern: THREAD_ID,
      }),
      { maxLength: MAX_PINNED_THREADS },
    );
    if (new Set(threadIds).size !== threadIds.length) {
      context.at("threadIds").fail("thread ids must be unique");
    }
    return { schemaVersion: 1, threadIds };
  },
});

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function rejectSymlink(filePath: string, label: string) {
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink()) throw new Error(`${label} no puede ser un enlace simbólico.`);
    return metadata;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/**
 * Durable, per-principal ordering for pinned conversations. Thread records can
 * be shared, so pinning must never be stored on the resource owner as a side
 * effect of another employee's preference.
 */
export class FilePinnedThreadStore {
  private readonly locks: ResourceLockManager;

  constructor(
    private readonly dataRoot: string,
    private readonly usersRoot: string,
    private readonly installationId: string,
  ) {
    if (!path.isAbsolute(dataRoot) || !path.isAbsolute(usersRoot)) {
      throw new Error("Pinned-thread roots must be absolute.");
    }
    this.locks = new ResourceLockManager({
      rootDirectory: path.join(dataRoot, "workbench-pins", "locks"),
      defaultTimeoutMs: 5_000,
    });
  }

  private filePath(userId: string) {
    if (!USER_ID.test(userId)) throw new Error("Pinned-thread user id is invalid.");
    return path.join(this.usersRoot, userId, "pinned-threads.json");
  }

  private async readExisting(userId: string): Promise<PinnedThreadRecord | null> {
    const filePath = this.filePath(userId);
    const userRoot = path.dirname(filePath);
    const userMetadata = await rejectSymlink(userRoot, "El usuario de anclados");
    if (!userMetadata?.isDirectory()) throw new Error("El usuario de anclados no está provisionado.");
    const fileMetadata = await rejectSymlink(filePath, "El estado de anclados");
    if (!fileMetadata) return null;
    if (!fileMetadata.isFile()) throw new Error("El estado de anclados no es un fichero regular.");
    return pinnedThreadSchema.parse(JSON.parse(await readFile(filePath, "utf8")) as unknown, filePath);
  }

  async read(userId: string, legacyThreadIds: readonly string[] = []) {
    const existing = await this.readExisting(userId);
    if (existing) return existing.threadIds;
    const seed = [...new Set(legacyThreadIds)].filter((id) => THREAD_ID.test(id)).slice(0, MAX_PINNED_THREADS);
    if (seed.length === 0) return [];
    return this.locks.withLock(`workbench-pins:${this.installationId}:${userId}`, async () => {
      const concurrent = await this.readExisting(userId);
      if (concurrent) return concurrent.threadIds;
      const record: PinnedThreadRecord = { schemaVersion: 1, threadIds: seed };
      await atomicWriteJson(this.filePath(userId), record, pinnedThreadSchema, { mode: 0o600 });
      return record.threadIds;
    });
  }

  async update(userId: string, threadId: string, pinned: boolean, legacyThreadIds: readonly string[] = []) {
    if (!THREAD_ID.test(threadId)) throw new Error("Pinned-thread id is invalid.");
    return this.locks.withLock(`workbench-pins:${this.installationId}:${userId}`, async () => {
      const legacy = [...new Set(legacyThreadIds)].filter((id) => THREAD_ID.test(id)).slice(0, MAX_PINNED_THREADS);
      const current = await this.readExisting(userId) ?? { schemaVersion: 1 as const, threadIds: legacy };
      const withoutThread = current.threadIds.filter((id) => id !== threadId);
      const threadIds = pinned ? [threadId, ...withoutThread].slice(0, MAX_PINNED_THREADS) : withoutThread;
      const next: PinnedThreadRecord = { schemaVersion: 1, threadIds };
      await atomicWriteJson(this.filePath(userId), next, pinnedThreadSchema, { mode: 0o600 });
      return next.threadIds;
    });
  }
}

export function projectPinnedThreads(
  threads: readonly import("@/workbench/types").WorkbenchThread[],
  orderedThreadIds: readonly string[],
) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const visiblePinnedIds = orderedThreadIds.filter((id) => byId.has(id));
  const pinned = new Set(visiblePinnedIds);
  return [
    ...visiblePinnedIds.map((id) => ({ ...byId.get(id)!, pinned: true })),
    ...threads.filter((thread) => !pinned.has(thread.id)).map((thread) => ({ ...thread, pinned: false })),
  ];
}
