import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerEvent, AppServerTransport } from "@/runtime/transport/contracts";
import { AppServerRpcRouter } from "@/runtime/transport/app-server-rpc-router";
import { FileTransportEventJournal } from "@/runtime/transport/file-event-journal";
import * as atomicFile from "@/storage/atomic-file";
import { FileJournal } from "@/storage/journal";
import { ResourceLockManager } from "@/storage/resource-lock";

const roots: string[] = [];

async function createJournal() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "aibrain-transport-journal-")));
  roots.push(root);
  return new FileTransportEventJournal({
    filePath: path.join(root, "transport", "events.jsonl"),
    lockManager: new ResourceLockManager({ rootDirectory: path.join(root, "locks") }),
  });
}

async function createCompactJournal(retained: number) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "aibrain-transport-compact-")));
  roots.push(root);
  return new FileTransportEventJournal({
    filePath: path.join(root, "transport", "events.jsonl"),
    lockManager: new ResourceLockManager({ rootDirectory: path.join(root, "locks") }),
    maxRetainedDeliveredEvents: retained,
  });
}

function event(sequence: number, eventId = `event-${sequence}`): AppServerEvent {
  return {
    eventId,
    sequence,
    occurredAt: "2026-08-27T00:00:00.000Z",
    message: {
      kind: "rpc-notification",
      rpc: { method: "warning", params: { threadId: null, message: `event ${sequence}` } },
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file transport event journal", () => {
  it("drains a persisted replay with a tail tool through bounded contiguous durable batches", async () => {
    const journal = await createJournal();
    const events = Array.from({length:1025},(_,index)=>event(index+1));
    events[1024]={...event(1025),message:{kind:"rpc-request",rpc:{id:0,method:"item/tool/call",params:{
      threadId:"synthetic",turnId:"turn",callId:"one",namespace:"synthetic",tool:"effect",arguments:{},
    }}}};
    // Synthetic source fixture only, under 1MB. Normal journal validation and
    // indexing still run; do not spend 1025 fsyncs preparing a replay test.
    const {mkdir}=await import("node:fs/promises");
    await mkdir(path.dirname(journal.filePath),{recursive:true,mode:0o700});
    await writeFile(journal.filePath,events.map((payload,index)=>JSON.stringify({schemaVersion:1,sequence:index+1,
      eventId:randomUUID(),recordedAt:payload.occurredAt,payload})).join("\n")+"\n",{mode:0o600});
    let yielded=0;
    let stop!:()=>void;
    const stopped=new Promise<void>(resolve=>{stop=resolve;});
    const transport:AppServerTransport={
      connect:async()=>{},send:async()=>{},deliverySequenceStart:()=>1,projectionSequenceTarget:()=>1025,
      async *events(){let after=0;while(after<1025){
        const page=await journal.readUndelivered(256,after);
        for(const event of page){after=event.sequence;yielded++;yield event;}
      }await stopped;},
      acknowledgeBatch:events=>journal.markDeliveredBatch(events),
      health:async()=>({healthy:true,state:"connected",endpoint:"synthetic",reconnectAttempt:0,pendingRequests:0,
        lastEventId:"event-1025",lastEventSequence:1025,lastConnectedAt:null,lastMessageAt:null,lastHeartbeatAt:null,lastError:null}),
      close:async()=>{stop();},
    };
    const writes=vi.spyOn(atomicFile,"atomicWriteJson");
    const effect=vi.fn(async()=>({ok:true}));
    const router=new AppServerRpcRouter(transport);
    router.registerTurn("synthetic","local",{onNotification:vi.fn(),onServerRequest:effect,onFailure:vi.fn()}).bindRuntimeTurn("turn");
    const start=performance.now();
    await router.start();
    await expect(router.assertProjectionReady()).rejects.toMatchObject({name:"RuntimeProjectionAdmissionDeferred"});
    try {
      await vi.waitFor(async()=>expect(await journal.loadDeliveryCursor()).toMatchObject({sequence:1025}),{timeout:2000,interval:10});
    } catch(error) {
      console.log(JSON.stringify({fixtureFailure:true,yielded,routerFailed:router.failed,cursor:await journal.loadDeliveryCursor(),
        writes:writes.mock.calls.filter(([file])=>file===`${journal.filePath}.delivery.json`).map(([,cursor])=>cursor),effects:effect.mock.calls.length}));
      await router.close();await transport.close();throw error;
    }
    const durableWrites=writes.mock.calls.filter(([file])=>file===`${journal.filePath}.delivery.json`).length;
    process.stdout.write(JSON.stringify({fixture:"persisted 1024 history + tail tool",elapsedMs:Math.round(performance.now()-start),durableWrites})+"\n");
    expect(durableWrites).toBeLessThanOrEqual(16);expect(effect).toHaveBeenCalledOnce();
    await vi.waitFor(()=>router.assertProjectionReady(),{timeout:2000,interval:10});
    expect(await journal.readUndelivered(10)).toEqual([]);
    expect((await journal.readEvents()).at(-1)?.sequence).toBe(1025);
    await router.close();await transport.close();
  });
  it("commits one validated contiguous batch, rejects any middle mismatch, and resumes after restart", async () => {
    const journal = await createJournal();
    for (let sequence=1; sequence<=8; sequence++) await journal.append(event(sequence));
    const originalWrite = atomicFile.atomicWriteJson;
    const writes = vi.spyOn(atomicFile,"atomicWriteJson");
    await expect(journal.markDeliveredBatch([event(1),event(3)])).rejects.toThrow("expected sequence 2");
    await expect(journal.markDeliveredBatch([event(1),event(2,"foreign")])).rejects.toThrow("absent");
    expect(await journal.loadDeliveryCursor()).toBeNull();
    const cursorWrites = () => writes.mock.calls.filter(([file]) => file === `${journal.filePath}.delivery.json`);
    expect(cursorWrites()).toHaveLength(0);
    await journal.markDeliveredBatch([event(1),event(2),event(3),event(4)]);
    expect(cursorWrites()).toHaveLength(1);
    const restarted = new FileTransportEventJournal({filePath:journal.filePath,
      lockManager:new ResourceLockManager({rootDirectory:path.join(path.dirname(path.dirname(journal.filePath)),"locks")})});
    expect(await restarted.loadDeliveryCursor()).toMatchObject({sequence:4,eventId:"event-4"});
    expect((await restarted.readUndelivered(10)).map(event=>event.sequence)).toEqual([5,6,7,8]);
    writes.mockRestore();
    const failedWrite = vi.spyOn(atomicFile,"atomicWriteJson").mockImplementation(async (...args) => {
      if(args[0] === `${journal.filePath}.delivery.json`) throw new Error("durable write failed");
      return originalWrite(...args);
    });
    await expect(restarted.markDeliveredBatch([event(5),event(6)])).rejects.toThrow("durable write failed");
    expect(await restarted.loadDeliveryCursor()).toMatchObject({sequence:4});
    failedWrite.mockRestore();
    await restarted.markDeliveredBatch([event(5),event(6),event(7),event(8)]);
    expect(await restarted.readUndelivered(10)).toEqual([]);
    expect(await restarted.loadCursor()).toMatchObject({sequence:8});
  });
  it("persists and replays multiline RPC errors intact after restart", async () => {
    const journal = await createJournal();
    const message = "Invalid request: unknown variant ``\n\tin apps._default.approvals_reviewer\r\n";
    const source: AppServerEvent = { ...event(1), message: { kind: "rpc-response", rpc: {
      id: "thread-start:exact", error: { code: -32600, message },
    } } };
    expect(await journal.append(source)).toBe(true);
    const restarted = new FileTransportEventJournal({ filePath: journal.filePath,
      lockManager: new ResourceLockManager({ rootDirectory: path.join(path.dirname(path.dirname(journal.filePath)), "locks") }) });
    expect(await restarted.readUndelivered(10)).toEqual([source]);
    await restarted.markDelivered(source);
    expect(await restarted.readUndelivered(10)).toEqual([]);
    expect(await restarted.readEvents()).toEqual([source]);
  });

  it("persists a replay cursor across instances and dedupes exact events", async () => {
    const journal = await createJournal();
    expect(await journal.loadCursor()).toBeNull();
    expect(await journal.append(event(1))).toBe(true);
    expect(await journal.append(event(1))).toBe(false);
    expect(await journal.append(event(2))).toBe(true);
    expect(await journal.loadCursor()).toEqual({ eventId: "event-2", sequence: 2 });
    expect(await journal.verifyAndRepair()).toMatchObject({ count: 2, lastSequence: 2 });
  });

  it("fails closed for gaps and event id reuse", async () => {
    const journal = await createJournal();
    await expect(journal.append(event(2))).rejects.toThrow("expected sequence 1");
    await journal.append(event(1, "stable-id"));
    await expect(journal.append(event(2, "stable-id"))).rejects.toThrow("different sequence");
  });

  it("tracks application delivery separately from transport receipt across instances", async () => {
    const journal = await createJournal();
    await journal.append(event(1));
    await journal.append(event(2));
    expect(await journal.readUndelivered(10)).toEqual([event(1), event(2)]);
    expect(await journal.readUndelivered(10, 1)).toEqual([event(2)]);

    await journal.markDelivered(event(1));
    expect(await journal.readUndelivered(10)).toEqual([event(2)]);
    await expect(journal.markDelivered(event(1))).resolves.toBeUndefined();
    await expect(journal.markDelivered(event(3))).rejects.toThrow("expected sequence 2");

    const restarted = new FileTransportEventJournal({
      filePath: journal.filePath,
      lockManager: new ResourceLockManager({ rootDirectory: path.join(path.dirname(path.dirname(journal.filePath)), "locks") }),
    });
    expect(await restarted.readUndelivered(10)).toEqual([event(2)]);
    await restarted.markDelivered(event(2));
    expect(await restarted.readUndelivered(10)).toEqual([]);
  });

  it("reconciles a validated resume cursor across a compacted acknowledgement gap", async () => {
    const journal = await createCompactJournal(2);
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      await journal.append(event(sequence));
    }
    await journal.markDelivered(event(1));
    await journal.reconcileDeliveryCursor("event-6", 6);

    expect(await journal.loadDeliveryCursor()).toMatchObject({ eventId: "event-6", sequence: 6 });
    expect(await journal.readEvents()).toEqual([event(5), event(6)]);
    expect(await journal.readUndelivered(10)).toEqual([]);
    await expect(journal.reconcileDeliveryCursor("event-5", 5)).rejects.toThrow("behind");
  });

  it("bounds delivered event history without losing sequence or restart recovery", async () => {
    const journal = await createCompactJournal(2);
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await journal.append(event(sequence));
      await journal.markDelivered(event(sequence));
    }
    expect(await journal.readEvents()).toEqual([event(4), event(5)]);
    expect(await journal.loadCursor()).toEqual({ eventId: "event-5", sequence: 5 });
    expect(await journal.readUndelivered(10)).toEqual([]);
    expect(await journal.append(event(6))).toBe(true);
    expect(await journal.readUndelivered(10)).toEqual([event(6)]);
  });
  it("bounds delivered bytes while preserving the cursor and every pending event across restart", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "aibrain-transport-bytes-")));
    roots.push(root);
    const options = { filePath: path.join(root, "events.jsonl"),
      lockManager: new ResourceLockManager({ rootDirectory: path.join(root, "locks") }),
      maxRetainedDeliveredBytes: 4_096 };
    const journal = new FileTransportEventJournal(options);
    const large = (sequence: number): AppServerEvent => ({ ...event(sequence), message: {
      kind: "rpc-notification",
      rpc: { method: "warning", params: { threadId: null, message: "x".repeat(8_192) } },
    } });
    for (let sequence = 1; sequence <= 6; sequence += 1) await journal.append(large(sequence));
    const initialBytes = (await stat(options.filePath)).size;
    await journal.markDelivered(large(1));
    await journal.markDelivered(large(2));
    await journal.markDelivered(large(3));
    expect((await stat(options.filePath)).size).toBe(initialBytes); // pending replay is never rewritten
    const restarted = new FileTransportEventJournal(options);
    expect(await restarted.loadDeliveryCursor()).toMatchObject({ sequence: 3, eventId: "event-3" });
    expect((await restarted.readEvents(2, 1)).map((entry) => entry.sequence)).toEqual([3]);
    expect((await restarted.readUndelivered(10)).map((entry) => entry.sequence)).toEqual([4, 5, 6]);
    expect(await restarted.loadCursor()).toEqual({ sequence: 6, eventId: "event-6" });
    await restarted.markDelivered(large(4));
    expect((await restarted.readUndelivered(10)).map((entry) => entry.sequence)).toEqual([5, 6]);
    await restarted.append(large(7));
    expect((await restarted.readEvents(6, 1))[0].sequence).toBe(7);
    await restarted.markDelivered(large(5));
    await restarted.markDelivered(large(6));
    await restarted.markDelivered(large(7));
    expect((await stat(options.filePath)).size).toBeLessThan(initialBytes);
    expect(await restarted.loadCursor()).toEqual({ sequence: 7, eventId: "event-7" });
    expect((await restarted.readEvents()).map(entry => entry.sequence)).toEqual([7]);
    expect(await restarted.readUndelivered(10)).toEqual([]);
  });

  it("rejects an externally corrupted payload sequence before indexed empty replay", async () => {
    const journal = await createJournal();
    await journal.append(event(1));
    await journal.append(event(2));
    const records = (await readFile(journal.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    records[1].payload.sequence = 100;
    await writeFile(journal.filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    await expect(journal.readEvents(2)).rejects.toThrow("non-contiguous payload sequence");
    await expect(journal.loadCursor()).rejects.toThrow("non-contiguous payload sequence");
  });

});


it.each([false, true])("does not rewrite a large pending suffix to remove one small record on the first ACK after restart (uncached=%s)", async uncached => {
  if (uncached) {
    const prototype = FileJournal.prototype as unknown as { rememberSnapshot(snapshot: unknown): void };
    vi.spyOn(prototype, "rememberSnapshot").mockImplementation(() => undefined);
  }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "aibrain-transport-pending-")));
  roots.push(root);
  const options = { filePath: path.join(root, "events.jsonl"),
    lockManager: new ResourceLockManager({ rootDirectory: path.join(root, "locks") }),
    maxRetainedDeliveredEvents: 2, maxRetainedDeliveredBytes: 4_096 };
  const original = new FileTransportEventJournal(options);
  for (let sequence = 1; sequence <= 3; sequence += 1) await original.append(event(sequence));
  for (let sequence = 4; sequence <= 40; sequence += 1) await original.append({ ...event(sequence), message: {
    kind: "rpc-notification", rpc: { method: "warning", params: { threadId: null, message: "x".repeat(8_192) } },
  } });
  await original.markDelivered(event(1)); await original.markDelivered(event(2));
  const before = (await stat(options.filePath)).ino;
  const compact = vi.spyOn(FileJournal.prototype, "compactContiguousTail");
  const restarted = new FileTransportEventJournal(options);
  await restarted.markDelivered(event(3));
  const outcomes = await Promise.all(compact.mock.results.map(result => result.value));
  expect(outcomes.filter(result => result.changed)).toHaveLength(0);
  expect((await stat(options.filePath)).ino).toBe(before);
  expect(await restarted.loadDeliveryCursor()).toMatchObject({ sequence: 3 });
  expect((await restarted.readUndelivered(40)).map(value => value.sequence)).toEqual(Array.from({ length: 37 }, (_, index) => index + 4));
});


