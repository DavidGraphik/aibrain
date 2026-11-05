import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { ResourceLockManager } from "@/storage/resource-lock";
import { FileDocumentStagingStore } from "./staging-store";
import { extractMacroWorkbook, stageMacroExcelUpload } from "./macro-excel-upload";
import { validateMacroWorkbookOriginal, validateUploadedDocumentFile } from "./upload-validation";

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const threadId = "11111111-1111-4111-8111-111111111111", uploadId = "22222222-2222-4222-8222-222222222222";
async function workbook(target = "worksheets/sheet1.xml", cell = '<c r="A1" t="s"><v>0</v></c><c r="B1"><f>WEBSERVICE("https://example.invalid/never")</f><v>42</v></c><c r="C1"><f>A1</f></c>') {
  const z = new JSZip();
  z.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>');
  z.file("xl/workbook.xml", `<workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  z.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/><Relationship Id="link" TargetMode="External" Target="https://example.invalid/never" Type="externalLink"/></Relationships>`);
  z.file("xl/sharedStrings.xml", `<sst ${NS}><si><t>=literal, not a formula</t></si></sst>`);
  z.file("xl/worksheets/sheet1.xml", `<worksheet ${NS}><sheetData><row r="1">${cell}</row></sheetData></worksheet>`);
  z.file("xl/vbaProject.bin", "INERT_TEST_VBA_PAYLOAD");
  return z.generateAsync({ type: "nodebuffer", compression: "STORE" });
}
describe("macro-enabled workbook passive upload", () => {
  it("keeps the exact original private and feeds only regenerated values/formula text to normal staging; retries reuse bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xlsm-test-"));
    try {
      const bytes = await workbook(), filePath = path.join(root, "source.xlsm");
      await writeFile(filePath, bytes, { mode: 0o600 });
      const input = { filePath, fileName: "Schedule.xlsm", declaredMimeType: "application/vnd.ms-excel.sheet.macroenabled.12", size: bytes.length, threadId, uploadId };
      await expect(validateUploadedDocumentFile(input)).rejects.toMatchObject({ code: "UPLOAD_MACROS_REJECTED" });
      expect((await validateMacroWorkbookOriginal(input)).sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      const locks = new ResourceLockManager({ rootDirectory: path.join(root, "locks") });
      const options = { locks, staging: new FileDocumentStagingStore(path.join(root, "staging"), locks), originals: new FileDocumentStagingStore(path.join(root, "originals"), locks), conversionGate: { run: async <T>(operation: () => Promise<T> | T) => operation() } };
      const doc = await stageMacroExcelUpload(input, options);
      expect(doc.legacyExcel).toMatchObject({ originalFileName: "Schedule.xlsm", formulaCount: 2, missingFormulaCaches: 1, cellCount: 3 });
      const original = await options.originals.resolveContentById(threadId, uploadId);
      expect(await readFile(path.join(options.originals.rootDirectory, original.document.relativePath))).toEqual(bytes);
      const passive = await readFile(path.join(options.staging.rootDirectory, doc.relativePath));
      const zip = await JSZip.loadAsync(passive);
      const xml = (await Promise.all(Object.values(zip.files).filter(e => !e.dir).map(e => e.async("string")))).join("\n");
      expect(xml).not.toMatch(/INERT_TEST_VBA_PAYLOAD|<f(?:\s|>)|TargetMode="External"|<hyperlink/);
      expect(xml).toContain("WEBSERVICE"); expect(xml).toContain("#UNVERIFIED_FORMULA_NO_SAVED_VALUE");
      expect(await stageMacroExcelUpload(input, options)).toEqual(doc);
      expect(await readFile(filePath)).toEqual(bytes);
      await expect(stageMacroExcelUpload({ ...input, size: input.size - 1 }, options)).rejects.toThrow();
      await writeFile(filePath, await workbook(undefined, '<c r="A1"><v>7</v></c>'), { mode: 0o600 });
      await expect(stageMacroExcelUpload({ ...input, size: (await readFile(filePath)).length }, options)).rejects.toMatchObject({ code: "STORAGE_STAGING_ID_CONFLICT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects traversal, corrupt XML, duplicate cells and unsafe passive-original MIME", async () => {
    await expect(extractMacroWorkbook(await workbook("../../unsafe.xml"))).rejects.toThrow();
    await expect(extractMacroWorkbook(await workbook(undefined, '<c r="A1"><v>1</v></c><c r="A1"><v>2</v></c>'))).rejects.toThrow();
    const bytes = await workbook(); const zip = await JSZip.loadAsync(bytes);
    zip.file("xl/worksheets/sheet1.xml", `<worksheet ${NS}><!DOCTYPE entity SYSTEM "file:///private"><sheetData/></worksheet>`);
    await expect(extractMacroWorkbook(await zip.generateAsync({ type: "nodebuffer" }))).rejects.toThrow();
    await expect(validateMacroWorkbookOriginal({ filePath: "/not-read", fileName: "Schedule.xlsm", declaredMimeType: "application/pdf" })).rejects.toMatchObject({ code: "UPLOAD_TYPE_MISMATCH" });
  });
  it("preserves spreadsheet epoch, saved dates and full modern coordinates without invoking formula evaluation", async () => {
    const zip = await JSZip.loadAsync(await workbook(undefined, '<c r="XFD1048576" s="1"><v>0.5</v></c>'));
    zip.file("xl/styles.xml", `<styleSheet ${NS}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="20"/></cellXfs></styleSheet>`);
    zip.file("xl/workbook.xml", (await zip.file("xl/workbook.xml")!.async("string")).replace("<sheets>",'<workbookPr date1904="1"/><sheets>'));
    const result = await extractMacroWorkbook(await zip.generateAsync({ type: "nodebuffer" }));
    expect(result.date1904).toBe(true); expect(result.sheets[0]!.cells).toEqual([[1048575, 16383, "date", 0.5, false]]);
  });
});
