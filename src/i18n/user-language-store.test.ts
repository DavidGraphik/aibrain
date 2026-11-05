vi.mock("server-only", () => ({}));
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileUserLanguageStore } from "./user-language-store";
const roots: string[] = [];
async function root() { const dir = await mkdtemp(path.join(os.tmpdir(), "aibrain-user-language-test-")); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe("personal language persistence and isolation", () => {
  it("keeps a user's choice across restart without changing colleagues or the company", async () => {
    const dir = await root(); const store = new FileUserLanguageStore("g03-production", dir);
    expect(await store.read("rafa")).toBeNull();
    await store.write("rafa", "es");
    expect(await new FileUserLanguageStore("g03-production", dir).read("rafa")).toBe("es");
    expect(await store.read("jordi")).toBeNull();
    await store.write("jordi", "ca");
    expect(await store.read("rafa")).toBe("es");
    expect(await store.read("jordi")).toBe("ca");
    await expect(stat(path.join(dir, "settings/language.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(path.join(dir, "settings/user-languages/rafa.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path.join(dir, "settings/user-languages/rafa.json"), "utf8"))).toMatchObject({ installationId: "g03-production", userId: "rafa", locale: "es" });
  });
  it("cannot read or overwrite records belonging to another company or user", async () => {
    const dir = await root(); const store = new FileUserLanguageStore("g03-production", dir);
    await store.write("rafa", "es");
    const foreign = new FileUserLanguageStore("company-b", dir);
    await expect(foreign.read("rafa")).rejects.toThrow("another identity");
    await expect(foreign.write("rafa", "en")).rejects.toThrow("another identity");
    await writeFile(path.join(dir, "settings/user-languages/jordi.json"), await readFile(path.join(dir, "settings/user-languages/rafa.json")));
    await expect(store.read("jordi")).rejects.toThrow("another identity");
    expect(await store.read("rafa")).toBe("es");
  });
  it("rejects linked paths, invalid identity paths and corrupt records", async () => {
    const dir = await root(), foreign = await root();
    await mkdir(path.join(dir, "settings")); await symlink(foreign, path.join(dir, "settings/user-languages"));
    const store = new FileUserLanguageStore("g03-production", dir);
    await expect(store.read("rafa")).rejects.toThrow("Unsafe");
    await expect(store.write("rafa", "es")).rejects.toThrow("Unsafe");
    await expect(stat(path.join(foreign, "rafa.json"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const userId of ["../rafa", "", "a/b", "..", "x".repeat(129)]) await expect(store.write(userId, "es")).rejects.toThrow("identity");
    const clean = await root(); await mkdir(path.join(clean, "settings/user-languages"), { recursive: true });
    for (const content of ["{", "x".repeat(4097), JSON.stringify({ schemaVersion: 1, installationId: "g03-production", userId: "rafa", locale: "fr" })]) {
      await writeFile(path.join(clean, "settings/user-languages/rafa.json"), content);
      await expect(new FileUserLanguageStore("g03-production", clean).read("rafa")).rejects.toThrow();
    }
  });
});