it.each([false, true])("admits a concurrent response at a replay count boundary without rewriting the pending suffix (uncached=%s)", async uncached => {
  if (uncached) {
    const prototype = FileJournal.prototype as unknown as { rememberSnapshot(snapshot: unknown): void };
    vi.spyOn(prototype, "rememberSnapshot").mockImplementation(() => undefined);
  }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "aibrain-transport-boundary-")));
  roots.push(root);
  const options = { filePath: path.join(root, "events.jsonl"),
    lockManager: new ResourceLockManager({ rootDirectory: path.join(root, "locks"), defaultTimeoutMs: 30, retryDelayMs: 1, jitterRatio: 0 }),
    maxRetainedDeliveredEvents: 2, maxRetainedDeliveredBytes: 4_096 };
  const journal = new FileTransportEventJournal(options);
  for (let sequence = 1; sequence <= 40; sequence += 1) await journal.append(event(sequence));
  await journal.markDelivered(event(1)); await journal.markDelivered(event(2)); await journal.markDelivered(event(3));
  let entered!: () => void, release!: () => void;
  const rewriting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const write = atomicFile.atomicWriteFileChunks;
  vi.spyOn(atomicFile, "atomicWriteFileChunks").mockImplementation(async (...args) => {
    if (args[0] === options.filePath) { entered(); await gate; }
    return write(...args);
  });
  const acknowledgement = journal.markDelivered(event(4));
  await Promise.race([rewriting, acknowledgement]);
  try {
    const response: AppServerEvent = { ...event(41), message: { kind: "rpc-response", rpc: { id: "initialize:concurrent", result: {} } } };
    await expect(journal.append(response)).resolves.toBe(true);
    expect((await journal.readUndelivered(40)).at(-1)).toEqual(response);
  } finally { release(); await acknowledgement; }
});


