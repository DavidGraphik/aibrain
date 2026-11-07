import { mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { FileSettingsStore } from "@/settings/preferences-store";

vi.mock("server-only", () => ({}));

const USER_ID = "00000000-0000-4000-8000-000000000001";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-settings-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const usersRoot = path.join(dataRoot, "users");
  await mkdir(path.join(usersRoot, USER_ID), { recursive: true, mode: 0o700 });
  return { root, dataRoot, usersRoot, store: new FileSettingsStore(dataRoot, usersRoot) };
}

describe("FileSettingsStore", () => {
  it("defaults every real app to available without writing a fake connection", async () => {
    const { store } = await fixture();
    const [user, company] = await Promise.all([store.readUser(USER_ID), store.readInstallation()]);
    expect(user.apps).toEqual({
      "web-search": true,
      "image-generation": true,
      skills: true,
      "managed-browser": true,
    });
    expect(company.apps).toEqual(user.apps);
  });

  it("persists employee and installation controls separately with private files", async () => {
    const { dataRoot, usersRoot, store } = await fixture();
    await store.updateUser(USER_ID, (current) => ({
      ...current,
      apps: { ...current.apps, "web-search": false },
      notifications: { ...current.notifications, sound: true },
    }));
    await store.updateInstallation((current) => ({
      ...current,
      apps: { ...current.apps, "managed-browser": false },
    }));

    expect((await store.readUser(USER_ID)).apps["web-search"]).toBe(false);
    expect((await store.readUser(USER_ID)).notifications.sound).toBe(true);
    expect((await store.readInstallation()).apps["managed-browser"]).toBe(false);
    expect((await stat(path.join(usersRoot, USER_ID, "settings.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(dataRoot, "settings", "apps.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(usersRoot, USER_ID, "settings.json"), "utf8")).not.toContain("token");
  });

  it("serializes concurrent updates instead of losing one preference", async () => {
    const { store } = await fixture();
    await Promise.all([
      store.updateUser(USER_ID, (current) => ({
        ...current,
        notifications: { ...current.notifications, sound: true },
      })),
      store.updateUser(USER_ID, (current) => ({
        ...current,
        notifications: { ...current.notifications, failures: false },
      })),
    ]);
    const result = await store.readUser(USER_ID);
    expect(result.notifications.sound).toBe(true);
    expect(result.notifications.failures).toBe(false);
  });
});
