import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { inspectLocalFormula, inspectNativeWorkbook, supportsNativeLegacyExcel } from "./legacy-excel-native-profile";
import { inspectLegacyTheme } from "./legacy-excel-theme";
import { inspectNativeExcelOutput } from "./legacy-excel-upload";

function record(id: number, body: Buffer) {
  const header = Buffer.alloc(4); header.writeUInt16LE(id); header.writeUInt16LE(body.length, 2);
  return Buffer.concat([header, body]);
}
function bof(kind: number) { const b = Buffer.alloc(16); b.writeUInt16LE(0x600); b.writeUInt16LE(kind, 2); return record(0x809, b); }
function workbook(globals: Buffer[] = [], sheet: Buffer[] = []) {
  const bound = Buffer.alloc(9); bound[6] = 1; bound[8] = 65;
  const eof = record(0xa, Buffer.alloc(0));
  bound.writeUInt32LE(20 + 13 + Buffer.concat(globals).length + 4);
  return Buffer.concat([bof(5), record(0x85, bound), ...globals, eof, bof(0x10), ...sheet, eof]);
}
function formula(tokens: Buffer) {
  const b = Buffer.alloc(22); b.writeUInt16LE(tokens.length, 20);
  return record(6, Buffer.concat([b, tokens]));
}
const int = (n: number) => Buffer.from([0x1e, n & 255, n >>> 8]);
function frt(id: number, length: number) { const b = Buffer.alloc(length); b.writeUInt16LE(id); return b; }
async function theme(mutate?: (parts: Map<string, string>) => void) {
  const rel = "http://schemas.openxmlformats.org/package/2006/relationships";
  const office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
  const drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const parts = new Map([
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'],
    ["_rels/.rels", `<Relationships xmlns="${rel}"><Relationship Id="rId1" Type="${office}officeDocument" Target="theme/theme/themeManager.xml"/></Relationships>`],
    ["theme/theme/_rels/themeManager.xml.rels", `<Relationships xmlns="${rel}"><Relationship Id="rId1" Type="${office}theme" Target="theme1.xml"/></Relationships>`],
    ["theme/theme/themeManager.xml", `<a:themeManager xmlns:a="${drawing}"/>`],
    ["theme/theme/theme1.xml", `<a:theme xmlns:a="${drawing}" name="Fictional"><a:themeElements><a:clrScheme name="Synthetic"><a:dk1><a:srgbClr val="102030"/></a:dk1></a:clrScheme></a:themeElements></a:theme>`],
  ]);
  mutate?.(parts);
  const zip = new JSZip(); for (const [name, xml] of parts) zip.file(name, xml, { createFolders: false });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("closed native XLS selector", () => {
  it.each(["legacy-autofilter", "legacy-autofilter-single", "legacy-autofilter-wide", "legacy-autofilter-maximum", "legacy-autofilter-multi"])("preserves the native path for %s", async name => {
    expect(supportsNativeLegacyExcel(await readFile(`tests/fixtures/${name}.xls`))).toBe(true);
  });
  it("keeps the macro/link carrier on the passive path", async () => {
    expect(supportsNativeLegacyExcel(await readFile("tests/fixtures/legacy-passive-links-macros.xls"))).toBe(false);
  });
  it.each([0x23, 0x2f, 0x50, 0x51, 0x52, 0x59, 0x5a, 0x9a, 0xb0, 0xd3, 0xdc, 0x1ad, 0x1b0, 0x1b1, 0x1b2, 0x1b8, 0x1ba, 0x1be, 0x221, 0x236, 0x418, 0x4bc, 0x800, 0x801, 0x803, 0x80a, 0x813, 0x851, 0x868, 0x872, 0x876, 0x878, 0x87a, 0x884, 0x897, 0x898, 0x899, 0xffff])("does not hand record %i to Office", id => {
    expect(() => inspectNativeWorkbook(workbook([record(id, Buffer.alloc(16))]))).toThrow();
  });
  it("checks full local SUM/arithmetic tokens including all bytes after the result", () => {
    const arithmetic = Buffer.concat([int(2), int(3), Buffer.from([5])]);
    const sum = Buffer.concat([int(2), int(3), Buffer.from([0x42, 2, 4, 0])]);
    for (const tokens of [arithmetic, sum, Buffer.concat([int(9), Buffer.from([0x19, 0x10, 0, 0])])]) {
      expect(() => inspectNativeWorkbook(workbook([], [formula(tokens)]))).not.toThrow();
      expect(() => inspectLocalFormula(tokens.subarray(0, -1))).toThrow();
      expect(() => inspectLocalFormula(Buffer.concat([tokens, Buffer.from([0x23, 0, 0, 0, 0])]))).toThrow();
    }
  });
  it("rejects every function except SUM, including every high-bit command", () => {
    for (let func = 0; func <= 0xffff; func++) {
      if (func === 4) continue;
      const tokens = Buffer.concat([int(1), Buffer.from([0x42, 1, func & 255, func >>> 8])]);
      expect(() => inspectLocalFormula(tokens)).toThrow();
    }
  });
  it.each([0x00, 0x01, 0x02, 0x16, 0x17, 0x18, 0x20, 0x21, 0x23, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x80, 0xff])("rejects unsupported token %i and class variants", id => {
    for (const variant of [id, ...(id >= 0x20 && id < 0x40 ? [id + 0x20, id + 0x40] : [])]) {
      expect(() => inspectLocalFormula(Buffer.concat([Buffer.from([variant]), Buffer.alloc(16)]))).toThrow();
    }
  });
  it("accepts only self-referencing SupBook and in-bounds same-book XTI", () => {
    const sup = Buffer.from([1, 0, 1, 4]), xti = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => inspectNativeWorkbook(workbook([record(0x1ae, sup), record(0x17, xti)]))).not.toThrow();
    for (const marker of [0, 1, 0x3a01, 0xffff]) {
      const b = Buffer.from(sup); b.writeUInt16LE(marker, 2);
      expect(() => inspectNativeWorkbook(workbook([record(0x1ae, b)]))).toThrow();
    }
    for (const offset of [2, 4, 6]) {
      const b = Buffer.from(xti); b.writeUInt16LE(0xffff, offset);
      expect(() => inspectNativeWorkbook(workbook([record(0x1ae, sup), record(0x17, b)]))).toThrow();
    }
  });
  it("rejects every defined name except a local inert FilterDatabase range", () => {
    const sup = record(0x1ae, Buffer.from([1, 0, 1, 4])), xti = record(0x17, Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]));
    const name = Buffer.alloc(27); name.writeUInt16LE(0x21); name[3] = 1; name[4] = 11; name[8] = 1; name[15] = 13; name[16] = 0x3b; name[21] = 2; name[25] = 2;
    const inspect = (b: Buffer) => inspectNativeWorkbook(workbook([sup, xti, record(0x18, b)]));
    expect(() => inspect(name)).not.toThrow();
    for (const [offset, value] of [[0, 0x23], [2, 0x41], [3, 2], [4, 10], [8, 0], [10, 1], [14, 1], [15, 1], [16, 0x23], [17, 1], [26, 1]]) {
      const b = Buffer.from(name); b[offset!] = value!; expect(() => inspect(b)).toThrow();
    }
  });
  it("refuses orphan continuations, alternate substreams, trailing records and malformed lengths", () => {
    const safe = workbook();
    for (const bytes of [safe.subarray(0, -1), Buffer.concat([safe, record(0x203, Buffer.alloc(14))]), workbook([record(0x3c, Buffer.alloc(3))]), workbook([record(0x87f, frt(0x87f, 12))]), workbook([record(0x161, Buffer.from([1, 0]))]), workbook([], [bof(0x40)])]) {
      expect(() => inspectNativeWorkbook(bytes)).toThrow();
    }
  });
  it("permits bounded colour/font themes and rejects executable resources, namespace aliases and DTDs", async () => {
    const safe = await theme();
    expect(() => inspectLegacyTheme(safe)).not.toThrow();
    const recordBody = Buffer.concat([frt(0x896, 16), safe]);
    expect(() => inspectNativeWorkbook(workbook([record(0x896, recordBody)]))).not.toThrow();
    for (const mutation of [
      (p: Map<string, string>) => p.set("theme/theme/theme1.xml", p.get("theme/theme/theme1.xml")!.replace("<a:themeElements>", '<a:blip r:link="rId99" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:themeElements>')),
      (p: Map<string, string>) => p.set("theme/theme/theme1.xml", p.get("theme/theme/theme1.xml")!.replace("drawingml/2006/main", "unknown/namespace")),
      (p: Map<string, string>) => p.set("theme/theme/theme1.xml", '<!DOCTYPE a:theme [<!ENTITY ext SYSTEM "file:///private">]>' + p.get("theme/theme/theme1.xml")),
      (p: Map<string, string>) => p.set("_rels/.rels", p.get("_rels/.rels")!.replace('Target="theme/theme/themeManager.xml"', 'Target="https://example.invalid" TargetMode="External"')),
      (p: Map<string, string>) => p.set("_rels/.rels", p.get("_rels/.rels")!.replace('Target="theme/theme/themeManager.xml"', 'Target="&#104;ttps://example.invalid"')),
      (p: Map<string, string>) => p.set("theme/theme/theme1.xml", p.get("theme/theme/theme1.xml")!.replace('name="Fictional"', 'xmlns:x="urn:external" x:link="file:///private"')),
      (p: Map<string, string>) => p.set("theme/theme/theme1.xml", " ".repeat(100_000)),
      (p: Map<string, string>) => p.set("theme/theme/vbaProject.bin", "INERT"),
    ]) {
      const bytes = await theme(mutation);
      expect(() => inspectLegacyTheme(bytes)).toThrow();
    }
    const corrupt = Buffer.from(safe); corrupt[40] = corrupt[40]! ^ 1;
    expect(() => inspectLegacyTheme(corrupt)).toThrow();
  });
  it("binds extended filter continuations to exact criteria counts, references and types", () => {
    const filter = frt(0x87e, 60); filter[2] = 1; filter.writeUInt32LE(1, 26); filter[34] = 8; filter.writeUInt32LE(0xffffffff, 40);
    const continued = frt(0x87f, 22); continued[2] = 1; continued[12] = 12; continued[13] = 2;
    const inspect = (f: Buffer, c: Buffer) => inspectNativeWorkbook(workbook([], [record(0x87e, f), record(0x87f, c)]));
    expect(() => inspect(filter, continued)).not.toThrow();
    for (const [offset, value] of [[18, 1], [22, 1], [26, 2], [34, 0], [40, 0], [44, 1]]) {
      const b = Buffer.from(filter); b[offset!] = value!; expect(() => inspect(b, continued)).toThrow();
    }
    for (const [offset, value] of [[0, 0], [4, 1], [12, 2], [12, 6], [12, 255], [13, 255]]) {
      const b = Buffer.from(continued); b[offset!] = value!; expect(() => inspect(filter, b)).toThrow();
    }
    expect(() => inspectNativeWorkbook(workbook([], [record(0x87e, filter)]))).toThrow();
  });
  it("does not accept header images, arbitrary drawings or smart-tag data as formatting", () => {
    const hf = frt(0x866, 78); hf[12] = 2; hf.writeUInt16LE(15, 14); hf.writeUInt16LE(0xf000, 16); hf.writeUInt32LE(56, 18);
    hf.writeUInt32LE(0xf0060000, 22); hf.writeUInt32LE(24, 26); hf.writeUInt32LE(1025, 30); hf.writeUInt32LE(2, 34);
    hf.writeUInt32LE(1, 38); hf.writeUInt32LE(1, 46); hf.writeUInt32LE(1, 50); hf.writeUInt32LE(0xf11e0040, 54); hf.writeUInt32LE(16, 58);
    expect(() => inspectNativeWorkbook(workbook([record(0x866, hf)]))).not.toThrow();
    for (const offset of [12, 14, 16, 18, 22, 26, 34, 38, 42, 50, 54, 58]) {
      const b = Buffer.from(hf); b[offset] = b[offset]! ^ 1;
      expect(() => inspectNativeWorkbook(workbook([record(0x866, b)]))).toThrow();
    }
    expect(() => inspectNativeWorkbook(workbook([record(0xeb, Buffer.alloc(8))]))).toThrow();
    const feature = frt(0x867, 23); feature[12] = 2; feature[14] = 1; feature.writeUInt32LE(0xffffffff, 15); feature[19] = 3;
    expect(() => inspectNativeWorkbook(workbook([record(0x867, feature)]))).not.toThrow();
    feature[12] = 4;
    expect(() => inspectNativeWorkbook(workbook([record(0x867, feature)]))).toThrow();
  });
  it("validates native XLSX results again before staging, including entity-encoded links", async () => {
    const make = async (f: string, relationship = "") => {
      const zip = new JSZip();
      zip.file("xl/worksheets/sheet1.xml", `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c><f>${f}</f></c></row></sheetData></worksheet>`);
      if (relationship) zip.file("xl/_rels/workbook.xml.rels", relationship);
      return zip.generateAsync({ type: "nodebuffer" });
    };
    await expect(inspectNativeExcelOutput(await make("SUM($A$1,A2)*2"))).resolves.toBeUndefined();
    for (const f of ['WEBSERVICE("https://example.invalid")', 'EXEC("x")', "Sheet1!A1", "[Other]A1", "_xlfn.SUM(A1)"]) {
      await expect(inspectNativeExcelOutput(await make(f))).rejects.toThrow();
    }
    await expect(inspectNativeExcelOutput(await make("SUM(A1)", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="x" Type="x" Target="https&#58;//example.invalid" TargetMode="External"/></Relationships>'))).rejects.toThrow();
  });
});
