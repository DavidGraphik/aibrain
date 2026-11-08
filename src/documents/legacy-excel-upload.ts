import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { SaxesParser } from "saxes";
import { readRegularFileWithin } from "@/security/safe-file";
import { supportsNativeLegacyExcel } from "./legacy-excel-native-profile";
import { inspectLegacyExcelForStorage } from "./legacy-excel-validation";
import { STORED_XLS_NOTICE, parseStoredLegacyExcelReceipt } from "./legacy-excel-policy";
import { preparePassiveLegacyExcelUpload } from "./legacy-excel-passive";
import { convertLegacyExcelToXlsx } from "./legacy-excel-conversion";
import { UploadValidationError, validateUploadedDocument, safeFileName, type ValidatedUpload } from "./upload-validation";
import { StorageError, type ResourceLockManager } from "@/storage";
import type { FileDocumentStagingStore } from "./staging-store";

function check(ok: unknown): asserts ok {
  if (!ok) throw new UploadValidationError("UPLOAD_NATIVE_XLS_OUTPUT_INVALID", "Converted workbook failed its closed output profile.");
}

/** Defence after native conversion: no external parts/relationships or new functions. */
export async function inspectNativeExcelOutput(data: Buffer) {
  const zip = await JSZip.loadAsync(data);
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    check(!/(?:externalLinks|connections|embeddings|activeX|vbaProject|macrosheets)/i.test(entry.name));
    if (!/\.(?:xml|rels)$/.test(entry.name)) continue;
    const parser = new SaxesParser({ xmlns: true });
    let formula: string | null = null, depth = 0, bytes = 0;
    parser.on("doctype", () => check(false));
    parser.on("processinginstruction", () => check(false));
    parser.on("opentag", tag => {
      check(++depth <= 64 && formula === null);
      if (tag.local === "Relationship") {
        check(tag.uri === "http://schemas.openxmlformats.org/package/2006/relationships");
        const attrs = Object.values(tag.attributes);
        check(!attrs.some(a => a.local === "TargetMode" && a.value !== "Internal"));
        check(!attrs.some(a => a.local === "Target" && /[\\:]|^\/\//.test(a.value)));
      }
      if (tag.local === "f" && tag.uri === "http://schemas.openxmlformats.org/spreadsheetml/2006/main") formula = "";
    });
    parser.on("text", value => { if (formula !== null) { formula += value; check(formula.length <= 16384); } });
    parser.on("cdata", () => check(false));
    parser.on("closetag", tag => {
      if (tag.local === "f" && formula !== null) {
        // Input grammar contains only local refs/scalars/arithmetic/SUM. Refuse an
        // unexpected name, command, URL, 3D reference or function in the derivative.
        check(/^[A-Za-z0-9$():.,+*/^%<>=&\s-]*$/.test(formula));
        check((formula.replaceAll("$", "").match(/[A-Za-z_][A-Za-z_0-9.]*/g) ?? []).every(token => ["SUM", "TRUE", "FALSE"].includes(token) || /^[A-Z]{1,3}[0-9]+$/.test(token)));
        formula = null;
      }
      depth--;
    });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for await (const chunk of new Readable({ objectMode: false }).wrap(entry.nodeStream())) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length; total += buffer.length;
      check(bytes <= 64 * 1024 * 1024 && total <= 250 * 1024 * 1024);
      parser.write(decoder.decode(buffer, { stream: true }));
    }
    parser.write(decoder.decode()).close();
  }
}

