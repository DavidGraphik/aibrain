import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { getHeapStatistics } from "node:v8";
import { atomicWriteFileChunks, recoverAtomicJsonFile, readValidatedJson, type StorageSchema } from "@/storage";
import { WorkbenchPersistenceError } from "@/workbench/errors";

export const WORKBENCH_FILE_LIMIT = 64 * 1024 * 1024;
export const WORKBENCH_SEGMENT_THRESHOLD = 32 * 1024 * 1024;
const MAX_HYDRATED_HISTORY_BYTES = 128 * 1024 * 1024;
type HistoryState = { schemaVersion: 1; installationId: string; userId: string; threads: { id: string; messages: unknown[] }[] };
export type Reference = { threadId: string; digest: string; bytes: number };
type Decoded<T> = { state: T; histories: Reference[] | null };
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function fail(): never { throw new WorkbenchPersistenceError("L’historial segmentat del workbench no és íntegre o segur."); }

function hydrationBudget() {
  const heapLimit = getHeapStatistics().heap_size_limit;
  if (!Number.isSafeInteger(heapLimit) || heapLimit <= 0) fail();
  return Math.min(MAX_HYDRATED_HISTORY_BYTES, Math.floor(heapLimit / 5));
}
function assertHydrationBudget(bytes: number, budget: number) {
  if (!Number.isSafeInteger(bytes) || bytes > budget) {
    throw new WorkbenchPersistenceError("L’historial complet del workbench supera el pressupost segur de memòria d’aquest procés. Les dades es conserven i les metadades continuen disponibles.");
  }
}
function manifestFor<T extends HistoryState>(state: T, histories: Reference[]) {
  return { ...state, schemaVersion: 2, threads: state.threads.map(thread => ({ ...thread, messages: [] })), histories };
}
function encodedManifest<T extends HistoryState>(state: T, histories: Reference[]) {
  return JSON.stringify(manifestFor(state, histories), null, 2) + "\n";
}


function diskSchema<T extends HistoryState>(schema: StorageSchema<T>): StorageSchema<Decoded<T>> {
  return { name: "WorkbenchDiskState", parse(value, source) {
    if (!value || typeof value !== "object" || !("schemaVersion" in value) || value.schemaVersion !== 2) {
      return { state: schema.parse(value, source), histories: null };
    }
    const { histories, ...header } = value as Record<string, unknown>;
    const state = schema.parse({ ...header, schemaVersion: 1 }, source);
    if (!Array.isArray(histories) || histories.length !== state.threads.length || state.threads.some(t => t.messages.length)) fail();
    const refs: Reference[] = histories.map((ref, index) => {
      if (!ref || typeof ref !== "object" || Object.keys(ref).sort().join(",") !== "bytes,digest,threadId") fail();
      const r = ref as Reference;
      if (r.threadId !== state.threads[index].id || typeof r.digest !== "string" || !/^[a-f0-9]{64}$/.test(r.digest) ||
          !Number.isSafeInteger(r.bytes) || r.bytes < 2 || r.bytes > WORKBENCH_FILE_LIMIT) fail();
      return r;
    });
    return { state, histories: refs };
  } };
}

async function secureDirectory(directory: string, create = false) {
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  const s = await lstat(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || await realpath(directory) !== path.join(await realpath(path.dirname(directory)), path.basename(directory))) fail();
}
async function readSafe(file: string, expectedBytes?: number) {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(WORKBENCH_FILE_LIMIT) ||
      (expectedBytes !== undefined && before.size !== BigInt(expectedBytes))) fail();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1n ||
        opened.size !== before.size || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) fail();
    // Never let a concurrently growing file determine an unbounded allocation.
    // Read only the previously validated length, then reject any size/identity
    // change; extensions cannot be consumed before the final metadata check.
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) fail();
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.size !== before.size || after.nlink !== 1n || after.dev !== before.dev || after.ino !== before.ino ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) fail();
    return bytes;
  } finally { await handle.close(); }
}
function objectsRoot(statePath: string) { return path.join(path.dirname(statePath), "workbench-history"); }

export async function readWorkbenchDisk<T extends HistoryState>(statePath: string, schema: StorageSchema<T>, recover = false, selectedThreadId?: string): Promise<{ state: T; segmented: boolean; histories?: Reference[] }> {
  const parser = diskSchema(schema);
  const decoded = recover ? (await recoverAtomicJsonFile(statePath, parser)).value : await readValidatedJson(statePath, parser);
  if (!decoded.histories) return { state: decoded.state, segmented: false };
  // Refuse the requested hydration before opening any history object. Metadata
  // reads remain available for ACLs; a selected read budgets only that history.
  const selectedHistories = selectedThreadId === undefined ? decoded.histories : decoded.histories.filter(ref => ref.threadId === selectedThreadId);
  const aggregateBytes = selectedHistories.reduce((total, ref) => total + ref.bytes,
    Buffer.byteLength(encodedManifest(decoded.state, decoded.histories)));
  assertHydrationBudget(aggregateBytes, hydrationBudget());
  const root = objectsRoot(statePath);
  try { await secureDirectory(root); } catch { fail(); }
  // Objects are immutable and user-local; requested objects are checked on every read.
  // The head's inode alone cannot certify an unchanged object after tampering.
  for (let index = 0; index < decoded.histories.length; index++) {
    const ref = decoded.histories[index];
    if (selectedThreadId !== undefined && ref.threadId !== selectedThreadId) continue;
    let bytes: Buffer;
    try { bytes = await readSafe(path.join(root, `${ref.digest}.json`), ref.bytes); } catch { fail(); }
    if (digest(bytes) !== ref.digest) fail();
    const object = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (Object.keys(object).sort().join(",") !== "installationId,messages,schemaVersion,threadId,userId" || object.schemaVersion !== 1 ||
        object.installationId !== decoded.state.installationId || object.userId !== decoded.state.userId || object.threadId !== ref.threadId || !Array.isArray(object.messages)) fail();
    decoded.state.threads[index].messages = object.messages;
  }
  return { state: schema.parse(decoded.state, statePath), segmented: true, histories: decoded.histories };
}

