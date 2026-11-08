import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, link, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/chat-contract";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import { writeSegmentedWorkbench } from "@/workbench/segmented-history";
import * as storage from "@/storage";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

const memory = vi.hoisted(() => ({ heapLimit: undefined as number | undefined }));
vi.mock("node:v8", async original => {
  const actual = await original<typeof import("node:v8")>();
  return { ...actual, getHeapStatistics: () => ({ ...actual.getHeapStatistics(), ...(memory.heapLimit === undefined ? {} : { heap_size_limit: memory.heapLimit }) }) };
});
const fileRace = vi.hoisted(() => ({ path: "", appended: false, unboundedRead: false, requestedBytes: 0, historyOpens: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (typeof args[0] === "string" && args[0].includes(`${path.sep}workbench-history${path.sep}`)) fileRace.historyOpens++;
    const handle = await actual.open(...args);
    if (args[0] !== fileRace.path) return handle;
    return new Proxy(handle, { get(target, property) {
      if (property === "read") return async (buffer: Buffer, offset: number, length: number, position: number) => {
        fileRace.requestedBytes += length;
        const result = await target.read(buffer, offset, length, position);
        if (!fileRace.appended) { fileRace.appended = true; await actual.appendFile(fileRace.path, "Concurrent extension"); }
        return result;
      };
      if (property === "readFile") return async () => { fileRace.unboundedRead = true; return target.readFile(); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } };
});
const policy = vi.hoisted(() => ({ migration: true }));
vi.mock("@/workbench/history-format-policy", () => ({ get WORKBENCH_HISTORY_MIGRATION_ENABLED() { return policy.migration; } }));
vi.mock("server-only", () => ({}));
// Exercise the actual boundary/migration with a small fixture: no huge deep
// comparisons, duplicated64MiB buffers, or production data in tests.
vi.mock("@/workbench/segmented-history", async importOriginal => ({
  ...await importOriginal<typeof import("@/workbench/segmented-history")>(),
  WORKBENCH_SEGMENT_THRESHOLD: 16 * 1024,
}));
const user = "0198b9f0-6631-7000-8000-000000000101";
const roots: string[] = [];
afterEach(async () => { memory.heapLimit = undefined; fileRace.historyOpens = 0; fileRace.path = ""; fileRace.appended = false; fileRace.unboundedRead = false; fileRace.requestedBytes = 0; policy.migration = true; await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-segments-")); roots.push(root);
  const usersRoot = path.join(root, "users"); await mkdir(path.join(usersRoot, user), { recursive: true });
  const store = new FileWorkbenchStore({ installationId: "synthetic-lab", usersRoot });
  const project = await store.createProject(user, "Preserved history");
  const a = await store.createThread(user, project.id, "A");
  const b = await store.createThread(user, project.id, "B");
  const statePath = path.join(usersRoot, user, "state/workbench.json");
  const original = await readFile(statePath, "utf8");
  const legacy = JSON.parse(original);
  const msg = (role: ChatMessage["role"], content: string): ChatMessage => ({ id: randomUUID(), role, content, createdAt: new Date().toISOString(), status: "complete", activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [] });
  // Two independent histories cross the reduced migration threshold.
  legacy.threads.find((t: { id: string }) => t.id === a.id).messages = [msg("user", "x".repeat(8192))];
  legacy.threads.find((t: { id: string }) => t.id === b.id).messages = [msg("assistant", "y".repeat(8192))];
  await writeFile(statePath, JSON.stringify(legacy));
  return { root, usersRoot, store, statePath, legacy, a, b };
}
async function migrate(f: Awaited<ReturnType<typeof fixture>>) {
  await f.store.updateThread(user, f.a.id, { title: "Still writable" });
  const head = JSON.parse(await readFile(f.statePath, "utf8"));
  expect(head.schemaVersion).toBe(2);
  return head;
}
describe("segmented workbench persistence", () => {
  it("migrates a legacy state past the operational boundary, retains every byte, adds a turn and recovers with a new store", async () => {
    const f = await fixture();
    const original = await readFile(f.statePath);
    const head = await migrate(f);
    expect(hash(await readFile(f.statePath + ".v1-preserved.json"))).toBe(hash(original));
    const before = await f.store.readExistingDurableStateForMaintenance(user);
    expect(hash(JSON.stringify(before!.threads.map(t => t.messages)))).toBe(hash(JSON.stringify(f.legacy.threads.map((t: { messages: ChatMessage[] }) => t.messages))));
    const prompt: ChatMessage = { id: randomUUID(), role: "user", content: "Describe synthetic PNG", createdAt: new Date().toISOString(), status: "complete", activity: [], plan: [], approvals: [], diff: "", attachments: [{ id: randomUUID(), name: "qa.png", mimeType: "image/png", size: 4096 }], artifacts: [] };
    const reply: ChatMessage = { ...prompt, id: randomUUID(), role: "assistant", content: "Synthetic response", attachments: [] };
    await f.store.beginThreadTurn(user, f.b.id, prompt, reply);
    const cold = new FileWorkbenchStore({ installationId: "synthetic-lab", usersRoot: f.usersRoot });
    expect(hash(JSON.stringify((await cold.getThread(user, f.b.id)).messages))).toBe(hash(JSON.stringify([...f.legacy.threads.find((t: { id: string }) => t.id === f.b.id).messages, prompt, reply])));
    expect((await cold.loadAccessSnapshot(user)).threads.every(t => !t.messages.length)).toBe(true);
    expect(hash(await readFile(f.statePath + ".v1-preserved.json"))).toBe(hash(original));
    // Old objects remain available for rollback; no automatic history pruning.
    for (const ref of head.histories) expect((await readFile(path.join(path.dirname(f.statePath), "workbench-history", ref.digest + ".json"))).length).toBe(ref.bytes);
  }, 30_000);
  it("hydrates only the authorized selected history, within a per-selection budget", async () => {
    const f = await fixture();
    const head = await migrate(f);
    memory.heapLimit = 75_000; // 15KB: each selected history fits, aggregate histories do not.
    fileRace.historyOpens = 0;
    const selected = await f.store.loadAccessSnapshot(user, f.a.id, { includeTurnContext: true });
    expect(fileRace.historyOpens).toBe(1);
    expect(selected.threads.find(t => t.id === f.a.id)?.messages[0].content).toBe("x".repeat(8192));
    expect(selected.threads.find(t => t.id === f.b.id)?.messages).toEqual([]);
    const chosen = head.histories.find((r: {threadId:string}) => r.threadId === f.a.id);
    await writeFile(path.join(path.dirname(f.statePath), "workbench-history", chosen.digest + ".json"), Buffer.alloc(chosen.bytes, 32));
    await expect(f.store.loadAccessSnapshot(user, f.a.id)).rejects.toThrow("historial segmentat");
  });
  it("lists projects without opening histories when the aggregate exceeds the heap budget", async () => {
    const f = await fixture();
    await f.store.load(user); // the ordinary bootstrap has already created standalone metadata
    await migrate(f);
    memory.heapLimit = 48 * 1024;
    fileRace.historyOpens = 0;
    const projects = await f.store.listProjects(user, { status: "active", limit: 20 });
    expect(projects.items.map(project => project.name)).toEqual(["Preserved history"]);
    expect(fileRace.historyOpens).toBe(0);
    await expect(f.store.load(user)).rejects.toThrow("pressupost segur de memòria");
  });

  it.each(["context", "conversation"] as const)("reads only the requested history for %s without an unrelated history blocking it", async reader => {
    const f = await fixture();
    const head = await migrate(f);
    const unrelated = head.histories.find((ref: { threadId: string }) => ref.threadId === f.b.id);
    const objectRoot = path.join(path.dirname(f.statePath), "workbench-history");
    await writeFile(path.join(objectRoot, unrelated.digest + ".json"), Buffer.alloc(unrelated.bytes, 32));
    memory.heapLimit = 75_000; // selected history fits; aggregate history cannot be hydrated
    fileRace.historyOpens = 0;
    const read = () => reader === "context"
      ? f.store.getThreadRuntimeContext(user, f.a.id)
      : f.store.getThreadConversationHistory(user, f.a.id);
    const value = await read();
    if (reader === "context") expect(value).toMatchObject({ projectName: "Preserved history", projectSourceOwnerId: user });
    else expect(value).toContain("x".repeat(8192));
    expect(fileRace.historyOpens).toBe(1);
    const selected = head.histories.find((ref: { threadId: string }) => ref.threadId === f.a.id);
    await writeFile(path.join(objectRoot, selected.digest + ".json"), Buffer.alloc(selected.bytes, 32));
    await expect(read()).rejects.toThrow("historial segmentat");
  });

  it("runs a new scheduled-style turn above the aggregate limit and preserves unrelated histories", async () => {
    const f = await fixture();
    await f.store.load(user);
    const head = await migrate(f);
    memory.heapLimit = 90_000; // 18KB: the aggregate is too large, any selected thread fits.
    const cold = new FileWorkbenchStore({ installationId: "synthetic-lab", usersRoot: f.usersRoot });
    await expect(cold.load(user)).rejects.toThrow("pressupost segur de memòria");
    const project = await cold.getProject(user, f.a.projectId);
    await cold.updateProjectPreferences(user, project.id, "", "Keep current employee criteria");
    const created = await cold.createThread(user, project.id, "Programada · bounded turn");
    // A deterministic retry returns the existing conversation without loading its siblings.
    expect((await cold.createThread(user, project.id, created.title, created.id)).id).toBe(created.id);
    const prompt: ChatMessage = { id: randomUUID(), role: "user", content: "Check synthetic changes", status: "complete", createdAt: new Date().toISOString(), activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [] };
    const assistant: ChatMessage = { ...prompt, id: randomUUID(), role: "assistant", content: "", status: "streaming" };
    await cold.beginThreadTurn(user, created.id, prompt, assistant);
    await cold.finishThreadTurn(user, created.id, { ...assistant, content: "Checked once", status: "complete" }, null);
    expect((await cold.getThread(user, created.id)).messages.map(m => m.content)).toEqual([prompt.content, "Checked once"]);
    expect((await cold.getThreadRuntimeContext(user, created.id)).projectId).toBe(project.id);
    expect(await cold.getThreadConversationHistory(user, created.id)).toBeTruthy();
    await Promise.all([
      cold.updateThread(user, created.id, { status: "archived" }),
      cold.updateThread(user, f.a.id, { title: "Concurrent preserved sibling" }),
    ]);
    expect((await cold.getThread(user, f.a.id)).title).toBe("Concurrent preserved sibling");
    const after = JSON.parse(await readFile(f.statePath, "utf8"));
    for (const ref of head.histories) {
      expect(after.histories.find((item: { threadId: string }) => item.threadId === ref.threadId)).toEqual(ref);
      expect(hash(await readFile(path.join(path.dirname(f.statePath), "workbench-history", ref.digest + ".json")))).toBe(ref.digest);
    }
    await expect(cold.load(user)).rejects.toThrow("pressupost segur de memòria");
  });
  it("rejects a selected write beyond budget or with a corrupt object without replacing the head", async () => {
    const f = await fixture();
    const head = await migrate(f);
    const committed = await readFile(f.statePath, "utf8");
    memory.heapLimit = 90_000;
    const original = f.legacy.threads.find((t: { id: string }) => t.id === f.b.id).messages[0];
    await expect(f.store.finishThreadTurn(user, f.b.id, { ...original, content: "z".repeat(20_000) }, null)).rejects.toThrow("pressupost segur de memòria");
    expect(await readFile(f.statePath, "utf8")).toBe(committed);
    const ref = head.histories.find((r: { threadId: string }) => r.threadId === f.b.id);
    await writeFile(path.join(path.dirname(f.statePath), "workbench-history", ref.digest + ".json"), Buffer.alloc(ref.bytes, 32));
    await expect(f.store.updateThread(user, f.b.id, { title: "Must fail" })).rejects.toThrow("historial segmentat");
    expect(await readFile(f.statePath, "utf8")).toBe(committed);
  });
  it("fails closed for a missing or tampered object even after a warm full-state read", async () => {
    const f = await fixture(); const head = await migrate(f);
    await f.store.getThread(user, f.a.id);
    const object = path.join(path.dirname(f.statePath), "workbench-history", head.histories[0].digest + ".json");
    const bytes = await readFile(object); await rm(object);
    await expect(f.store.load(user)).rejects.toThrow("historial segmentat");
    expect(JSON.parse(await readFile(f.statePath, "utf8")).schemaVersion).toBe(2);
    await writeFile(object, bytes); await writeFile(object, Buffer.alloc(bytes.length, 32));
    await expect(f.store.load(user)).rejects.toThrow("historial segmentat");
  }, 30_000);
  it.each(["symlink", "hardlink"])("rejects a %s object without replacing the committed head", async kind => {
    const f = await fixture(); const head = await migrate(f);
    const object = path.join(path.dirname(f.statePath), "workbench-history", head.histories[0].digest + ".json");
    const copy = path.join(f.root, "copy.json"); await writeFile(copy, await readFile(object)); await rm(object);
    if (kind === "symlink") await symlink(copy, object); else await link(copy, object);
    await expect(f.store.load(user)).rejects.toThrow("historial segmentat");
    expect(JSON.parse(await readFile(f.statePath, "utf8")).revision).toBe(head.revision);
  }, 30_000);
  it("keeps the prior committed head when a writer fails after publishing objects", async () => {
    const f = await fixture(); await migrate(f);
    const committed = await readFile(f.statePath, "utf8");
    const state = await f.store.readExistingDurableStateForMaintenance(user);
    state!.threads[0].messages[0].content += "New uncommitted content";
    const original = storage.atomicWriteFileChunks;
    const writer = vi.spyOn(storage, "atomicWriteFileChunks").mockImplementation(async (file, chunks, options) => {
      if (file === f.statePath) throw new Error("simulated failure before head commit");
      return original(file, chunks, options);
    });
    try {
      const schema = { name: "Synthetic", parse: (v: unknown) => v as NonNullable<typeof state> };
      await expect(writeSegmentedWorkbench(f.statePath, state!, schema, { preserveLegacy: false })).rejects.toThrow("simulated failure");
    } finally { writer.mockRestore(); }
    expect(await readFile(f.statePath, "utf8")).toBe(committed);
    expect((await f.store.getThread(user, f.a.id)).messages[0].content).toBe(f.legacy.threads[0].messages[0].content);
  });
  it("rejects a validly hashed history copied from another user", async () => {
    const f = await fixture(); const head = await migrate(f);
    const ref = head.histories[0];
    const root = path.join(path.dirname(f.statePath), "workbench-history");
    const foreign = JSON.parse(await readFile(path.join(root, ref.digest + ".json"), "utf8"));
    foreign.userId = "0198b9f0-6631-7000-8000-000000000102";
    const bytes = JSON.stringify(foreign); ref.digest = hash(bytes); ref.bytes = Buffer.byteLength(bytes);
    await writeFile(path.join(root, ref.digest + ".json"), bytes);
    await writeFile(f.statePath, JSON.stringify(head));
    await expect(f.store.load(user)).rejects.toThrow("historial segmentat");
  });

  it("keeps v1 unchanged under reader-first policy while still writing already migrated v2", async () => {
    const f = await fixture();
    policy.migration = false;
    await f.store.updateThread(user, f.a.id, { title: "Reader-only stage" });
    expect(JSON.parse(await readFile(f.statePath, "utf8")).schemaVersion).toBe(1);
    policy.migration = true;
    await migrate(f);
    policy.migration = false;
    const cold = new FileWorkbenchStore({ installationId: "synthetic-lab", usersRoot: f.usersRoot });
    await cold.updateThread(user, f.a.id, { title: "Recovery writer works" });
    await cold.finishThreadTurn(user, f.b.id, { ...f.legacy.threads[1].messages[0], content: "Small recovered result" }, null);
    expect(JSON.parse(await readFile(f.statePath, "utf8")).schemaVersion).toBe(2);
    expect((await cold.getThread(user, f.a.id)).messages[0].content).toBe(f.legacy.threads[0].messages[0].content);
  });

  it("rejects growth during an object read without consuming the extension", async () => {
    const f = await fixture(); const head = await migrate(f);
    const ref = head.histories[0];
    fileRace.path = path.join(path.dirname(f.statePath), "workbench-history", ref.digest + ".json");
    await expect(f.store.load(user)).rejects.toThrow("historial segmentat");
    expect(fileRace.appended).toBe(true);
    expect(fileRace.unboundedRead).toBe(false);
    expect(fileRace.requestedBytes).toBeLessThanOrEqual(ref.bytes);
    expect(JSON.parse(await readFile(f.statePath, "utf8")).revision).toBe(head.revision);
  });

  it("rejects aggregate hydration before opening histories while preserving access metadata", async () => {
    const f = await fixture();
    await f.store.load(user); // provision the ordinary standalone catalogue before constraining memory
    await migrate(f);
    memory.heapLimit = 48 * 1024;
    fileRace.historyOpens = 0;
    await expect(f.store.load(user)).rejects.toThrow("pressupost segur de memòria");
    expect(fileRace.historyOpens).toBe(0);
    const metadata = await f.store.loadAccessSnapshot(user);
    expect(metadata.threads.some(thread => thread.id === f.a.id)).toBe(true);
    expect(metadata.threads.every(thread => thread.messages.length === 0)).toBe(true);
    expect(fileRace.historyOpens).toBe(0);
  });
  it("refuses a write beyond the same process budget without changing the readable committed head", async () => {
    const f = await fixture(); await migrate(f);
    const committed = await readFile(f.statePath, "utf8");
    const state = await f.store.readExistingDurableStateForMaintenance(user);
    state!.threads[0].messages[0].content += "z".repeat(16 * 1024);
    memory.heapLimit = 128 * 1024;
    const schema = { name: "Synthetic", parse: (value: unknown) => value as NonNullable<typeof state> };
    await expect(writeSegmentedWorkbench(f.statePath, state!, schema, { preserveLegacy: false })).rejects.toThrow("pressupost segur de memòria");
    expect(await readFile(f.statePath, "utf8")).toBe(committed);
    expect((await f.store.getThread(user, f.a.id)).messages[0].content).toBe(f.legacy.threads[0].messages[0].content);
  });

});


it("scans 3664 synthetic histories with one validated manifest, one selected object at a time, and fresh head/object checks", async () => {
  const f = await fixture();
  const template = f.legacy.threads.find((thread: { id: string }) => thread.id === f.a.id);
  const historyRoot = path.join(path.dirname(f.statePath), "workbench-history");
  await mkdir(historyRoot, { mode: 0o700 });
  const threads: typeof f.legacy.threads = [], histories: Array<{ threadId: string; digest: string; bytes: number }> = [];
  for (let start = 0; start < 3664; start += 64) {
    await Promise.all(Array.from({ length: Math.min(64, 3664 - start) }, async (_, offset) => {
      const id = `10000000-0000-4000-8000-${String(start + offset).padStart(12, "0")}`;
      const thread = { ...template, id, messages: [] };
      const bytes = JSON.stringify({ schemaVersion: 1, installationId: f.legacy.installationId, userId: user, threadId: id, messages: [] });
      const digest = hash(bytes);
      threads[start + offset] = thread;
      histories[start + offset] = { threadId: id, digest, bytes: Buffer.byteLength(bytes) };
      await writeFile(path.join(historyRoot, `${digest}.json`), bytes, { mode: 0o600 });
    }));
  }
  await writeFile(f.statePath, JSON.stringify({ ...f.legacy, schemaVersion: 2, threads, histories }));
  const readSpy = vi.spyOn(storage, "readValidatedJson");
  const reader = f.store.createThreadReader(user);
  fileRace.historyOpens = 0;
  const started = performance.now();
  for (const thread of threads) {
    const value = await reader(thread.id);
    expect(value.threads).toHaveLength(1);
    expect(value.threads[0].id).toBe(thread.id);
  }
  console.info(JSON.stringify({ syntheticThreads: threads.length, scanMs: Math.round(performance.now() - started), headReads: readSpy.mock.calls.filter(([file]) => file === f.statePath).length, historyOpens: fileRace.historyOpens }));
  expect(readSpy.mock.calls.filter(([file]) => file === f.statePath)).toHaveLength(1);
  expect(fileRace.historyOpens).toBe(threads.length);
  // Canonical metadata changes must invalidate the same request reader.
  threads[0].title = "Changed during scan";
  await writeFile(f.statePath, JSON.stringify({ ...f.legacy, schemaVersion: 2, threads, histories }));
  expect((await reader(threads[0].id)).threads[0].title).toBe("Changed during scan");
  await writeFile(path.join(historyRoot, `${histories[0].digest}.json`), "{}");
  await expect(reader(threads[0].id)).rejects.toThrow();
  readSpy.mockRestore();
}, 30000);
