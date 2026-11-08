import { mkdtemp, readFile, readdir, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DocumentPreviewService,
  DocumentToolProcessError,
  SystemDocumentToolRunner,
  type DocumentToolRunner,
} from "@/documents/preview-service";
import { FileDocumentStagingStore } from "@/documents/staging-store";
import { validateUploadedDocument } from "@/documents/upload-validation";
import { generatedPngFixture } from "../../tests/helpers/png-fixture";
import { ResourceLockManager } from "@/storage/resource-lock";
import { StorageError } from "@/storage/errors";
import { generateLocalDocument } from "@/runtime/documents/local-document-generator";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";

class FakeRunner implements DocumentToolRunner {
  calls: Array<{ command: string; args: readonly string[] }> = [];
  async run(command: string, args: readonly string[]) {
    this.calls.push({ command, args });
    return { stdout: "Pages:          2\nEncrypted:      no\n", stderr: "" };
  }
}

async function eventually<T>(read: () => Promise<T>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

describe("document preview service", () => {
  let root: string;
  let stagingRoot: string;
  let previewRoot: string;
  let locks: ResourceLockManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aibrain-preview-"));
    stagingRoot = path.join(root, "staging");
    previewRoot = path.join(root, "previews");
    locks = new ResourceLockManager({ rootDirectory: path.join(root, "locks") });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prints the reviewed workbook using its own print area and never whole-sheet export", async () => {
    const generated = await generateLocalDocument({ format: "xlsx", title: "Print fixture", content: "Synthetic fixture", rows: [["Test", "15:00–20:45"]] });
    const staged = await new FileDocumentStagingStore(stagingRoot, locks).stage({ threadId: THREAD_ID, uploadId: UPLOAD_ID, data: generated.data,
      validated: validateUploadedDocument({ fileName: "reviewed.xlsx", declaredMimeType: generated.mimeType, data: generated.data }) });
    const filters: string[] = [];
    const runner: DocumentToolRunner = { async run(command, args, options) {
      if (command.endsWith("soffice")) {
        filters.push(args[args.indexOf("--convert-to") + 1]);
        expect(await readFile(args.at(-1)!)).toEqual(generated.data);
        await writeFile(path.join(options.cwd, "input.pdf"), "%PDF-1.7\nprint fixture\n%%EOF");
      }
      if (command.endsWith("pdftoppm")) await writeFile(`${args.at(-1)}.png`, generatedPngFixture(16, 9));
      return { stdout: "Pages: 1\nEncrypted: no\n", stderr: "" };
    } };
    const service = new DocumentPreviewService({ stagingRoot, previewRoot, lockManager: locks, runner, spreadsheetLayout: "print",
      tools: { soffice: "/tools/soffice", pdfinfo: "/tools/pdfinfo", pdftoppm: "/tools/pdftoppm", qpdf: "/tools/qpdf" } });
    expect((await service.create(staged)).pages).toBe(1); expect(filters).toEqual(["pdf:calc_pdf_Export"]);
    expect(await readFile(path.join(stagingRoot, staged.relativePath))).toEqual(generated.data);
  });

  it.each([134, 139])("uses original print layout after Calc whole-sheet crash %s without changing the workbook", async (exitCode) => {
    const generated = await generateLocalDocument({ format: "xlsx", title: "Synthetic schedule", content: "Fixture", rows: [["Person", "Hours"], ["Test", "15:00–20:45"]] });
    const staged = await new FileDocumentStagingStore(stagingRoot, locks).stage({
      threadId: THREAD_ID, uploadId: UPLOAD_ID, data: generated.data,
      validated: validateUploadedDocument({ fileName: "schedule.xlsx", declaredMimeType: generated.mimeType, data: generated.data }),
    });
    const filters: string[] = [], budgets: number[] = [], commands: string[] = [];
    const runner: DocumentToolRunner = {
      async run(command, args, options) {
        commands.push(command);
        if (command.endsWith("soffice")) {
          filters.push(args[args.indexOf("--convert-to") + 1]); budgets.push(options.timeoutMs);
          expect(args).toEqual(expect.arrayContaining(["--safe-mode", "--norestore", "--headless"]));
          expect(await readFile(args.at(-1)!)).toEqual(generated.data);
          const pdf = path.join(options.cwd, "input.pdf");
          if (filters.length === 1) {
            await writeFile(pdf, "incomplete crash output");
            throw new DocumentToolProcessError(exitCode);
          }
          await expect(readFile(pdf)).rejects.toMatchObject({ code: "ENOENT" });
          await writeFile(pdf, "%PDF-1.7\noriginal print layout fixture\n%%EOF");
        }
        if (command.endsWith("pdftoppm")) await writeFile(`${args.at(-1)}.png`, generatedPngFixture(16, 9));
        return { stdout: "Pages: 1\nEncrypted: no\n", stderr: "" };
      },
    };
    const service = new DocumentPreviewService({ stagingRoot, previewRoot, lockManager: locks, runner,
      tools: { soffice: "/tools/soffice", pdfinfo: "/tools/pdfinfo", pdftoppm: "/tools/pdftoppm", qpdf: "/tools/qpdf" } });
    const preview = await service.create(staged);
    expect(preview).toMatchObject({ status: "ready", pages: 1, sourceSha256: staged.sha256 });
    expect(filters).toEqual(['pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}', "pdf:calc_pdf_Export"]);
    expect(budgets[1]).toBeLessThanOrEqual(budgets[0]);
    expect(commands).toEqual(["/tools/soffice", "/tools/soffice", "/tools/qpdf", "/tools/pdfinfo", "/tools/pdftoppm"]);
    expect(await readFile(path.join(stagingRoot, staged.relativePath))).toEqual(generated.data);
    await expect(service.create(staged)).resolves.toEqual(preview);
    expect(filters).toHaveLength(2);
  });

  it.each([
    ["sandbox refusal", new DocumentToolProcessError(78)],
    ["missing executable", new DocumentToolProcessError(null, "ENOENT")],
    ["timeout", new StorageError("DOCUMENT_TOOL_TIMEOUT", "timeout")],
    ["cancellation", new StorageError("DOCUMENT_OPERATION_ABORTED", "cancelled")],
    ["unsafe PDF", new StorageError("DOCUMENT_PDF_UNSAFE", "unsafe")],
  ] as const)("does not retry %s as a print-layout fallback", async (_reason, failure) => {
    const generated = await generateLocalDocument({ format: "xlsx", title: "Fixture", content: "Fixture", rows: [["Test", 1]] });
    const staged = await new FileDocumentStagingStore(stagingRoot, locks).stage({
      threadId: THREAD_ID, uploadId: UPLOAD_ID, data: generated.data,
      validated: validateUploadedDocument({ fileName: "fixture.xlsx", declaredMimeType: generated.mimeType, data: generated.data }),
    });
    let calls = 0;
    const service = new DocumentPreviewService({ stagingRoot, previewRoot, lockManager: locks,
      runner: { async run() { calls++; throw failure; } },
      tools: { soffice: "/tools/soffice", pdfinfo: "/tools/pdfinfo", pdftoppm: "/tools/pdftoppm" }, requireQpdf: false });
    await expect(service.create(staged)).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(await readdir(path.join(previewRoot, THREAD_ID, UPLOAD_ID))).toEqual([]);
  });

  it("records the converter exit status without exposing its output", async () => {
    await expect(new SystemDocumentToolRunner().run(process.execPath, ["-e", "process.exit(134)"], {
      cwd: root, env: {}, timeoutMs: 5_000,
    })).rejects.toMatchObject({ code: "DOCUMENT_TOOL_FAILED", exitCode: 134, spawnCode: null });
  });

  it.each(["client work", "données # 100%"])("keeps the Office profile URL inside a work directory containing %s", async (name) => {
    const generated = await generateLocalDocument({ format: "xlsx", title: "Synthetic", content: "QA", rows: [["Code"], ["00123"]] });
    const staged = await new FileDocumentStagingStore(stagingRoot, locks).stage({
      threadId: THREAD_ID, uploadId: UPLOAD_ID, data: generated.data,
      validated: validateUploadedDocument({ fileName: "synthetic.xlsx", declaredMimeType: generated.mimeType, data: generated.data }),
    });
    const runner: DocumentToolRunner = {
      async run(command, args, options) {
        if (command.endsWith("soffice")) {
          const argument = args.find((arg) => arg.startsWith("-env:UserInstallation="))!;
          const profileUrl = argument.slice("-env:UserInstallation=".length);
          expect(profileUrl).not.toMatch(/[\s#]/u);
          expect(fileURLToPath(profileUrl)).toBe(path.join(options.cwd, "lo-profile"));
          await writeFile(path.join(options.cwd, "input.pdf"), "%PDF-1.7\n%%EOF\n");
        }
        if (command.endsWith("pdftoppm")) await writeFile(`${args.at(-1)}.png`, generatedPngFixture());
        return { stdout: "Pages: 1\nEncrypted: no\n", stderr: "" };
      },
    };
    const service = new DocumentPreviewService({ stagingRoot, previewRoot: path.join(root, name, "previews"), lockManager: locks,
      runner, tools: { soffice: "/tools/soffice", pdfinfo: "/tools/pdfinfo", pdftoppm: "/tools/pdftoppm" }, requireQpdf: false });
    expect((await service.create(staged)).pages).toBe(1);
  });

  it("creates an idempotent text preview without invoking external tools", async () => {
    const data = Buffer.from("safe text");
    const staged = await new FileDocumentStagingStore(stagingRoot, locks).stage({
      threadId: THREAD_ID,
      uploadId: UPLOAD_ID,
      data,
      validated: validateUploadedDocument({ fileName: "notes.txt", declaredMimeType: "text/plain", data }),
    });
    const runner = new FakeRunner();
    const service = new DocumentPreviewService({
      stagingRoot,
      previewRoot,
      lockManager: locks,
      runner,
      tools: { soffice: "/tools/soffice", pdfinfo: "/tools/pdfinfo", pdftoppm: "/tools/pdftoppm" },
      requireQpdf: false,
      now: () => 1_000,
    });

    const first = await service.create(staged);
    const second = await service.create(staged);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: 2,
      files: ["preview.txt"],
      artifacts: [{ fileName: "preview.txt", size: data.length, sha256: staged.sha256 }],
      pages: null,
      status: "ready",
    });
    expect(runner.calls).toHaveLength(0);
    expect(await readFile(path.join(previewRoot, THREAD_ID, UPLOAD_ID, "preview.txt"), "utf8")).toBe("safe text");
    expect((await service.read(THREAD_ID, UPLOAD_ID)).sourceSha256).toBe(staged.sha256);
    expect((await service.readFile(THREAD_ID, UPLOAD_ID, "preview.txt")).toString("utf8")).toBe("safe text");
    await expect(service.readFile(THREAD_ID, UPLOAD_ID, "not-listed.txt"))
      .rejects.toMatchObject({ code: "DOCUMENT_PREVIEW_FILE_NOT_FOUND" });

    const previewPath = path.join(previewRoot, THREAD_ID, UPLOAD_ID, "preview.txt");
    const outside = path.join(root, "outside-preview.txt");
    await writeFile(outside, "outside", { mode: 0o600 });
    await unlink(previewPath);
    await symlink(outside, previewPath);
    await expect(service.readFile(THREAD_ID, UPLOAD_ID, "preview.txt"))
      .rejects.toMatchObject({ code: "DOCUMENT_PREVIEW_INTEGRITY_FAILED" });
    await expect(service.create(staged)).rejects.toMatchObject({ code: "STORAGE_SYMLINK_REJECTED" });
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  it("rebuilds legacy metadata and an altered ready artifact from the staged source", async () => {
    const data = Buffer.from("attested source");
    const staged = await new FileDocumentStagingStore(stagingRoot, locks).stage({
      threadId: THREAD_ID,
      uploadId: UPLOAD_ID,
      data,
      validated: validateUploadedDocument({ fileName: "notes.txt", declaredMimeType: "text/plain", data }),
    });
    const service = new DocumentPreviewService({
      stagingRoot,
      previewRoot,
      lockManager: locks,
      runner: new FakeRunner(),
      tools: { soffice: "/tools/soffice", pdfinfo: "/tools/pdfinfo", pdftoppm: "/tools/pdftoppm" },
      requireQpdf: false,
    });
    const created = await service.create(staged);
    const directory = path.join(previewRoot, THREAD_ID, UPLOAD_ID);
    const metadataPath = path.join(directory, "preview.json");
    await writeFile(path.join(directory, "preview.txt"), "altered", { mode: 0o600 });
    await expect(service.read(THREAD_ID, UPLOAD_ID))
      .rejects.toMatchObject({ code: "DOCUMENT_PREVIEW_INTEGRITY_FAILED" });
    const repaired = await service.create(staged);
    expect(repaired.artifacts).toEqual(created.artifacts);
    expect(await readFile(path.join(directory, "preview.txt"), "utf8")).toBe("attested source");

    await unlink(path.join(directory, "preview.txt"));
    await expect(service.read(THREAD_ID, UPLOAD_ID))
      .rejects.toMatchObject({ code: "DOCUMENT_PREVIEW_INTEGRITY_FAILED" });
    await expect(service.create(staged)).resolves.toMatchObject({ artifacts: created.artifacts });

    const legacy = { ...repaired } as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.artifacts;
    await writeFile(metadataPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
    await expect(service.read(THREAD_ID, UPLOAD_ID))
      .rejects.toMatchObject({ code: "DOCUMENT_PREVIEW_REBUILD_REQUIRED" });
    await expect(service.create(staged)).resolves.toMatchObject({ schemaVersion: 2 });
  });

  it("renders page two from verified PDF bytes inside the exact private converter root", async () => {
    const data = Buffer.from("%PDF-1.7\nsynthetic two-page fixture\n%%EOF\n");
    const png = generatedPngFixture(16, 9);
    const staged = await new FileDocumentStagingStore(stagingRoot, locks).stage({
      threadId: THREAD_ID, uploadId: UPLOAD_ID, data,
      validated: validateUploadedDocument({ fileName: "slides.pdf", declaredMimeType: "application/pdf", data }),
    });
    let pageTwoCalls = 0;
    const runner: DocumentToolRunner = {
      async run(command, args, options) {
        if (command.endsWith("pdfinfo")) return { stdout: "Pages: 2\nEncrypted: no\n", stderr: "" };
        if (command.endsWith("pdftoppm")) {
          if (args[1] === "2") {
            pageTwoCalls += 1;
            expect(path.basename(options.cwd)).toMatch(/^\.work-[A-Za-z0-9_-]+$/u);
            const input = args.at(-2)!;
            expect(input).toBe(path.join(options.cwd, "document.pdf"));
            expect(await readFile(input)).toEqual(data);
            expect(args.at(-1)).toBe(path.join(options.cwd, "page"));
          }
          await writeFile(`${args.at(-1)}.png`, png);
        }
        return { stdout: "", stderr: "" };
      },
    };
    const service = new DocumentPreviewService({ stagingRoot, previewRoot, lockManager: locks, runner,
      tools: { soffice: "/tools/soffice", pdfinfo: "/tools/pdfinfo", pdftoppm: "/tools/pdftoppm" }, requireQpdf: false });
    await service.create(staged);
    expect(await service.renderPage(THREAD_ID, UPLOAD_ID, 2)).toEqual(png);
    expect(pageTwoCalls).toBe(1);
    const directory = path.join(previewRoot, THREAD_ID, UPLOAD_ID);
    expect((await readdir(directory)).filter((entry) => entry.startsWith(".work-"))).toEqual([]);
    await writeFile(path.join(directory, "document.pdf"), "tampered PDF");
    await expect(service.renderPage(THREAD_ID, UPLOAD_ID, 2)).rejects.toMatchObject({ code: "DOCUMENT_PREVIEW_INTEGRITY_FAILED" });
    expect(pageTwoCalls).toBe(1);
  });

  it("rejects a sparse oversized converter output before loading it into memory", async () => {
    const data = Buffer.from("%PDF-1.7\n%%EOF\n");
    const staged = await new FileDocumentStagingStore(stagingRoot, locks).stage({
      threadId: THREAD_ID,
      uploadId: UPLOAD_ID,
      data,
      validated: validateUploadedDocument({ fileName: "report.pdf", declaredMimeType: "application/pdf", data }),
    });
    const runner: DocumentToolRunner = {
      async run(command, args) {
        if (command.endsWith("pdfinfo")) return { stdout: "Pages: 1\nEncrypted: no\n", stderr: "" };
        if (command.endsWith("pdftoppm")) {
          const outputPrefix = args.at(-1)!;
          await writeFile(`${outputPrefix}.png`, "x", { mode: 0o600 });
          await truncate(`${outputPrefix}.png`, 20 * 1024 * 1024 + 1);
        }
        return { stdout: "", stderr: "" };
      },
    };
    const service = new DocumentPreviewService({
      stagingRoot,
      previewRoot,
      lockManager: locks,
      runner,
      tools: { soffice: "/tools/soffice", pdfinfo: "/tools/pdfinfo", pdftoppm: "/tools/pdftoppm" },
      requireQpdf: false,
    });
    await expect(service.create(staged)).rejects.toMatchObject({ code: "DOCUMENT_PREVIEW_TOO_LARGE" });
    expect((await readdir(path.join(previewRoot, THREAD_ID, UPLOAD_ID)))
      .filter((entry) => entry.startsWith(".work-"))).toEqual([]);
  });

  it.each([
    { reason: "request cancellation", expectedCode: "DOCUMENT_OPERATION_ABORTED", abort: true },
    { reason: "conversion timeout", expectedCode: "DOCUMENT_TOOL_TIMEOUT", abort: false },
  ])("kills the complete converter process group after $reason", async ({ expectedCode, abort }) => {
    const pidFile = path.join(root, `converter-child-${abort ? "abort" : "timeout"}.pid`);
    const childProgram = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const parentProgram = [
      "const {spawn}=require('node:child_process')",
      "const {writeFileSync}=require('node:fs')",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{stdio:'ignore'})`,
      "writeFileSync(process.argv[1],String(child.pid))",
      "process.on('SIGTERM',()=>{})",
      "setInterval(()=>{},1000)",
    ].join(";");
    const controller = new AbortController();
    const runner = new SystemDocumentToolRunner();
    const startedAt = Date.now();
    const running = runner.run(process.execPath, ["-e", parentProgram, pidFile], {
      cwd: root,
      env: {},
      timeoutMs: abort ? 5_000 : 250,
      signal: controller.signal,
    });
    const childPid = Number(await eventually(async () => await readFile(pidFile, "utf8")));
    expect(processIsAlive(childPid)).toBe(true);
    if (abort) controller.abort();
    await expect(running).rejects.toMatchObject({ code: expectedCode });
    await eventually(async () => {
      if (processIsAlive(childPid)) throw new Error("converter child is still alive");
      return true;
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("fails closed when production requires qpdf but none is configured", () => {
    expect(() => new DocumentPreviewService({
      stagingRoot,
      previewRoot,
      lockManager: locks,
      runner: new FakeRunner(),
      tools: { soffice: "/tools/soffice", pdfinfo: "/tools/pdfinfo", pdftoppm: "/tools/pdftoppm" },
      requireQpdf: true,
    })).toThrowError(expect.objectContaining({ code: "DOCUMENT_TOOL_MISSING" }));
  });
});
