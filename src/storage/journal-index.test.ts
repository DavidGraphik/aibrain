import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { FileJournal } from "./journal";
import { ResourceLockManager } from "./resource-lock";
import type { StorageSchema } from "./schema";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("indexes validated large records once and keeps lookups/appends incremental", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-journal-index-")); roots.push(root);
  const filePath = path.join(root, "events.jsonl");
  type Payload = { id: string; sequence: number; body: string };
  let parsed = 0;
  const schema: StorageSchema<Payload> = { name: "IndexedFixture", parse(value) {
    parsed += 1;
    const p = value as Payload;
    if (!p || typeof p.id !== "string" || !Number.isSafeInteger(p.sequence) || typeof p.body !== "string") throw Error("invalid");
    return p;
  } };
  const record = (sequence: number, body = "x".repeat(512 * 1024)) => ({ schemaVersion: 1, sequence,
    eventId: randomUUID(), recordedAt: "2026-10-26T00:00:00.000Z", payload: { id: `id-${sequence}`, sequence, body } });
  await mkdir(root, { recursive: true });
  const out = await open(filePath, "w");
  try { for (let i = 1; i <= 32; i += 1) await out.writeFile(JSON.stringify(record(i)) + "\n"); }
  finally { await out.close(); }
  const journal = new FileJournal({ filePath, payloadSchema: schema, keyOf: p => p.id,
    contiguousPayloadSequence: p => p.sequence,
    lockManager: new ResourceLockManager({ rootDirectory: path.join(root, "locks") }) });
  expect((await journal.findLastByKey("id-16"))?.payload.sequence).toBe(16);
  expect(parsed).toBe(33); // one cold verification, then the selected record
  parsed = 0;
  for (let i = 0; i < 16; i += 1) expect((await journal.findLastByKey("id-16"))?.payload.id).toBe("id-16");
  expect(parsed).toBe(16);
  parsed = 0;
  for (let i = 0; i < 16; i += 1) {
    expect(await journal.compactContiguousTail({ anchorSequence: 1, maxRetainedEntries: 2,
      maxRetainedBytes: 1024, minimumEntries: 0, minimumRemovedEntries: 1 })).toMatchObject({ changed: false });
  }
  expect(parsed).toBe(0); // byte offsets decide a no-op compaction without rescanning payloads
  parsed = 0;
  const next = { id: "id-33", sequence: 33, body: "small" };
  await journal.appendIndexed(next, (existing, last) => { expect(existing).toBeNull(); expect(last).toBe(32); return true; });
  expect(parsed).toBeLessThan(5);
  expect((await journal.findLastByKey("id-33"))?.payload).toEqual(next);
  // A same-size external change invalidates the fingerprint and cannot hide
  // corrupt records outside the selected key or the new append position.
  const text = await readFile(filePath, "utf8");
  await writeFile(filePath, text.replace('"sequence":1,', '"sequence":0,'));
  await expect(journal.findLastByKey("id-33")).rejects.toThrow("invalid complete journal record");
  await expect(journal.appendIndexed({ id: "id-34", sequence: 34, body: "small" }, () => true)).rejects.toThrow();
});

it("tracks the latest keyed receipt and reindexes after a prefix rewrite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-journal-index-rewrite-")); roots.push(root);
  type Receipt = { id: string; value: string };
  const schema: StorageSchema<Receipt> = { name: "Receipt", parse: value => value as Receipt };
  const journal = new FileJournal({ filePath: path.join(root, "receipts.jsonl"), payloadSchema: schema,
    keyOf: p => p.id, lockManager: new ResourceLockManager({ rootDirectory: path.join(root, "locks") }) });
  await journal.append({ id: "create", value: "accepted" });
  await journal.append({ id: "create", value: "completed" });
  await journal.append({ id: "uncertain", value: "accepted" });
  expect((await journal.findLastByKey("create"))?.payload.value).toBe("completed");
  await journal.compactSelected(async () => new Set([2, 3]));
  expect((await journal.findLastByKey("create"))?.sequence).toBe(1);
  expect((await journal.findLastByKey("uncertain"))?.payload.value).toBe("accepted");
  expect(await journal.findLastByKey("missing")).toBeNull();
});
