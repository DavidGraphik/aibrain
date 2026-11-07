import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { generateLocalDocument } from "@/runtime/documents/local-document-generator";
import { DocumentPreviewService } from "@/documents/preview-service";
import { FileDocumentStagingStore } from "@/documents/staging-store";
import { validateUploadedDocument } from "@/documents/upload-validation";
import { ResourceLockManager } from "@/storage/resource-lock";

const run = promisify(execFile);
const darwin = process.platform === "darwin";
const tools = {
  soffice: process.env.AIBRAIN_SOFFICE_BIN ?? (darwin ? "/Applications/LibreOffice.app/Contents/MacOS/soffice" : "/usr/bin/soffice"),
  pdfinfo: process.env.AIBRAIN_PDFINFO_BIN ?? (darwin ? "/opt/homebrew/bin/pdfinfo" : "/usr/bin/pdfinfo"),
  pdftoppm: process.env.AIBRAIN_PDFTOPPM_BIN ?? (darwin ? "/opt/homebrew/bin/pdftoppm" : "/usr/bin/pdftoppm"),
  qpdf: process.env.AIBRAIN_QPDF_BIN ?? (darwin ? "/opt/homebrew/bin/qpdf" : "/usr/bin/qpdf"),
};
const pdftotext = process.env.AIBRAIN_PDFTOTEXT_BIN ?? (darwin ? "/opt/homebrew/bin/pdftotext" : "/usr/bin/pdftotext");
const enabled = process.env.AIBRAIN_REAL_DOCUMENT_MATRIX === "1" && [...Object.values(tools), pdftotext].every(existsSync);

it.skipIf(!enabled).each(["pdf", "docx", "pptx", "xlsx"] as const)(
  "regenerates an old %s cache from unchanged source and verifies native pixels/text",
  async (format) => {
    const root = await mkdtemp(path.join(tmpdir(), "files-feedback-native-"));
    try {
      const source = await generateLocalDocument({ format, title: "Hello world", content: "Hello world\nFILES FEEDBACK NATIVE",
        ...(format === "xlsx" ? { rows: [["Values"], [10], [20], [{ formula: "SUM(A2:A3)" }], ["=SUM(A2:A3)"]] } : {}),
      });
      const stagingRoot = path.join(root, "staging");
      const previewRoot = path.join(root, "previews");
      const locks = new ResourceLockManager({ rootDirectory: path.join(root, "locks") });
      const staged = await new FileDocumentStagingStore(stagingRoot, locks).stage({
        threadId: "11111111-1111-4111-8111-111111111111", uploadId: "22222222-2222-4222-8222-222222222222",
        validated: validateUploadedDocument({ fileName: `hello-world.${format}`, declaredMimeType: source.mimeType, data: source.data }), data: source.data,
      });
      const service = new DocumentPreviewService({ stagingRoot, previewRoot, tools, lockManager: locks, requireQpdf: true });
      const initial = await service.create(staged);
      expect(initial.pages).toBeGreaterThan(0);
      const directory = path.join(previewRoot, staged.threadId, staged.uploadId);
      const legacy: Record<string, unknown> = { ...initial, schemaVersion: 1 };
      delete legacy.artifacts;
      await writeFile(path.join(directory, "preview.json"), JSON.stringify(legacy), { mode: 0o600 });
      await expect(service.readFile(staged.threadId, staged.uploadId, "document.pdf"))
        .rejects.toMatchObject({ code: "DOCUMENT_PREVIEW_REBUILD_REQUIRED" });
      await service.create(staged);
      const pdf = await service.readFile(staged.threadId, staged.uploadId, "document.pdf");
      const png = await service.readFile(staged.threadId, staged.uploadId, "page-1.png");
      expect(png.length).toBeGreaterThan(1000);
      const extracted = (await run(pdftotext, ["-layout", path.join(directory, "document.pdf"), "-"])).stdout;
      if (format === "xlsx") {
        expect(extracted).toMatch(/\b30\b/);
        expect(extracted).toContain("=SUM(A2:A3)");
      } else expect(extracted).toContain("Hello world");
      await rm(path.join(directory, "page-1.png"));
      await service.create(staged);
      expect((await service.readFile(staged.threadId, staged.uploadId, "page-1.png")).length).toBeGreaterThan(1000);
      expect(await readFile(path.join(stagingRoot, staged.relativePath))).toEqual(source.data);
      if (process.env.AIBRAIN_FILES_EVIDENCE_DIR) {
        const evidence = process.env.AIBRAIN_FILES_EVIDENCE_DIR;
        await mkdir(evidence, { recursive: true });
        await writeFile(path.join(evidence, `hello-world.${format}`), source.data);
        await writeFile(path.join(evidence, `${format}-preview.pdf`), pdf);
        await writeFile(path.join(evidence, `${format}-page-1.png`), png);
        await writeFile(path.join(evidence, `${format}-text.txt`), extracted);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 90_000,
);
