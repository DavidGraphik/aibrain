import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilePinnedThreadStore, projectPinnedThreads } from "@/workbench/pinned-thread-store";
import type { WorkbenchThread } from "@/workbench/types";

vi.mock("server-only", () => ({}));

const USER_A = "00000000-0000-4000-8000-000000000101";
const USER_B = "00000000-0000-4000-8000-000000000102";
const THREAD_A = "00000000-0000-4000-8000-000000000201";
const THREAD_B = "00000000-0000-4000-8000-000000000202";
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aibrain-pins-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const usersRoot = path.join(dataRoot, "users");
  await mkdir(path.join(usersRoot, USER_A), { recursive: true, mode: 0o700 });
  await mkdir(path.join(usersRoot, USER_B), { recursive: true, mode: 0o700 });
  return {
    root,
    usersRoot,
    store: new FilePinnedThreadStore(dataRoot, usersRoot, "pin-lab"),
  };
}

function thread(id: string, pinned = false): WorkbenchThread {
  return {
    id,
    projectId: "00000000-0000-4000-8000-000000000301",
    title: id === THREAD_A ? "A" : "B",
    status: "active",
    pinned,
    createdAt: "2026-09-05T08:00:00.000Z",
    updatedAt: "2026-09-05T08:00:00.000Z",
    messages: [],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FilePinnedThreadStore", () => {
  it("persists a stable newest-pin-first order independently for each user", async () => {
    const { usersRoot, store } = await fixture();
    await store.update(USER_A, THREAD_A, true);
    await store.update(USER_A, THREAD_B, true);
    await store.update(USER_B, THREAD_A, true);

    const restarted = new FilePinnedThreadStore(path.dirname(usersRoot), usersRoot, "pin-lab");
    await expect(restarted.read(USER_A)).resolves.toEqual([THREAD_B, THREAD_A]);
    await expect(restarted.read(USER_B)).resolves.toEqual([THREAD_A]);
    await store.update(USER_A, THREAD_B, false);
    await expect(restarted.read(USER_A)).resolves.toEqual([THREAD_A]);

    const persisted = JSON.parse(await readFile(path.join(usersRoot, USER_A, "pinned-threads.json"), "utf8"));
    expect(persisted).toEqual({ schemaVersion: 1, threadIds: [THREAD_A] });
  });

  it("migrates legacy owner pins once and projects only visible conversations", async () => {
    const { store } = await fixture();
    await expect(store.read(USER_A, [THREAD_A])).resolves.toEqual([THREAD_A]);
    await expect(store.read(USER_A, [THREAD_B])).resolves.toEqual([THREAD_A]);
    expect(projectPinnedThreads([thread(THREAD_A), thread(THREAD_B, true)], [THREAD_B, THREAD_A]))
      .toMatchObject([{ id: THREAD_B, pinned: true }, { id: THREAD_A, pinned: true }]);
    expect(projectPinnedThreads([thread(THREAD_A)], [THREAD_B, THREAD_A]))
      .toMatchObject([{ id: THREAD_A, pinned: true }]);
  });

  it("rejects a symlinked user root instead of escaping the principal boundary", async () => {
    const { root, usersRoot, store } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await rm(path.join(usersRoot, USER_A), { recursive: true, force: true });
    await symlink(outside, path.join(usersRoot, USER_A), "dir");
    await expect(store.update(USER_A, THREAD_A, true)).rejects.toThrow("enlace simbólico");
    await expect(readFile(path.join(outside, "pinned-threads.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
