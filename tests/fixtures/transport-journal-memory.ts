// Synthetic subprocess acceptance: no company data and no external connections.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { AppServerEvent } from "@/runtime/transport/contracts";
import { FileTransportEventJournal } from "@/runtime/transport/file-event-journal";
import { ResourceLockManager } from "@/storage/resource-lock";

const root = process.env.JOURNAL_MEMORY_ROOT ?? await realpath(await mkdtemp(path.join(tmpdir(), "aibrain-bounded-transport-")));
function event(sequence: number): AppServerEvent {
  return { eventId: `event-${sequence}`, sequence, occurredAt: "2026-10-26T00:00:00.000Z",
    message: { kind: "rpc-notification", rpc: { method: "warning", params: {
      threadId: null, message: String(sequence).padStart(6, "0") + "x".repeat(sequence === 80 ? 8 * 1024 * 1024 : 1024 * 1024),
    } } } };
}
try {
  const filePath = path.join(root, "events.jsonl");
  await mkdir(root, { recursive: true });
  const handle = await open(filePath, "w");
  try {
    for (let sequence = 1; sequence <= 160; sequence += 1) {
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, sequence,
        eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        recordedAt: "2026-10-26T00:00:00.000Z", payload: event(sequence) }) + "\n");
    }
    await handle.sync();
  } finally { await handle.close(); }
  const originalBytes = (await stat(filePath)).size;
  const options = { filePath, lockManager: new ResourceLockManager({ rootDirectory: path.join(root, "locks") }),
    maxRetainedDeliveredBytes: 1024, maxRetainedDeliveredEvents: 2 };
  const journal = new FileTransportEventJournal(options);
  assert.equal((await journal.loadCursor())?.sequence, 160);
  assert.equal(await journal.append(event(161)), true);
  assert.equal(await journal.append(event(161)), false);
  await journal.reconcileDeliveryCursor("event-78", 78);
  // Every unacknowledged event, including the one larger than the page budget,
  // must remain intact across compaction and a completely fresh instance.
  const restarted = new FileTransportEventJournal(options);
  const seen: number[] = [];
  let after = 78, pages = 0;
  for (;;) {
    const page = await restarted.readUndelivered(256, after);
    if (!page.length) break;
    pages += 1;
    assert.ok(page.length <= 3, "byte-bounded pages must not retain a whole backlog");
    for (const source of page) {
      assert.equal(source.sequence, after + 1);
      assert.deepEqual(source, event(source.sequence));
      seen.push(source.sequence); after = source.sequence;
    }
  }
  assert.deepEqual(seen, Array.from({ length: 83 }, (_, index) => index + 79));
  await restarted.reconcileDeliveryCursor("event-161", 161);
  assert.equal((await restarted.loadCursor())?.sequence, 161);
  assert.deepEqual(await restarted.readUndelivered(256), []);
  assert.equal((await restarted.readEvents()).length, 1);
  assert.ok((await stat(filePath)).size < 2 * 1024 * 1024);
  console.log(JSON.stringify({ outcome: "PASS", originalBytes, pages, verifiedPendingEvents: seen.length,
    heapLimitMiB: 128, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
} finally { await rm(root, { recursive: true, force: true }); }
