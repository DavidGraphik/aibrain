import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { legacyWordText } from "./legacy-word-text";
const input = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(32), Buffer.from("WordDocument\0", "utf16le")]);
const gate = { run: async <T>(fn: () => Promise<T>) => fn() };
it("uses the existing sandbox, passive Word import and removes the private copy", async () => {
  let cwd = "";
  const run = vi.fn(async (_command, args, options) => {
    cwd = options.cwd;
    expect(args).toContain("--infilter=MS Word 97");
    expect(args).toEqual(expect.arrayContaining(["--safe-mode", "--norestore", "--headless"]));
    await writeFile(path.join(cwd, "source.txt"), "\uFEFFFITXA\r\nRevisió2026");
    return { stdout: "", stderr: "" };
  });
  expect(await legacyWordText(input, { conversionGate: gate, soffice: "/usr/local/bin/aibrain-soffice", runner: { run } })).toBe("FITXA\nRevisió2026");
  await expect(access(cwd)).rejects.toThrow();
});
it("rejects renamed binary types and an unapproved converter before execution", async () => {
  const run = vi.fn();
  await expect(legacyWordText(Buffer.from("not-doc"), { conversionGate: gate, runner: { run } })).rejects.toThrow("FORMAT_INVALID");
  await expect(legacyWordText(input, { conversionGate: gate, soffice: "/usr/bin/soffice", runner: { run } })).rejects.toThrow("SANDBOX_UNAVAILABLE");
  expect(run).not.toHaveBeenCalled();
});
it("rejects credential-shaped, binary or invalid UTF8 extraction and cleans up failures", async () => {
  for (const value of [Buffer.from("password=abcdefghijklmnopqrstu"), Buffer.from("abc\0def"), Buffer.from([255])]) {
    let cwd = "";
    await expect(legacyWordText(input, { conversionGate: gate, soffice: "/usr/local/bin/aibrain-soffice", runner: {run: async (_c, _a, o) => {cwd=o.cwd;await writeFile(path.join(cwd,"source.txt"),value);return {stdout:"",stderr:""};}}})).rejects.toThrow();
    await expect(access(cwd)).rejects.toThrow();
  }
});
