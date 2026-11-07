import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileJournal } from "@/storage/journal";
import { ResourceLockManager } from "@/storage/resource-lock";
import {
  defineVersionedSchema,
  expectString,
} from "@/storage/schema";

type TestEvent = { schemaVersion: 1; label: string };

const eventSchema = defineVersionedSchema<TestEvent>({
  name: "TestJournalEvent",
  schemaVersion: 1,
  keys: ["label"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      label: expectString(record.label, context.at("label"), { minLength: 1, maxLength: 80 }),
    };
  },
});

describe("append-only file journal", () => {
  let root: string;
  let journalPath: string;
  let lockManager: ResourceLockManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aibrain-journal-"));
    journalPath = path.join(root, "turns", "turn-1.jsonl");
    lockManager = new ResourceLockManager({
      rootDirectory: path.join(root, "locks"),
      staleAfterMs: 2_000,
      heartbeatIntervalMs: 100,
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
      jitterRatio: 0,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function journal(manager = lockManager) {
    return new FileJournal({
      filePath: journalPath,
      lockManager: manager,
      payloadSchema: eventSchema,
    });
  }

  it("appends strictly increasing durable sequences and paginates replay", async () => {
    const events = journal();
    const first = await events.append({ schemaVersion: 1, label: "one" });
    const second = await events.append({ schemaVersion: 1, label: "two" });
    const third = await events.append({ schemaVersion: 1, label: "three" });

    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
    expect(new Set([first.eventId, second.eventId, third.eventId]).size).toBe(3);
    expect((await events.read({ afterSequence: 1, limit: 1 }))[0]?.payload.label).toBe("two");
    expect((await events.verifyAndRepair())).toEqual({
      count: 3,
      lastSequence: 3,
      repairedBytes: 0,
    });
  });

  it("serializes concurrent appenders without gaps or duplicates", async () => {
    const secondManager = new ResourceLockManager({
      rootDirectory: path.join(root, "locks"),
      staleAfterMs: 2_000,
      heartbeatIntervalMs: 100,
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
      jitterRatio: 0,
    });
    const journals = [journal(), journal(secondManager)];
    const appended = await Promise.all(Array.from({ length: 60 }, (_, index) =>
      journals[index % journals.length].append({ schemaVersion: 1, label: `event-${index}` })));

    const replay = await journals[0].read();
    expect(replay.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 60 }, (_, index) => index + 1),
    );
    expect(new Set(replay.map((entry) => entry.eventId)).size).toBe(60);
    expect(new Set(appended.map((entry) => entry.payload.label)).size).toBe(60);
  });

  it("supports an atomic conditional append under the journal lock", async () => {
    const events = journal();
    const first = await events.appendIf(
      { schemaVersion: 1, label: "unique" },
      (entries) => !entries.some((entry) => entry.payload.label === "unique"),
    );
    const duplicate = await events.appendIf(
      { schemaVersion: 1, label: "unique" },
      (entries) => !entries.some((entry) => entry.payload.label === "unique"),
    );

    expect(first?.sequence).toBe(1);
    expect(duplicate).toBeNull();
    expect(await events.read()).toHaveLength(1);
  });

  it("truncates only a torn final record and continues at the next sequence", async () => {
    const events = journal();
    await events.append({ schemaVersion: 1, label: "committed" });
    const committedLength = (await readFile(journalPath)).length;
    await writeFile(journalPath, "{\"schemaVersion\":1", { flag: "a" });

    const repair = await events.verifyAndRepair();
    expect(repair).toMatchObject({ count: 1, lastSequence: 1 });
    expect(repair.repairedBytes).toBeGreaterThan(0);
    expect((await readFile(journalPath)).length).toBe(committedLength);

    const next = await events.append({ schemaVersion: 1, label: "after-restart" });
    expect(next.sequence).toBe(2);
    expect((await events.read()).map((entry) => entry.payload.label))
      .toEqual(["committed", "after-restart"]);
  });

  it("fails closed for a corrupt complete record instead of dropping history", async () => {
    const events = journal();
    await events.append({ schemaVersion: 1, label: "committed" });
    await writeFile(journalPath, "not-json\n", { flag: "a" });
    const before = await readFile(journalPath, "utf8");

    await expect(events.verifyAndRepair()).rejects.toMatchObject({ code: "STORAGE_CORRUPT" });
    expect(await readFile(journalPath, "utf8")).toBe(before);
  });

  it("detects sequence gaps", async () => {
    const malformed = {
      schemaVersion: 1,
      sequence: 2,
      eventId: "00000000-0000-4000-8000-000000000000",
      recordedAt: new Date(0).toISOString(),
      payload: { schemaVersion: 1, label: "gap" },
    };
    await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify(malformed)}\n`);

    await expect(journal().read()).rejects.toThrow(/expected sequence 1, found 2/);
  });

  it("rejects journal symlinks", async () => {
    const outside = path.join(root, "outside.jsonl");
    await writeFile(outside, "");
    await mkdir(path.dirname(journalPath), { recursive: true });
    await symlink(outside, journalPath);

    await expect(journal().append({ schemaVersion: 1, label: "blocked" }))
      .rejects.toMatchObject({ code: "STORAGE_SYMLINK_REJECTED" });
    expect(await readFile(outside, "utf8")).toBe("");
  });

  it("atomically compacts retained payloads and continues its internal sequence", async () => {
    const events = journal();
    await events.append({ schemaVersion: 1, label: "discarded" });
    await events.append({ schemaVersion: 1, label: "retained" });
    await expect(events.compact((entries) => entries.slice(-1).map((entry) => entry.payload)))
      .resolves.toEqual({ before: 2, after: 1, changed: true });
    expect((await events.read()).map((entry) => entry.payload.label)).toEqual(["retained"]);
    await events.append({ schemaVersion: 1, label: "after-compaction" });
    expect((await events.read()).map((entry) => [entry.sequence, entry.payload.label])).toEqual([
      [1, "retained"],
      [2, "after-compaction"],
    ]);
  });

  it("skips the atomic rewrite when compaction is not due", async () => {
    const events = journal();
    await events.append({ schemaVersion: 1, label: "unchanged" });
    const before = await readFile(journalPath, "utf8");
    await expect(events.compact(() => undefined))
      .resolves.toEqual({ before: 1, after: 1, changed: false });
    expect(await readFile(journalPath, "utf8")).toBe(before);
  });
  it("does not revalidate large historical payloads on append or indexed replay", async () => {
    const parse = vi.fn((value: unknown) => value as TestEvent);
    const events = new FileJournal({ filePath: journalPath, lockManager,
      payloadSchema: { name: "LargeEvent", parse } });
    const label = "x".repeat(1024 * 1024);
    await Promise.all(Array.from({ length: 10 }, () => events.append({ schemaVersion: 1, label })));
    parse.mockClear();
    expect(await events.read({ afterSequence: 10 })).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
    expect((await events.read({ afterSequence: 9, limit: 1 }))[0].payload.label).toHaveLength(label.length);
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockClear();
    await events.append({ schemaVersion: 1, label: "new" });
    // Admission and newly constructed envelope only; ten MB of history is untouched.
    expect(parse).toHaveBeenCalledTimes(2);
    expect((await events.readLast())?.sequence).toBe(11);
  });

  it("revalidates same-size external corruption and replacement after a cached read", async () => {
    const events = journal();
    await events.append({ schemaVersion: 1, label: "original" });
    await events.read();
    const valid = await readFile(journalPath, "utf8");
    await writeFile(journalPath, valid.replace('"sequence":1', '"sequence":9'));
    await expect(events.read()).rejects.toMatchObject({ code: "STORAGE_CORRUPT" });
    await writeFile(`${journalPath}.replacement`, valid.replace("original", "replaced"));
    await rename(`${journalPath}.replacement`, journalPath);
    expect((await events.read())[0].payload.label).toBe("replaced");
  });

  it("does not let callers mutate a cached snapshot and detects external compaction", async () => {
    const events = journal();
    await events.append({ schemaVersion: 1, label: "one" });
    await events.append({ schemaVersion: 1, label: "two" });
    (await events.read())[0].payload.label = "mutated";
    expect((await events.read())[0].payload.label).toBe("one");
    await journal().compact((entries) => entries.slice(-1).map((entry) => entry.payload));
    expect((await events.read()).map((entry) => entry.payload.label)).toEqual(["two"]);
    expect((await events.append({ schemaVersion: 1, label: "three" })).sequence).toBe(2);
  });

  it("revalidates history if an external writer edits a prefix and also appends", async () => {
    const events = journal();
    await events.append({ schemaVersion: 1, label: "committed" });
    const valid = await readFile(journalPath, "utf8");
    await writeFile(journalPath, valid.replace('"sequence":1', '"sequence":8') + "{}\n");
    await expect(events.append({ schemaVersion: 1, label: "next" }))
      .rejects.toMatchObject({ code: "STORAGE_CORRUPT" });
  });

  it("rejects a symlink that replaces a previously cached journal", async () => {
    const events = journal();
    await events.append({ schemaVersion: 1, label: "committed" });
    await rename(journalPath, `${journalPath}.outside`);
    await symlink(`${journalPath}.outside`, journalPath);
    await expect(events.read()).rejects.toMatchObject({ code: "STORAGE_SYMLINK_REJECTED" });
  });

  it("observes a different writer's append before assigning the next sequence", async () => {
    const events = journal();
    await events.append({ schemaVersion: 1, label: "first" });
    await journal().append({ schemaVersion: 1, label: "external" });
    expect((await events.read({ afterSequence: 1 }))[0].payload.label).toBe("external");
    expect((await events.append({ schemaVersion: 1, label: "third" })).sequence).toBe(3);
  });

  it("falls back safely beyond the bounded offset index without dropping records", async () => {
    const count = 65_538;
    const line = { schemaVersion: 1, eventId: "00000000-0000-4000-8000-000000000000",
      recordedAt: new Date(0).toISOString(), payload: { schemaVersion: 1, label: "history" } };
    await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(journalPath, Array.from({ length: count }, (_, index) =>
      JSON.stringify({ ...line, sequence: index + 1 })).join("\n") + "\n");
    const events = journal();
    expect((await events.read({ afterSequence: count - 1, limit: 1 }))[0].sequence).toBe(count);
    expect((await events.readLast())?.sequence).toBe(count);
    expect((await events.append({ schemaVersion: 1, label: "after-index-cap" })).sequence).toBe(count + 1);
    expect((await events.read({ afterSequence: count }))[0].payload.label).toBe("after-index-cap");
  });

  it("enforces configured payload continuity on append and before compaction writes", async () => {
    const events = new FileJournal({ filePath: journalPath, lockManager,
      payloadSchema: eventSchema, contiguousPayloadSequence: (payload) => Number(payload.label) });
    for (const label of ["10", "11", "12"]) await events.append({ schemaVersion: 1, label });
    const before = await readFile(journalPath, "utf8");
    await expect(events.append({ schemaVersion: 1, label: "14" })).rejects.toThrow("non-contiguous payload sequence");
    await expect(events.compact((entries) => [entries[0].payload, entries[2].payload]))
      .rejects.toThrow("non-contiguous payload sequence");
    expect(await readFile(journalPath, "utf8")).toBe(before);
    await events.compact((entries) => entries.slice(1).map((entry) => entry.payload));
    expect((await events.readContiguous(11, 1))[0].payload.label).toBe("12");
  });

});
