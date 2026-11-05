import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { atomicWriteFile } from "@/storage/atomic-file";
import { readRegularFileWithin } from "@/security/safe-file";
import { StorageError } from "@/storage/errors";
import { readPassiveLegacyExcelContainer } from "./legacy-excel-validation";
import { UploadValidationError, safeFileName, validateUploadedDocument, type ValidatedUpload } from "./upload-validation";
import { SystemDocumentToolRunner, type DocumentToolRunner } from "./preview-service";
import type { DocumentConversionAdmission } from "./conversion-gate";
import { PASSIVE_XLS_NOTICE, parseLegacyExcelProvenance, type LegacyExcelProvenance } from "./legacy-excel-policy";

type Cell = [number, number, "text" | "number" | "date" | "boolean" | "error", string | number | boolean, boolean];
type Formula = [number, number, string, "missing" | "unverified"];
type Sheet = { name: string; cells: Cell[]; formulas: Formula[] };
type Extracted = {
  schemaVersion: 1; reader: "xlrd-2.0.2" | "ooxml-values-v1"; date1904: boolean; sheets: Sheet[];
  cellCount: number; formulaCount: number; missingFormulaCaches: number;
  undecodedFormulas: number; omittedSheets: number; linkRecords: number;
};
const MAX_RESULT = 40 * 1024 * 1024;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function requireValue(ok: unknown): asserts ok {
  if (!ok) throw new UploadValidationError("UPLOAD_PASSIVE_XLS_INVALID", "Passive XLS output failed validation.");
}
function text(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && value.length <= 32767 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value) && value.isWellFormed());
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  requireValue(Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max);
}
function keys(value: unknown, expected: string[]): asserts value is Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  const actual = Object.keys(value);
  requireValue(actual.length === expected.length && expected.every(key => Object.hasOwn(value, key)));
}
export function validatePassiveExcelResult(value: unknown): Extracted {
  keys(value, ["schemaVersion", "reader", "date1904", "sheets", "cellCount", "formulaCount", "missingFormulaCaches", "undecodedFormulas", "omittedSheets", "linkRecords"]);
  requireValue(value.schemaVersion === 1 && ["xlrd-2.0.2", "ooxml-values-v1"].includes(String(value.reader)) && typeof value.date1904 === "boolean");
  requireValue(Array.isArray(value.sheets) && value.sheets.length > 0 && value.sheets.length <= 100);
  for (const name of ["cellCount", "formulaCount", "missingFormulaCaches", "undecodedFormulas", "omittedSheets", "linkRecords"]) integer(value[name], 0, 1_000_000);
  requireValue(Number(value.cellCount) > 0 && Number(value.cellCount) <= 500_000 && Number(value.formulaCount) <= (value.reader === "ooxml-values-v1" ? 500_000 : 100_000));
  requireValue(Number(value.missingFormulaCaches) <= Number(value.formulaCount) && Number(value.undecodedFormulas) <= Number(value.formulaCount) && Number(value.omittedSheets) <= 100);
  let cells = 0, formulas = 0, missing = 0;
  const sheetNames = new Set<string>();
  for (const sheet of value.sheets) {
    keys(sheet, ["name", "cells", "formulas"]);
    text(sheet.name);
    requireValue(sheet.name.length > 0 && sheet.name.length <= 31 && !/[\[\]:*?/\\]/u.test(sheet.name));
    requireValue(!sheetNames.has(sheet.name.toLowerCase()));
    sheetNames.add(sheet.name.toLowerCase());
    requireValue(Array.isArray(sheet.cells) && Array.isArray(sheet.formulas));
    const coordinates = new Map<string, Cell>();
    for (const cell of sheet.cells) {
      requireValue(Array.isArray(cell) && cell.length === 5);
      integer(cell[0], 0, value.reader === "ooxml-values-v1" ? 1048575 : 65535); integer(cell[1], 0, value.reader === "ooxml-values-v1" ? 16383 : 255);
      requireValue(typeof cell[4] === "boolean");
      const key = `${cell[0]}:${cell[1]}`;
      requireValue(!coordinates.has(key)); coordinates.set(key, cell as Cell);
      if (cell[2] === "number" || cell[2] === "date") requireValue(typeof cell[3] === "number" && Number.isFinite(cell[3]));
      else if (cell[2] === "boolean") requireValue(typeof cell[3] === "boolean");
      else { requireValue(cell[2] === "text" || cell[2] === "error"); text(cell[3]); }
      requireValue(++cells <= 500_000);
    }
    const formulaCoordinates = new Set<string>();
    for (const formula of sheet.formulas) {
      requireValue(Array.isArray(formula) && formula.length === 4);
      integer(formula[0], 0, value.reader === "ooxml-values-v1" ? 1048575 : 65535); integer(formula[1], 0, value.reader === "ooxml-values-v1" ? 16383 : 255); text(formula[2]);
      requireValue(formula[3] === "missing" || formula[3] === "unverified");
      const key = `${formula[0]}:${formula[1]}`;
      const cell = coordinates.get(key);
      requireValue(cell?.[4] === true && !formulaCoordinates.has(key));
      formulaCoordinates.add(key);
      if (formula[3] === "missing") {
        requireValue(cell[2] === "text" && cell[3] === "#UNVERIFIED_FORMULA_NO_SAVED_VALUE");
        missing += 1;
      }
      requireValue(++formulas <= (value.reader === "ooxml-values-v1" ? 500_000 : 100_000));
    }
    requireValue([...coordinates.values()].filter(cell => cell[4]).length === formulaCoordinates.size);
  }
  requireValue(cells === value.cellCount && formulas === value.formulaCount && missing === value.missingFormulaCaches);
  return value as unknown as Extracted;
}
function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function column(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : column(Math.floor(index / 26) - 1) + String.fromCharCode(65 + index % 26);
}
function sheetXml(cells: Cell[], budget: { bytes: number; maximum: number }) {
  const rows = new Map<number, string[]>();
  for (const [row, col, kind, value, formula] of cells) {
    const address = `${column(col)}${row + 1}`;
    const style = kind === "date" ? (formula ? 3 : 1) : (formula ? 2 : 0);
    const body = kind === "number" || kind === "date" ? `<v>${value}</v>`
      : kind === "boolean" ? `<v>${value ? 1 : 0}</v>`
      : `<is><t xml:space="preserve">${xml(String(value))}</t></is>`;
    const type = kind === "number" || kind === "date" ? "n" : kind === "boolean" ? "b" : "inlineStr";
    const rowCells = rows.get(row) ?? [];
    const fragment = `<c r="${address}" t="${type}" s="${style}">${body}</c>`;
    budget.bytes += Buffer.byteLength(fragment) + (rows.has(row) ? 0 : 40);
    requireValue(budget.bytes <= budget.maximum);
    rowCells.push(fragment); rows.set(row, rowCells);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${[...rows].sort(([a], [b]) => a - b).map(([row, cells]) => `<row r="${row + 1}">${cells.join("")}</row>`).join("")}</sheetData></worksheet>`;
}

/** Generate a new values-only package. No source ZIP/XML, relationship, name or drawing is copied. */
export async function buildPassiveExcel(result: Extracted, provenance: LegacyExcelProvenance) {
  validatePassiveExcelResult(result);
  parseLegacyExcelProvenance(provenance);
  requireValue(provenance.sheetCount === result.sheets.length && provenance.cellCount === result.cellCount &&
    provenance.formulaCount === result.formulaCount && provenance.missingFormulaCaches === result.missingFormulaCaches &&
    provenance.undecodedFormulas === result.undecodedFormulas && provenance.omittedSheets === result.omittedSheets);
  const names = new Set(result.sheets.map(sheet => sheet.name.toLowerCase()));
  let noticeName = "AiBrain - lectura pasiva";
  for (let index = 2; names.has(noticeName.toLowerCase()); index++) noticeName = `AiBrain - lectura pasiva ${index}`;
  const report: Cell[] = [
    [0, 0, "text", PASSIVE_XLS_NOTICE, false],
    [1, 0, "text", "Original conservado intacto y separado. Esta copia contiene valores guardados; formato, objetos y funcionamiento de macros no se conservan.", false],
    [2, 0, "text", "Las fórmulas se muestran abajo como texto, sin evaluar. Sus valores guardados y dependencias externas no están verificados. No los presentes como resultados fiables ni actualizados.", false],
    [3, 0, "text", `Original SHA256: ${provenance.originalSha256}`, false],
    [4, 0, "text", `Hojas de datos: ${result.sheets.length}; celdas: ${result.cellCount}; fórmulas: ${result.formulaCount}; sin resultado guardado: ${result.missingFormulaCaches}; fórmulas sin decodificar: ${result.undecodedFormulas}; hojas no tabulares omitidas: ${result.omittedSheets}.`, false],
    [6, 0, "text", "Hoja", false], [6, 1, "text", "Celda", false], [6, 2, "text", "Fórmula como texto (no ejecutable)", false], [6, 3, "text", "Estado del resultado guardado", false],
  ];
  let reportRow = 7;
  for (const sheet of result.sheets) for (const [row, col, formula, cache] of sheet.formulas) {
    report.push([reportRow, 0, "text", sheet.name, false], [reportRow, 1, "text", `${column(col)}${row + 1}`, false],
      [reportRow, 2, "text", formula, false], [reportRow, 3, "text", cache === "missing" ? "No disponible" : "No verificado", false]);
    reportRow++;
  }
  const sheets = [{ name: noticeName, cells: report }, ...result.sheets];
  const zip = new JSZip();
  const fixedDate = new Date("1980-01-01T00:00:00.000Z");
  const put = (name: string, contents: string) => zip.file(name, contents, { date: fixedDate, createFolders: false });
  put("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
  put("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  put("xl/workbook.xml", `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="${result.date1904 ? 1 : 0}"/><sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  put("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  put("xl/styles.xml", '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE699"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  const budget = { bytes: 0, maximum: (result.reader === "ooxml-values-v1" ? 200 : 45) * 1024 * 1024 };
  sheets.forEach((sheet, i) => put(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet.cells, budget)));
  // STORE prevents highly repetitive but valid output from exceeding the upload ratio limit.
  const data = await zip.generateAsync({ type: "nodebuffer", compression: result.reader === "ooxml-values-v1" ? "DEFLATE" : "STORE", compressionOptions: { level: 1 } });
  requireValue(data.length <= 50 * 1024 * 1024);
  validateUploadedDocument({ data, fileName: "passive.xlsx", declaredMimeType: XLSX_MIME });
  return data;
}

export async function preparePassiveLegacyExcelUpload(input: {
  fileName: string; declaredMimeType: string; filePath: string;
}, options: { reader: string; conversionGate: DocumentConversionAdmission; runner?: DocumentToolRunner; signal?: AbortSignal }) {
  const fileName = safeFileName(input.fileName);
  requireValue(path.extname(fileName).toLowerCase() === ".xls" && ["application/vnd.ms-excel", "application/octet-stream"].includes(input.declaredMimeType.trim().toLowerCase()));
  requireValue(path.isAbsolute(options.reader));
  const original = await readRegularFileWithin(path.dirname(input.filePath), path.basename(input.filePath), 16 * 1024 * 1024);
  const container = readPassiveLegacyExcelContainer(original);
  const originalSha256 = createHash("sha256").update(original).digest("hex");
  return options.conversionGate.run(async () => {
    const work = await mkdtemp(path.join(tmpdir(), "aibrain-passive-xls-"));
    try {
      await mkdir(path.join(work, "output"), { mode: 0o700 });
      await atomicWriteFile(path.join(work, "source.biff"), container.workbook, { mode: 0o600 });
      try {
        await (options.runner ?? new SystemDocumentToolRunner()).run(options.reader, [], {
          cwd: work, env: {}, timeoutMs: 40_000, signal: options.signal,
        });
      } catch (error) {
        if (error instanceof StorageError && error.code === "DOCUMENT_OPERATION_ABORTED") throw error;
        throw new UploadValidationError("UPLOAD_PASSIVE_XLS_UNREADABLE", "The isolated reader could not extract supported saved data.");
      }
      const raw = await readRegularFileWithin(work, "output/result.json", MAX_RESULT);
      let decoded: unknown;
      try { decoded = JSON.parse(raw.toString("utf8")); } catch { requireValue(false); }
      const result = validatePassiveExcelResult(decoded);
      const legacyExcel = parseLegacyExcelProvenance({
        policy: "values-only-v1", originalFileName: fileName, originalSha256, originalSize: original.length,
        sheetCount: result.sheets.length, cellCount: result.cellCount, formulaCount: result.formulaCount,
        missingFormulaCaches: result.missingFormulaCaches, undecodedFormulas: result.undecodedFormulas,
        omittedSheets: result.omittedSheets, omittedStreams: container.opaqueStreams,
      });
      const data = await buildPassiveExcel(result, legacyExcel);
      let stem = "";
      for (const character of fileName.slice(0, -4)) {
        if ((stem + character).length > 105) break;
        stem += character;
      }
      const derivedName = `${stem}.passive.xlsx`;
      const validated: ValidatedUpload = { ...validateUploadedDocument({ data, fileName: derivedName, declaredMimeType: XLSX_MIME }), legacyExcel };
      const originalValidated: ValidatedUpload = { kind: "xls", fileName, mediaType: "application/vnd.ms-excel", size: original.length, sha256: originalSha256, officeEntries: null };
      return { originalValidated, validated, data };
    } finally { await rm(work, { recursive: true, force: true }); }
  }, { signal: options.signal });
}
