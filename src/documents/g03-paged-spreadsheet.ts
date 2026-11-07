import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteFile } from "@/storage/atomic-file";
import type { DocumentConversionAdmission } from "./conversion-gate";
import { isSpreadsheetPreview } from "./spreadsheet-preview";
import { SystemDocumentToolRunner, type DocumentToolRunner } from "./preview-service";

const RUNNER = "/usr/local/bin/aibrain-g03-paged-spreadsheet";
const MAX_INPUT = 16 * 1024 * 1024;
const MAX_OUTPUT = 512 * 1024;

/** Passive saved-value reading; only the immutable wrapper may parse source bytes. */
export async function readG03PagedSpreadsheet(bytes: Buffer, suffix: string, part: number, options: {
  conversionGate: DocumentConversionAdmission; runner?: DocumentToolRunner; signal?: AbortSignal;
}) {
  if (!bytes.length || bytes.length > MAX_INPUT || ![".xlsx", ".xltx", ".xlsm"].includes(suffix) ||
      !Number.isSafeInteger(part) || part < 1 || part > 999) throw new Error("SERVER_SPREADSHEET_INPUT_INVALID");
  return options.conversionGate.run(async () => {
    const work = await mkdtemp(path.join(tmpdir(), "aibrain-g03-paged-"));
    try {
      await atomicWriteFile(path.join(work, `source${suffix}`), bytes, { mode: 0o600 });
      const output = await (options.runner ?? new SystemDocumentToolRunner()).run(RUNNER, [suffix, String(part)], {
        cwd: work, env: {}, timeoutMs: 40_000, signal: options.signal,
      });
      if (Buffer.byteLength(output.stdout) > MAX_OUTPUT) throw new Error("SERVER_SPREADSHEET_OUTPUT_TOO_LARGE");
      const result: unknown = JSON.parse(output.stdout);
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("SERVER_SPREADSHEET_INVALID");
      const value = result as Record<string, unknown>;
      if (value.ok === false) {
        if (value.reason === "SERVER_PART_UNAVAILABLE") throw new Error("SERVER_PART_UNAVAILABLE");
        if (value.reason === "TEXT_TOO_LARGE") throw new Error("SERVER_TEXT_TOO_LARGE");
        throw new Error("SERVER_SPREADSHEET_UNAVAILABLE");
      }
      if (value.ok !== true || value.sourceSha256 !== createHash("sha256").update(bytes).digest("hex") || value.page !== part || !Number.isSafeInteger(value.parts) || Number(value.parts) < part ||
          Number(value.parts) > 999 || typeof value.text !== "string" || !value.text || [...value.text].length > 20000 ||
          Buffer.byteLength(value.text) > 120 * 1024 || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value.text)) {
        throw new Error("SERVER_SPREADSHEET_INVALID");
      }
      return { content: value.text, parts: Number(value.parts), preview: isSpreadsheetPreview(value.preview) ? value.preview : null };
    } finally { await rm(work, { recursive: true, force: true }); }
  }, { signal: options.signal });
}
