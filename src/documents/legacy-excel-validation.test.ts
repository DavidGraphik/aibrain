import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateLocalDocument } from "@/runtime/documents/local-document-generator";
import { ResourceLockManager } from "@/storage/resource-lock";
import { FileDocumentStagingStore } from "./staging-store";
import { prepareTurnDocumentWorkspaceInputs, ServerTurnDocumentInputResolver } from "./turn-attachments";
import { describe, it, expect } from "vitest";
import { validateUploadedDocument, validateUploadedDocumentFile } from "./upload-validation";
import { makeAutoFilterProfile } from "../../tests/fixtures/legacy-autofilter";

const fixture = () => readFile(path.resolve("tests/infra/fixtures/knowledge-legacy.xls"));
const validate = (data: Buffer, fileName = "horaris.xls", declaredMimeType = "application/vnd.ms-excel") =>
  validateUploadedDocument({ data, fileName, declaredMimeType });

describe("legacy Excel attachments", () => {
  it.each(["legacy-autofilter", "legacy-autofilter-single", "legacy-autofilter-wide", "legacy-autofilter-maximum", "legacy-autofilter-multi"])(
    "admits %s through both upload paths independently of its filename", async fixtureName => {
    const data = await readFile(path.resolve(`tests/fixtures/${fixtureName}.xls`));
    const directory = await mkdtemp(path.join(tmpdir(), "xls-autofilter-"));
    try {
      const filePath = path.join(directory, "filters.xls");
      await writeFile(filePath, data, { mode: 0o600 });
      for (const fileName of ["filters.xls", "inventari fictici 2026.xls"]) {
        for (const mime of ["application/vnd.ms-excel", "application/octet-stream"]) {
          const accepted = validate(data, fileName, mime);
          expect(accepted.kind).toBe("xls");
          expect(await validateUploadedDocumentFile({ filePath, fileName, declaredMimeType: mime })).toEqual(accepted);
        }
      }
      expect(await readFile(filePath)).toEqual(data);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("keeps active controls and unbound or continued drawings out of both upload paths", async () => {
    const data = await readFile(path.resolve("tests/fixtures/legacy-autofilter.xls"));
    const profile = makeAutoFilterProfile();
    const object = data.indexOf(profile.sheets[0].pairs[0].object);
    const drawing = data.indexOf(profile.sheets[0].pairs[1].drawing);
    expect(object).toBeGreaterThan(512);
    expect(drawing).toBeGreaterThan(512);
    const cases: [number, number][] = [
      [object + 4, 7], // button, not auxiliary AutoFilter
      [object + 22, 4], // FtMacro instead of FtSbs
      [object + 50, 2], // nonempty object formula
      [object + 56, 0x0001], // ordinary form dropdown
      [drawing - 4, 0x003c], // continued, not independently bound Drawing
      [drawing + 32, 0x8382], // complex hyperlink property
    ];
    const directory = await mkdtemp(path.join(tmpdir(), "xls-filter-negatives-"));
    try {
      const filePath = path.join(directory, "unsafe.xls");
      for (const [offset, value] of cases) {
        const invalid = Buffer.from(data);
        invalid.writeUInt16LE(value, offset);
        await writeFile(filePath, invalid, { mode: 0o600 });
        for (const mime of ["application/vnd.ms-excel", "application/octet-stream"]) {
          expect(() => validate(invalid, "unsafe.xls", mime)).toThrowError(expect.objectContaining({ code: "UPLOAD_MACROS_REJECTED" }));
          await expect(validateUploadedDocumentFile({ filePath, fileName: "unsafe.xls", declaredMimeType: mime })).rejects.toMatchObject({ code: "UPLOAD_MACROS_REJECTED" });
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("accepts a structurally validated XLS sent with a generic binary MIME", async () => {
    const data = await fixture();
    const expected = validate(data);
    expect(validate(data, "horaris.xls", "application/octet-stream")).toEqual(expected);
    const directory = await mkdtemp(path.join(tmpdir(), "xls-binary-mime-"));
    try {
      const filePath = path.join(directory, "horaris.xls");
      await writeFile(filePath, data, { mode: 0o600 });
      expect(await validateUploadedDocumentFile({ filePath, fileName: "horaris.xls", declaredMimeType: "application/octet-stream" })).toEqual(expected);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("accepts a real Unicode, multi-sheet BIFF8 workbook and preserves its original hash", async () => {
    const data = await fixture();
    const result = validate(data);
    expect(result).toMatchObject({ kind: "xls", mediaType: "application/vnd.ms-excel", size: data.length });
    const directory = await mkdtemp(path.join(tmpdir(), "xls-upload-"));
    try {
      const filePath = path.join(directory, "horaris.xls");
      await writeFile(filePath, data, { mode: 0o600 });
      const locks = new ResourceLockManager({ rootDirectory: path.join(directory, "locks") });
      const stagingRoot = path.join(directory, "staging");
      const store = new FileDocumentStagingStore(stagingRoot, locks);
      const document = await store.stage({ threadId: "11111111-1111-4111-8111-111111111111", uploadId: "22222222-2222-4222-8222-222222222222", validated: result, data });
      expect((await store.readById(document.threadId, document.uploadId)).kind).toBe("xls");
      const resolver = new ServerTurnDocumentInputResolver({ stagingRoot, pdftotext: "/unused", workspaceXlsx: true, previews: {
        read: async () => { throw new Error("Original workbook should be used"); },
        readFile: async () => { throw new Error("Original workbook should be used"); },
      } });
      const codexInputs = await resolver.resolve(document);
      const converted = await generateLocalDocument({ format: "xlsx", title: "Fixture", content: "Synthetic conversion output", rows: [["Test", 12.5]] });
      const prepared = await prepareTurnDocumentWorkspaceInputs({ documents: [{ document, absolutePath: filePath, codexInputs }], projectWorkspace: directory, stagingRoot, legacyExcelConversion: {
        soffice: "/tools/soffice", conversionGate: { run: async operation => operation() },
        runner: { run: async (_command, args, options) => {
          expect(args).toContain("xlsx:Calc MS Excel 2007 XML");
          expect(args).toContain("--safe-mode");
          expect(await readFile(path.join(options.cwd, "source.xls"))).toEqual(data);
          await writeFile(path.join(options.cwd, "source.xlsx"), converted.data, { mode: 0o600 });
          return { stdout: "", stderr: "" };
        } },
      } });
      expect(await readFile(path.join(prepared.directory!, "input-1.xlsx"))).toEqual(converted.data);
      expect(await readFile(filePath)).toEqual(data);
      expect(prepared.codexInputs[0]).toMatchObject({ text: expect.stringContaining('"convertedFrom":"xls"') });
      expect(await validateUploadedDocumentFile({ filePath, fileName: "horaris.xls", declaredMimeType: "application/vnd.ms-excel" })).toEqual(result);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("rejects disguised formats, truncated containers and cyclic allocation chains", async () => {
    const data = await fixture();
    expect(() => validate(data, "horaris.xlsx")).toThrow();
    expect(() => validate(data, "horaris.xls", "application/pdf")).toThrow();
    expect(() => validate(data.subarray(0, 512))).toThrow();
    const cyclic = Buffer.from(data);
    const fat = cyclic.readUInt32LE(76);
    const directory = cyclic.readUInt32LE(48);
    cyclic.writeUInt32LE(directory, (fat + 1) * 512 + directory * 4);
    expect(() => validate(cyclic)).toThrow();
  });
  it("keeps generic binary MIME subject to filename, CFB and active-content rejection", async () => {
    const data = await fixture();
    const xlsx = await generateLocalDocument({ format: "xlsx", title: "Fixture", content: "Synthetic workbook", rows: [["Test", 12.5]] });
    expect(() => validate(xlsx.data, "renamed.xls", "application/octet-stream")).toThrow();
    expect(() => validate(xlsx.data, "original.xlsx", "application/octet-stream")).toThrow();
    const invalid: Buffer[] = [Buffer.from("renamed plain text"), data.subarray(0, 512)];
    const cyclic = Buffer.from(data);
    cyclic.writeUInt32LE(data.readUInt32LE(48), (data.readUInt32LE(76) + 1) * 512 + data.readUInt32LE(48) * 4);
    invalid.push(cyclic);
    const macro = Buffer.from(data);
    const directoryOffset = (data.readUInt32LE(48) + 1) * 512;
    Buffer.from("_VBA_PROJECT_CUR\0", "utf16le").copy(macro, directoryOffset + 128);
    macro.writeUInt16LE(34, directoryOffset + 128 + 64);
    invalid.push(macro);
    const bof = data.indexOf(Buffer.from("0908100000060500", "hex"));
    expect(bof).toBeGreaterThan(0);
    for (const id of [0x002f, 0x00d3, 0x01ba, 0x01b8, 0x005d]) {
      const active = Buffer.from(data);
      active.writeUInt16LE(id, bof + 20);
      invalid.push(active);
    }
    const macroSheet = Buffer.from(data);
    const sheetBof = data.indexOf(Buffer.from("0908100000061000", "hex"));
    expect(sheetBof).toBeGreaterThan(0);
    macroSheet.writeUInt16LE(0x0040, sheetBof + 6);
    invalid.push(macroSheet);
    const directory = await mkdtemp(path.join(tmpdir(), "xls-rejected-binary-"));
    try {
      const filePath = path.join(directory, "unsafe.xls");
      for (const bytes of invalid) {
        expect(() => validate(bytes, "unsafe.xls", "application/octet-stream")).toThrow();
        await writeFile(filePath, bytes, { mode: 0o600 });
        await expect(validateUploadedDocumentFile({ filePath, fileName: "unsafe.xls", declaredMimeType: "application/octet-stream" })).rejects.toThrow();
      }
      for (const fileName of ["renamed.xlsx", "renamed.doc", "renamed.exe"]) {
        expect(() => validate(data, fileName, "application/octet-stream")).toThrow();
      }
      for (const mime of ["", "application/pdf", "application/x-executable"]) {
        expect(() => validate(data, "unsafe.xls", mime)).toThrow();
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("rejects VBA storages, encryption and Excel 4 macro sheets", async () => {
    const data = await fixture();
    const directoryOffset = (data.readUInt32LE(48) + 1) * 512;
    const macro = Buffer.from(data);
    Buffer.from("_VBA_PROJECT_CUR\0", "utf16le").copy(macro, directoryOffset + 128);
    macro.writeUInt16LE(34, directoryOffset + 128 + 64);
    expect(() => validate(macro)).toThrow();
    const bof = data.indexOf(Buffer.from("0908100000060500", "hex"));
    expect(bof).toBeGreaterThan(0);
    const encrypted = Buffer.from(data);
    encrypted.writeUInt16LE(0x002f, bof + 20);
    expect(() => validate(encrypted)).toThrow();
    const macroSheet = Buffer.from(data);
    const sheetBof = data.indexOf(Buffer.from("0908100000061000", "hex"));
    expect(sheetBof).toBeGreaterThan(0);
    macroSheet.writeUInt16LE(0x0040, sheetBof + 6);
    expect(() => validate(macroSheet)).toThrow();
  });
});
