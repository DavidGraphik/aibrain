import { constants, type BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, atomicWriteFileChunks, fsyncDirectory } from "@/storage/atomic-file";
import { StorageCorruptionError, StorageError } from "@/storage/errors";
import { ResourceLockManager } from "@/storage/resource-lock";
import {
  defineVersionedSchema,
  expectInteger,
  expectIsoDate,
  expectString,
  parseJson,
  type StorageSchema,
} from "@/storage/schema";

export type JournalEntry<Payload> = {
  schemaVersion: 1;
  sequence: number;
  eventId: string;
  recordedAt: string;
  payload: Payload;
};

export type FileJournalOptions<Payload> = {
  filePath: string;
  lockManager: ResourceLockManager;
  payloadSchema: StorageSchema<Payload>;
  now?: () => number;
  contiguousPayloadSequence?: (payload: Payload) => number;
  /** Optional lightweight latest-record index; never retains payloads. */
  keyOf?: (payload: Payload) => string;
  /** Share validated indexes only; payload trees and authorization are never shared. */
  shareReadIndex?: boolean;
};

export type JournalReadOptions = {
  afterSequence?: number;
  limit?: number;
  /** Return at least one whole record, then stop before this byte budget. */
  maxBytes?: number;
};

type AppendJob<Payload> = {
  payload: Payload;
  resolve: (entry: JournalEntry<Payload>) => void;
  reject: (error: unknown) => void;
};

// Cache only validated snapshots, scoped to the journal instance (including its
// schema). The process-wide LRU bounds both retained payloads and offset indexes.
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 65_536;
type JournalSnapshot<Payload> = {
  fingerprint: string;
  offsets: number[];
  count: number;
  bytes: number;
  entries?: JournalEntry<Payload>[];
  keys?: Map<string, number>;
  weight: number;
  contiguousSequenceOffset?: number;
};
const snapshots = new Map<object, JournalSnapshot<unknown>>();
let snapshotBytes = 0;

type SharedIndexScope = { path: string; lockRoot: string; schema: object; keyOf: unknown; sequenceOf: unknown; key: object };
const sharedIndexScopes: SharedIndexScope[] = [];
const sharedLastReads = new Map<object, Map<string, Promise<JournalEntry<unknown> | null>>>();
function sharedIndexScope<Payload>(options: FileJournalOptions<Payload>) {
  const index = sharedIndexScopes.findIndex(scope => scope.path === options.filePath && scope.lockRoot === options.lockManager.rootDirectory && scope.schema === options.payloadSchema &&
    scope.keyOf === options.keyOf && scope.sequenceOf === options.contiguousPayloadSequence);
  const scope = index < 0 ? { path: options.filePath, lockRoot: options.lockManager.rootDirectory, schema: options.payloadSchema, keyOf: options.keyOf, sequenceOf: options.contiguousPayloadSequence, key: {} } : sharedIndexScopes.splice(index, 1)[0];
  sharedIndexScopes.push(scope);
  while (sharedIndexScopes.length > 128) sharedIndexScopes.shift();
  return scope.key;
}