export async function prepareLegacyExcelUpload(
  input: Parameters<typeof preparePassiveLegacyExcelUpload>[0],
  options: Parameters<typeof preparePassiveLegacyExcelUpload>[1] & { soffice: string },
) {
  const fileName = safeFileName(input.fileName);
  const original = await readRegularFileWithin(path.dirname(input.filePath), path.basename(input.filePath), 16 * 1024 * 1024);
  if (!supportsNativeLegacyExcel(original)) return preparePassiveLegacyExcelUpload(input, options);
  const originalValidated = validateUploadedDocument({ data: original, fileName, declaredMimeType: input.declaredMimeType });
  const data = await convertLegacyExcelToXlsx(original, {
    soffice: options.soffice, conversionGate: options.conversionGate, runner: options.runner,
  }, options.signal);
  await inspectNativeExcelOutput(data);
  let stem = "";
  for (const character of fileName.slice(0, -4)) {
    if ((stem + character).length > 115) break;
    stem += character;
  }
  const validated = validateUploadedDocument({ data, fileName: `${stem}.xlsx`, declaredMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  return { originalValidated, validated, data };
}

/** Serialize original→derivative identity, reusing the exact bytes on retries.
 * Native Office output need not be byte-deterministic across separate runs.
 */
export async function stageLegacyExcelUpload(
  input: Parameters<typeof prepareLegacyExcelUpload>[0] & { threadId: string; uploadId: string; size: number },
  options: Parameters<typeof prepareLegacyExcelUpload>[1] & {
    locks: ResourceLockManager; staging: FileDocumentStagingStore; originals: FileDocumentStagingStore;
  },
) {
  const fileName = safeFileName(input.fileName);
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > 16 * 1024 * 1024) {
    throw new UploadValidationError("UPLOAD_SIZE_INVALID", "Legacy Excel exceeds the bounded input size.");
  }
  if (path.extname(fileName).toLowerCase() !== ".xls" || !["application/vnd.ms-excel", "application/octet-stream"].includes(input.declaredMimeType.trim().toLowerCase())) {
    throw new UploadValidationError("UPLOAD_MIME_INVALID", "Legacy Excel filename and MIME must agree.");
  }
  const bytes = await readRegularFileWithin(path.dirname(input.filePath), path.basename(input.filePath), 16 * 1024 * 1024);
  if (bytes.length !== input.size) throw new UploadValidationError("UPLOAD_SOURCE_CHANGED", "Upload changed before staging.");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const missing = (error: unknown) => error && typeof error === "object" && "code" in error && error.code === "ENOENT";
  return options.locks.withLock(`legacy-excel:${options.originals.rootDirectory}:${input.threadId}:${input.uploadId}`, async () => {
    let originalExists = false;
    try {
      const original = await options.originals.resolveContentById(input.threadId, input.uploadId);
      if (original.document.sha256 !== sha256 || original.document.fileName !== fileName || original.document.size !== bytes.length) {
        throw new StorageError("STORAGE_STAGING_ID_CONFLICT", "Upload id identifies a different original.");
      }
      const stored = await readRegularFileWithin(options.originals.rootDirectory, original.document.relativePath, 16 * 1024 * 1024);
      if (!stored.equals(bytes)) throw new StorageError("STORAGE_STAGING_CONTENT_CORRUPT", "Stored original no longer matches its identity.");
      originalExists = true;
    } catch (error) { if (!missing(error)) throw error; }
    try {
      const staged = await options.staging.resolveContentById(input.threadId, input.uploadId);
      if (!originalExists || (staged.document.kind !== "xlsx" && !staged.document.storedLegacyExcel)) throw new StorageError("STORAGE_STAGING_ID_CONFLICT", "Upload id has no matching legacy provenance.");
      const provenance = staged.document.storedLegacyExcel ?? staged.document.legacyExcel;
      if (provenance && (provenance.originalSha256 !== sha256 || provenance.originalFileName !== fileName || provenance.originalSize !== bytes.length)) {
        throw new StorageError("STORAGE_STAGING_CONTENT_CORRUPT", "Legacy receipt no longer matches its original.");
      }
      const content = await readRegularFileWithin(options.staging.rootDirectory, staged.document.relativePath, 50 * 1024 * 1024);
      if (createHash("sha256").update(content).digest("hex") !== staged.document.sha256) throw new StorageError("STORAGE_STAGING_CONTENT_CORRUPT", "Stored derivative no longer matches its identity.");
      return staged.document;
    } catch (error) { if (!missing(error)) throw error; }
    inspectLegacyExcelForStorage(bytes);
    // Admission and preservation precede optional processing. Never expose this
    // private original through staging, previews, worker mounts or converter fallbacks.
    const originalValidated: ValidatedUpload = { kind: "xls", fileName, mediaType: "application/vnd.ms-excel", size: bytes.length, sha256, officeEntries: null };
    await options.originals.stageFile({ threadId: input.threadId, uploadId: input.uploadId, validated: originalValidated, sourcePath: input.filePath });
    let prepared: Awaited<ReturnType<typeof prepareLegacyExcelUpload>>;
    try {
      prepared = await prepareLegacyExcelUpload(input, options);
    } catch (error) {
      if (options.signal?.aborted || (error instanceof StorageError && error.code === "DOCUMENT_OPERATION_ABORTED")) throw error;
      const storedLegacyExcel = parseStoredLegacyExcelReceipt({ status: "unavailable", originalFileName: fileName, originalSha256: sha256, originalSize: bytes.length });
      const data = Buffer.from(`${STORED_XLS_NOTICE}\nEl original permanece intacto en almacenamiento privado. Este archivo es únicamente el comprobante de estado, no contiene celdas ni resultados. No se han ejecutado macros ni actualizado enlaces. No deduzcas datos ni resultados del libro a partir de este comprobante.\n`);
      const validated: ValidatedUpload = { ...validateUploadedDocument({ data, fileName: `${fileName.slice(0, 105)}.xls-status.txt`, declaredMimeType: "text/plain" }), storedLegacyExcel };
      return options.staging.stage({ threadId: input.threadId, uploadId: input.uploadId, validated, data });
    }
    if (prepared.originalValidated.sha256 !== sha256) throw new UploadValidationError("UPLOAD_SOURCE_CHANGED", "Original changed during preparation.");
    return options.staging.stage({ threadId: input.threadId, uploadId: input.uploadId, validated: prepared.validated, data: prepared.data });
  });
}
