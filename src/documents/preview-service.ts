import { transcribeAudio } from "./audio-transcription";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { StagedDocument } from "@/documents/staging-store";
import type { DocumentConversionAdmission } from "@/documents/conversion-gate";
import { ensurePrivateDirectoryTree } from "@/documents/staging-store";
import { readRegularFileWithin } from "@/security/safe-file";
import { atomicWriteFile, atomicWriteJson, readValidatedJson } from "@/storage/atomic-file";
import { StorageError } from "@/storage/errors";
import type { ResourceLockManager } from "@/storage/resource-lock";
import {
  defineVersionedSchema,
  expectArray,
  expectInteger,
  expectIsoDate,
  expectOneOf,
  expectStrictRecord,
  expectString,
  ValidationContext,
} from "@/storage/schema";

export type DocumentPreview = {
  schemaVersion: 2;
  uploadId: string;
  threadId: string;
  sourceSha256: string;
  status: "ready";
  kind: StagedDocument["kind"];
  files: string[];
  artifacts: Array<{ fileName: string; size: number; sha256: string }>;
  pages: number | null;
  createdAt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PREVIEW_METADATA_BYTES = 64 * 1024;
const MAX_PDF_PREVIEW_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024;

type LegacyDocumentPreview = Omit<DocumentPreview, "schemaVersion" | "artifacts"> & { schemaVersion: 1 };

function parsePreviewArtifact(value: unknown, context: ValidationContext) {
  const record = expectStrictRecord(value, ["fileName", "size", "sha256"], context);
  return {
    fileName: expectString(record.fileName, context.at("fileName"), {
      minLength: 1,
      maxLength: 160,
      pattern: /^[a-z0-9][a-z0-9._-]*$/,
    }),
    size: expectInteger(record.size, context.at("size"), { minimum: 1, maximum: MAX_PDF_PREVIEW_BYTES }),
    sha256: expectString(record.sha256, context.at("sha256"), { pattern: SHA256 }),
  };
}

const previewSchema = defineVersionedSchema<DocumentPreview>({
  name: "DocumentPreview",
  schemaVersion: 2,
  keys: ["uploadId", "threadId", "sourceSha256", "status", "kind", "files", "artifacts", "pages", "createdAt"],
  parse(record, context) {
    const parsed: DocumentPreview = {
      schemaVersion: 2,
      uploadId: expectString(record.uploadId, context.at("uploadId"), { pattern: UUID }),
      threadId: expectString(record.threadId, context.at("threadId"), { pattern: UUID }),
      sourceSha256: expectString(record.sourceSha256, context.at("sourceSha256"), { pattern: SHA256 }),
      status: expectOneOf(record.status, ["ready"] as const, context.at("status")),
      kind: expectOneOf(record.kind, ["docx", "xlsx", "xls", "pptx", "pdf", "text", "image", "audio"] as const, context.at("kind")),
      files: expectArray(record.files, context.at("files"), (value, item) =>
        expectString(value, item, { minLength: 1, maxLength: 160, pattern: /^[a-z0-9][a-z0-9._-]*$/ }), { maxLength: 2 }),
      artifacts: expectArray(record.artifacts, context.at("artifacts"), parsePreviewArtifact, { maxLength: 2 }),
      pages: record.pages === null ? null : expectInteger(record.pages, context.at("pages"), { minimum: 1, maximum: 500 }),
      createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
    };
    const filesMatchKind = parsed.kind === "text" || parsed.kind === "audio"
      ? parsed.files.length === 1 && parsed.files[0] === "preview.txt"
      : parsed.kind === "image"
        ? parsed.files.length === 1 && /^preview[.](?:png|jpe?g|gif|webp)$/u.test(parsed.files[0] ?? "")
        : parsed.files.length === 2 && parsed.files[0] === "document.pdf" && parsed.files[1] === "page-1.png";
    if (!filesMatchKind) context.at("files").fail("do not match the preview kind");
    if (parsed.files.length !== parsed.artifacts.length ||
        parsed.files.some((fileName, index) => parsed.artifacts[index]?.fileName !== fileName)) {
      context.at("artifacts").fail("must attest every preview file in order");
    }
    return parsed;
  },
});

const legacyPreviewSchema = defineVersionedSchema<LegacyDocumentPreview>({
  name: "LegacyDocumentPreview",
  schemaVersion: 1,
  keys: ["uploadId", "threadId", "sourceSha256", "status", "kind", "files", "pages", "createdAt"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      uploadId: expectString(record.uploadId, context.at("uploadId"), { pattern: UUID }),
      threadId: expectString(record.threadId, context.at("threadId"), { pattern: UUID }),
      sourceSha256: expectString(record.sourceSha256, context.at("sourceSha256"), { pattern: SHA256 }),
      status: expectOneOf(record.status, ["ready"] as const, context.at("status")),
      kind: expectOneOf(record.kind, ["docx", "xlsx", "xls", "pptx", "pdf", "text", "image", "audio"] as const, context.at("kind")),
      files: expectArray(record.files, context.at("files"), (value, item) =>
        expectString(value, item, { minLength: 1, maxLength: 160, pattern: /^[a-z0-9][a-z0-9._-]*$/ }), { maxLength: 2 }),
      pages: record.pages === null ? null : expectInteger(record.pages, context.at("pages"), { minimum: 1, maximum: 500 }),
      createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
    };
  },
});

