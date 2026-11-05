import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { convertLegacyExcelToXlsx } from "./legacy-excel-conversion";

const gate = { run: async <T>(operation: () => T | Promise<T>) => operation() };
describe("legacy workbook conversion failure boundaries", () => {
  it("rejects invalid source before starting a native tool", async () => {
    let ran = false;
    await expect(convertLegacyExcelToXlsx(Buffer.from("invalid"), { soffice: "/tools/soffice", conversionGate: gate, runner: { run: async () => { ran = true; return { stdout: "", stderr: "" }; } } })).rejects.toThrow();
    expect(ran).toBe(false);
  });
  it.each(["missing", "invalid", "symlink"])("rejects %s output and cleans the conversion directory", async mode => {
    const data = await readFile(path.resolve("tests/infra/fixtures/knowledge-legacy.xls"));
    let work = "";
    await expect(convertLegacyExcelToXlsx(data, { soffice: "/tools/soffice", conversionGate: gate, runner: { run: async (_command, _args, options) => {
      work = options.cwd;
      if (mode === "invalid") await writeFile(path.join(work, "source.xlsx"), "not a workbook");
      if (mode === "symlink") { const { symlink } = await import("node:fs/promises"); await symlink(path.join(work, "source.xls"), path.join(work, "source.xlsx")); }
      return { stdout: "", stderr: "" };
    } } })).rejects.toThrow();
    await expect(readFile(path.join(work, "source.xls"))).rejects.toThrow();
  });
  it("propagates conversion admission rejection without running a tool", async () => {
    const data = await readFile(path.resolve("tests/infra/fixtures/knowledge-legacy.xls"));
    await expect(convertLegacyExcelToXlsx(data, { soffice: "/tools/soffice", conversionGate: { run: async () => { throw new Error("capacity"); } } })).rejects.toThrow("capacity");
  });
});
