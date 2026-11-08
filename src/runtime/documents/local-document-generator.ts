import { createHash } from "node:crypto";
import { styleScheduleWorkbook } from "./schedule-spreadsheet";
import { arnallScheduleParts, type ArnallSchedule } from "./arnall-schedule";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { MAX_TRANSLATION_DOCUMENT_BYTES, MAX_TRANSLATION_DOCUMENT_LINES } from "./translation-limits";

export type LocalDocumentFormat = "pdf" | "docx" | "pptx" | "xlsx";
export type LocalDocumentSlide = Readonly<{ title: string; body: string }>;
export type LocalDocumentFormula = Readonly<{ formula: string }>;
export type LocalDocumentCell = string | number | boolean | null | LocalDocumentFormula;

/** Explicit, local numeric formulas only; never reinterpret untrusted cell text. */
export function isLocalDocumentFormula(value: unknown): value is LocalDocumentFormula {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 1 || Object.keys(value)[0] !== "formula" || !("formula" in value) || typeof value.formula !== "string") return false;
  const formula = value.formula.replace(/^=/u, "");
  if (!formula || formula.length > 1000) return false;
  // No strings, workbook/sheet links, names, URLs, DDE or external functions.
  const rest = formula.replace(/\b(?:SUM|MIN|MAX|AVERAGE|COUNT|ROUND|ABS)(?=\s*\()/gu, "")
    .replace(/\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6}\b/gu, "")
    .replace(/(?:[0-9]+(?:\.[0-9]+)?|\s|[()+*/^%,:=-])/gu, "");
  return rest.length === 0;
}

export type LocalDocumentInput = Readonly<{
  format: LocalDocumentFormat;
  title: string;
  includeTitle?: boolean;
  content: string;
  rows?: readonly (readonly LocalDocumentCell[])[];
  slides?: readonly LocalDocumentSlide[];
  sourcePng?: Uint8Array;
  spreadsheetLayout?: "schedule";
  arnallSchedule?: ArnallSchedule;
  verbatim?: boolean;
}>;

export type GeneratedLocalDocument = Readonly<{
  data: Buffer;
  format: LocalDocumentFormat;
  mimeType: string;
  pages: number | null;
  sha256: string;
}>;

const MIME_TYPES: Record<LocalDocumentFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const MAX_CONTENT_BYTES = 200_000;
const MAX_ROWS = 2_000;
const MAX_COLUMNS = 100;
const MAX_CELL_BYTES = 16_000;
const MAX_SOURCE_IMAGE_BYTES = 20_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const A4_WIDTH_POINTS = 595.28;
const A4_HEIGHT_POINTS = 841.89;
const A4_IMAGE_MARGIN_POINTS = 36;

export class LocalDocumentGenerationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalDocumentGenerationError";
  }
}

