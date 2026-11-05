import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { InstallationConfig } from "@/config/installation-schema";
import { FileOutlookArchiveStore, type OutlookArchiveAuthority, type OutlookArchiveBatch, type OutlookArchiveRecord } from "./outlook-archive-store";
vi.mock("server-only", () => ({}));
const faults = vi.hoisted(() => ({ failIndex: false }));
vi.mock("@/storage", async importOriginal => { const original = await importOriginal<typeof import("@/storage")>(); return { ...original, atomicWriteFile: async (...args: Parameters<typeof original.atomicWriteFile>) => { if (faults.failIndex && args[0].endsWith("index.json")) throw new Error("SIMULATED_INTERRUPTION_AFTER_OBJECT_FSYNC"); return original.atomicWriteFile(...args); } }; });
let root: string, config: InstallationConfig, store: FileOutlookArchiveStore;
const a: OutlookArchiveAuthority = { userId: "11111111-1111-4111-8111-111111111111", deviceId: "device-one", storeIds: ["STORE"] };
const b: OutlookArchiveAuthority = { userId: "22222222-2222-4222-8222-222222222222", deviceId: "device-two", storeIds: ["OTHER"] };
const epoch = "11111111-1111-4111-8111-111111111111", version = "a".repeat(64);
const h = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const body = "historical confidential mail 2009";
const item = (id = "OLD", data: Record<string, unknown> = {}): OutlookArchiveRecord => ({ kind: "item", storeId: "STORE", id, folderId: "FOLDER", version, lastModified: "2026-10-20T10:00:00Z", data: { itemClass: 43, subject: "Past project", receivedAt: "2009-04-10T00:00:00Z", senderAddress: "person@example.test", body: { total: body.length }, attachments: [], ...data } });
const textRecord = (id = "OLD"): OutlookArchiveRecord => ({ kind: "text", storeId: "STORE", itemId: id, version, offset: 0, totalChars: body.length, text: body });
const batch = (sequence: number, records: OutlookArchiveRecord[], complete = false): OutlookArchiveBatch => ({ schema: 1, epoch, sequence, records, checkpoint: { phase: complete ? "caught_up" : "backfill", errors: [], scannedItems: complete ? 1 : 0, expectedItems: complete ? 1 : null } });
beforeEach(async () => { faults.failIndex = false; root = await mkdtemp(path.join(os.tmpdir(), "outlook-archive-")); config = { installationId: "g03-production", paths: { dataRoot: root, usersRoot: path.join(root, "users") } } as InstallationConfig; for (const x of [a, b]) await mkdir(path.join(config.paths.usersRoot, x.userId), { recursive: true, mode: 0o700 }); store = new FileOutlookArchiveStore(config, Buffer.alloc(32, 7), { freeBytes: async () => 30 * 1024 ** 3 }); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function seed(records = [item(), textRecord()]) { await store.configure(a, 10 * 1024 * 1024); await store.ingest(a, batch(1, records, true)); }
describe("always available encrypted Outlook read replica", () => {
  it("keeps complete historical body searchable/readable after the paired PC is off, with truthful freshness", async () => {
    await seed(); const status = await store.status(a); expect(status).toMatchObject({ availableWithComputerOff: true, replicatedItems: 1, localChangesAfterLastSyncUnavailable: true, currentStateVerified: false, deletedItemsMayRemain: true, coverage: { phase: "caught_up" } }); expect(status.lastCompletedAt).toBeTruthy();
    const search = await store.execute(a, "items.search", { storeId: "STORE", query: "confidential", kind: "mail" }); expect(search).toMatchObject({ status: "succeeded", result: { items: [{ entryId: "OLD" }], complete: true, archiveCoverage: { lastSyncedAt: status.lastSyncedAt } } });
    expect(await store.execute(a, "items.read", { storeId: "STORE", entryId: "OLD", bodyOffset: 11, bodyLimit: 12 })).toMatchObject({ result: { body: { text: body.slice(11, 23), total: body.length, nextOffset: 23 } } });
    const folder = path.join(config.paths.usersRoot, a.userId, "connectors/outlook-archive");
    const files = ["index.json", ...(await readdir(path.join(folder, "objects"))).map(file => `objects/${file}`)];
    for (const file of files) {
      const raw = await readFile(path.join(folder, file), "utf8"), encrypted = JSON.parse(raw);
      expect(encrypted).toEqual({ v: 1, iv: expect.any(String), tag: expect.any(String), ciphertext: expect.any(String) });
      expect(Buffer.from(encrypted.iv, "base64")).toHaveLength(12);
      expect(Buffer.from(encrypted.tag, "base64")).toHaveLength(16);
      expect(Buffer.from(encrypted.ciphertext, "base64").toString("base64")).toBe(encrypted.ciphertext);
      // Base64 ciphertext can contain OLD by chance; a plaintext JSON identifier or body cannot appear.
      expect(raw).not.toContain(JSON.stringify("OLD"));
      expect(raw).not.toContain(JSON.stringify(body));
    }
  });
  it("requires operator capacity review, per-user quota and 15GiB physical floor before any copy", async () => {
    await expect(store.ingest(a, batch(1, [item()]))).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_CAPACITY_REVIEW_REQUIRED" }); await store.configure(a, 50); await expect(store.ingest(a, batch(1, [item()]))).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_QUOTA_EXCEEDED" });
    await store.configure(a, 10 * 1024 ** 2); const low = new FileOutlookArchiveStore(config, Buffer.alloc(32, 7), { freeBytes: async () => 15 * 1024 ** 3 }); await expect(low.ingest(a, batch(1, [item()]))).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_DISK_RESERVE" }); expect((await store.status(a)).replicatedItems).toBe(0);
  });
  it("binds users/stores/tenant/device epochs and replay hashes, including concurrent retries", async () => {
    await store.configure(a, 10 * 1024 ** 2); const request = batch(1, [item(), textRecord()], true); const replies = await Promise.all([store.ingest(a, request), store.ingest(a, request)]); expect(replies.map(r => r.duplicate).sort()).toEqual([false, true]);
    await expect(store.ingest(a, { ...request, checkpoint: { ...request.checkpoint, scannedItems: 2, expectedItems: 2 } })).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_BATCH_REPLAY_CHANGED" }); await expect(store.ingest(a, batch(3, []))).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_SEQUENCE_MISMATCH" });
    await expect(store.ingest(b, request)).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_STORE_DENIED" }); await expect(store.execute(b, "items.read", { storeId: "STORE", entryId: "OLD" })).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_STORE_DENIED" }); expect((await store.status(b)).availableWithComputerOff).toBe(false);
    await expect(store.ingest({ ...a, deviceId: "replacement" }, batch(2, []))).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_NEW_EPOCH_REQUIRES_SEQUENCE_ONE" }); const other = new FileOutlookArchiveStore({ ...config, installationId: "company-qa" }, Buffer.alloc(32, 7)); await expect(other.status(a)).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_IDENTITY_INVALID" });
  });
  it("never asserts completion for missing body/attachment bytes or failed/partial scans", async () => {
    await store.configure(a, 10 * 1024 ** 2); await expect(store.ingest(a, batch(1, [item()], true))).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_BODY_INCOMPLETE" });
    await store.ingest(a, batch(1, [item()])); await expect(store.execute(a, "items.read", { storeId: "STORE", entryId: "OLD" })).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_ITEM_INCOMPLETE" });
    await expect(store.ingest(a, batch(2, [textRecord(), item("OLD", { attachments: [{ index: 1, size: 3, filename: "photo.png" }] })], true))).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_ATTACHMENT_INCOMPLETE" });
    const partial = batch(2, [textRecord()]); partial.checkpoint = { phase: "blocked", errors: ["ACCESS_DENIED"], scannedItems: 1, expectedItems: 2 }; await store.ingest(a, partial); expect(await store.execute(a, "items.search", { storeId: "STORE", query: "absent" })).toMatchObject({ result: { items: [], complete: false, archiveCoverage: { coverage: { errors: ["ACCESS_DENIED"] } } } });
  });
  it("streams attachment originals in contiguous chunks and verifies the full hash before publication", async () => {
    const original = Buffer.from("original picture bytes with exact checksum"), data = item("OLD", { body: { total: 0 }, attachments: [{ index: 1, size: original.length, filename: "image.png" }] }); await store.configure(a, 10 * 1024 ** 2); await store.ingest(a, batch(1, [data]));
    const part = (offset: number, bytes: Buffer): OutlookArchiveRecord => ({ kind: "attachment", storeId: "STORE", itemId: "OLD", version, index: 1, offset, totalBytes: original.length, sha256: h(original), filename: "image.png", dataBase64: bytes.toString("base64") });
    await expect(store.ingest(a, batch(2, [part(3, original.subarray(3))]))).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_CHUNK_SEQUENCE_INVALID" }); await store.ingest(a, batch(2, [part(0, original.subarray(0, 10))])); await expect(store.execute(a, "attachments.read", { storeId: "STORE", entryId: "OLD", index: 1 })).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_ITEM_INCOMPLETE" });
    const corrupt = part(10, original.subarray(10)); if (corrupt.kind !== "attachment") throw new Error(); corrupt.dataBase64 = Buffer.alloc(original.length - 10).toString("base64"); await expect(store.ingest(a, batch(3, [corrupt], true))).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_ATTACHMENT_HASH_MISMATCH" });
    await store.ingest(a, batch(3, [part(10, original.subarray(10))], true)); const read = await store.execute(a, "attachments.read", { storeId: "STORE", entryId: "OLD", index: 1, offset: 4, length: 9 }); expect(read.result).toMatchObject({ dataBase64: original.subarray(4, 13).toString("base64"), sha256: h(original), totalSize: original.length, nextOffset: 13 });
  });
  it("preserves the previous readable object when a new immutable version cannot commit its index", async () => {
    await seed(); const next = item(); if (next.kind !== "item") throw new Error(); next.version = "b".repeat(64); next.data.body = { total: 9 }; await expect(store.ingest(a, batch(2, [next], true))).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_BODY_INCOMPLETE" }); expect(await store.execute(a, "items.read", { storeId: "STORE", entryId: "OLD" })).toMatchObject({ result: { body: { text: body }, snapshotVersion: version } });
  });
  it("publishes each version only after every body and attachment chunk, preserving the previous complete read during PC shutdown", async () => {
    const firstBytes = Buffer.from("old-photo"), nextBytes = Buffer.from("new-photo-original"), nextBody = "updated body from the user's Outlook", nextVersion = "b".repeat(64);
    const attachment = (v: string, bytes: Buffer, offset = 0, end = bytes.length): OutlookArchiveRecord => ({ kind: "attachment", storeId: "STORE", itemId: "OLD", version: v, index: 1, offset, totalBytes: bytes.length, sha256: h(bytes), filename: "photo.png", dataBase64: bytes.subarray(offset, end).toString("base64") });
    await seed([item("OLD", { attachments: [{ index: 1, size: firstBytes.length, filename: "photo.png" }] }), textRecord(), attachment(version, firstBytes)]);
    const next = item("OLD", { subject: "Updated subject", body: { total: nextBody.length }, attachments: [{ index: 1, size: nextBytes.length, filename: "photo.png" }] }); if (next.kind !== "item") throw new Error(); next.version = nextVersion;
    await store.ingest(a, batch(2, [next]));
    expect(await store.status(a)).toMatchObject({ availableWithComputerOff: true, replicatedItems: 1, pendingItems: 1 });
    const oldRead = () => store.execute(a, "items.read", { storeId: "STORE", entryId: "OLD" });
    expect(await oldRead()).toMatchObject({ result: { subject: "Past project", body: { text: body }, snapshotVersion: version, newerVersionPending: true } });
    expect(await store.execute(a, "attachments.read", { storeId: "STORE", entryId: "OLD", index: 1 })).toMatchObject({ result: { dataBase64: firstBytes.toString("base64"), sha256: h(firstBytes) } });
    const textPart = (offset: number, end: number): OutlookArchiveRecord => ({ kind: "text", storeId: "STORE", itemId: "OLD", version: nextVersion, offset, totalChars: nextBody.length, text: nextBody.slice(offset, end) });
    await store.ingest(a, batch(3, [textPart(0, 8)])); expect(await oldRead()).toMatchObject({ result: { body: { text: body }, snapshotVersion: version } });
    expect(await store.execute(a, "items.search", { storeId: "STORE", query: "confidential" })).toMatchObject({ result: { items: [{ entryId: "OLD", snapshotVersion: version }] } });
    expect(await store.execute(a, "items.search", { storeId: "STORE", query: "Updated subject" })).toMatchObject({ result: { items: [] } });
    await store.ingest(a, batch(4, [textPart(8, nextBody.length), attachment(nextVersion, nextBytes, 0, 5)])); expect(await oldRead()).toMatchObject({ result: { body: { text: body }, snapshotVersion: version } });
    // The device can disappear at every prior checkpoint; only this durable
    // final original byte fragment atomically switches the readable pointer.
    await store.ingest(a, batch(5, [attachment(nextVersion, nextBytes, 5)]));
    expect(await oldRead()).toMatchObject({ result: { subject: "Updated subject", body: { text: nextBody }, snapshotVersion: nextVersion, newerVersionPending: false } }); expect(await store.status(a)).toMatchObject({ replicatedItems: 1, pendingItems: 0 });
    expect(await store.execute(a, "attachments.read", { storeId: "STORE", entryId: "OLD", index: 1 })).toMatchObject({ result: { dataBase64: nextBytes.toString("base64"), sha256: h(nextBytes) } });
  });
  it("survives interruption after immutable object persistence and retries the uncommitted sequence", async () => {
    await seed(); const next = item(); if (next.kind !== "item") throw new Error(); next.version = "b".repeat(64); next.data.body = { total: 0 }; next.data.subject = "New revision";
    faults.failIndex = true; await expect(store.ingest(a, batch(2, [next], true))).rejects.toThrow("SIMULATED_INTERRUPTION"); faults.failIndex = false;
    expect(await store.execute(a, "items.read", { storeId: "STORE", entryId: "OLD" })).toMatchObject({ result: { body: { text: body }, snapshotVersion: version } });
    await store.ingest(a, batch(2, [next], true)); expect(await store.execute(a, "items.read", { storeId: "STORE", entryId: "OLD" })).toMatchObject({ result: { subject: "New revision", body: { text: "" }, snapshotVersion: next.version } });
  });
  it("invalidates stale scope/epoch claims without erasing the existing archive", async () => {
    await seed(); await expect(store.ingest(a, { ...batch(1, []), epoch: "22222222-2222-4222-8222-222222222222" })).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_EPOCH_REPLACEMENT_REQUIRES_REENROLL" });
    const changed = { ...a, storeIds: ["STORE", "NEW-STORE"] }; expect((await store.status(changed)).coverage).toMatchObject({ phase: "blocked", errors: ["PAIRED_STORE_SCOPE_CHANGED"] }); expect(await store.execute(changed, "items.search", { storeId: "STORE" })).toMatchObject({ result: { complete: false } });
  });
  it("retains replicated records after a partial scan and never converts absence into deletion", async () => {
    await seed(); await store.ingest(a, batch(2, [])); expect(await store.execute(a, "items.read", { storeId: "STORE", entryId: "OLD" })).toMatchObject({ result: { body: { text: body } } }); expect((await store.status(a)).lastCompletedAt).toBeTruthy();
    await expect(store.execute(a, "mail.send", { storeId: "STORE", entryId: "OLD", expectedFingerprint: "a".repeat(64) })).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_WRITES_REQUIRE_LIVE_OUTLOOK" });
  });
  it("exposes contacts and recurring calendar masters with saved exceptions without inventing occurrences", async () => {
    await seed([item("CONTACT", { itemClass: 40, fullName: "Person", Email1Address: "a@example.test", body: { total: 0 } }), item("SERIES", { itemClass: 26, body: { total: 0 }, isRecurring: true, start: "2009-01-01T00:00:00Z", recurrence: { noEndDate: true, exceptions: [{ originalDate: "2026-10-21T10:00:00Z", deleted: true }] } })]);
    expect(await store.execute(a, "items.search", { storeId: "STORE", kind: "calendar", after: "2026-10-20T00:00:00Z", before: "2026-10-30T00:00:00Z" })).toMatchObject({ result: { items: [{ entryId: "SERIES", recurrence: { noEndDate: true } }], recurrenceExpanded: false } }); expect(await store.execute(a, "items.search", { storeId: "STORE", kind: "contact", query: "a@example.test" })).toMatchObject({ result: { items: [{ entryId: "CONTACT" }] } });
    await expect(store.execute(a, "items.read", { storeId: "STORE", entryId: "SERIES", occurrenceStartUtc: "2026-10-21T10:00:00Z" })).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_OCCURRENCE_REQUIRES_LIVE_EXPANSION" });
  });
  it("rejects symlinks, world-readable storage and substituted cross-user encrypted objects", async () => {
    await seed(); const folder = path.join(config.paths.usersRoot, a.userId, "connectors/outlook-archive"); const file = path.join(folder, "index.json"); await chmod(file, 0o644); await expect(store.status(a)).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_STORAGE_INVALID" }); await chmod(file, 0o600);
    await rm(file); const foreign = path.join(root, "foreign.json"); await writeFile(foreign, "{}", { mode: 0o600 }); await symlink(foreign, file); await expect(store.status(a)).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_STORAGE_UNSAFE" });
  });
});
