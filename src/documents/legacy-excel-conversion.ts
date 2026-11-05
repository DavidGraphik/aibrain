import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { atomicWriteFile } from "@/storage/atomic-file";
import { readRegularFileWithin } from "@/security/safe-file";
import { validateUploadedDocument } from "./upload-validation";
import { SystemDocumentToolRunner, type DocumentToolRunner } from "./preview-service";
import type { DocumentConversionAdmission } from "./conversion-gate";

export type LegacyExcelConversionOptions = {
  soffice: string;
  conversionGate: DocumentConversionAdmission;
  runner?: DocumentToolRunner;
};

/** Convert only a validated original, in the existing networkless document sandbox. */
export async function convertLegacyExcelToXlsx(
  bytes: Buffer,
  options: LegacyExcelConversionOptions,
  signal?: AbortSignal,
): Promise<Buffer> {
  validateUploadedDocument({ fileName: "source.xls", declaredMimeType: "application/vnd.ms-excel", data: bytes });
  if (!path.isAbsolute(options.soffice)) throw new Error("Legacy Excel converter must be an absolute path.");
  return options.conversionGate.run(async () => {
    const work = await mkdtemp(path.join(tmpdir(), "aibrain-turn-document-"));
    try {
      const source = path.join(work, "source.xls");
      await atomicWriteFile(source, bytes, { mode: 0o600 });
      await (options.runner ?? new SystemDocumentToolRunner()).run(options.soffice, [
        `-env:UserInstallation=file://${path.join(work, "lo-profile")}`,
        "--headless", "--invisible", "--nologo", "--nodefault", "--nofirststartwizard",
        "--norestore", "--safe-mode", "--convert-to", "xlsx:Calc MS Excel 2007 XML", "--outdir", work, source,
      ], {
        cwd: work,
        env: { HOME: work, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", SAL_USE_VCLPLUGIN: "svp" },
        timeoutMs: 60_000,
        signal,
      });
      const converted = await readRegularFileWithin(work, "source.xlsx", 50 * 1024 * 1024);
      const result = validateUploadedDocument({ fileName: "source.xlsx", declaredMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: converted });
      if (result.kind !== "xlsx") throw new Error("Legacy Excel conversion did not produce an XLSX workbook.");
      return converted;
    } finally { await rm(work, { recursive: true, force: true }); }
  }, { signal });
}