function fingerprint(stat: BigIntStats) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.nlink}:${stat.mode}`;
}

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}

function createJournalEntrySchema<Payload>(payloadSchema: StorageSchema<Payload>) {
  return defineVersionedSchema<JournalEntry<Payload>>({
    name: `JournalEntry<${payloadSchema.name}>`,
    schemaVersion: 1,
    keys: ["sequence", "eventId", "recordedAt", "payload"],
    parse(record, context) {
      return {
        schemaVersion: 1,
        sequence: expectInteger(record.sequence, context.at("sequence"), { minimum: 1 }),
        eventId: expectString(record.eventId, context.at("eventId"), {
          minLength: 36,
          maxLength: 36,
          pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        }),
        recordedAt: expectIsoDate(record.recordedAt, context.at("recordedAt")),
        payload: payloadSchema.parse(record.payload, `${context.source}${context.at("payload").path}`),
      };
    },
  });
}

export class FileJournal<Payload> {
  readonly filePath: string;
  private readonly lockManager: ResourceLockManager;
  private readonly payloadSchema: StorageSchema<Payload>;
  private readonly entrySchema: StorageSchema<JournalEntry<Payload>>;
  private readonly now: () => number;
  private readonly contiguousPayloadSequence?: (payload: Payload) => number;
  private readonly keyOf?: (payload: Payload) => string;
  private readonly snapshotKey: object;
  private readonly shareReadIndex: boolean;
  private readonly appendQueue: AppendJob<Payload>[] = [];
  private appendScheduled = false;
  private appendDraining = false;

  constructor(options: FileJournalOptions<Payload>) {
    if (!path.isAbsolute(options.filePath)) {
      throw new StorageError(
        "STORAGE_JOURNAL_OPTIONS_INVALID",
        "Journal filePath must be absolute.",
      );
    }
    this.filePath = path.resolve(options.filePath);
    this.shareReadIndex = options.shareReadIndex === true;
    this.snapshotKey = this.shareReadIndex ? sharedIndexScope({ ...options, filePath: this.filePath }) : this;
    this.lockManager = options.lockManager;
    this.payloadSchema = options.payloadSchema;
    this.entrySchema = createJournalEntrySchema(options.payloadSchema);
    this.now = options.now ?? Date.now;
    this.contiguousPayloadSequence = options.contiguousPayloadSequence;
    this.keyOf = options.keyOf;
  }

  private lockKey() {
    return `journal:${this.filePath}`;
  }

  private async assertNotSymlink() {
    try {
      const metadata = await lstat(this.filePath);
      if (this.shareReadIndex && (!metadata.isFile() || metadata.nlink !== 1 || await realpath(this.filePath) !== this.filePath)) {
        throw new StorageCorruptionError(this.filePath, "unsafe shared journal identity");
      }
      if (metadata.isSymbolicLink()) {
        throw new StorageError(
          "STORAGE_SYMLINK_REJECTED",
          `Refusing to open journal symbolic link ${this.filePath}.`,
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  private forgetSnapshot() {
    const old = snapshots.get(this.snapshotKey);
    if (old) snapshotBytes -= old.weight;
    snapshots.delete(this.snapshotKey);
  }

  private keyWeight(keys: Map<string, number> | undefined) {
    let bytes = 0;
    if (keys) for (const key of keys.keys()) bytes += key.length * 2 + 48;
    return bytes;
  }

  private rememberSnapshot(snapshot: JournalSnapshot<Payload>) {
    this.forgetSnapshot();
    snapshots.set(this.snapshotKey, snapshot as JournalSnapshot<unknown>);
    snapshotBytes += snapshot.weight;
    while (snapshotBytes > MAX_CACHE_BYTES || snapshots.size > 128) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshotBytes -= snapshots.get(oldest)!.weight;
      snapshots.delete(oldest);
    }
  }

  private parseEntry(line: string, expectedSequence: number) {
    if (line.length === 0) {
      throw new StorageCorruptionError(this.filePath, `empty journal record at sequence ${expectedSequence}`);
    }
    let entry: JournalEntry<Payload>;
    try {
      entry = parseJson(this.entrySchema, line, `${this.filePath}:${expectedSequence}`);
    } catch (error) {
      throw new StorageCorruptionError(this.filePath,
        `invalid complete journal record at sequence ${expectedSequence}`, { cause: error });
    }
    if (entry.sequence !== expectedSequence) {
      throw new StorageCorruptionError(this.filePath,
        `expected sequence ${expectedSequence}, found ${entry.sequence}`);
    }
    return entry;
  }

  private validateContiguousSequence(entry: JournalEntry<Payload>, offset?: number) {
    if (!this.contiguousPayloadSequence) return undefined;
    const sequence = this.contiguousPayloadSequence(entry.payload);
    if (!Number.isSafeInteger(sequence) || sequence < 1 ||
        (offset !== undefined && sequence !== entry.sequence + offset)) {
      throw new StorageCorruptionError(this.filePath, "non-contiguous payload sequence");
    }
    return offset ?? sequence - entry.sequence;
  }

  private pageEnd(offsets: number[], after: number, limit: number, maxBytes: number) {
    const maximum = Math.min(offsets.length - 1, after + limit);
    let end = Math.min(maximum, after + 1);
    while (end < maximum && offsets[end + 1] - offsets[after] <= maxBytes) end += 1;
    return end;
  }

  /** One complete UTF-8 JSONL record at a time; partial tails are never parsed. */
  private async *lines(handle: Awaited<ReturnType<typeof open>>) {
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    let position = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      let start = 0;
      for (let end = chunk.indexOf(0x0a); end >= 0 && end < bytesRead; end = chunk.indexOf(0x0a, start)) {
        const part = chunk.subarray(start, end);
        const bytes = fragments.length ? Buffer.concat([...fragments, part], fragmentBytes + part.length) : part;
        fragments = []; fragmentBytes = 0;
        yield { bytes, end: position + end + 1 };
        start = end + 1;
      }
      if (start < bytesRead) {
        const part = chunk.subarray(start, bytesRead);
        fragments.push(part); fragmentBytes += part.length;
      }
      position += bytesRead;
    }
  }

  private async readUnlocked(repairIncompleteTail: boolean, options: JournalReadOptions = {}) {
    const after = options.afterSequence ?? 0;
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    let handle;
    try {
      handle = await open(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      this.forgetSnapshot();
      if (isNodeError(error, "ENOENT")) {
        return { entries: [] as JournalEntry<Payload>[], repairedBytes: 0, count: 0, identity: "missing" };
      }
      throw error;
    }
    try {
      const stat = await handle.stat({ bigint: true });
      const cached = snapshots.get(this.snapshotKey) as JournalSnapshot<Payload> | undefined;
      if (cached?.fingerprint === fingerprint(stat)) {
        this.rememberSnapshot(cached);
        if (after >= cached.count || limit === 0) {
          return { entries: [] as JournalEntry<Payload>[], repairedBytes: 0, count: cached.count, identity: cached.fingerprint };
        }
        if (cached.entries) {
          return { entries: structuredClone(cached.entries.slice(after, this.pageEnd(cached.offsets, after, limit, maxBytes))),
            repairedBytes: 0, count: cached.count, identity: cached.fingerprint };
        }
        if (cached.offsets.length === cached.count + 1) {
          const end = this.pageEnd(cached.offsets, after, limit, maxBytes);
          const data = Buffer.alloc(cached.offsets[end] - cached.offsets[after]);
          let read = 0;
          while (read < data.length) {
            const result = await handle.read(data, read, data.length - read, cached.offsets[after] + read);
            if (result.bytesRead === 0) throw new StorageCorruptionError(this.filePath, "journal changed during read");
            read += result.bytesRead;
          }
          const entries: JournalEntry<Payload>[] = [];
          let start = 0;
          for (let sequence = after + 1; sequence <= end; sequence += 1) {
            const finish = cached.offsets[sequence] - cached.offsets[after] - 1;
            entries.push(this.parseEntry(data.subarray(start, finish).toString("utf8"), sequence));
            start = finish + 1;
          }
          return { entries, repairedBytes: 0, count: cached.count, identity: cached.fingerprint };
        }
      }
      // Any external change, even a same-size in-place rewrite, revalidates the
      // complete file. Only our own fsynced appends can extend a trusted index.
      this.forgetSnapshot();
      const entries: JournalEntry<Payload>[] = [];
      const retained: JournalEntry<Payload>[] | undefined = !this.shareReadIndex && Number(stat.size) <= MAX_SNAPSHOT_BYTES ? [] : undefined;
      const offsets = [0];
      let keys = this.keyOf ? new Map<string, number>() : undefined;
      let lineStart = 0;
      let count = 0;
      let selectedBytes = 0;
      let pageFull = false;
      let contiguousSequenceOffset: number | undefined;
      // Validate every complete record, including records outside the requested
      // page, without retaining the whole historical file or its parsed tree.
      for await (const line of this.lines(handle)) {
        const entry = this.parseEntry(line.bytes.toString("utf8"), count + 1);
        contiguousSequenceOffset = this.validateContiguousSequence(entry, contiguousSequenceOffset);
        count += 1;
        if (keys && this.keyOf) {
          keys.set(this.keyOf(entry.payload), count);
          if (keys.size > MAX_INDEX_ENTRIES) keys = undefined;
        }
        retained?.push(entry);
        if (count > after && entries.length < limit && !pageFull) {
          if (entries.length && selectedBytes + line.bytes.length + 1 > maxBytes) pageFull = true;
          else { entries.push(entry); selectedBytes += line.bytes.length + 1; }
        }
        lineStart = line.end;
        if (offsets.length <= MAX_INDEX_ENTRIES) offsets.push(lineStart);
      }
      if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(stat)) {
        throw new StorageCorruptionError(this.filePath, "journal changed during read");
      }
      const repairedBytes = Number(stat.size) - lineStart;
      let finalStat = stat;
      if (repairedBytes > 0) {
        if (!repairIncompleteTail) {
          throw new StorageCorruptionError(this.filePath, "journal ends with an incomplete record");
        }
        const writer = await open(this.filePath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        try {
          if (fingerprint(await writer.stat({ bigint: true })) !== fingerprint(stat)) {
            throw new StorageCorruptionError(this.filePath, "journal changed during repair");
          }
          await writer.truncate(lineStart);
          await writer.sync();
          finalStat = await writer.stat({ bigint: true });
        } finally {
          await writer.close();
        }
        await fsyncDirectory(path.dirname(this.filePath));
      }
      this.rememberSnapshot({ fingerprint: fingerprint(finalStat), offsets, count, bytes: lineStart,
        contiguousSequenceOffset, keys,
        // Readers and predicate callbacks must not be able to mutate cached data.
        entries: retained ? structuredClone(retained) : undefined,
        weight: offsets.length * 16 + (retained ? lineStart * 4 : 0) + this.keyWeight(keys) + 256 });
      return { entries, repairedBytes, count, identity: fingerprint(finalStat) };
    } finally {
      await handle.close();
    }
  }

  private async writeEntries(entries: JournalEntry<Payload>[]) {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const cached = snapshots.get(this.snapshotKey) as JournalSnapshot<Payload> | undefined;
    const handle = await open(this.filePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const before = await handle.stat({ bigint: true });
      let contiguousSequenceOffset = cached?.fingerprint === fingerprint(before)
        ? cached.contiguousSequenceOffset : undefined;
      for (const entry of entries) {
        contiguousSequenceOffset = this.validateContiguousSequence(entry, contiguousSequenceOffset);
      }
      const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`);
      this.forgetSnapshot();
      await handle.writeFile(lines.join(""), "utf8");
      await handle.sync();
      const after = await handle.stat({ bigint: true });
      if (cached?.fingerprint === fingerprint(before) || before.size === 0n) {
        const offsets = cached ? [...cached.offsets] : [0];
        let keys = this.keyOf ? (cached ? (cached.keys ? new Map(cached.keys) : undefined) : new Map<string, number>()) : undefined;
        if (keys && this.keyOf) for (const entry of entries) keys.set(this.keyOf(entry.payload), entry.sequence);
        if (keys && keys.size > MAX_INDEX_ENTRIES) keys = undefined;
        let bytes = Number(before.size);
        for (const line of lines) {
          bytes += Buffer.byteLength(line);
          if (offsets.length <= MAX_INDEX_ENTRIES) offsets.push(bytes);
        }
        const retained = !this.shareReadIndex && bytes <= MAX_SNAPSHOT_BYTES && (cached?.entries || before.size === 0n)
          ? structuredClone([...(cached?.entries ?? []), ...entries]) : undefined;
        this.rememberSnapshot({ fingerprint: fingerprint(after), offsets,
          count: (cached?.count ?? 0) + entries.length, bytes, entries: retained, contiguousSequenceOffset, keys,
          weight: offsets.length * 16 + (retained ? bytes * 4 : 0) + this.keyWeight(keys) + 256 });
      }
      if (before.size === 0n) await fsyncDirectory(directory);
    } finally {
      await handle.close();
    }
  }

  private async keyedEntryUnlocked(key: string) {
    if (!this.keyOf) throw new StorageError("STORAGE_JOURNAL_INDEX_REQUIRED", "Keyed lookup needs a configured key.");
    await this.readUnlocked(true, { limit: 0 });
    const cached = snapshots.get(this.snapshotKey) as JournalSnapshot<Payload> | undefined;
    if (cached?.keys) {
      const sequence = cached.keys.get(key);
      return sequence === undefined ? null : (await this.readUnlocked(true, { afterSequence: sequence - 1, limit: 1 })).entries[0];
    }
    let last: JournalEntry<Payload> | null = null;
    for await (const entry of this.scanEntries()) if (this.keyOf(entry.payload) === key) last = entry;
    return last;
  }

  async findLastByKey(key: string) {
    return this.lockManager.withLock(this.lockKey(), async () => {
      await this.assertNotSymlink();
      return this.keyedEntryUnlocked(key);
    });
  }

  /** Indexed duplicate checks and contiguous allocation still share the durable
   * cross-process append lock. A changed fingerprint revalidates the full file. */
  async appendIndexed(payload: Payload, shouldAppend: (existing: JournalEntry<Payload> | null, lastSequence: number) => boolean) {
    if (!this.keyOf) throw new StorageError("STORAGE_JOURNAL_INDEX_REQUIRED", "Indexed append needs a configured key.");
    const validated = this.payloadSchema.parse(payload, `${this.filePath}:payload`);
    return this.lockManager.withLock(this.lockKey(), async () => {
      await this.assertNotSymlink();
      const { count } = await this.readUnlocked(true, { limit: 0 });
      const existing = await this.keyedEntryUnlocked(this.keyOf!(validated));
      const cached = snapshots.get(this.snapshotKey) as JournalSnapshot<Payload> | undefined;
      let lastSequence = count ? count + (cached?.contiguousSequenceOffset ?? 0) : 0;
      if (count && this.contiguousPayloadSequence && cached?.contiguousSequenceOffset === undefined) {
        const last = (await this.readUnlocked(true, { afterSequence: count - 1, limit: 1 })).entries[0];
        lastSequence = this.contiguousPayloadSequence(last.payload);
      }
      if (!shouldAppend(existing, lastSequence)) return null;
      const entry = this.entrySchema.parse({ schemaVersion: 1, sequence: count + 1,
        eventId: randomUUID(), recordedAt: new Date(this.now()).toISOString(), payload: validated });
      await this.writeEntries([entry]);
      return entry;
    });
  }

  /** Validate an ordered group under one append lock; publish only after fsync.
   * Existing identities may be replayed, but an invalid member writes nothing. */
  async appendBatchIndexed(payloads: readonly Payload[], shouldAppend: (payload: Payload, existing: JournalEntry<Payload> | null, lastSequence: number) => boolean) {
    if (!this.keyOf || !payloads.length || payloads.length > 256) throw new StorageError("STORAGE_JOURNAL_INDEX_REQUIRED", "Invalid indexed append batch.");
    const validated = payloads.map(payload => this.payloadSchema.parse(payload, `${this.filePath}:payload`));
    return this.lockManager.withLock(this.lockKey(), async () => {
      await this.assertNotSymlink();
      const { count } = await this.readUnlocked(true, { limit: 0 });
      const cached = snapshots.get(this.snapshotKey) as JournalSnapshot<Payload> | undefined;
      let lastSequence = count ? count + (cached?.contiguousSequenceOffset ?? 0) : 0;
      if (count && this.contiguousPayloadSequence && cached?.contiguousSequenceOffset === undefined) {
        lastSequence = this.contiguousPayloadSequence((await this.readUnlocked(true, { afterSequence: count - 1, limit: 1 })).entries[0].payload);
      }
      const created: JournalEntry<Payload>[] = [], selected = new Map<string, JournalEntry<Payload>>();
      const results: (JournalEntry<Payload> | null)[] = [];
      for (const payload of validated) {
        const key = this.keyOf!(payload), existing = selected.get(key) ?? await this.keyedEntryUnlocked(key);
        if (!shouldAppend(payload, existing, lastSequence)) { results.push(null); continue; }
        const entry = this.entrySchema.parse({ schemaVersion: 1, sequence: count + created.length + 1,
          eventId: randomUUID(), recordedAt: new Date(this.now()).toISOString(), payload });
        created.push(entry); selected.set(key, entry); results.push(entry);
        lastSequence = this.contiguousPayloadSequence ? this.contiguousPayloadSequence(payload) : entry.sequence;
      }
      if (created.length) await this.writeEntries(created);
      return results;
    });
  }

  /** Inspect records under the append lock without materializing their history. */
  async appendScanned(payload: Payload, inspect: (entry: JournalEntry<Payload>) => void,
    shouldAppend: (last: JournalEntry<Payload> | null) => boolean) {
    const validatedPayload = this.payloadSchema.parse(payload, `${this.filePath}:payload`);
    return this.lockManager.withLock(this.lockKey(), async () => {
      await this.assertNotSymlink();
      await this.readUnlocked(true, { limit: 0 });
      let last: JournalEntry<Payload> | null = null;
      for await (const entry of this.scanEntries()) { inspect(entry); last = entry; }
      if (!shouldAppend(last)) return null;
      const entry = this.entrySchema.parse({ schemaVersion: 1, sequence: (last?.sequence ?? 0) + 1,
        eventId: randomUUID(), recordedAt: new Date(this.now()).toISOString(), payload: validatedPayload });
      await this.writeEntries([entry]);
      return entry;
    });
  }

  private async *scanEntries() {
    let handle;
    try { handle = await open(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if (isNodeError(error, "ENOENT")) return; throw error; }
    try {
      let expected = 1;
      for await (const line of this.lines(handle)) yield this.parseEntry(line.bytes.toString("utf8"), expected++);
    } finally { await handle.close(); }
  }

  /** Bounded lookup for request ledgers whose last matching receipt is authoritative. */
  async findLast(predicate: (payload: Payload) => boolean) {
    return this.lockManager.withLock(this.lockKey(), async () => {
      await this.assertNotSymlink();
      await this.readUnlocked(true, { limit: 0 });
      let last: JournalEntry<Payload> | null = null;
      for await (const entry of this.scanEntries()) if (predicate(entry.payload)) last = entry;
      return last;
    });
  }

  /** Select by lightweight identities under the journal lock, then rewrite one
   * record at a time. Effect receipts need not be materialized to preserve them. */
  async compactSelected(select: (entries: AsyncIterable<JournalEntry<Payload>>) => Promise<ReadonlySet<number> | undefined>) {
    return this.lockManager.withLock(this.lockKey(), async () => {
      await this.assertNotSymlink();
      const { count } = await this.readUnlocked(true, { limit: 0 });
      const selected = await select(this.scanEntries());
      if (selected === undefined || selected.size === count) return Object.freeze({ before: count, after: count, changed: false });
      if ([...selected].some(sequence => !Number.isSafeInteger(sequence) || sequence < 1 || sequence > count)) {
        throw new StorageError("STORAGE_JOURNAL_COMPACT_INVALID", "Selected journal sequence is invalid.");
      }
      const self = this;
      async function* retainedLines() {
        let sequence = 0;
        for await (const entry of self.scanEntries()) {
          if (selected!.has(entry.sequence)) yield JSON.stringify({ ...entry, sequence: ++sequence }) + "\n";
        }
      }
      await atomicWriteFileChunks(this.filePath, retainedLines(), { mode: 0o600 });
      this.forgetSnapshot();
      return Object.freeze({ before: count, after: selected.size, changed: true });
    });
  }

  /** Drop only a validated contiguous prefix. Keep the anchor and every record
   * after it. The retained older window is bounded by both count and bytes. */
  async compactContiguousTail(options: { anchorSequence: number; maxRetainedEntries: number;
    maxRetainedBytes: number; minimumEntries: number; minimumRemovedEntries: number; minimumRemovedBytes?: number; deferWhilePending?: boolean }) {
    const sequenceOf = this.contiguousPayloadSequence;
    const { deferWhilePending, ...bounds } = options;
    if (!sequenceOf || (deferWhilePending !== undefined && typeof deferWhilePending !== "boolean") ||
      Object.values(bounds).some(value => !Number.isSafeInteger(value) || value < 0)) {
      throw new StorageError("STORAGE_JOURNAL_COMPACT_INVALID", "Invalid contiguous compaction bounds.");
    }
    return this.lockManager.withLock(this.lockKey(), async () => {
      await this.assertNotSymlink();
      const { count } = await this.readUnlocked(true, { limit: 0 });
      const cached = snapshots.get(this.snapshotKey) as JournalSnapshot<Payload> | undefined;
      let earliest = 0, removedBytes = 0, found = false;
      if (cached?.offsets.length === count + 1 && cached.contiguousSequenceOffset !== undefined) {
        const anchor = options.anchorSequence - cached.contiguousSequenceOffset;
        if (anchor >= 1 && anchor <= count) {
          found = true; earliest = anchor;
          let retainedBytes = cached.offsets[anchor] - cached.offsets[anchor - 1] - 1;
          while (earliest > 1 && anchor - earliest + 1 < options.maxRetainedEntries) {
            const bytes = cached.offsets[earliest - 1] - cached.offsets[earliest - 2] - 1;
            if (retainedBytes + bytes > options.maxRetainedBytes) break;
            retainedBytes += bytes; earliest -= 1;
          }
        }
        removedBytes = cached.offsets[earliest - 1] ?? 0;
      } else {
        const window: { index: number; bytes: number; offset: number }[] = [];
        let retainedBytes = 0, scannedBytes = 0;
        for await (const entry of this.scanEntries()) {
          const sequence = sequenceOf(entry.payload);
          if (sequence > options.anchorSequence) break;
          const bytes = Buffer.byteLength(JSON.stringify(entry));
          window.push({ index: entry.sequence, bytes, offset: scannedBytes });
          retainedBytes += bytes; scannedBytes += bytes + 1;
          while (window.length > 1 && (window.length > options.maxRetainedEntries || retainedBytes > options.maxRetainedBytes)) {
            retainedBytes -= window.shift()!.bytes;
          }
          if (sequence === options.anchorSequence) { earliest = window[0].index; removedBytes = window[0].offset; found = true; break; }
        }
      }
      if (!found) throw new StorageCorruptionError(this.filePath, "compaction anchor is absent");
      if (deferWhilePending) {
        const lastSequence = cached?.contiguousSequenceOffset !== undefined
          ? count + cached.contiguousSequenceOffset
          : sequenceOf((await this.readUnlocked(true, { afterSequence: count - 1, limit: 1 })).entries[0].payload);
        // The decision shares the append lock: a response cannot slip between
        // checking for pending history and starting a discretionary rewrite.
        if (lastSequence > options.anchorSequence) {
          return Object.freeze({ before: count, after: count, changed: false, deferred: true });
        }
      }
      const removed = earliest - 1;
      const belowBatch = removed < options.minimumRemovedEntries &&
        (options.minimumRemovedBytes === undefined || removedBytes < options.minimumRemovedBytes);
      if (!removed || count <= options.minimumEntries || belowBatch) {
        return Object.freeze({ before: count, after: count, changed: false });
      }
      const self = this;
      async function* retainedLines() {
        let sequence = 0;
        for await (const entry of self.scanEntries()) {
          if (entry.sequence < earliest) continue;
          yield JSON.stringify({ ...entry, sequence: ++sequence }) + "\n";
        }
      }
      await atomicWriteFileChunks(this.filePath, retainedLines(), { mode: 0o600 });
      this.forgetSnapshot();
      return Object.freeze({ before: count, after: count - removed, changed: true });
    });
  }

  async appendIf(
    payload: Payload,
    shouldAppend: (entries: readonly JournalEntry<Payload>[]) => boolean | Promise<boolean>,
  ) {
    const validatedPayload = this.payloadSchema.parse(payload, `${this.filePath}:payload`);
    return this.lockManager.withLock(this.lockKey(), async () => {
      await this.assertNotSymlink();
      const { entries } = await this.readUnlocked(true);
      if (!await shouldAppend(entries)) return null;
      const entry = this.entrySchema.parse({
        schemaVersion: 1,
        sequence: (entries.at(-1)?.sequence ?? 0) + 1,
        eventId: randomUUID(),
        recordedAt: new Date(this.now()).toISOString(),
        payload: validatedPayload,
      });

      await this.writeEntries([entry]);
      return entry;
    });
  }

  async append(payload: Payload) {
    const validatedPayload = this.payloadSchema.parse(payload, `${this.filePath}:payload`);
    return new Promise<JournalEntry<Payload>>((resolve, reject) => {
      this.appendQueue.push({ payload: validatedPayload, resolve, reject });
      this.scheduleAppendDrain();
    });
  }

  private scheduleAppendDrain() {
    if (this.appendScheduled || this.appendDraining) return;
    this.appendScheduled = true;
    queueMicrotask(() => {
      this.appendScheduled = false;
      void this.drainAppends();
    });
  }

  private async drainAppends() {
    if (this.appendDraining) return;
    this.appendDraining = true;
    const jobs = this.appendQueue.splice(0);
    try {
      const appended = await this.lockManager.withLock(this.lockKey(), async () => {
        await this.assertNotSymlink();
        const { count } = await this.readUnlocked(true, { limit: 0 });
        const created = jobs.map((job, index) => this.entrySchema.parse({
          schemaVersion: 1,
          sequence: count + index + 1,
          eventId: randomUUID(),
          recordedAt: new Date(this.now()).toISOString(),
          payload: job.payload,
        }));
        await this.writeEntries(created);
        return created;
      });
      jobs.forEach((job, index) => job.resolve(appended[index]));
    } catch (error) {
      jobs.forEach((job) => job.reject(error));
    } finally {
      this.appendDraining = false;
      if (this.appendQueue.length > 0) this.scheduleAppendDrain();
    }
  }

  async read(options: JournalReadOptions = {}) {
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new StorageError(
        "STORAGE_JOURNAL_READ_INVALID",
        "afterSequence must be a non-negative safe integer.",
      );
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new StorageError(
        "STORAGE_JOURNAL_READ_INVALID",
        "limit must be a positive safe integer.",
      );
    }

    return this.lockManager.withLock(this.lockKey(), async () => {
      await this.assertNotSymlink();
      const { entries } = await this.readUnlocked(true, { afterSequence, limit, maxBytes: options.maxBytes });
      return entries;
    });
  }

  /** Only the unlocked transport startup calls this coalescing boundary. A
   * caller must not join while owning another resource lock. */
  async readLast() {
    if (!this.shareReadIndex) return this.readLastLocked();
    const identity = await this.sharedReadIdentity();
    let reads = sharedLastReads.get(this.snapshotKey);
    const pending = reads?.get(identity);
    if (pending) return structuredClone(await pending) as JournalEntry<Payload> | null;
    // Bound in-flight identities too; an attacker rotating a file cannot grow
    // an unbounded promise table or join a different canonical revision.
    if ((!reads && sharedLastReads.size >= 128) || (reads && reads.size >= 4)) return this.readLastLocked();
    if (!reads) { reads = new Map(); sharedLastReads.set(this.snapshotKey, reads); }
    let validatedIdentity = identity;
    const reading = this.readLastLocked(value => { validatedIdentity = value; }).then(async last => {
      const after = await this.sharedReadIdentity();
      // A valid append after the read lease is released cannot invalidate the
      // snapshot linearized under that lease. New callers use the new complete
      // fingerprint and cannot join this older in-flight revision.
      const sameFile = validatedIdentity !== "missing" && after !== "missing" &&
        validatedIdentity.split(":").slice(0, 2).join(":") === after.split(":").slice(0, 2).join(":");
      if (validatedIdentity !== after && !sameFile) throw new StorageCorruptionError(this.filePath, "journal rotated during shared startup read");
      return last;
    });
    reads.set(identity, reading as Promise<JournalEntry<unknown> | null>);
    try { return structuredClone(await reading); }
    finally {
      if (reads.get(identity) === reading) reads.delete(identity);
      if (!reads.size && sharedLastReads.get(this.snapshotKey) === reads) sharedLastReads.delete(this.snapshotKey);
    }
  }

  private async sharedReadIdentity() {
    try {
      const info = await lstat(this.filePath, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || await realpath(this.filePath) !== this.filePath) {
        throw new StorageCorruptionError(this.filePath, "unsafe shared journal identity");
      }
      return fingerprint(info);
    } catch (error) { if (isNodeError(error, "ENOENT")) return "missing"; throw error; }
  }

  private async readLastLocked(onValidated?: (identity: string) => void) {
    return this.lockManager.withLock(this.lockKey(), async () => {
      await this.assertNotSymlink();
      const indexed = await this.readUnlocked(true, { limit: 0 });
      const selected = indexed.count ? await this.readUnlocked(true, { afterSequence: indexed.count - 1, limit: 1 }) : indexed;
      if (this.shareReadIndex) {
        // readUnlocked reports its validated post-repair identity, so repairing
        // an incomplete tail remains compatible with startup snapshot checks.
        if (indexed.identity !== selected.identity || selected.identity !== await this.sharedReadIdentity()) {
          throw new StorageCorruptionError(this.filePath, "journal changed during locked startup read");
        }
        onValidated?.(selected.identity);
      }
      return selected.entries[0] ?? null;
    });
  }

  /** Read a contiguous payload sequence that survives internal renumbering on compaction. */
  async readContiguous(
    afterSequence: number,
    limit: number,
    maxBytes?: number,
  ) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
        !Number.isSafeInteger(limit) || limit < 1) {
      throw new StorageError("STORAGE_JOURNAL_READ_INVALID", "Invalid contiguous journal read bounds.");
    }
    const sequenceOf = this.contiguousPayloadSequence;
    if (!sequenceOf) {
      throw new StorageError("STORAGE_JOURNAL_READ_INVALID", "Contiguous payload sequences must be configured on the journal.");
    }
    return this.lockManager.withLock(this.lockKey(), async () => {
      await this.assertNotSymlink();
      const first = (await this.readUnlocked(true, { limit: 1 })).entries[0];
      if (!first) return [];
      const firstSequence = sequenceOf(first.payload);
      const internalAfter = Math.max(0, afterSequence - firstSequence + 1);
      const { entries } = await this.readUnlocked(true, { afterSequence: internalAfter, limit, maxBytes });
      for (const entry of entries) {
        if (sequenceOf(entry.payload) !== firstSequence + entry.sequence - 1) {
          throw new StorageCorruptionError(this.filePath, "non-contiguous payload sequence");
        }
      }
      return entries;
    });
  }

  /**
   * Atomically rewrites a journal under its normal cross-process lock.
   *
   * This is intended only for operational ledgers whose authoritative cursor
   * or projection is stored separately. The callback receives validated
   * entries and returns the payloads that must remain, in their new order.
   */
  async compact(
    retain: (entries: readonly JournalEntry<Payload>[]) => readonly Payload[] | undefined,
  ) {
    return this.lockManager.withLock(this.lockKey(), async () => {
      await this.assertNotSymlink();
      const { entries } = await this.readUnlocked(true);
      const retained = retain(entries);
      if (retained === undefined) {
        return Object.freeze({ before: entries.length, after: entries.length, changed: false });
      }
      const payloads = retained.map((payload) =>
        this.payloadSchema.parse(payload, `${this.filePath}:compaction`));
      const compacted = payloads.map((payload, index) => this.entrySchema.parse({
        schemaVersion: 1,
        sequence: index + 1,
        eventId: randomUUID(),
        recordedAt: new Date(this.now()).toISOString(),
        payload,
      }));
      let contiguousSequenceOffset: number | undefined;
      for (const entry of compacted) {
        contiguousSequenceOffset = this.validateContiguousSequence(entry, contiguousSequenceOffset);
      }
      this.forgetSnapshot();
      await atomicWriteFile(
        this.filePath,
        compacted.length === 0
          ? ""
          : `${compacted.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        { mode: 0o600 },
      );
      return Object.freeze({ before: entries.length, after: compacted.length, changed: true });
    });
  }

  async verifyAndRepair() {
    return this.lockManager.withLock(this.lockKey(), async () => {
      await this.assertNotSymlink();
      // Explicit verification always checks bytes, including previously indexed history.
      this.forgetSnapshot();
      const result = await this.readUnlocked(true, { limit: 0 });
      return {
        count: result.count,
        lastSequence: result.count,
        repairedBytes: result.repairedBytes,
      };
    });
  }
}