export function localDocumentMimeType(format: LocalDocumentFormat) {
  return MIME_TYPES[format];
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cleanText(value: string, maximumBytes: number, label: string) {
  const cleaned = value.replace(/\r\n?/gu, "\n").replace(/\0/gu, "").trim();
  if (!cleaned || Buffer.byteLength(cleaned, "utf8") > maximumBytes) {
    throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_INPUT_INVALID", `${label} is empty or too large.`);
  }
  return cleaned;
}

function normalizedInput(input: LocalDocumentInput) {
  if (!(input.format in MIME_TYPES)) {
    throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_FORMAT_INVALID", "Document format is not supported.");
  }
  const title = cleanText(input.title, 500, "title");
  if (input.includeTitle !== undefined && typeof input.includeTitle !== "boolean") {
    throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_INPUT_INVALID", "includeTitle must be a boolean.");
  }
  if (input.verbatim && input.format !== "docx") {
    throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_FORMAT_INVALID", "Verbatim translation requires Word format.");
  }
  const maxContentBytes = input.verbatim ? MAX_TRANSLATION_DOCUMENT_BYTES : MAX_CONTENT_BYTES;
  const sourcePng = input.sourcePng === undefined ? undefined : Buffer.from(input.sourcePng);
  if (sourcePng !== undefined && (
    input.format !== "pdf" ||
    sourcePng.byteLength < 64 ||
    sourcePng.byteLength > MAX_SOURCE_IMAGE_BYTES ||
    !sourcePng.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  )) {
    throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_SOURCE_IMAGE_INVALID", "Source image must be a valid PNG for PDF generation.");
  }
  const content = sourcePng
    ? input.content.replace(/\r\n?/gu, "\n").replace(/\0/gu, "").trim()
    : cleanText(input.content, maxContentBytes, "content");
  if (Buffer.byteLength(content, "utf8") > maxContentBytes) {
    throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_INPUT_INVALID", "content is too large.");
  }
  if (input.verbatim && content.split("\n").length > MAX_TRANSLATION_DOCUMENT_LINES) {
    throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_INPUT_INVALID", "Translation contains too many lines.");
  }
  if (input.rows !== undefined) {
    if (!Array.isArray(input.rows) || input.rows.length === 0 || input.rows.length > MAX_ROWS) {
      throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_ROWS_INVALID", "Spreadsheet rows are invalid.");
    }
    for (const row of input.rows) {
      if (!Array.isArray(row) || row.length === 0 || row.length > MAX_COLUMNS) {
        throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_ROWS_INVALID", "Spreadsheet row width is invalid.");
      }
      for (const cell of row) {
        if (cell !== null && typeof cell !== "string" && typeof cell !== "number" && typeof cell !== "boolean" && !isLocalDocumentFormula(cell)) {
          throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_ROWS_INVALID", "Spreadsheet cell type is invalid.");
        }
        if (typeof cell === "number" && !Number.isFinite(cell)) {
          throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_ROWS_INVALID", "Spreadsheet numbers must be finite.");
        }
        if (typeof cell === "string" && (cell.includes("\0") || Buffer.byteLength(cell, "utf8") > MAX_CELL_BYTES)) {
          throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_ROWS_INVALID", "Spreadsheet cell text is invalid.");
        }
      }
    }
  }
  const slides = input.slides === undefined ? undefined : normalizeDocumentSlides(input.slides);
  if (slides && (sourcePng || !["pdf", "pptx"].includes(input.format))) {
    throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_SLIDES_INVALID", "Slides require PDF or PPTX without a source image.");
  }
  if (input.spreadsheetLayout && (input.format !== "xlsx" || !input.rows || input.rows.some(row => row.length !== 9))) {
    throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_ROWS_INVALID", "Schedule layout requires nine spreadsheet columns.");
  }
  if (input.arnallSchedule && (input.format !== "xlsx" || input.spreadsheetLayout !== "schedule")) throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_ROWS_INVALID", "The approved schedule template requires an XLSX schedule.");
  return { format: input.format, title, includeTitle: input.includeTitle !== false, content, rows: input.rows, slides, sourcePng, spreadsheetLayout: input.spreadsheetLayout, arnallSchedule: input.arnallSchedule, verbatim: input.verbatim === true };
}

export function normalizeDocumentSlides(value: unknown): readonly LocalDocumentSlide[] {
  if (!Array.isArray(value) || !value.length || value.length > 50) {
    throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_SLIDES_INVALID", "Provide between 1 and 50 authored slides, each with title and body.");
  }
  const slides = value.map((slide: unknown) => {
    if (!slide || typeof slide !== "object" || Array.isArray(slide) ||
        Object.keys(slide).length !== 2 || !("title" in slide) || !("body" in slide) ||
        typeof slide.title !== "string" || typeof slide.body !== "string") {
      throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_SLIDES_INVALID", "Each slide needs final title and body text, not a generation prompt.");
    }
    return { title: cleanText(slide.title, 500, "slide title"), body: cleanText(slide.body, 16_000, "slide body") };
  });
  if (Buffer.byteLength(JSON.stringify(slides), "utf8") > MAX_CONTENT_BYTES) {
    throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_SLIDES_INVALID", "Presentation content is too large.");
  }
  return slides;
}

async function zipBytes(files: Record<string, string>, deterministic = false) {
  const archive = new JSZip();
  for (const [name, value] of Object.entries(files)) archive.file(name, value, deterministic ? { date: new Date("2000-01-01T00:00:00.000Z"), createFolders: false } : undefined);
  const bytes = await archive.generateAsync({
    type: "uint8array",
    // Verbatim translations can legitimately repeat many identical rows.
    // Store their already bounded XML without compression so the same upload
    // archive-bomb validator does not reject highly repetitive documents.
    compression: deterministic ? "STORE" : "DEFLATE",
    compressionOptions: deterministic ? undefined : { level: 6 },
    platform: "UNIX",
  });
  return Buffer.from(bytes);
}

function coreProperties(title: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>AiBrain</dc:creator><cp:lastModifiedBy>AiBrain</cp:lastModifiedBy></cp:coreProperties>`;
}

function appProperties(application: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>${xml(application)}</Application><AppVersion>1.0</AppVersion></Properties>`;
}

async function docxBytes(title: string, content: string, verbatim = false, includeTitle = true) {
  const completeLines = [...(includeTitle ? [title] : []), ...content.split("\n")];
  const lines = verbatim ? completeLines : completeLines.slice(0, 5_000);
  const paragraphs = lines.map((raw, index) => {
    const heading = includeTitle && index === 0 || (!verbatim && /^#{1,3}\s/u.test(raw));
    const bullet = !verbatim && /^[-*]\s+/u.test(raw);
    const value = verbatim ? raw : raw.replace(/^#{1,3}\s+/u, "").replace(/^[-*]\s+/u, "");
    if (!value.trim()) return "<w:p/>";
    return `<w:p>${heading ? '<w:pPr><w:keepNext/></w:pPr>' : ""}<w:r><w:rPr>${heading ? '<w:b/><w:sz w:val="32"/>' : bullet ? '<w:sz w:val="22"/>' : '<w:sz w:val="22"/>'}</w:rPr><w:t xml:space="preserve">${xml(bullet ? `• ${value}` : value)}</w:t></w:r></w:p>`;
  }).join("");
  return zipBytes({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`,
    "docProps/core.xml": coreProperties(title),
    "docProps/app.xml": appProperties("AiBrain Document Generator"),
  }, verbatim);
}

function spreadsheetRows(content: string, explicit?: readonly (readonly LocalDocumentCell[])[]) {
  if (explicit) return explicit;
  const lines = content.split("\n").filter((line) => line.trim()).slice(0, MAX_ROWS);
  return lines.map((line) => {
    const separator = line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",";
    return line.split(separator).slice(0, MAX_COLUMNS).map((cell) => cell.trim());
  });
}

function columnName(index: number) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

async function xlsxBytes(title: string, content: string, explicitRows?: readonly (readonly LocalDocumentCell[])[], layout?: "schedule") {
  const rows = spreadsheetRows(content, explicitRows);
  // Whole-sheet PDF export crops text that overflows the last used column.
  // Give literal values their own cell width rather than relying on overflow;
  // the approved schedule renderer supplies its own fixed column geometry.
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      const value = cell === null || isLocalDocumentFormula(cell) ? "" : String(cell);
      const longestLine = value.split(/\r\n?|\n/u).reduce((longest, line) => Math.max(longest, line.length), 0);
      widths[index] = Math.min(255, Math.max(widths[index] ?? 12, longestLine + 3));
    });
  }
  const columns = layout === "schedule" ? "" : `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>`;
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((cell, columnIndex) => {
      const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
      if (isLocalDocumentFormula(cell)) return `<c r="${reference}"><f>${xml(cell.formula.replace(/^=/u, ""))}</f></c>`;
      if (typeof cell === "number") return `<c r="${reference}"><v>${cell}</v></c>`;
      if (typeof cell === "boolean") return `<c r="${reference}" t="b"><v>${cell ? 1 : 0}</v></c>`;
      return `<c r="${reference}" t="inlineStr"${rowIndex === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${xml(cell === null ? "" : String(cell))}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(title.slice(0, 31).replace(/[\\/*?:\[\]]/gu, " ") || "Datos")}" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="0" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>${columns}<sheetData>${sheetRows}</sheetData></worksheet>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
    "docProps/core.xml": coreProperties(title),
    "docProps/app.xml": appProperties("AiBrain Spreadsheet Generator"),
  };
  if (layout === "schedule") styleScheduleWorkbook(files, title, content, rows);
  return zipBytes(files);
}

function presentationTheme() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="AiBrain"><a:themeElements><a:clrScheme name="AiBrain"><a:dk1><a:srgbClr val="20201E"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="3A3935"/></a:dk2><a:lt2><a:srgbClr val="F4F3EF"/></a:lt2><a:accent1><a:srgbClr val="5755D9"/></a:accent1><a:accent2><a:srgbClr val="26866A"/></a:accent2><a:accent3><a:srgbClr val="CA7138"/></a:accent3><a:accent4><a:srgbClr val="8B5FBF"/></a:accent4><a:accent5><a:srgbClr val="3978A8"/></a:accent5><a:accent6><a:srgbClr val="B04452"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="AiBrain"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="AiBrain"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}

function slideXml(title: string, body: string) {
  const titleSize = Math.min(3200, Math.floor(80000 / Math.max(1, title.length)));
  const paragraphs = body.split("\n").filter((line) => line.trim()).map((line) => `<a:p><a:r><a:rPr lang="es-ES" sz="1800"/><a:t>${xml(line.replace(/^[-*]\s+/u, ""))}</a:t></a:r><a:endParaRPr lang="es-ES" sz="1800"/></a:p>`).join("") || "<a:p><a:endParaRPr lang=\"es-ES\" sz=\"2200\"/></a:p>";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Título"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="457200"/><a:ext cx="10820400" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="es-ES" sz="${titleSize}" b="1"/><a:t>${xml(title)}</a:t></a:r><a:endParaRPr lang="es-ES" sz="${titleSize}"/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Contenido"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="10287000" cy="4572000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function presentationSlides(title: string, content: string, explicit?: readonly LocalDocumentSlide[]) {
  const sections = explicit ?? content.split(/\n\s*---\s*\n/gu).map((section) => section.trim()).filter(Boolean).map((section) => {
    const lines = section.split("\n").filter((line) => line.trim());
    const heading = (lines.shift() ?? title).replace(/^#+\s*/u, "");
    return { title: lines.length ? heading : title, body: lines.join("\n") || section };
  });
  // One authored section is one slide. Reject overflow rather than changing the deck narrative.
  const slides = sections.map((slide) => {
    if (slide.title.length > 80 || /[\r\n]/u.test(slide.title)) {
      throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_SLIDES_INVALID", "Slide titles must be a single line of at most 80 characters; shorten the heading and move detail into the body.");
    }
    const lines = wrapLines("", slide.body, 44).slice(2);
    if (lines.length > 12) {
      throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_SLIDE_OVERFLOW", "A slide exceeds the basic renderer layout. Shorten its body or author a designed deck with the local presentation workflow; no extra slides were created.");
    }
    return { title: slide.title, body: lines.join("\n") };
  });
  if (slides.length > 50) throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_SLIDES_INVALID", "Presentation exceeds 50 slides; shorten or split it into separate files.");
  return slides;
}

async function pptxBytes(title: string, slides: readonly LocalDocumentSlide[]) {
  const overrides = slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  const slideIds = slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("");
  const relationships = slides.map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("");
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${overrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    "ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${relationships}</Relationships>`,
    "ppt/slideMasters/slideMaster1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`,
    "ppt/slideLayouts/slideLayout1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld name="En blanco"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    "ppt/theme/theme1.xml": presentationTheme(),
    "docProps/core.xml": coreProperties(title),
    "docProps/app.xml": appProperties("AiBrain Presentation Generator"),
  };
  slides.forEach((slide, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = slideXml(slide.title, slide.body);
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`;
  });
  return zipBytes(files);
}

const CP1252: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87,
  "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91,
  "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98,
  "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

// Helvetica/WinAnsi has no arrow glyphs. Keep their direction in a readable
// ASCII form before wrapping, without adding font binaries or licenses.
function compatiblePdfText(value: string) {
  return value.normalize("NFC").replace(/[→←↔]/gu, character => ({ "→": "->", "←": "<-", "↔": "<->" })[character]!);
}

function pdfString(value: string) {
  const bytes: number[] = [];
  for (const character of value) {
    const point = character.codePointAt(0)!;
    const byte = CP1252[character] ?? ((point >= 0x20 && point <= 0x7e) || (point >= 0xa0 && point <= 0xff) ? point : undefined);
    if (byte === undefined) {
      throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_PDF_TEXT_UNSUPPORTED", `Basic PDF cannot represent U+${point.toString(16).toUpperCase()}; use a compatible textual representation instead of silently changing the symbol.`);
    }
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) bytes.push(0x5c);
    bytes.push(byte);
  }
  return Buffer.from(bytes).toString("latin1");
}

function wrapLines(title: string, content: string, width = 88) {
  const source = [title, "", ...content.split("\n")];
  const result: string[] = [];
  for (const raw of source) {
    const words = raw.replace(/^#{1,3}\s+/u, "").split(/\s+/u).filter(Boolean).flatMap((word) => word.match(new RegExp(`.{1,${width}}`, "gu")) ?? []);
    if (words.length === 0) {
      result.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (`${line} ${word}`.trim().length > width && line) {
        result.push(line);
        line = word;
      } else line = `${line} ${word}`.trim();
    }
    if (line) result.push(line);
  }
  return result;
}

function textPdfBytes(title: string, content: string, slides?: readonly LocalDocumentSlide[]) {
  const lines = wrapLines(title, content);
  const pageContents = slides?.map((slide) => [slide.title, "", ...slide.body.split("\n")])
    ?? Array.from({ length: Math.max(1, Math.ceil(lines.length / 44)) }, (_, page) => lines.slice(page * 44, (page + 1) * 44));
  const pages = pageContents.length;
  const objects: Buffer[] = [];
  const add = (value: string | Buffer) => {
    objects.push(typeof value === "string" ? Buffer.from(value, "latin1") : value);
    return objects.length;
  };
  const catalogId = add("");
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pageIds: number[] = [];
  for (let page = 0; page < pages; page += 1) {
    const pageLines = pageContents[page]!;
    const operators = pageLines.map((line, index) => `${slides ? `/F1 ${index === 0 ? Math.min(18, Math.floor(800 / Math.max(1, line.length))) : 18} Tf ` : ""}${index === 0 ? "" : "T* "}(${pdfString(line)}) Tj`).join("\n");
    const stream = Buffer.from(`BT\n/F1 ${slides ? 18 : 11} Tf\n${slides ? 25 : 15} TL\n${slides ? "54 472" : "72 760"} Td\n${operators}\nET\n`, "latin1");
    const streamId = add(Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "latin1"),
      stream,
      Buffer.from("endstream", "latin1"),
    ]));
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${slides ? "960 540" : "595 842"}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R >>`));
  }
  objects[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, "latin1");
  objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`, "latin1");
  const chunks = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [0];
  let offset = chunks[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), object, Buffer.from("\nendobj\n", "latin1")]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xrefOffset = offset;
  const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n", ...offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`)].join("");
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "latin1"));
  return { data: Buffer.concat(chunks), pages };
}

async function imagePdfBytes(title: string, sourcePng: Uint8Array) {
  try {
    const document = await PDFDocument.create();
    document.setTitle(title);
    document.setCreator("AiBrain");
    document.setProducer("AiBrain Document Generator");
    const image = await document.embedPng(sourcePng);
    const page = document.addPage([A4_WIDTH_POINTS, A4_HEIGHT_POINTS]);
    const maximumWidth = A4_WIDTH_POINTS - (A4_IMAGE_MARGIN_POINTS * 2);
    const maximumHeight = A4_HEIGHT_POINTS - (A4_IMAGE_MARGIN_POINTS * 2);
    const scale = Math.min(maximumWidth / image.width, maximumHeight / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, {
      x: (A4_WIDTH_POINTS - width) / 2,
      y: (A4_HEIGHT_POINTS - height) / 2,
      width,
      height,
    });
    return { data: Buffer.from(await document.save()), pages: 1 };
  } catch (error) {
    throw new LocalDocumentGenerationError(
      "LOCAL_DOCUMENT_SOURCE_IMAGE_INVALID",
      error instanceof Error && error.message ? "Source PNG cannot be embedded safely." : "Source PNG is invalid.",
    );
  }
}

export async function generateLocalDocument(input: LocalDocumentInput): Promise<GeneratedLocalDocument> {
  const normalized = normalizedInput(input);
  let data: Buffer;
  let pages: number | null = null;
  if (normalized.format === "pdf") {
    const title = compatiblePdfText(normalized.title);
    const content = compatiblePdfText(normalized.content);
    const slides = normalized.slides?.map(slide => ({ title: compatiblePdfText(slide.title), body: compatiblePdfText(slide.body) }));
    const generated = normalized.sourcePng
      ? await imagePdfBytes(normalized.title, normalized.sourcePng)
      : textPdfBytes(title, content, slides ? presentationSlides(title, content, slides) : undefined);
    data = generated.data;
    pages = generated.pages;
  } else if (normalized.format === "docx") {
    data = await docxBytes(normalized.title, normalized.content, normalized.verbatim, normalized.includeTitle);
  } else if (normalized.format === "xlsx") {
    data = normalized.arnallSchedule ? await zipBytes(arnallScheduleParts(normalized.arnallSchedule)) : await xlsxBytes(normalized.title, normalized.content, normalized.rows, normalized.spreadsheetLayout);
  } else {
    const slides = presentationSlides(normalized.title, normalized.content, normalized.slides);
    data = await pptxBytes(normalized.title, slides);
    pages = slides.length;
  }
  if (data.length < 64 || data.length > 20_000_000) {
    throw new LocalDocumentGenerationError("LOCAL_DOCUMENT_OUTPUT_INVALID", "Generated document size is invalid.");
  }
  return Object.freeze({
    data,
    format: normalized.format,
    mimeType: MIME_TYPES[normalized.format],
    pages,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
