import { createHash } from "node:crypto";
import { lstat, link, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileJournal } from "./journal";
import { ResourceLockManager } from "./resource-lock";

const roots: string[] = [];
type Payload = { label: string };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(shared: boolean, schema = { name: "SharedMetadata", parse: (value: unknown) => value as Payload }) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "shared-journal-"))); roots.push(root);
  const file = path.join(root, "journal.jsonl"), lockRoot = path.join(root, "locks");
  const make = (parser = schema) => new FileJournal({ filePath: file, payloadSchema: parser, shareReadIndex: shared,
    lockManager: new ResourceLockManager({ rootDirectory: lockRoot, defaultTimeoutMs: 30, retryDelayMs: 1, jitterRatio: 0 }) });
  await make().append({ label: "initial" });
  return { root, file, lockRoot, schema, make };
}

it.each([false, true])("reproduces overlapping generation startup lock contention and coalesces only an opted-in same revision (shared=%s)", async shared => {
  const f = await fixture(shared), first = f.make(), second = f.make();
  const prototype = FileJournal.prototype as unknown as { readLastLocked(): Promise<unknown> };
  const original = prototype.readLastLocked;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  let firstRead = true;
  vi.spyOn(prototype, "readLastLocked").mockImplementation(async function (this: FileJournal<Payload>) {
    if (!firstRead) return original.call(this);
    firstRead = false;
    // Exact cold-scan critical section: canonical journal lock belongs to a
    // real reader in this process while a replacement generation connects.
    const lock = new ResourceLockManager({ rootDirectory: f.lockRoot });
    return lock.withLock(`journal:${f.file}`, async () => { entered(); await gate; return { sequence: 1, payload: { label: "initial" } }; });
  });
  const one = first.readLast(); await started;
  const key = createHash("sha256").update(`journal:${f.file}`).digest("hex");
  const owner = JSON.parse(await readFile(path.join(f.lockRoot, `${key}.lock/owner.json`), "utf8"));
  expect(owner).toMatchObject({ processId: process.pid, resourceHash: key });
  const two = second.readLast();
  if (!shared) {
    await expect(two).rejects.toMatchObject({ code: "STORAGE_LOCK_TIMEOUT", resourceKey: `journal:${f.file}` });
    release(); await one;
  } else {
    await new Promise(resolve => setTimeout(resolve, 45)); release();
    const [a, b] = await Promise.all([one, two]);
    expect(a).toEqual(b); expect(a).not.toBe(b);
    expect(prototype.readLastLocked).toHaveBeenCalledTimes(1);
  }
});

it("shares only indexes, validates fresh append/rewrite/rotation, and never shares a different schema", async () => {
  const parse = vi.fn((value: unknown) => value as Payload), f = await fixture(true, { name: "Counted", parse });
  await f.make().append({ label: "second" });
  parse.mockClear();
  const other = f.make();
  expect((await other.readLast())?.payload.label).toBe("second");
  expect(parse).toHaveBeenCalledTimes(1); // selected payload is parsed again; no payload tree cache
  parse.mockClear();
  await other.readLast(); expect(parse).toHaveBeenCalledTimes(1);
  const distinct = { name: "OtherSchema", parse: vi.fn((value: unknown) => value as Payload) };
  await f.make(distinct).readLast(); expect(distinct.parse.mock.calls.length).toBeGreaterThan(1);
  const bytes = await readFile(f.file, "utf8"), original = await lstat(f.file);
  await writeFile(f.file, bytes.replace("initial", "changed")); await utimes(f.file, original.atime, original.mtime);
  expect((await f.make().read({ limit: 1 }))[0].payload.label).toBe("changed");
  await writeFile(f.file + ".next", bytes.replace("second", "rotated")); await rename(f.file + ".next", f.file);
  expect((await f.make().readLast())?.payload.label).toBe("rotated");
  await f.make().append({ label: "appended" });
  expect((await other.readLast())?.sequence).toBe(3);
  await writeFile(f.file, (await readFile(f.file, "utf8")).replace('"sequence":1', '"sequence":9'));
  await expect(f.make().readLast()).rejects.toMatchObject({ code: "STORAGE_CORRUPT" });
});

