import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTaskCenterStore } from "@/task-center/file-store";

vi.mock("server-only", () => ({}));

const INSTALLATION_ID = "synthetic-lab";
const USER_A = "0198b9f0-6631-7000-8000-000000000301";
const USER_B = "0198b9f0-6631-7000-8000-000000000302";
const TASK_A = "0198b9f0-6631-7000-8000-000000000303.0198b9f0-6631-7000-8000-000000000304";
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-task-center-"));
  roots.push(root);
  const usersRoot = path.join(root, "users");
  await mkdir(path.join(usersRoot, USER_A), { recursive: true, mode: 0o700 });
  await mkdir(path.join(usersRoot, USER_B), { recursive: true, mode: 0o700 });
  return { usersRoot, store: new FileTaskCenterStore({ installationId: INSTALLATION_ID, usersRoot }) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileTaskCenterStore", () => {
  it("persists read history and explicit preferences across restart", async () => {
    const { usersRoot, store } = await fixture();
    await store.update(USER_A, {
      markRead: [TASK_A],
      preferences: { inApp: false, desktop: true },
    });
    const restarted = new FileTaskCenterStore({ installationId: INSTALLATION_ID, usersRoot });
    await expect(restarted.load(USER_A)).resolves.toEqual({
      readTaskIds: [TASK_A],
      preferences: { inApp: false, desktop: true },
    });
  });

  it("isolates notification state by authenticated user", async () => {
    const { store } = await fixture();
    await store.update(USER_A, { markRead: [TASK_A] });
    await expect(store.load(USER_B)).resolves.toEqual({
      readTaskIds: [],
      preferences: { inApp: true, desktop: false },
    });
  });

  it("rejects task ids outside the strict conversation/message format", async () => {
    const { store } = await fixture();
    await expect(store.update(USER_A, { markRead: ["../../other-user"] }))
      .rejects.toThrow("no es válida");
  });

  it("rejects a state root redirected outside the authenticated user", async () => {
    const { usersRoot, store } = await fixture();
    const outside = path.join(path.dirname(usersRoot), "outside-state");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, path.join(usersRoot, USER_A, "state"));
    await expect(store.load(USER_A)).rejects.toThrow("no es seguro");
  });
});
