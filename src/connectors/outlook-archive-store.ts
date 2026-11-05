import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import { atomicWriteFile, ResourceLockManager } from "@/storage";
import { USER_ID_PATTERN } from "./contracts";
import { mailEncryptionKey } from "./mail-store";
import { desktopRecord, normalizeOutlookDesktopOperationArgs, OutlookDesktopError, type OutlookDesktopOperation } from "./outlook-desktop-contracts";

/** The caller must recheck the current enabled user, mail policy and paired device.
 * This store is deliberately not an authentication or operator-approval boundary. */
export type OutlookArchiveAuthority = { userId: string; deviceId: string; storeIds: string[] };
export type OutlookArchiveCheckpoint = { phase: "backfill" | "caught_up" | "blocked"; errors: string[]; scannedItems: number; expectedItems: number | null };
export type OutlookArchiveRecord =
  | { kind: "folder"; storeId: string; id: string; parentId: string | null; name: string; itemType: number }
  | { kind: "item"; storeId: string; id: string; folderId: string; version: string; lastModified: string; data: Record<string, unknown> }
  | { kind: "text"; storeId: string; itemId: string; version: string; offset: number; totalChars: number; text: string }
  | { kind: "attachment"; storeId: string; itemId: string; version: string; index: number; offset: number; totalBytes: number; sha256: string; filename: string; dataBase64: string };