export type ToolRunOptions = {
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  signal?: AbortSignal;
};

export interface DocumentToolRunner {
  run(command: string, args: readonly string[], options: ToolRunOptions): Promise<{ stdout: string; stderr: string }>;
}

export class DocumentToolProcessError extends StorageError {
  constructor(readonly exitCode: number | null, readonly spawnCode: string | null = null) {
    super("DOCUMENT_TOOL_FAILED", `Document tool failed with code ${spawnCode ?? exitCode ?? "unknown"}.`);
  }
}

const MAXIMUM_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;
const TOOL_TERMINATION_GRACE_MS = 250;

type ToolTerminationReason = "aborted" | "output" | "timeout";

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    // Every converter starts as a new process-group leader. Killing the group
    // also reaches LibreOffice helpers instead of leaving them behind after a
    // request cancellation or timeout. Windows has no negative-PID groups.
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

export class SystemDocumentToolRunner implements DocumentToolRunner {
  async run(command: string, args: readonly string[], options: ToolRunOptions) {
    if (options.signal?.aborted) {
      throw new StorageError("DOCUMENT_OPERATION_ABORTED", "Document operation was aborted.");
    }
    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { NODE_ENV: process.env.NODE_ENV ?? "production", ...options.env },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let spawnError: Error | null = null;
      let terminationReason: ToolTerminationReason | null = null;
      let forceKillTimer: NodeJS.Timeout | null = null;

      const terminate = (reason: ToolTerminationReason) => {
        if (terminationReason) return;
        terminationReason = reason;
        try {
          signalProcessTree(child, "SIGTERM");
        } catch {
          // The bounded SIGKILL below remains the authoritative cleanup.
        }
        forceKillTimer = setTimeout(() => {
          try {
            signalProcessTree(child, "SIGKILL");
          } catch {
            // close/error still settles the request without exposing details.
          }
        }, TOOL_TERMINATION_GRACE_MS);
        forceKillTimer.unref();
      };

      const collect = (target: Buffer[], chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += value.length;
        if (outputBytes > MAXIMUM_TOOL_OUTPUT_BYTES) {
          terminate("output");
          return;
        }
        target.push(value);
      };
      child.stdout.on("data", (chunk: Buffer | string) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer | string) => collect(stderr, chunk));

