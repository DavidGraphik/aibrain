import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { readRegularFileWithin } from "@/security/safe-file";
import { StorageError, type ResourceLockManager } from "@/storage";
import type { FileDocumentStagingStore } from "./staging-store";
import type { DocumentConversionAdmission } from "./conversion-gate";
import { buildPassiveExcel, validatePassiveExcelResult } from "./legacy-excel-passive";
import { parseLegacyExcelProvenance } from "./legacy-excel-policy";
import { validateMacroWorkbookOriginal, validateUploadedDocument, UploadValidationError } from "./upload-validation";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function check(ok: unknown): asserts ok {
  if (!ok) throw new UploadValidationError("UPLOAD_PASSIVE_XLS_INVALID", "Workbook saved-data structure is invalid or exceeds its bounded reader.");
}
const attr = (tag: SaxesTagNS, name: string) => Object.values(tag.attributes).find(a => a.local === name)?.value;

/** Reads only named XML data parts. No Office process, formulas, URLs, VBA or objects. */
export async function extractMacroWorkbook(data: Buffer, signal?: AbortSignal) {
  check(data.length <= 50 * 1024 * 1024);
  const zip = await JSZip.loadAsync(data);
  check(Object.keys(zip.files).length <= 5000);
  let totalXml = 0;
  async function parse(name: string, handlers: {
    open?: (tag: SaxesTagNS) => void; close?: (tag: SaxesTagNS) => void; text?: (value: string) => void;
  }) {
    const entry = zip.file(name); check(entry);
    const parser = new SaxesParser({ xmlns: true });
    let depth = 0, size = 0;
    parser.on("doctype", () => check(false));
    parser.on("processinginstruction", () => check(false));
    parser.on("opentag", tag => { check(++depth <= 64); handlers.open?.(tag); });
    parser.on("closetag", tag => { handlers.close?.(tag); depth--; });
    parser.on("text", value => handlers.text?.(value));
    parser.on("cdata", value => handlers.text?.(value));
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for await (const chunk of new Readable({ objectMode: false }).wrap(entry.nodeStream())) {
      if (signal?.aborted) throw new StorageError("DOCUMENT_OPERATION_ABORTED", "Workbook reading aborted.");
      const bytes = Buffer.from(chunk); size += bytes.length; totalXml += bytes.length;
      check(size <= 64 * 1024 * 1024 && totalXml <= 250 * 1024 * 1024);
      parser.write(decoder.decode(bytes, { stream: true }));
    }
    parser.write(decoder.decode()).close(); check(depth === 0);
  }
  const sheets: Array<{ name: string; id: string }> = [];
  let date1904 = false;
  await parse("xl/workbook.xml", { open: tag => {
    if (tag.uri !== NS) return;
    if (tag.local === "workbookPr") date1904 = ["1", "true"].includes(attr(tag, "date1904") ?? "");
    if (tag.local === "sheet") { check(sheets.length < 100); sheets.push({ name: attr(tag, "name") ?? "", id: attr(tag, "id") ?? "" }); }
  }});
  const targets = new Map<string, string>();
  let linkRecords = 0;
  await parse("xl/_rels/workbook.xml.rels", { open: tag => {
    if (tag.uri !== REL || tag.local !== "Relationship") return;
    if (attr(tag, "TargetMode") === "External") { linkRecords++; return; }
    if (!attr(tag, "Type")?.endsWith("/worksheet")) return;
    const target = attr(tag, "Target") ?? "";
    const resolved = path.posix.normalize(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    check(/^xl\/worksheets\/[^/\\]+\.xml$/.test(resolved) && !target.includes(":"));
    const id = attr(tag, "Id") ?? ""; check(id && !targets.has(id)); targets.set(id, resolved);
  }});
  const strings: string[] = [];
  let stringBytes = 0;
  if (zip.file("xl/sharedStrings.xml")) {
    let current: string | null = null, inText = false;
    await parse("xl/sharedStrings.xml", {
      open: tag => { if (tag.uri !== NS) return; if (tag.local === "si") { check(current === null); current = ""; } if (tag.local === "t") inText = true; },
      text: value => { if (inText && current !== null) { current += value; check(current.length <= 32767); } },
      close: tag => { if (tag.uri !== NS) return; if (tag.local === "t") inText = false; if (tag.local === "si") { check(current !== null && strings.length < 500000); stringBytes += Buffer.byteLength(current); check(stringBytes <= 40 * 1024 * 1024); strings.push(current); current = null; } },
    });
  }
  const dateStyles = new Set<number>();
  if (zip.file("xl/styles.xml")) {
    const formats = new Map<number, string>(); let inCellXfs = false, index = 0;
    await parse("xl/styles.xml", { open: tag => {
      if (tag.uri !== NS) return;
      if (tag.local === "numFmt") formats.set(Number(attr(tag, "numFmtId")), attr(tag, "formatCode") ?? "");
      if (tag.local === "cellXfs") inCellXfs = true;
      if (tag.local === "xf" && inCellXfs) {
        const id = Number(attr(tag, "numFmtId"));
        const format = (formats.get(id) ?? "").replace(/"[^\"]*"|\\./g, "").replace(/\[(?![hms]+\])[^\]]*\]/gi, "");
        if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[ymdhs]/i.test(format)) dateStyles.add(index);
        check(++index <= 65536);
      }
    }, close: tag => { if (tag.uri === NS && tag.local === "cellXfs") inCellXfs = false; }});
  }
  const result: ReturnType<typeof validatePassiveExcelResult> = {
    schemaVersion: 1, reader: "ooxml-values-v1", date1904, sheets: [], cellCount: 0, formulaCount: 0,
    missingFormulaCaches: 0, undecodedFormulas: 0, omittedSheets: 0, linkRecords,
  };
  for (const sheet of sheets) {
    const target = targets.get(sheet.id);
    if (!target) { result.omittedSheets++; continue; }
    const cells: (typeof result.sheets)[number]["cells"] = [], formulas: (typeof result.sheets)[number]["formulas"] = [];
    let cell: { row: number; col: number; type: string; style: number; value: string; inline: string; formula: string; hasFormula: boolean } | null = null;
    let field = "";
    await parse(target, {
      open: tag => {
        if (tag.uri !== NS) return;
        if (tag.local === "c") {
          check(cell === null); const coordinate = /^(\p{Lu}{1,3})([1-9][0-9]*)$/u.exec(attr(tag, "r") ?? ""); check(coordinate);
          let col = 0; for (const c of coordinate[1]!) col = col * 26 + c.charCodeAt(0) - 64;
          const row = Number(coordinate[2]) - 1; check(row < 1048576 && col <= 16384);
          cell = { row, col: col - 1, type: attr(tag, "t") ?? "n", style: Number(attr(tag, "s") ?? 0), value: "", inline: "", formula: "", hasFormula: false };
        }
        if (cell && ["v", "t", "f"].includes(tag.local)) { field = tag.local; if (field === "f") cell.hasFormula = true; }
      },
      text: value => {
        if (!cell || !field) return;
        const key = field === "v" ? "value" : field === "t" ? "inline" : "formula";
        cell[key] += value; check(cell[key].length <= 32767);
      },
      close: tag => {
        if (tag.uri !== NS) return;
        if (["v", "t", "f"].includes(tag.local)) field = "";
        if (tag.local !== "c" || !cell) return;
        const c = cell; cell = null;
        const missing = c.hasFormula && c.value === "";
        let kind: (typeof cells)[number][2] = "text";
        let value: string | number | boolean = missing ? "#UNVERIFIED_FORMULA_NO_SAVED_VALUE" : c.value;
        if (!missing) {
          if (c.type === "s") { check(/^\d+$/.test(c.value) && Number(c.value) < strings.length); value = strings[Number(c.value)]!; }
          else if (c.type === "inlineStr") value = c.inline;
          else if (c.type === "b") { check(["0", "1"].includes(c.value)); kind = "boolean"; value = c.value === "1"; }
          else if (c.type === "e") kind = "error";
          else if (c.type === "n" && c.value !== "") { check(Number.isFinite(Number(c.value))); kind = dateStyles.has(c.style) ? "date" : "number"; value = Number(c.value); }
          else check(["n", "str", "d"].includes(c.type));
        }
        if (value === "" && !c.hasFormula) return;
        check(++result.cellCount <= 500000); cells.push([c.row, c.col, kind, value, c.hasFormula]);
        if (c.hasFormula) {
          check(++result.formulaCount <= 500000);
          if (missing) result.missingFormulaCaches++;
          if (!c.formula) result.undecodedFormulas++;
          formulas.push([c.row, c.col, c.formula || "[Fórmula compartida/array sin expresión local]", missing ? "missing" : "unverified"]);
        }
      },
    });
    result.sheets.push({ name: sheet.name, cells, formulas });
  }
  return validatePassiveExcelResult(result);
}

