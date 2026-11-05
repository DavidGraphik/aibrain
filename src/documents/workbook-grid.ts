import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isSpreadsheetPreview, type SpreadsheetPreview } from "@/documents/spreadsheet-preview";
import { validateUploadedDocument } from "@/documents/upload-validation";
import { atomicWriteFile } from "@/storage/atomic-file";

const run = promisify(execFile);

/** Read saved XLSX cell values only, after the caller has authorized the source. */
export async function prepareWorkbookGrid(input: { fileName: string; data: Buffer; signal?: AbortSignal }): Promise<SpreadsheetPreview> {
  const validated = validateUploadedDocument({
    fileName: input.fileName,
    declaredMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    data: input.data,
  });
  if (validated.kind !== "xlsx") throw new Error("A workbook is required.");
  const directory = await mkdtemp(path.join(tmpdir(), "aibrain-workbook-grid-"));
  try {
    await chmod(directory, 0o700);
    const source = path.join(directory, "source.xlsx");
    await atomicWriteFile(source, input.data, { mode: 0o600 });
    const script = process.env.NODE_ENV === "production"
      ? "/usr/local/share/aibrain/xlsx-turn-text.py"
      : path.resolve(process.cwd(), "scripts/xlsx-turn-text.py");
    const { stdout } = await run("/usr/bin/python3", [script, "--preview-json", source], {
      cwd: directory,
      timeout: 15_000,
      maxBuffer: 100_000,
      signal: input.signal,
      env: { NODE_ENV: process.env.NODE_ENV, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    const result: unknown = JSON.parse(stdout);
    if (!isSpreadsheetPreview(result)) throw new Error("Invalid workbook grid.");
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