export type OutlookArchiveBatch = { schema: 1; epoch: string; sequence: number; records: OutlookArchiveRecord[]; checkpoint: OutlookArchiveCheckpoint };
type Ref = { bodyTotal?: number; attachments?: { index: number; size: number }[]; length?: number; key: string; bytes: number; hash: string; kind: OutlookArchiveRecord["kind"]; storeId: string; itemId?: string; version?: string; id?: string; folderId?: string; offset?: number; index?: number; total?: number; sha256?: string; filename?: string; itemClass?: number; lastModified?: string };
type State = { schema: 1; installationId: string; userId: string; quotaBytes: number; bytesStored: number; deviceId?: string; storeIds?: string[]; epoch?: string; sequence: number; lastBatchHash?: string; lastSyncedAt?: string; lastCompletedAt?: string; checkpoint: OutlookArchiveCheckpoint; refs: Record<string, Ref>; readableItems: Record<string, Ref>; cursors: Record<string, { scope: string; offset: number; expires: number }> };
const MAX_BATCH = 768 * 1024, MAX_RECORD = 512 * 1024, MAX_INDEX = 32 * 1024 * 1024, MAX_REFS = 200_000;
export const OUTLOOK_ARCHIVE_MAX_BATCH_BYTES = MAX_BATCH;
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
function fail(code = "OUTLOOK_ARCHIVE_ARGUMENTS_INVALID", status = 400): never { throw new OutlookDesktopError(code, status); }
const text = (v: unknown, max = 4096, empty = false): string => { if (typeof v !== "string" || v.length > max || (!empty && !v.length) || v.includes("\0")) fail(); return v as string; };
const number = (v: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): number => { if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) fail(); return Number(v); };
const keys = (v: unknown, names: string[]): Record<string, unknown> => { if (!desktopRecord(v) || Object.keys(v).some(k => !names.includes(k))) fail(); return v as Record<string, unknown>; };
const uuid = (v: unknown) => { const s = text(v, 36); if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s)) fail(); return s; };
const missing = (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "ENOENT";
const recordKey = (r: OutlookArchiveRecord) => hash(JSON.stringify(r.kind === "folder" ? [r.kind, r.storeId, r.id] : r.kind === "item" ? [r.kind, r.storeId, r.id] : r.kind === "text" ? [r.kind, r.storeId, r.itemId, r.version, r.offset] : [r.kind, r.storeId, r.itemId, r.version, r.index, r.offset]));
const base = (r: OutlookArchiveRecord): Ref => ({ key: recordKey(r), bytes: 0, hash: "", kind: r.kind, storeId: r.storeId, ...("id" in r ? { id: r.id } : { itemId: r.itemId, version: r.version, offset: r.offset }), ...(r.kind === "item" ? { folderId: r.folderId, version: r.version, itemClass: Number(r.data.itemClass), lastModified: r.lastModified, bodyTotal: Number((r.data.body as Record<string, unknown>).total), attachments: (r.data.attachments as { index: number; size: number }[]).map(a => ({ index: a.index, size: a.size })) } : {}), ...(r.kind === "text" ? { total: r.totalChars, length: r.text.length } : {}), ...(r.kind === "attachment" ? { index: r.index, total: r.totalBytes, length: Buffer.from(r.dataBase64, "base64").length, sha256: r.sha256, filename: r.filename } : {}) });
function batch(input: unknown, authority: OutlookArchiveAuthority): OutlookArchiveBatch {
  const b = keys(input, ["schema", "epoch", "sequence", "records", "checkpoint"]); if (b.schema !== 1 || !Array.isArray(b.records) || b.records.length > 50 || Buffer.byteLength(JSON.stringify(input)) > MAX_BATCH) fail();
  uuid(b.epoch); number(b.sequence, Number.MAX_SAFE_INTEGER, 1);
  const c = keys(b.checkpoint, ["phase", "errors", "scannedItems", "expectedItems"]);
  if (!["backfill", "caught_up", "blocked"].includes(String(c.phase)) || !Array.isArray(c.errors) || c.errors.length > 100 || c.errors.some(e => !/^[A-Z0-9_:.-]{1,180}$/.test(String(e)))) fail();
  number(c.scannedItems); if (c.expectedItems !== null) number(c.expectedItems); if (c.phase === "caught_up" && (c.errors.length || c.expectedItems === null || c.scannedItems !== c.expectedItems)) fail("OUTLOOK_ARCHIVE_COVERAGE_NOT_COMPLETE");
  for (const raw of b.records) {
    if (!desktopRecord(raw)) fail(); const kind = raw.kind;
    keys(raw, kind === "folder" ? ["kind", "storeId", "id", "parentId", "name", "itemType"] : kind === "item" ? ["kind", "storeId", "id", "folderId", "version", "lastModified", "data"] : kind === "text" ? ["kind", "storeId", "itemId", "version", "offset", "totalChars", "text"] : kind === "attachment" ? ["kind", "storeId", "itemId", "version", "index", "offset", "totalBytes", "sha256", "filename", "dataBase64"] : []);
    if (!authority.storeIds.includes(text(raw.storeId))) fail("OUTLOOK_ARCHIVE_STORE_DENIED", 403);
    if (Buffer.byteLength(JSON.stringify(raw)) > MAX_RECORD) fail("OUTLOOK_ARCHIVE_RECORD_TOO_LARGE", 413);
    if (kind === "folder") { text(raw.id); if (raw.parentId !== null) text(raw.parentId); text(raw.name, 2000, true); number(raw.itemType, 100); }
    else if (kind === "item") { text(raw.id); text(raw.folderId); text(raw.version, 64); if (!/^[a-f0-9]{64}$/.test(String(raw.version)) || !Number.isFinite(Date.parse(text(raw.lastModified, 40))) || !desktopRecord(raw.data) || ![43, 40, 26].includes(Number(raw.data.itemClass))) fail(); if (!desktopRecord(raw.data.body)) fail(); number(raw.data.body.total, 100_000_000); if (!Array.isArray(raw.data.attachments) || raw.data.attachments.length > 10000) fail(); for (const a of raw.data.attachments) { if (!desktopRecord(a)) fail(); number(a.index, 10000, 1); number(a.size, 25 * 1024 * 1024); text(a.filename, 1000, true); } }
    else if (kind === "text" || kind === "attachment") { text(raw.itemId); if (!/^[a-f0-9]{64}$/.test(text(raw.version, 64))) fail(); number(raw.offset, 100_000_000); if (kind === "text") { const total = number(raw.totalChars, 100_000_000), s = text(raw.text, 100000, true); if (Number(raw.offset) + s.length > total || !s.length && total !== 0) fail(); } else { number(raw.index, 10000, 1); const total = number(raw.totalBytes, 25 * 1024 * 1024); if (!/^[a-f0-9]{64}$/.test(text(raw.sha256, 64))) fail(); text(raw.filename, 1000, true); const s = text(raw.dataBase64, 360000, true), bytes = Buffer.from(s, "base64"); if (bytes.toString("base64") !== s || bytes.length > 256 * 1024 || Number(raw.offset) + bytes.length > total || !bytes.length && total !== 0) fail(); } }
    else fail();
  }
  return input as OutlookArchiveBatch;
}

export class FileOutlookArchiveStore {
  private readonly locks: ResourceLockManager;
  private readonly minimumFreeBytes: number;
  private readonly freeBytes: (folder: string) => Promise<number>;
  constructor(private readonly config: Readonly<InstallationConfig>, private readonly key = mailEncryptionKey(), options: { minimumFreeBytes?: number; freeBytes?: (folder: string) => Promise<number> } = {}) {
    this.minimumFreeBytes = options.minimumFreeBytes ?? 15 * 1024 ** 3;
    this.freeBytes = options.freeBytes ?? (async folder => { const fs = await statfs(folder); return fs.bavail * fs.bsize; });
    this.locks = new ResourceLockManager({ rootDirectory: path.join(config.paths.dataRoot, "connectors", "outlook-archive", "locks"), defaultTimeoutMs: 15000, staleAfterMs: 60000 });
  }
  private assert(a: OutlookArchiveAuthority) { if (this.config.installationId !== "g03-production" || !USER_ID_PATTERN.test(a.userId) || !a.deviceId || a.deviceId.length > 100 || !a.storeIds.length || a.storeIds.length > 32 || a.storeIds.some(s => typeof s !== "string" || !s.length || s.length > 4096)) fail("OUTLOOK_ARCHIVE_IDENTITY_INVALID", 403); }
  private async folder(a: OutlookArchiveAuthority) {
    this.assert(a); const users = path.resolve(this.config.paths.usersRoot); let folder = users;
    for (const part of ["", a.userId, "connectors", "outlook-archive", "objects"]) {
      if (part) folder = path.join(folder, part);
      if (["connectors", "outlook-archive", "objects"].includes(part)) await mkdir(folder, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
      const meta = await lstat(folder), relative = path.relative(await realpath(users), await realpath(folder));
      if (!meta.isDirectory() || meta.isSymbolicLink() || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || part && (meta.mode & 0o077) !== 0) fail("OUTLOOK_ARCHIVE_STORAGE_UNSAFE", 503);
    }
    return path.dirname(folder);
  }
  private aad(a: OutlookArchiveAuthority, name: string) { return Buffer.from(`${this.config.installationId}\0${a.userId}\0outlook-archive\0${name}`); }
  private encrypt(a: OutlookArchiveAuthority, name: string, value: unknown) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv); cipher.setAAD(this.aad(a, name)); const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]); return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }); }
  private async read(a: OutlookArchiveAuthority, folder: string, name: string, max: number): Promise<unknown> {
    let handle; try { handle = await open(path.join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) { if (missing(e)) return undefined; fail("OUTLOOK_ARCHIVE_STORAGE_UNSAFE", 503); }
    try { const meta = await handle!.stat(); if (!meta.isFile() || meta.mode & 0o077 || meta.size > max) throw new Error(); const v = JSON.parse(await handle!.readFile("utf8")); if (v.v !== 1) throw new Error(); const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(v.iv, "base64")); decipher.setAAD(this.aad(a, name)); decipher.setAuthTag(Buffer.from(v.tag, "base64")); return JSON.parse(Buffer.concat([decipher.update(Buffer.from(v.ciphertext, "base64")), decipher.final()]).toString("utf8")); } catch { fail("OUTLOOK_ARCHIVE_STORAGE_INVALID", 503); } finally { await handle!.close(); }
  }
  private async state(a: OutlookArchiveAuthority, folder: string): Promise<State> {
    const value = await this.read(a, folder, "index.json", MAX_INDEX * 2); if (!value) return { schema: 1, installationId: this.config.installationId, userId: a.userId, quotaBytes: 0, bytesStored: 0, sequence: 0, checkpoint: { phase: "backfill", errors: [], scannedItems: 0, expectedItems: null }, refs: {}, readableItems: {}, cursors: {} };
    const s = value as State; if (s.schema !== 1 || s.installationId !== this.config.installationId || s.userId !== a.userId || !desktopRecord(s.refs) || !desktopRecord(s.cursors)) fail("OUTLOOK_ARCHIVE_STORAGE_INVALID", 503); if (s.readableItems === undefined) s.readableItems = this.publishCompleteItems(s.refs, {}); if (!desktopRecord(s.readableItems)) fail("OUTLOOK_ARCHIVE_STORAGE_INVALID", 503); return s;
  }
  private async writeState(a: OutlookArchiveAuthority, folder: string, s: State) { if (Buffer.byteLength(JSON.stringify(s)) > MAX_INDEX) fail("OUTLOOK_ARCHIVE_INDEX_FULL", 507); await atomicWriteFile(path.join(folder, "index.json"), this.encrypt(a, "index.json", s), { mode: 0o600 }); }
  private async transaction<T>(a: OutlookArchiveAuthority, action: (s: State, folder: string) => Promise<T>) { this.assert(a); return this.locks.withLock(`archive:${this.config.installationId}:${a.userId}`, async () => { const folder = await this.folder(a); return action(await this.state(a, folder), folder); }); }
  private coverage(s: State, a: OutlookArchiveAuthority) { const refs = Object.values(s.readableItems).filter(r => a.storeIds.includes(r.storeId)); const pendingItems = Object.entries(s.refs).filter(([key, r]) => r.kind === "item" && a.storeIds.includes(r.storeId) && s.readableItems[key]?.hash !== r.hash).length; const scopeMatches = !s.storeIds || [...s.storeIds].sort().join("\0") === [...a.storeIds].sort().join("\0"); return { source: "encrypted-outlook-read-replica", availableWithComputerOff: refs.some(r => r.kind === "item"), configured: s.quotaBytes > 0, quotaBytes: s.quotaBytes, bytesStored: s.bytesStored, lastSyncedAt: s.lastSyncedAt ?? null, lastCompletedAt: s.lastCompletedAt ?? null, coverage: scopeMatches ? s.checkpoint : { ...s.checkpoint, phase: "blocked", errors: ["PAIRED_STORE_SCOPE_CHANGED"] }, replicatedItems: refs.length, pendingItems, currentStateVerified: false, localChangesAfterLastSyncUnavailable: true, deletedItemsMayRemain: true, recurrenceExpanded: false, sourceChanged: false }; }
  async status(a: OutlookArchiveAuthority) { return this.transaction(a, async s => this.coverage(s, a)); }
  /** Operator-only; never call with a model-chosen quota. Capacity is still checked on every write. */
  async configure(a: OutlookArchiveAuthority, quotaBytes: number) { number(quotaBytes, 20 * 1024 ** 3); return this.transaction(a, async (s, folder) => { if (quotaBytes && quotaBytes < s.bytesStored) fail("OUTLOOK_ARCHIVE_QUOTA_BELOW_EXISTING_DATA", 409); if (quotaBytes && await this.freeBytes(folder) - 2 * 1024 * 1024 < this.minimumFreeBytes) fail("OUTLOOK_ARCHIVE_DISK_RESERVE", 507); s.quotaBytes = quotaBytes; await this.writeState(a, folder, s); return this.coverage(s, a); }); }
  async ingest(a: OutlookArchiveAuthority, input: unknown) {
    const b = batch(input, a), fingerprint = hash(JSON.stringify(b));
    return this.transaction(a, async (s, folder) => {
      if (!s.quotaBytes) fail("OUTLOOK_ARCHIVE_CAPACITY_REVIEW_REQUIRED", 409);
      if (s.deviceId === a.deviceId && s.epoch === b.epoch && s.sequence === b.sequence) { if (s.lastBatchHash !== fingerprint) fail("OUTLOOK_ARCHIVE_BATCH_REPLAY_CHANGED", 409); return { accepted: true, duplicate: true, sequence: s.sequence, archiveCoverage: this.coverage(s, a) }; }
      if (s.epoch && s.deviceId === a.deviceId && s.epoch !== b.epoch) fail("OUTLOOK_ARCHIVE_EPOCH_REPLACEMENT_REQUIRES_REENROLL", 409);
      if (s.epoch !== b.epoch || s.deviceId !== a.deviceId) { if (b.sequence !== 1) fail("OUTLOOK_ARCHIVE_NEW_EPOCH_REQUIRES_SEQUENCE_ONE", 409); s.epoch = b.epoch; s.sequence = 0; s.deviceId = a.deviceId; }
      s.storeIds = [...a.storeIds];
      if (b.sequence !== s.sequence + 1) fail("OUTLOOK_ARCHIVE_SEQUENCE_MISMATCH", 409);
      const staged = new Map<string, { ref: Ref; record: OutlookArchiveRecord; encrypted: string }>(); let projected = s.bytesStored;
      for (const record of b.records) {
        const logicalKey = recordKey(record), ref = base(record); ref.hash = hash(JSON.stringify(record)); ref.key = hash(logicalKey + ref.hash);
        const name = `objects/${ref.key}.json`, encrypted = this.encrypt(a, name, record); ref.bytes = Buffer.byteLength(encrypted);
        const previous = staged.get(logicalKey)?.ref ?? s.refs[logicalKey]; if (previous?.hash !== ref.hash) projected += ref.bytes; staged.set(logicalKey, { ref, record, encrypted });
      }
      if (projected > s.quotaBytes || new Set([...Object.keys(s.refs), ...staged.keys()]).size > MAX_REFS) fail("OUTLOOK_ARCHIVE_QUOTA_EXCEEDED", 507);
      const additional = [...staged.values()].reduce((n, v) => n + v.ref.bytes, 0) + Buffer.byteLength(JSON.stringify(s)) * 3 + 2 * 1024 * 1024;
      if (await this.freeBytes(folder) - additional < this.minimumFreeBytes) fail("OUTLOOK_ARCHIVE_DISK_RESERVE", 507);
      const all = { ...s.refs, ...Object.fromEntries([...staged].map(([k, v]) => [k, v.ref])) };
      const stagedByContent = new Map([...staged.values()].map(v => [v.ref.key, v]));
      const getRecord = async (ref: Ref) => stagedByContent.get(ref.key)?.record ?? await this.object(a, folder, ref);
      for (const { ref } of staged.values()) {
        if (ref.kind === "text" || ref.kind === "attachment") {
          const owner = all[hash(JSON.stringify(["item", ref.storeId, ref.itemId]))]; if (!owner || owner.version !== ref.version) fail("OUTLOOK_ARCHIVE_PARENT_VERSION_REQUIRED", 409);
          const parts = Object.values(all).filter(r => r.kind === ref.kind && r.storeId === ref.storeId && r.itemId === ref.itemId && r.version === ref.version && r.index === ref.index).sort((x, y) => x.offset! - y.offset!); let end = 0; const h = createHash("sha256");
          for (const p of parts) { if (p.offset !== end || p.total !== ref.total || p.kind === "attachment" && p.sha256 !== ref.sha256) fail("OUTLOOK_ARCHIVE_CHUNK_SEQUENCE_INVALID", 409); end += p.length ?? 0; }
          if (end > ref.total!) fail();
          if (ref.kind === "attachment" && end === ref.total) { for (const p of parts) { const data = await getRecord(p); if (data.kind !== "attachment") fail(); h.update(Buffer.from(data.dataBase64, "base64")); } if (h.digest("hex") !== ref.sha256) fail("OUTLOOK_ARCHIVE_ATTACHMENT_HASH_MISMATCH", 409); }
        }
      }
      if (b.checkpoint.phase === "caught_up") {
        const chunks = new Map<string, Ref[]>();
        for (const ref of Object.values(all)) if (ref.kind === "text" || ref.kind === "attachment") { const key = JSON.stringify([ref.kind, ref.storeId, ref.itemId, ref.version, ref.index]); const parts = chunks.get(key) ?? []; parts.push(ref); chunks.set(key, parts); }
        for (const ref of Object.values(all).filter(r => r.kind === "item" && a.storeIds.includes(r.storeId))) {
          const texts = chunks.get(JSON.stringify(["text", ref.storeId, ref.id, ref.version, undefined])) ?? [];
          if (this.chunkLengthFromIndex(texts) !== ref.bodyTotal) fail("OUTLOOK_ARCHIVE_BODY_INCOMPLETE", 409);
          for (const attachment of ref.attachments ?? []) { const parts = chunks.get(JSON.stringify(["attachment", ref.storeId, ref.id, ref.version, attachment.index])) ?? []; if (this.chunkLengthFromIndex(parts) !== attachment.size || !parts.length) fail("OUTLOOK_ARCHIVE_ATTACHMENT_INCOMPLETE", 409); }
        }
      }
      for (const { ref, encrypted } of staged.values()) await atomicWriteFile(path.join(folder, "objects", `${ref.key}.json`), encrypted, { mode: 0o600 });
      s.readableItems = this.publishCompleteItems(all, s.readableItems);
      s.refs = all; s.bytesStored = projected; s.sequence = b.sequence; s.lastBatchHash = fingerprint; s.lastSyncedAt = new Date().toISOString(); s.checkpoint = b.checkpoint; if (b.checkpoint.phase === "caught_up") s.lastCompletedAt = s.lastSyncedAt;
      await this.writeState(a, folder, s); return { accepted: true, duplicate: false, sequence: s.sequence, archiveCoverage: this.coverage(s, a) };
    });
  }
  private publishCompleteItems(refs: Record<string, Ref>, previous: Record<string, Ref>) {
    const readable = { ...previous }, chunks = new Map<string, Ref[]>();
    for (const ref of Object.values(refs)) if (ref.kind === "text" || ref.kind === "attachment") {
      const key = JSON.stringify([ref.kind, ref.storeId, ref.itemId, ref.version, ref.index]), parts = chunks.get(key) ?? []; parts.push(ref); chunks.set(key, parts);
    }
    for (const [logicalKey, ref] of Object.entries(refs)) if (ref.kind === "item") {
      const texts = chunks.get(JSON.stringify(["text", ref.storeId, ref.id, ref.version, undefined])) ?? [];
      if (this.chunkLengthFromIndex(texts) !== ref.bodyTotal || texts.some(p => p.total !== ref.bodyTotal)) continue;
      let complete = true;
      for (const expected of ref.attachments ?? []) {
        const parts = chunks.get(JSON.stringify(["attachment", ref.storeId, ref.id, ref.version, expected.index])) ?? [];
        if (!parts.length || this.chunkLengthFromIndex(parts) !== expected.size || parts.some(p => p.total !== expected.size)) { complete = false; break; }
      }
      if (complete) readable[logicalKey] = ref;
    }
    return readable;
  }
  private async object(a: OutlookArchiveAuthority, folder: string, ref: Ref): Promise<OutlookArchiveRecord> { const data = await this.read(a, folder, `objects/${ref.key}.json`, MAX_RECORD * 2) as OutlookArchiveRecord; if (!data || hash(JSON.stringify(data)) !== ref.hash) fail("OUTLOOK_ARCHIVE_OBJECT_INVALID", 503); return data; }
  private chunkLengthFromIndex(refs: Ref[]) { let end = 0; for (const ref of refs.sort((x, y) => x.offset! - y.offset!)) { if (ref.offset !== end) return -1; end += ref.length ?? 0; } return end; }
  private async chunkLength(a: OutlookArchiveAuthority, folder: string, refs: Ref[], staged = new Map<string, { record: OutlookArchiveRecord }>()) { let end = 0; for (const ref of refs.sort((x, y) => x.offset! - y.offset!)) { if (ref.offset !== end) return -1; const data = staged.get(ref.key)?.record ?? await this.object(a, folder, ref); if (data.kind === "text") end += data.text.length; else if (data.kind === "attachment") end += Buffer.from(data.dataBase64, "base64").length; } return end; }
  async execute(a: OutlookArchiveAuthority, operation: OutlookDesktopOperation, input: unknown) {
    const args = normalizeOutlookDesktopOperationArgs(operation, input); if (!["stores.list", "folders.list", "items.search", "items.read", "attachments.read"].includes(operation)) fail("OUTLOOK_ARCHIVE_WRITES_REQUIRE_LIVE_OUTLOOK", 409);
    if (args.storeId && !a.storeIds.includes(String(args.storeId))) fail("OUTLOOK_ARCHIVE_STORE_DENIED", 403);
    return this.transaction(a, async (s, folder) => {
      // Keep the previous complete version visible while a newer metadata/body/attachment sequence is still arriving.
      const refs = [...Object.values(s.refs).filter(r => r.kind !== "item"), ...Object.values(s.readableItems)].filter(r => a.storeIds.includes(r.storeId)), archiveCoverage = this.coverage(s, a); let result: Record<string, unknown>;
      if (operation === "stores.list") { const roots = await Promise.all(refs.filter(r => r.kind === "folder").map(r => this.object(a, folder, r))); result = { stores: [...new Set(refs.map(r => r.storeId))].map(storeId => { const root = roots.find(r => r.kind === "folder" && r.storeId === storeId && r.parentId === null); return { storeId, name: root?.kind === "folder" ? root.name : storeId, rootFolderId: root?.kind === "folder" ? root.id : null, source: "archive" }; }) }; }
      else if (operation === "folders.list") { const all = await Promise.all(refs.filter(r => r.kind === "folder" && r.storeId === args.storeId).map(r => this.object(a, folder, r))); const root = all.find(r => r.kind === "folder" && r.parentId === null); const parent = args.parentId ?? (root?.kind === "folder" ? root.id : null); const folders = all.filter(r => r.kind === "folder" && r.parentId === parent); const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 25); result = { folders: folders.slice(offset, offset + limit).map(r => ({ ...r, folderId: "id" in r ? r.id : undefined, defaultItemType: r.kind === "folder" ? r.itemType : undefined })), total: folders.length, nextOffset: offset + limit < folders.length ? offset + limit : null }; }
      else if (operation === "items.search") {
        const scope = hash(JSON.stringify({ ...args, cursor: undefined })); let offset = 0; const now = Date.now(); for (const [key, value] of Object.entries(s.cursors)) if (value.expires < now) delete s.cursors[key];
        if (args.cursor) { const cursor = s.cursors[String(args.cursor)]; if (!cursor || cursor.scope !== scope || cursor.expires < now) fail("OUTLOOK_ARCHIVE_CURSOR_INVALID", 409); offset = cursor.offset; }
        const candidates = refs.filter(r => r.kind === "item" && r.storeId === args.storeId && (!args.folderId || r.folderId === args.folderId)).sort((x, y) => x.key.localeCompare(y.key)); const items: Record<string, unknown>[] = []; let scanned = 0;
        const classFor = { mail: 43, contact: 40, calendar: 26 };
        while (offset < candidates.length && scanned < 200 && items.length < Number(args.limit ?? 25)) {
          const ref = candidates[offset++]; scanned++; const item = await this.object(a, folder, ref); if (item.kind !== "item" || args.kind && Number(item.data.itemClass) !== classFor[args.kind as keyof typeof classFor]) continue;
          const data = item.data; const date = Date.parse(String(data.receivedAt ?? data.start ?? item.lastModified)), end = Date.parse(String(data.end ?? data.receivedAt ?? data.start ?? item.lastModified)); if (!data.isRecurring && (args.after && end < Date.parse(String(args.after)) || args.before && date > Date.parse(String(args.before)))) continue;
          if (args.from && !String(data.senderAddress ?? "").toLowerCase().includes(String(args.from).toLowerCase()) || args.to && !String(data.to ?? "").toLowerCase().includes(String(args.to).toLowerCase())) continue;
          if (args.query) { const q = String(args.query).toLowerCase(); let found = JSON.stringify(data).toLowerCase().includes(q); if (!found) { const parts = refs.filter(r => r.kind === "text" && r.storeId === ref.storeId && r.itemId === ref.id && r.version === ref.version).sort((x, y) => x.offset! - y.offset!); let tail = ""; for (const p of parts) { const body = await this.object(a, folder, p); if (body.kind !== "text") continue; if ((tail + body.text).toLowerCase().includes(q)) { found = true; break; } tail = body.text.slice(-q.length); } } if (!found) continue; }
          const summary = { ...data }; delete summary.body; delete summary.attachments; items.push({ ...summary, entryId: ref.id, storeId: ref.storeId, snapshotVersion: ref.version, newerVersionPending: s.refs[hash(JSON.stringify(["item", ref.storeId, ref.id]))]?.hash !== ref.hash });
        }
        let cursor: string | null = null; if (offset < candidates.length) { if (Object.keys(s.cursors).length >= 100) fail("OUTLOOK_ARCHIVE_CURSOR_LIMIT", 429); cursor = randomBytes(16).toString("hex"); s.cursors[cursor] = { scope, offset, expires: now + 24 * 3600000 }; } await this.writeState(a, folder, s); result = { items, cursor, scanned, complete: !cursor && archiveCoverage.coverage.phase === "caught_up" && !archiveCoverage.coverage.errors.length && !(args.kind === "calendar" && (args.after || args.before)), queryExhausted: !cursor, calendarOccurrencesComplete: false, recurrenceExpanded: false, calendarCoverage: "series-masters-and-saved-exceptions" };
      } else {
        const ref = refs.find(r => r.kind === "item" && r.storeId === args.storeId && r.id === args.entryId); if (!ref) { if (Object.values(s.refs).some(r => r.kind === "item" && r.storeId === args.storeId && r.id === args.entryId)) fail("OUTLOOK_ARCHIVE_ITEM_INCOMPLETE", 409); fail("OUTLOOK_ARCHIVE_ITEM_NOT_REPLICATED", 404); } const item = await this.object(a, folder, ref!); if (item.kind !== "item") fail();
        if (args.occurrenceStartUtc) fail("OUTLOOK_ARCHIVE_OCCURRENCE_REQUIRES_LIVE_EXPANSION", 409);
        if (operation === "items.read") { const total = Number((item.data.body as Record<string, unknown>).total), offset = Number(args.bodyOffset ?? 0), limit = Number(args.bodyLimit ?? 16000); if (offset > total) fail(); const end = Math.min(total, offset + limit); const parts = refs.filter(r => r.kind === "text" && r.storeId === ref!.storeId && r.itemId === ref!.id && r.version === ref!.version && r.offset! < end).sort((x, y) => x.offset! - y.offset!); let body = "", expected = offset; for (const p of parts) { const v = await this.object(a, folder, p); if (v.kind !== "text") continue; const from = Math.max(offset, v.offset), to = Math.min(end, v.offset + v.text.length); if (to <= from) continue; if (from !== expected) fail("OUTLOOK_ARCHIVE_BODY_INCOMPLETE", 409); body += v.text.slice(from - v.offset, to - v.offset); expected = to; } if (expected !== end) fail("OUTLOOK_ARCHIVE_BODY_INCOMPLETE", 409); result = { ...item.data, entryId: ref!.id, storeId: ref!.storeId, body: { text: body, offset, total, nextOffset: end < total ? end : null }, snapshotVersion: ref!.version, newerVersionPending: s.refs[hash(JSON.stringify(["item", ref!.storeId, ref!.id]))]?.hash !== ref!.hash }; }
        else { const parts = refs.filter(r => r.kind === "attachment" && r.storeId === ref!.storeId && r.itemId === ref!.id && r.version === ref!.version && r.index === args.index).sort((x, y) => x.offset! - y.offset!); if (!parts.length || await this.chunkLength(a, folder, parts) !== parts[0].total) fail("OUTLOOK_ARCHIVE_ATTACHMENT_INCOMPLETE", 409); const bytes: Buffer[] = [], h = createHash("sha256"); for (const part of parts) { const v = await this.object(a, folder, part); if (v.kind !== "attachment") fail(); const b = Buffer.from(v.dataBase64, "base64"); h.update(b); bytes.push(b); } if (h.digest("hex") !== parts[0].sha256) fail("OUTLOOK_ARCHIVE_ATTACHMENT_HASH_MISMATCH", 503); const total = parts[0].total!, offset = Number(args.offset ?? 0); if (offset > total) fail(); const end = Math.min(total, offset + Number(args.length ?? 1048576)); result = { filename: parts[0].filename, contentType: "application/octet-stream", dataBase64: Buffer.concat(bytes).subarray(offset, end).toString("base64"), totalSize: total, offset, nextOffset: end < total ? end : null, sha256: parts[0].sha256, snapshotVersion: ref!.version, newerVersionPending: s.refs[hash(JSON.stringify(["item", ref!.storeId, ref!.id]))]?.hash !== ref!.hash }; }
      }
      return { operationId: hash(JSON.stringify(["archive", a.userId, operation, args, s.lastSyncedAt])), operation, status: "succeeded" as const, result: { ...result!, archiveCoverage, sourceChanged: false } };
    });
  }
}
