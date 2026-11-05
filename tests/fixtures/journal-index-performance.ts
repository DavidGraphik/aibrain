import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { FileJournal } from "../../src/storage/journal";
import { ResourceLockManager } from "../../src/storage/resource-lock";
import type { StorageSchema } from "../../src/storage/schema";

type Payload = { id: string; sequence: number; body: string };
const root = process.env.JOURNAL_PERFORMANCE_ROOT ?? await mkdtemp(path.join(tmpdir(), "aibrain-journal-index-performance-"));
let parsed = 0;
const schema: StorageSchema<Payload> = { name: "IndexBenchmark", parse(value) {
  parsed += 1; const p = value as Payload;
  if (!p || typeof p.id !== "string" || !Number.isSafeInteger(p.sequence) || typeof p.body !== "string") throw Error("invalid");
  return p;
} };
try {
  await mkdir(root, { recursive: true });
  const filePath = path.join(root, "events.jsonl"), out = await open(filePath, "w");
  try {
    for (let i = 1; i <= 64; i += 1) await out.writeFile(JSON.stringify({ schemaVersion: 1, sequence: i,
      eventId: randomUUID(), recordedAt: "2026-10-26T00:00:00.000Z",
      payload: { id: `id-${i}`, sequence: i, body: "x".repeat(1024 * 1024) } }) + "\n");
  } finally { await out.close(); }
  const journal = new FileJournal({ filePath, payloadSchema: schema, keyOf: p => p.id,
    contiguousPayloadSequence: p => p.sequence,
    lockManager: new ResourceLockManager({ rootDirectory: path.join(root, "locks") }) });
  // The previous implementation exposes findLast; compare the same lookup,
  // append and no-op retention workload against that exact revision.
  const indexed = typeof journal.findLastByKey === "function";
  const lookup = () => indexed ? journal.findLastByKey("id-32") : journal.findLast(p => p.id === "id-32");
  await lookup(); parsed = 0;
  let started = performance.now();
  for (let i = 0; i < 16; i += 1) assert.equal((await lookup())?.payload.id, "id-32");
  const lookupMs = Math.round(performance.now() - started), lookupParses = parsed;
  parsed = 0; started = performance.now();
  for (let i = 65; i <= 72; i += 1) {
    const p = { id: `id-${i}`, sequence: i, body: "small" };
    if (indexed) await journal.appendIndexed(p, (existing, last) => { assert.equal(existing, null); assert.equal(last, i - 1); return true; });
    else await journal.appendScanned(p, () => undefined, last => { assert.equal(last?.sequence, i - 1); return true; });
  }
  const appendMs = Math.round(performance.now() - started), appendParses = parsed;
  parsed = 0; started = performance.now();
  for (let i = 0; i < 16; i += 1) assert.equal((await journal.compactContiguousTail({ anchorSequence: 1,
    maxRetainedEntries: 2, maxRetainedBytes: 1024, minimumEntries: 0, minimumRemovedEntries: 1 })).changed, false);
  console.log(JSON.stringify({ outcome: "PASS", indexed, fixtureBytes: (await stat(filePath)).size,
    lookupMs, lookupParses, appendMs, appendParses,
    retentionMs: Math.round(performance.now() - started), retentionParses: parsed,
    peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
} finally { await rm(root, { recursive: true, force: true }); }
