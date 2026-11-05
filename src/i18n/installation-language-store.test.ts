import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileInstallationLanguageStore } from "./installation-language-store";
const roots: string[] = [];
async function root() { const dir = await mkdtemp(path.join(os.tmpdir(), "aibrain-language-test-")); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe("installation language persistence", () => {
  it("defaults to English and keeps each company's choice after a restart", async () => {
    const a = await root(), b = await root();
    const first = new FileInstallationLanguageStore("company-a", a);
    expect(await first.read()).toBe("en");
    await first.write("es", "admin-a");
    expect(await new FileInstallationLanguageStore("company-a", a).read()).toBe("es");
    expect(await new FileInstallationLanguageStore("company-b", b).read()).toBe("en");
    expect((await stat(path.join(a, "settings/language.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path.join(a, "settings/language.json"), "utf8"))).toMatchObject({ updatedBy: "admin-a", installationId: "company-a" });
    await first.write("en", "admin-a");
    expect(await first.read()).toBe("en");
  });
  it("fails closed for a foreign record and cannot overwrite it", async () => {
    const dir = await root();
    await new FileInstallationLanguageStore("company-a", dir).write("es", "admin-a");
    const foreign = new FileInstallationLanguageStore("company-b", dir);
    await expect(foreign.read()).rejects.toThrow("another installation");
    await expect(foreign.write("en", "admin-b")).rejects.toThrow();
    expect(await new FileInstallationLanguageStore("company-a", dir).read()).toBe("es");
  });
  it("rejects linked settings even when the target preference does not exist", async () => {
    const dir = await root(), foreign = await root();
    await symlink(foreign, path.join(dir, "settings"));
    const store = new FileInstallationLanguageStore("company-a", dir);
    await expect(store.read()).rejects.toThrow("Unsafe");
    await expect(store.write("es", "admin-a")).rejects.toThrow("Unsafe");
    await expect(stat(path.join(foreign, "language.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects invalid, oversized and corrupt records without falling back silently", async () => {
    const dir = await root(); await mkdir(path.join(dir, "settings"));
    const store = new FileInstallationLanguageStore("company-a", dir);
    for (const content of ["{", "x".repeat(4097), JSON.stringify({ schemaVersion: 1, installationId: "company-a", locale: "fr", updatedBy: "admin" })]) {
      await writeFile(path.join(dir, "settings/language.json"), content);
      await expect(store.read()).rejects.toThrow();
    }
  });
});