      const abort = () => terminate("aborted");
      options.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
      timeout.unref();

      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        options.signal?.removeEventListener("abort", abort);
        if (terminationReason) {
          // A wrapper can exit before a helper. One final group kill closes that
          // race and makes cleanup independent of the wrapper's exit order.
          try {
            signalProcessTree(child, "SIGKILL");
          } catch {
            // The group is already gone.
          }
        }
        if (terminationReason === "aborted") {
          reject(new StorageError("DOCUMENT_OPERATION_ABORTED", "Document operation was aborted."));
        } else if (terminationReason === "timeout") {
          reject(new StorageError("DOCUMENT_TOOL_TIMEOUT", "Document conversion exceeded its time limit."));
        } else if (terminationReason === "output") {
          reject(new StorageError("DOCUMENT_TOOL_OUTPUT_TOO_LARGE", "Document tool output exceeded its safety limit."));
        } else if (spawnError || code !== 0) {
          const spawnCode = spawnError && "code" in spawnError ? String(spawnError.code) : null;
          reject(new DocumentToolProcessError(code, spawnCode));
        } else {
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        }
      });
    });
  }
}

export type DocumentToolchain = {
  soffice: string;
  pdfinfo: string;
  pdftoppm: string;
  qpdf?: string;
  ffprobe?: string;
  audioTranscriber?: string;
};

function validateToolPath(name: string, value: string | undefined, required: boolean) {
  if (!value) {
    if (required) throw new StorageError("DOCUMENT_TOOL_MISSING", `${name} is required.`);
    return undefined;
  }
  if (!path.isAbsolute(value)) throw new StorageError("DOCUMENT_TOOL_INVALID", `${name} must be an absolute path.`);
  return path.resolve(value);
}

function parsePdfInfo(output: string) {
  const encrypted = /^Encrypted:\s+yes/im.test(output);
  const pagesMatch = output.match(/^Pages:\s+(\d+)\s*$/im);
  const pages = pagesMatch ? Number(pagesMatch[1]) : NaN;
  if (encrypted) throw new StorageError("DOCUMENT_PDF_ENCRYPTED", "Encrypted PDFs are not accepted.");
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 500) {
    throw new StorageError("DOCUMENT_PDF_UNSAFE", "PDF page count is missing or exceeds the safety limit.");
  }
  return pages;
}

function outputExtension(document: StagedDocument) {
  if (document.kind === "image") return path.extname(document.fileName).toLowerCase().slice(1);
  return document.kind === "text" ? "txt" : "pdf";
}