/** Request-local manifest reuse. Every selection rechecks the canonical head and
 * each immutable object; histories are never retained in the manifest cache. */
export function createWorkbenchThreadDiskReader<T extends HistoryState & { projects: unknown }>(statePath: string, schema: StorageSchema<T>) {
  let head: Decoded<T> | null = null;
  let identity: string | null = null;
  let headBytes = 0;
  async function currentIdentity() {
    const st = await lstat(statePath, { bigint: true });
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n || st.size > BigInt(WORKBENCH_FILE_LIMIT)) fail();
    return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join(":");
  }
  return async (threadId: string): Promise<T> => {
    const before = await currentIdentity();
    if (!head || identity !== before) {
      const decoded = await readValidatedJson(statePath, diskSchema(schema));
      if (before !== await currentIdentity()) { head = null; identity = null; throw new WorkbenchPersistenceError("L’estat del workbench ha canviat durant la lectura."); }
      // Legacy files contain inline histories: do not retain their siblings.
      if (!decoded.histories) {
        const selected = decoded.state.threads.filter(thread => thread.id === threadId);
        return schema.parse({ ...decoded.state, threads: selected }, statePath);
      }
      head = decoded; identity = before; headBytes = Buffer.byteLength(encodedManifest(decoded.state, decoded.histories));
    }
    const index = head.state.threads.findIndex(thread => thread.id === threadId);
    if (index < 0) return schema.parse({ ...head.state, projects: structuredClone(head.state.projects), threads: [] }, statePath);
    const ref = head.histories![index];
    assertHydrationBudget(ref.bytes + headBytes, hydrationBudget());
    const root = objectsRoot(statePath);
    await secureDirectory(root);
    const bytes = await readSafe(path.join(root, `${ref.digest}.json`), ref.bytes);
    if (digest(bytes) !== ref.digest) fail();
    const object = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (Object.keys(object).sort().join(",") !== "installationId,messages,schemaVersion,threadId,userId" || object.schemaVersion !== 1 ||
        object.installationId !== head.state.installationId || object.userId !== head.state.userId || object.threadId !== ref.threadId || !Array.isArray(object.messages)) fail();
    if (before !== await currentIdentity()) throw new WorkbenchPersistenceError("L’estat del workbench ha canviat durant la lectura.");
    return schema.parse({ ...head.state, projects: structuredClone(head.state.projects), threads: [{ ...structuredClone(head.state.threads[index]), messages: object.messages }] }, statePath);
  };
}

export async function readWorkbenchMetadata<T extends HistoryState>(statePath: string, schema: StorageSchema<T>) {
  return (await readValidatedJson(statePath, diskSchema(schema))).state;
}

export async function writeSegmentedWorkbench<T extends HistoryState>(statePath: string, state: T, schema: StorageSchema<T>, options: { preserveLegacy?: boolean; retainedHistories?: Reference[] } = {}) {
  const root = objectsRoot(statePath);
  await secureDirectory(root, true);
  // The caller validated the committed legacy state under the user lock.
  // Preserve its bytes without decoding a second full history into the heap.
  if (options.preserveLegacy !== false) {
      const original = await readSafe(statePath);
      const preserved = `${statePath}.v1-preserved.json`;
      try {
        if (digest(await readSafe(preserved)) !== digest(original)) fail();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        await atomicWriteFileChunks(preserved, [original]);
      }
  }
  const histories: Reference[] = [];
  const budget = hydrationBudget();
  let objectBytes = 0;
  const minimumHeadBytes = Buffer.byteLength(encodedManifest(state, []));
  assertHydrationBudget(minimumHeadBytes, budget);
  const retained = new Map(options.retainedHistories?.map(ref => [ref.threadId, ref]));
  for (const thread of state.threads) {
    const previous = retained.get(thread.id);
    if (previous) {
      // These messages were deliberately not hydrated. Retain their committed
      // immutable reference, never serialize the empty metadata placeholder.
      if (thread.messages.length) fail();
      histories.push(previous);
      continue;
    }
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, installationId: state.installationId, userId: state.userId, threadId: thread.id, messages: thread.messages }));
    if (bytes.length > WORKBENCH_FILE_LIMIT) fail();
    objectBytes += bytes.length;
    assertHydrationBudget(minimumHeadBytes + objectBytes, budget);
    const hash = digest(bytes);
    const file = path.join(root, `${hash}.json`);
    try {
      const existing = await readSafe(file, bytes.length);
      if (digest(existing) !== hash) fail();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await atomicWriteFileChunks(file, [bytes]);
    }
    histories.push({ threadId: thread.id, digest: hash, bytes: bytes.length });
  }
  const manifest = manifestFor(state, histories);
  const head = encodedManifest(state, histories);
  assertHydrationBudget(Buffer.byteLength(head) + objectBytes, budget);
  if (Buffer.byteLength(head) > WORKBENCH_FILE_LIMIT) fail();
  diskSchema(schema).parse(manifest, statePath);
  // Each atomic object writer fsyncs its directory before the head is committed.
  await atomicWriteFileChunks(statePath, [head]);
}