it.each(["hardlink", "symlink", "parent-alias"])("refuses %s identity even after a warm index", async kind => {
  const f = await fixture(true); await f.make().readLast();
  if (kind === "hardlink") await link(f.file, f.file + ".link");
  else if (kind === "symlink") { await rename(f.file, f.file + ".target"); await symlink(f.file + ".target", f.file); }
  else {
    const alias = f.root + ".alias"; await symlink(f.root, alias); roots.push(alias);
    const j = new FileJournal({ filePath: path.join(alias, "journal.jsonl"), payloadSchema: f.schema, shareReadIndex: true,
      lockManager: new ResourceLockManager({ rootDirectory: f.lockRoot }) });
    await expect(j.readLast()).rejects.toMatchObject({ code: "STORAGE_CORRUPT" }); return;
  }
  await expect(f.make().readLast()).rejects.toMatchObject({ code: "STORAGE_CORRUPT" });
});

it("does not join an older in-flight revision after an external rotation", async () => {
  const f = await fixture(true), first = f.make();
  const second = new FileJournal({ filePath: f.file, payloadSchema: f.schema, shareReadIndex: true,
    lockManager: new ResourceLockManager({ rootDirectory: f.lockRoot, defaultTimeoutMs: 1000 }) });
  const prototype = FileJournal.prototype as unknown as { readLastLocked(): Promise<unknown> };
  const original = prototype.readLastLocked;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  let cold = true;
  const spy = vi.spyOn(prototype, "readLastLocked").mockImplementation(async function (this: FileJournal<Payload>) {
    if (!cold) return original.call(this);
    cold = false;
    return new ResourceLockManager({ rootDirectory: f.lockRoot }).withLock(`journal:${f.file}`, async () => {
      entered(); await gate; return { sequence: 1, payload: { label: "initial" } };
    });
  });
  const stale = first.readLast(), denial = expect(stale).rejects.toMatchObject({ code: "STORAGE_CORRUPT" });
  await started;
  const bytes = await readFile(f.file, "utf8");
  await writeFile(f.file + ".next", bytes.replace("initial", "rotated")); await rename(f.file + ".next", f.file);
  const fresh = second.readLast();
  await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2), { interval: 1 });
  release(); await denial;
  expect((await fresh)?.payload.label).toBe("rotated");
});

it("returns its validated snapshot when a legitimate append occurs after unlock but before publication", async () => {
  const f = await fixture(true), reader = f.make(), writer = f.make();
  const prototype = FileJournal.prototype as unknown as {
    readLastLocked(onValidated?: (identity: string) => void): Promise<unknown>;
  };
  const original = prototype.readLastLocked;
  let append = true;
  vi.spyOn(prototype, "readLastLocked").mockImplementation(async function (this: FileJournal<Payload>, onValidated) {
    const snapshot = await original.call(this, onValidated); // the read lease has been released
    if (append) {
      append = false;
      await writer.append({ label: "legitimate append" });
      // The old read is still unpublished: a new revision must read its own
      // last entry rather than joining that older in-flight snapshot.
      expect((await writer.readLast())?.payload.label).toBe("legitimate append");
    }
    return snapshot;
  });
  expect((await reader.readLast())?.payload.label).toBe("initial");
  expect((await writer.readLast())?.payload.label).toBe("legitimate append");
  expect((await reader.readLast())?.sequence).toBe(2);
});

it("does not hide an external rewrite made while the selected snapshot is still locked", async () => {
  const f = await fixture(true), reader = f.make();
  const prototype = FileJournal.prototype as unknown as { readUnlocked(...args: unknown[]): Promise<unknown> };
  const original = prototype.readUnlocked;
  let changed = false;
  vi.spyOn(prototype, "readUnlocked").mockImplementation(async function (this: FileJournal<Payload>, ...args) {
    const snapshot = await original.apply(this, args);
    if (!changed) {
      changed = true;
      const bytes = await readFile(f.file, "utf8");
      await writeFile(f.file, bytes.replace("initial", "rewrite"));
    }
    return snapshot;
  });
  await expect(reader.readLast()).rejects.toMatchObject({ code: "STORAGE_CORRUPT" });
});


it("keeps the normal incomplete-tail repair when validating a shared startup snapshot", async () => {
  const f = await fixture(true), original = await readFile(f.file, "utf8");
  await writeFile(f.file, '{"incomplete":', { flag: "a" });
  expect((await f.make().readLast())?.payload.label).toBe("initial");
  expect(await readFile(f.file, "utf8")).toBe(original);
  expect((await f.make().append({ label: "next" })).sequence).toBe(2);
});