function artifactFor(fileName: string, bytes: Buffer) {
  return {
    fileName,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function maximumArtifactBytes(fileName: string) {
  return fileName === "document.pdf" ? MAX_PDF_PREVIEW_BYTES : MAX_IMAGE_PREVIEW_BYTES;
}

function isPng(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.byteLength > signature.length && signature.every((value, index) => bytes[index] === value);
}

export class DocumentPreviewService {
  readonly previewRoot: string;
  private readonly tools: DocumentToolchain;

  constructor(options: {
    stagingRoot: string;
    previewRoot: string;
    lockManager: ResourceLockManager;
    runner?: DocumentToolRunner;
    tools: DocumentToolchain;
    conversionGate?: DocumentConversionAdmission;
    audioGate?: DocumentConversionAdmission;
    audioTranscribe?: (document: StagedDocument, source: Buffer, signal?: AbortSignal) => Promise<string>;
    requireQpdf?: boolean;
    spreadsheetLayout?: "whole-sheet" | "print";
    now?: () => number;
  }) {
    if (!path.isAbsolute(options.stagingRoot) || !path.isAbsolute(options.previewRoot)) {
      throw new StorageError("DOCUMENT_PREVIEW_OPTIONS_INVALID", "Staging and preview roots must be absolute.");
    }
    this.stagingRoot = path.resolve(options.stagingRoot);
    this.previewRoot = path.resolve(options.previewRoot);
    this.lockManager = options.lockManager;
    this.runner = options.runner ?? new SystemDocumentToolRunner();
    this.conversionGate = options.conversionGate ?? null;
    this.audioGate = options.audioGate ?? null;
    this.audioTranscribe = options.audioTranscribe;
    if (!this.conversionGate && process.env.NODE_ENV === "production") {
      throw new StorageError(
        "DOCUMENT_CONVERSION_GATE_MISSING",
        "Production document previews require installation-wide conversion admission.",
      );
    }
    this.now = options.now ?? Date.now;
    this.spreadsheetLayout = options.spreadsheetLayout ?? "whole-sheet";
    this.tools = {
      ffprobe: validateToolPath("ffprobe", options.tools.ffprobe, false),
      audioTranscriber: validateToolPath("audioTranscriber", options.tools.audioTranscriber, false),
      soffice: validateToolPath("soffice", options.tools.soffice, true)!,
      pdfinfo: validateToolPath("pdfinfo", options.tools.pdfinfo, true)!,
      pdftoppm: validateToolPath("pdftoppm", options.tools.pdftoppm, true)!,
      qpdf: validateToolPath("qpdf", options.tools.qpdf, options.requireQpdf ?? process.env.NODE_ENV === "production"),
    };
  }

  private readonly stagingRoot: string;
  private readonly lockManager: ResourceLockManager;
  private readonly runner: DocumentToolRunner;
  private readonly conversionGate: DocumentConversionAdmission | null;
  private readonly audioTranscribe: ((document: StagedDocument, source: Buffer, signal?: AbortSignal) => Promise<string>) | undefined;
  private readonly audioGate: DocumentConversionAdmission | null;
  private readonly now: () => number;
  private readonly spreadsheetLayout: "whole-sheet" | "print";

  private previewLocations(threadId: string, uploadId: string) {
    if (!UUID.test(threadId) || !UUID.test(uploadId)) {
      throw new StorageError("DOCUMENT_PREVIEW_ID_INVALID", "Preview thread and upload ids must be UUIDs.");
    }
    const relativeDirectory = path.posix.join(threadId, uploadId);
    return {
      relativeDirectory,
      directory: path.join(this.previewRoot, threadId, uploadId),
      metadataPath: path.join(this.previewRoot, threadId, uploadId, "preview.json"),
    };
  }

  private async readMetadata(metadataPath: string): Promise<DocumentPreview | LegacyDocumentPreview> {
    const metadata = await lstat(metadataPath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 ||
        metadata.size > MAX_PREVIEW_METADATA_BYTES || (metadata.mode & 0o077) !== 0) {
      throw new StorageError("DOCUMENT_PREVIEW_UNSAFE", "Preview metadata is not a private regular file.");
    }
    try {
      return await readValidatedJson(metadataPath, previewSchema);
    } catch (error) {
      try {
        return await readValidatedJson(metadataPath, legacyPreviewSchema);
      } catch {
        throw error;
      }
    }
  }

  private async verifyArtifacts(preview: DocumentPreview, directory: string) {
    try {
      for (const artifact of preview.artifacts) {
        const bytes = await readRegularFileWithin(
          directory,
          artifact.fileName,
          maximumArtifactBytes(artifact.fileName),
        );
        if (bytes.length !== artifact.size || artifactFor(artifact.fileName, bytes).sha256 !== artifact.sha256) {
          throw new Error("artifact identity changed");
        }
      }
    } catch (error) {
      throw new StorageError(
        "DOCUMENT_PREVIEW_INTEGRITY_FAILED",
        "Preview artifacts no longer match their durable attestation.",
        { cause: error },
      );
    }
  }

  async create(document: StagedDocument, options: { signal?: AbortSignal } = {}) {
    if (options.signal?.aborted) {
      throw new StorageError("DOCUMENT_OPERATION_ABORTED", "Document preview was aborted.");
    }
    const { directory, metadataPath } = this.previewLocations(document.threadId, document.uploadId);
    return this.lockManager.withLock(`document-preview:${metadataPath}`, async () => {
      try {
        const existing = await this.readMetadata(metadataPath);
        if (existing.sourceSha256 !== document.sha256 || existing.kind !== document.kind ||
            existing.threadId !== document.threadId || existing.uploadId !== document.uploadId) {
          throw new StorageError("DOCUMENT_PREVIEW_CONFLICT", "Preview id already belongs to different source content.");
        }
        if (existing.schemaVersion === 2) {
          try {
            await this.verifyArtifacts(existing, directory);
            return existing;
          } catch (error) {
            if (!(error instanceof StorageError && error.code === "DOCUMENT_PREVIEW_INTEGRITY_FAILED")) throw error;
          }
        }
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      }

      await ensurePrivateDirectoryTree(this.previewRoot, [document.threadId, document.uploadId]);
      const work = await mkdtemp(path.join(directory, ".work-"));
      try {
        const source = await readRegularFileWithin(this.stagingRoot, document.relativePath, 50 * 1024 * 1024);
        if (source.length !== document.size || createHash("sha256").update(source).digest("hex") !== document.sha256) {
          throw new StorageError("DOCUMENT_PREVIEW_SOURCE_CHANGED", "Staged source no longer matches its immutable identity.");
        }
        if (options.signal?.aborted) {
          throw new StorageError("DOCUMENT_OPERATION_ABORTED", "Document preview was aborted.");
        }
        const inputPath = path.join(work, `input${path.extname(document.fileName).toLowerCase()}`);
        if (document.kind !== "audio" || !this.audioTranscribe) {
          await atomicWriteFile(inputPath, source, { mode: 0o600 });
        }
        const files: string[] = [];
        const artifacts: DocumentPreview["artifacts"] = [];
        let pages: number | null = null;

        if (document.kind === "audio") {
          if (!this.audioGate) throw new StorageError("DOCUMENT_AUDIO_UNAVAILABLE", "Audio transcription requires installation-wide admission.");
          await this.audioGate.run(async () => {
            const transcript = this.audioTranscribe
              ? await this.audioTranscribe(document, source, options.signal)
              : await transcribeAudio({
              source, inputPath, work, tools: this.tools, runner: this.runner, signal: options.signal,
            });
            if (options.signal?.aborted) throw new StorageError("DOCUMENT_OPERATION_ABORTED", "Audio transcription was aborted.");
            const bytes = Buffer.from(transcript, "utf8");
            await atomicWriteFile(path.join(directory, "preview.txt"), bytes, { mode: 0o600 });
            files.push("preview.txt");
            artifacts.push(artifactFor("preview.txt", bytes));
          }, { signal: options.signal });
        } else if (document.kind === "text" || document.kind === "image") {
          const name = `preview.${outputExtension(document)}`;
          await atomicWriteFile(path.join(directory, name), source, { mode: 0o600 });
          files.push(name);
          artifacts.push(artifactFor(name, source));
        } else {
          await this.runWithConversionAdmission(async () => {
          let pdfPath = inputPath;
          const environment = {
            HOME: path.join(work, "home"),
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            SAL_USE_VCLPLUGIN: "svp",
          };
          await ensurePrivateDirectoryTree(work, ["home"]);
          if (document.kind !== "pdf") {
            // Calc's normal print pagination slices wide sheets into narrow
            // strips. Whole-sheet export keeps cell styles, merges, drawings
            // and charts together on one vector PDF page per sheet.
            const pdfFilter = document.kind === "xlsx"
              ? this.spreadsheetLayout === "print" ? "pdf:calc_pdf_Export" : 'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}'
              : "pdf";
            const conversionStarted = performance.now();
            const convert = (filter: string) => this.runner.run(this.tools.soffice, [
              `-env:UserInstallation=${pathToFileURL(path.join(work, "lo-profile")).href}`,
              "--headless", "--invisible", "--nologo", "--nodefault", "--nofirststartwizard",
              "--norestore", "--safe-mode", "--convert-to", filter, "--outdir", work, inputPath,
            ], { cwd: work, env: environment,
              timeoutMs: Math.max(1, 60_000 - (performance.now() - conversionStarted)), signal: options.signal });
            try {
              await convert(pdfFilter);
            } catch (error) {
              // Calc can crash drawing SinglePageSheets for an otherwise valid
              // workbook. Retry once using its original print layout, retaining
              // the same sandbox, source bytes and total conversion deadline.
              if (document.kind !== "xlsx" || this.spreadsheetLayout === "print" || !(error instanceof DocumentToolProcessError) ||
                  error.spawnCode !== null || ![134, 139].includes(error.exitCode ?? 0) ||
                  options.signal?.aborted || performance.now() - conversionStarted >= 60_000) throw error;
              await rm(path.join(work, "input.pdf"), { force: true });
              await rm(path.join(work, "lo-profile"), { recursive: true, force: true });
              await convert("pdf:calc_pdf_Export");
            }
            pdfPath = path.join(work, "input.pdf");
          }
          if (this.tools.qpdf) {
            if (document.kind === "pdf") {
              // Recover structural warnings into a separate representation.
              // Fatal parsing errors still fail; the resulting file must pass
              // a strict check below. The staged/workspace source is untouched.
              const normalizedPdfPath = path.join(work, "normalized.pdf");
              // Building a new page container also repairs absent trailer /Size;
              // a plain qpdf rewrite preserves that defect in historical PDFs.
              await this.runner.run(this.tools.qpdf, ["--warning-exit-0", "--empty", "--pages", pdfPath, "1-z", "--", normalizedPdfPath], {
                cwd: work, env: environment, timeoutMs: 15_000, signal: options.signal,
              });
              pdfPath = normalizedPdfPath;
            }
            await this.runner.run(this.tools.qpdf, ["--check", pdfPath], {
              cwd: work, env: environment, timeoutMs: 15_000, signal: options.signal,
            });
          }
          const info = await this.runner.run(this.tools.pdfinfo, [pdfPath], {
            cwd: work, env: environment, timeoutMs: 15_000, signal: options.signal,
          });
          pages = parsePdfInfo(info.stdout);
          await this.runner.run(this.tools.pdftoppm, [
            "-f", "1", "-singlefile", "-png", ...(document.kind === "xlsx" ? ["-scale-to", "2000"] : ["-r", "120"]), pdfPath, path.join(work, "page-1"),
          ], { cwd: work, env: environment, timeoutMs: 30_000, signal: options.signal });
          let pdf: Buffer;
          let image: Buffer;
          try {
            pdf = await readRegularFileWithin(work, path.basename(pdfPath), MAX_PDF_PREVIEW_BYTES);
            image = await readRegularFileWithin(work, "page-1.png", MAX_IMAGE_PREVIEW_BYTES);
          } catch (error) {
            throw new StorageError(
              "DOCUMENT_PREVIEW_TOO_LARGE",
              "Generated preview is unsafe or exceeds its read limit.",
              { cause: error },
            );
          }
          await atomicWriteFile(path.join(directory, "document.pdf"), pdf, { mode: 0o600 });
          await atomicWriteFile(path.join(directory, "page-1.png"), image, { mode: 0o600 });
          await Promise.all([
            chmod(path.join(directory, "document.pdf"), 0o600),
            chmod(path.join(directory, "page-1.png"), 0o600),
          ]);
          files.push("document.pdf", "page-1.png");
          artifacts.push(artifactFor("document.pdf", pdf), artifactFor("page-1.png", image));
          }, options.signal);
        }

        const preview: DocumentPreview = {
          schemaVersion: 2,
          uploadId: document.uploadId,
          threadId: document.threadId,
          sourceSha256: document.sha256,
          status: "ready",
          kind: document.kind,
          files,
          artifacts,
          pages,
          createdAt: new Date(this.now()).toISOString(),
        };
        await atomicWriteJson(metadataPath, preview, previewSchema);
        return preview;
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    });
  }

  async renderPage(threadId: string, uploadId: string, page: number, options: { signal?: AbortSignal } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 500) {
      throw new StorageError("DOCUMENT_PREVIEW_PAGE_INVALID", "Preview page is outside the safe range.");
    }
    const { directory, metadataPath } = this.previewLocations(threadId, uploadId);
    const preview = await this.readMetadata(metadataPath);
    if (preview.kind === "text" || preview.kind === "image" || preview.pages === null || page > preview.pages) {
      throw new StorageError("DOCUMENT_PREVIEW_PAGE_INVALID", "Preview page does not exist.");
    }
    if (preview.schemaVersion === 2) await this.verifyArtifacts(preview, directory);
    const fileName = `page-${page}.png`;
    return this.lockManager.withLock(`document-preview-page:${metadataPath}:${page}`, async () => {
      try {
        const cached = await readRegularFileWithin(directory, fileName, MAX_IMAGE_PREVIEW_BYTES);
        if (!isPng(cached)) throw new Error("invalid cached page");
        return cached;
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
          if (!(error instanceof Error && error.message === "invalid cached page")) throw error;
        }
      }
      const work = await mkdtemp(path.join(directory, ".work-"));
      try {
        // The converter can read only its private work root. Copy verified
        // immutable bytes into it rather than passing a sibling cache path.
        const pdf = await readRegularFileWithin(directory, "document.pdf", MAX_PDF_PREVIEW_BYTES);
        if (preview.schemaVersion === 2) {
          const expected = preview.artifacts.find((artifact) => artifact.fileName === "document.pdf");
          if (!expected || expected.size !== pdf.length || expected.sha256 !== createHash("sha256").update(pdf).digest("hex")) {
            throw new StorageError("DOCUMENT_PREVIEW_INTEGRITY_FAILED", "Cached PDF no longer matches its preview identity.");
          }
        }
        const inputPath = path.join(work, "document.pdf");
        await atomicWriteFile(inputPath, pdf, { mode: 0o600 });
        await this.runWithConversionAdmission(async () => {
          await this.runner.run(this.tools.pdftoppm, [
            "-f", String(page), "-l", String(page), "-singlefile", "-png", ...(preview.kind === "xlsx" ? ["-scale-to", "2000"] : ["-r", "144"]),
            inputPath, path.join(work, "page"),
          ], {
            cwd: work,
            env: { HOME: work, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
            timeoutMs: 30_000,
            signal: options.signal,
          });
        }, options.signal);
        const rendered = await readRegularFileWithin(work, "page.png", MAX_IMAGE_PREVIEW_BYTES);
        if (!isPng(rendered)) throw new StorageError("DOCUMENT_PREVIEW_PAGE_INVALID", "Rendered page is not a PNG.");
        await atomicWriteFile(path.join(directory, fileName), rendered, { mode: 0o600 });
        await chmod(path.join(directory, fileName), 0o600);
        return rendered;
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    });
  }

  private runWithConversionAdmission<T>(operation: () => Promise<T>, signal?: AbortSignal) {
    return this.conversionGate ? this.conversionGate.run(operation, { signal }) : operation();
  }

  async read(threadId: string, uploadId: string) {
    const locations = this.previewLocations(threadId, uploadId);
    const preview = await this.readMetadata(locations.metadataPath);
    if (preview.schemaVersion !== 2) {
      throw new StorageError(
        "DOCUMENT_PREVIEW_REBUILD_REQUIRED",
        "Legacy preview metadata must be rebuilt from its staged source.",
      );
    }
    if (preview.threadId !== threadId || preview.uploadId !== uploadId) {
      throw new StorageError("DOCUMENT_PREVIEW_MISMATCH", "Preview identity does not match its path.");
    }
    await this.verifyArtifacts(preview, locations.directory);
    return preview;
  }

  async readFile(threadId: string, uploadId: string, fileName: string) {
    const preview = await this.read(threadId, uploadId);
    if (!preview.files.includes(fileName)) {
      throw new StorageError("DOCUMENT_PREVIEW_FILE_NOT_FOUND", "Preview file was not found.");
    }
    return readRegularFileWithin(
      this.previewRoot,
      path.posix.join(threadId, uploadId, fileName),
      100 * 1024 * 1024,
    );
  }
}