it.each([false, true])("compacts after replay drains on a non-boundary ACK (uncached=%s)", async uncached => {
  if (uncached) {
    const prototype = FileJournal.prototype as unknown as { rememberSnapshot(snapshot: unknown): void };
    vi.spyOn(prototype, "rememberSnapshot").mockImplementation(() => undefined);
  }
  const journal = await createCompactJournal(2);
  for (let sequence = 1; sequence <= 9; sequence += 1) await journal.append(event(sequence));
  for (let sequence = 1; sequence <= 8; sequence += 1) await journal.markDelivered(event(sequence));
  expect(await journal.readEvents()).toHaveLength(9);
  await journal.markDelivered(event(9));
  expect((await journal.readEvents()).map(entry => entry.sequence)).toEqual([8, 9]);
  expect(await journal.loadDeliveryCursor()).toMatchObject({ sequence: 9 });
  expect(await journal.loadCursor()).toMatchObject({ sequence: 9 });
  expect(await journal.readUndelivered(10)).toEqual([]);
});


it.each(["missing-anchor", "corruption"])("does not bypass %s validation when discretionary compaction is deferred", async kind => {
  const journal = await createCompactJournal(2);
  for (let sequence = 1; sequence <= 5; sequence += 1) await journal.append(event(sequence));
  if (kind === "corruption") {
    const records = (await readFile(journal.filePath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    records[4].payload.sequence = 99;
    await writeFile(journal.filePath, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  }
  const original = await readFile(journal.filePath, "utf8");
  const storage = (journal as unknown as { journal: FileJournal<AppServerEvent> }).journal;
  await expect(storage.compactContiguousTail({ anchorSequence: kind === "missing-anchor" ? 0 : 1,
    maxRetainedEntries: 2, maxRetainedBytes: 4_096, minimumEntries: 0,
    minimumRemovedEntries: 1, deferWhilePending: true })).rejects.toMatchObject({ code: "STORAGE_CORRUPT" });
  expect(await readFile(journal.filePath, "utf8")).toBe(original);
  expect(await journal.loadDeliveryCursor()).toBeNull();
});


it.each([false, true])("reconciles a reconnect cursor jump without blocking a new response behind pending-history compaction (uncached=%s)", async uncached => {
  if (uncached) {
    const prototype = FileJournal.prototype as unknown as { rememberSnapshot(snapshot: unknown): void };
    vi.spyOn(prototype, "rememberSnapshot").mockImplementation(() => undefined);
  }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "aibrain-transport-resume-")));
  roots.push(root);
  const options = { filePath: path.join(root, "events.jsonl"),
    lockManager: new ResourceLockManager({ rootDirectory: path.join(root, "locks"), defaultTimeoutMs: 30, retryDelayMs: 1, jitterRatio: 0 }),
    maxRetainedDeliveredEvents: 2, maxRetainedDeliveredBytes: 4_096 };
  const journal = new FileTransportEventJournal(options);
  for (let sequence = 1; sequence <= 9; sequence += 1) await journal.append(event(sequence));
  await journal.markDelivered(event(1));
  let entered!: () => void, release!: () => void;
  const rewriting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const write = atomicFile.atomicWriteFileChunks;
  vi.spyOn(atomicFile, "atomicWriteFileChunks").mockImplementation(async (...args) => {
    if (args[0] === options.filePath) { entered(); await gate; }
    return write(...args);
  });
  const reconciliation = journal.reconcileDeliveryCursor("event-5", 5);
  await Promise.race([rewriting, reconciliation]);
  try {
    const response: AppServerEvent = { ...event(10), message: { kind: "rpc-response", rpc: { id: "initialize:reconnect", result: {} } } };
    await expect(journal.append(response)).resolves.toBe(true);
    expect(await journal.loadDeliveryCursor()).toMatchObject({ eventId: "event-5", sequence: 5 });
    expect((await journal.readUndelivered(10)).map(value => value.sequence)).toEqual([6, 7, 8, 9, 10]);
    await expect(journal.reconcileDeliveryCursor("wrong-event-5", 5)).rejects.toThrow("conflicts");
    await expect(journal.reconcileDeliveryCursor("missing", 11)).rejects.toThrow("absent");
    expect(await journal.loadDeliveryCursor()).toMatchObject({ eventId: "event-5", sequence: 5 });
  } finally { release(); await reconciliation; }
  for (let sequence = 6; sequence <= 10; sequence += 1) await journal.markDelivered(event(sequence));
  expect((await journal.readEvents()).map(value => value.sequence)).toEqual([9, 10]);
  expect(await journal.loadDeliveryCursor()).toMatchObject({ eventId: "event-10", sequence: 10 });
  expect(await journal.readUndelivered(10)).toEqual([]);
});