export async function stageMacroExcelUpload(input: { fileName: string; declaredMimeType: string; filePath: string; threadId: string; uploadId: string; size: number }, options: {
  locks: ResourceLockManager; staging: FileDocumentStagingStore; originals: FileDocumentStagingStore;
  conversionGate: DocumentConversionAdmission; signal?: AbortSignal;
}) {
  const original = await validateMacroWorkbookOriginal(input);
  check(original.size === input.size);
  return options.locks.withLock(`macro-excel:${options.originals.rootDirectory}:${input.threadId}:${input.uploadId}`, async () => {
    await options.originals.stageFile({ threadId: input.threadId, uploadId: input.uploadId, validated: original, sourcePath: input.filePath });
    try {
      const previous = await options.staging.resolveContentById(input.threadId, input.uploadId);
      if (previous.document.legacyExcel?.originalSha256 !== original.sha256) throw new StorageError("STORAGE_STAGING_ID_CONFLICT", "Upload identifies another original.");
      const content = await readRegularFileWithin(options.staging.rootDirectory, previous.document.relativePath, 50 * 1024 * 1024);
      if (createHash("sha256").update(content).digest("hex") !== previous.document.sha256) throw new StorageError("STORAGE_STAGING_CONTENT_CORRUPT", "Stored derivative no longer matches its identity.");
      return previous.document;
    } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
    return options.conversionGate.run(async () => {
      const bytes = await readRegularFileWithin(path.dirname(input.filePath), path.basename(input.filePath), 50 * 1024 * 1024);
      check(createHash("sha256").update(bytes).digest("hex") === original.sha256);
      const result = await extractMacroWorkbook(bytes, options.signal);
      const provenance = parseLegacyExcelProvenance({ policy: "values-only-v1", originalFileName: original.fileName,
        originalSha256: original.sha256, originalSize: original.size, sheetCount: result.sheets.length, cellCount: result.cellCount,
        formulaCount: result.formulaCount, missingFormulaCaches: result.missingFormulaCaches, undecodedFormulas: result.undecodedFormulas,
        omittedSheets: result.omittedSheets, omittedStreams: Object.keys((await JSZip.loadAsync(bytes)).files).filter(name => /vbaproject|activex|embeddings|customui|externallinks|macrosheets/i.test(name)).length });
      const data = await buildPassiveExcel(result, provenance);
      const validated = { ...validateUploadedDocument({ data, fileName: `${original.fileName.slice(0, -5).slice(0, 105)}.passive.xlsx`, declaredMimeType: XLSX }), legacyExcel: provenance };
      return options.staging.stage({ threadId: input.threadId, uploadId: input.uploadId, validated, data });
    }, { signal: options.signal });
  });
}
