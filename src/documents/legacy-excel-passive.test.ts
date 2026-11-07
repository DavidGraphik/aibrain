import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import resultFixture from "../../tests/fixtures/legacy-passive-result.json";
import { buildPassiveExcel, preparePassiveLegacyExcelUpload, validatePassiveExcelResult } from "./legacy-excel-passive";
import { readPassiveLegacyExcelContainer } from "./legacy-excel-validation";
import { validateUploadedDocument } from "./upload-validation";
import { parseLegacyExcelProvenance } from "./legacy-excel-policy";

const fixture = () => readFile("tests/fixtures/legacy-passive-links-macros.xls");
const result = () => validatePassiveExcelResult(structuredClone(resultFixture));
const provenance = () => parseLegacyExcelProvenance({
  policy: "values-only-v1", originalFileName: "example.xls", originalSha256: "a".repeat(64), originalSize: 9728,
  sheetCount: 1, cellCount: 9, formulaCount: 3, missingFormulaCaches: 3, undecodedFormulas: 0, omittedSheets: 0, omittedStreams: 1,
});

describe("passive legacy Excel boundary", () => {
  it("keeps a VBA/link carrier rejected by normal admission but extracts only its bounded Workbook stream", async () => {
    const data = await fixture();
    expect(() => validateUploadedDocument({ data, fileName: "example.xls", declaredMimeType: "application/vnd.ms-excel" })).toThrow();
    const container = readPassiveLegacyExcelContainer(data);
    expect(container.storages).toBe(1);
    expect(container.opaqueStreams).toBe(1);
    expect(container.workbook.includes(Buffer.from("INERT_TEST_VBA_PAYLOAD"))).toBe(false);
    expect(data.includes(Buffer.from("INERT_TEST_VBA_PAYLOAD"))).toBe(true);
  });

  it("regenerates deterministic XLSX values and warnings, with no active formulas, hyperlinks or opaque bytes", async () => {
    const extracted = result();
    extracted.sheets[0]!.cells[0]![3] = '=WEBSERVICE("https://example.invalid/do-not-open")';
    const bytes = await buildPassiveExcel(extracted, provenance());
    expect(await buildPassiveExcel(extracted, provenance())).toEqual(bytes);
    const zip = await JSZip.loadAsync(bytes);
    const entries = await Promise.all(Object.values(zip.files).filter(entry => !entry.dir).map(async entry => [entry.name, await entry.async("string")]));
    const xml = entries.map(([, content]) => content).join("\n");
    expect(xml).not.toMatch(/<f(?:\s|>)/);
    expect(xml).not.toMatch(/<hyperlink|TargetMode="External"|INERT_TEST_VBA_PAYLOAD/);
    expect(xml).toContain('t="inlineStr"');
    expect(xml).toContain("WEBSERVICE"); // literal text, never a formula
    expect(xml).toContain("no verificados");
    expect(xml).toContain("#UNVERIFIED_FORMULA_NO_SAVED_VALUE");
    expect(validateUploadedDocument({ data: bytes, fileName: "passive.xlsx", declaredMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }).kind).toBe("xlsx");
  });

  it.each([
    ["unrecognized relationships", (r: Record<string, unknown>) => { r.externalLinks = ["https://example.invalid"]; }],
    ["nonfinite value", (r: ReturnType<typeof result>) => { r.sheets[0]!.cells[3]![3] = Infinity; }],
    ["duplicate coordinate", (r: ReturnType<typeof result>) => { r.sheets[0]!.cells.push(r.sheets[0]!.cells[0]!); }],
    ["out of bounds row", (r: ReturnType<typeof result>) => { r.sheets[0]!.cells[0]![0] = 65536; }],
    ["executable cell type", (r: ReturnType<typeof result>) => { (r.sheets[0]!.cells[0] as unknown[])[2] = "formula"; }],
    ["invalid XML characters", (r: ReturnType<typeof result>) => { r.sheets[0]!.cells[0]![3] = "\u0000"; }],
    ["claimed verified cache", (r: ReturnType<typeof result>) => { (r.sheets[0]!.formulas[0] as unknown[])[3] = "verified"; }],
    ["missing formula provenance", (r: ReturnType<typeof result>) => { r.sheets[0]!.formulas.pop(); }],
    ["unbound formula", (r: ReturnType<typeof result>) => { r.sheets[0]!.formulas[0]![0] = 60; }],
    ["false totals", (r: ReturnType<typeof result>) => { r.cellCount = 1; }],
  ] as const)("rejects %s from the reader", (_name, mutate) => {
    const extracted = result();
    mutate(extracted);
    expect(() => validatePassiveExcelResult(extracted)).toThrow();
  });

  it("passes only raw BIFF to the isolated runner, preserves source bytes and adds derivative provenance", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "passive-xls-test-"));
    const bytes = await fixture();
    const filePath = path.join(directory, "original.xls");
    await writeFile(filePath, bytes, { mode: 0o600 });
    const run = vi.fn(async (_command, args, options) => {
      expect(args).toEqual([]);
      const input = await readFile(path.join(options.cwd, "source.biff"));
      expect(input.includes(Buffer.from("INERT_TEST_VBA_PAYLOAD"))).toBe(false);
      expect(input.subarray(0, 2)).toEqual(Buffer.from([9, 8]));
      await writeFile(path.join(options.cwd, "output/result.json"), JSON.stringify(result()), { mode: 0o600 });
      return { stdout: "", stderr: "" };
    });
    try {
      const prepared = await preparePassiveLegacyExcelUpload({ fileName: "original.xls", declaredMimeType: "application/octet-stream", filePath }, {
        reader: "/tools/isolated-passive-reader", conversionGate: { run: async operation => operation() }, runner: { run },
      });
      expect(prepared.originalValidated.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(prepared.validated).toMatchObject({ kind: "xlsx", fileName: "original.passive.xlsx", legacyExcel: { policy: "values-only-v1", formulaCount: 3 } });
      expect(await readFile(filePath)).toEqual(bytes);
      expect(run).toHaveBeenCalledOnce();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("refuses corrupted/encrypted CFB before any reader can start", async () => {
    const bytes = await fixture();
    const corrupt = Buffer.from(bytes);
    corrupt.writeUInt32LE(0xffffffff, 48);
    expect(() => readPassiveLegacyExcelContainer(corrupt)).toThrow();
    const encrypted = Buffer.from(bytes);
    const bof = encrypted.indexOf(Buffer.from("0908100000060500", "hex"));
    expect(bof).toBeGreaterThan(0);
    encrypted.writeUInt16LE(0x2f, bof + 20);
    expect(() => readPassiveLegacyExcelContainer(encrypted)).toThrowError(expect.objectContaining({ code: "UPLOAD_ENCRYPTED_REJECTED" }));
  });

  it("bounds escaped XML expansion before assembling an oversized workbook", async () => {
    const extracted = result();
    extracted.sheets[0]!.cells = Array.from({ length: 1000 }, (_, index) => [index, 0, "text", "&".repeat(32767), false]);
    extracted.sheets[0]!.formulas = [];
    Object.assign(extracted, { cellCount: 1000, formulaCount: 0, missingFormulaCaches: 0, undecodedFormulas: 0 });
    const metadata = { ...provenance(), cellCount: 1000, formulaCount: 0, missingFormulaCaches: 0 };
    await expect(buildPassiveExcel(extracted, metadata)).rejects.toMatchObject({ code: "UPLOAD_PASSIVE_XLS_INVALID" });
  });
});
