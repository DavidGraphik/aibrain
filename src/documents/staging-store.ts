import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { ValidatedUpload } from "@/documents/upload-validation";
import { parseLegacyExcelProvenance, parseStoredLegacyExcelReceipt, type LegacyExcelProvenance, type StoredLegacyExcelReceipt } from "./legacy-excel-policy";
import { atomicWriteFile, atomicWriteJson, fsyncDirectory, readValidatedJson } from "@/storage/atomic-file";
import { StorageError } from "@/storage/errors";
import type { ResourceLockManager } from "@/storage/resource-lock";
import {
  defineVersionedSchema,
  expectInteger,
  expectIsoDate,
  expectOneOf,
  expectString,
} from "@/storage/schema";

export type StagedDocument = {
  schemaVersion: 1;
  uploadId: string;
  threadId: string;
  fileName: string;
  relativePath: string;
  kind: ValidatedUpload["kind"];
  mediaType: string;
  size: number;
  sha256: string;
  status: "staged";
  createdAt: string;
  legacyExcel?: LegacyExcelProvenance;
  storedLegacyExcel?: StoredLegacyExcelReceipt;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_METADATA_BYTES = 64 * 1024;

const baseStagedDocumentSchema = defineVersionedSchema<Omit<StagedDocument, "legacyExcel" | "storedLegacyExcel">>({
  name: "StagedDocument",
  schemaVersion: 1,
  keys: [
    "uploadId", "threadId", "fileName", "relativePath", "kind", "mediaType",
    "size", "sha256", "status", "createdAt",
  ],
  parse(record, context) {
    return {
      schemaVersion: 1,
      uploadId: expectString(record.uploadId, context.at("uploadId"), { pattern: UUID }),
      threadId: expectString(record.threadId, context.at("threadId"), { pattern: UUID }),
      fileName: expectString(record.fileName, context.at("fileName"), { minLength: 1, maxLength: 120 }),
      relativePath: expectString(record.relativePath, context.at("relativePath"), {
        minLength: 1,
        maxLength: 500,
        pattern: /^threads\/[0-9a-f-]+\/uploads\/[0-9a-f-]+\/[^/\\]+$/i,
      }),
      kind: expectOneOf(record.kind, ["docx", "xlsx", "xls", "pptx", "pdf", "text", "image", "audio"] as const, context.at("kind")),
      mediaType: expectString(record.mediaType, context.at("mediaType"), { minLength: 1, maxLength: 180 }),
      size: expectInteger(record.size, context.at("size"), { minimum: 1, maximum: 50 * 1024 * 1024 }),
      sha256: expectString(record.sha256, context.at("sha256"), { pattern: SHA256 }),
      status: expectOneOf(record.status, ["staged"] as const, context.at("status")),
      createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
    };
  },
});

// Preserve old v1 metadata while strictly validating the optional new provenance.
const stagedDocumentSchema = {
  name: "StagedDocument",
  parse(value: unknown, source?: string): StagedDocument {
    if (!value || typeof value !== "object" || Array.isArray(value)) return baseStagedDocumentSchema.parse(value, source);
    const { legacyExcel, storedLegacyExcel, ...base } = value as Record<string, unknown>;
    const document = baseStagedDocumentSchema.parse(base, source);
    if (storedLegacyExcel !== undefined) {
      try {
        if (legacyExcel !== undefined || document.kind !== "text" || document.mediaType !== "text/plain" ||
            !document.fileName.endsWith(".xls-status.txt")) throw new Error("Invalid receipt type.");
        return { ...document, storedLegacyExcel: parseStoredLegacyExcelReceipt(storedLegacyExcel) };
      } catch { throw new StorageError("STORAGE_STAGING_METADATA_UNSAFE", "Stored XLS receipt is invalid."); }
    }
    if (legacyExcel === undefined) return document;
    try {
      if (document.kind !== "xlsx" || !document.fileName.endsWith(".passive.xlsx")) throw new Error("Invalid derivative type.");
      return { ...document, legacyExcel: parseLegacyExcelProvenance(legacyExcel) };
    } catch {
      throw new StorageError("STORAGE_STAGING_METADATA_UNSAFE", "Passive XLS provenance is invalid.");
    }
  },
};

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function readStagedMetadata(metadataPath: string) {
  const metadata = await lstat(metadataPath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 ||
      metadata.size > MAX_METADATA_BYTES || (metadata.mode & 0o077) !== 0) {
    throw new StorageError("STORAGE_STAGING_METADATA_UNSAFE", "Staging metadata is not a private regular file.");
  }
  return readValidatedJson(metadataPath, stagedDocumentSchema);
}

async function atomicCopyValidatedFile(
  sourcePath: string,
  targetPath: string,
  validated: ValidatedUpload,
) {
  const temporary = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  let source: Awaited<ReturnType<typeof open>> | null = null;
  let destination: Awaited<ReturnType<typeof open>> | null = null;
  try {
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const sourceMetadata = await source.stat();
    if (!sourceMetadata.isFile() || sourceMetadata.nlink !== 1 || (sourceMetadata.mode & 0o077) !== 0) {
      throw new StorageError("STORAGE_STAGING_SOURCE_UNSAFE", "Staging source is not a private regular file.");
    }
    destination = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position <= validated.size) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > validated.size) {
        throw new StorageError("STORAGE_STAGING_CONTENT_MISMATCH", "Validated upload grew before staging.");
      }
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written);
        written += result.bytesWritten;
      }
    }
    if (position !== validated.size || hash.digest("hex") !== validated.sha256) {
      throw new StorageError("STORAGE_STAGING_CONTENT_MISMATCH", "Validated upload changed before staging.");
    }
    await destination.sync();
    await destination.close();
    destination = null;
    try {
      await link(temporary, targetPath);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new StorageError("STORAGE_STAGING_ID_CONFLICT", "Staged content already exists and was not overwritten.");
      }
      throw error;
    }
    await fsyncDirectory(path.dirname(targetPath));
    await unlink(temporary);
    await fsyncDirectory(path.dirname(targetPath));
  } finally {
    await source?.close().catch(() => undefined);
    await destination?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function assertExistingContentMatches(
  targetPath: string,
  validated: ValidatedUpload,
  mismatchCode = "STORAGE_STAGING_ID_CONFLICT",
) {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new StorageError("STORAGE_STAGING_CONTENT_MISSING", "Staging metadata points to missing content.");
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
      throw new StorageError("STORAGE_STAGING_ORPHAN_UNSAFE", "Orphaned staged content is not a private regular file.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position <= validated.size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > validated.size) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (position !== validated.size || hash.digest("hex") !== validated.sha256) {
      throw new StorageError(mismatchCode, "Staged content differs from its validated identity.");
    }
  } finally {
    await handle.close();
  }
}

export async function ensurePrivateDirectoryTree(root: string, segments: readonly string[]) {
  const assertDirectory = async (directory: string) => {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new StorageError("STORAGE_SYMLINK_REJECTED", `Unsafe staging directory ${directory}.`);
    }
  };
  let current = root;
  await mkdir(current, { recursive: true, mode: 0o700 });
  await assertDirectory(current);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await assertDirectory(current);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
      }
      await assertDirectory(current);
    }
  }
  return current;
}

export class FileDocumentStagingStore {
  readonly rootDirectory: string;

  constructor(
    rootDirectory: string,
    private readonly lockManager: ResourceLockManager,
    private readonly now: () => number = Date.now,
  ) {
    if (!path.isAbsolute(rootDirectory) || rootDirectory === path.parse(rootDirectory).root) {
      throw new StorageError("STORAGE_STAGING_OPTIONS_INVALID", "Staging root must be a non-root absolute path.");
    }
    this.rootDirectory = path.resolve(rootDirectory);
  }

  private paths(threadId: string, uploadId: string, fileName: string) {
    if (!UUID.test(threadId) || !UUID.test(uploadId)) {
      throw new StorageError("STORAGE_STAGING_ID_INVALID", "Thread and upload ids must be UUIDs.");
    }
    if (
      fileName.length < 1
      || fileName.length > 120
      || fileName === "."
      || fileName === ".."
      || fileName !== path.basename(fileName)
      || fileName.includes("/")
      || fileName.includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(fileName)
    ) {
      throw new StorageError("STORAGE_STAGING_FILENAME_INVALID", "Staging filename is unsafe.");
    }
    const relativeDirectory = path.posix.join("threads", threadId, "uploads", uploadId);
    return {
      relativeDirectory,
      relativePath: path.posix.join(relativeDirectory, fileName),
      directory: path.join(this.rootDirectory, "threads", threadId, "uploads", uploadId),
      metadataPath: path.join(this.rootDirectory, "threads", threadId, "uploads", uploadId, "upload.json"),
      contentPath: path.join(this.rootDirectory, "threads", threadId, "uploads", uploadId, fileName),
    };
  }

  async stage(input: {
    threadId: string;
    uploadId: string;
    validated: ValidatedUpload;
    data: Buffer;
  }) {
    const actualHash = createHash("sha256").update(input.data).digest("hex");
    if (input.data.length !== input.validated.size || actualHash !== input.validated.sha256) {
      throw new StorageError("STORAGE_STAGING_CONTENT_MISMATCH", "Validated upload size changed before staging.");
    }
    const locations = this.paths(input.threadId, input.uploadId, input.validated.fileName);
    return this.lockManager.withLock(`document-upload:${locations.metadataPath}`, async () => {
      try {
        const existing = await readStagedMetadata(locations.metadataPath);
        if (existing.sha256 !== input.validated.sha256 || existing.fileName !== input.validated.fileName) {
          throw new StorageError("STORAGE_STAGING_ID_CONFLICT", "Upload id already identifies different content.");
        }
        await assertExistingContentMatches(
          locations.contentPath,
          input.validated,
          "STORAGE_STAGING_CONTENT_CORRUPT",
        );
        return existing;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }

      await ensurePrivateDirectoryTree(this.rootDirectory, [
        "threads", input.threadId, "uploads", input.uploadId,
      ]);
      await atomicWriteFile(locations.contentPath, input.data, { mode: 0o600 });
      const metadata: StagedDocument = {
        schemaVersion: 1,
        uploadId: input.uploadId,
        threadId: input.threadId,
        fileName: input.validated.fileName,
        relativePath: locations.relativePath,
        kind: input.validated.kind,
        mediaType: input.validated.mediaType,
        size: input.validated.size,
        sha256: input.validated.sha256,
        status: "staged",
        createdAt: new Date(this.now()).toISOString(),
        ...(input.validated.legacyExcel ? { legacyExcel: input.validated.legacyExcel } : {}),
        ...(input.validated.storedLegacyExcel ? { storedLegacyExcel: input.validated.storedLegacyExcel } : {}),
      };
      await atomicWriteJson(locations.metadataPath, metadata, stagedDocumentSchema);
      return metadata;
    });
  }

  async stageFile(input: {
    threadId: string;
    uploadId: string;
    validated: ValidatedUpload;
    sourcePath: string;
  }) {
    const locations = this.paths(input.threadId, input.uploadId, input.validated.fileName);
    return this.lockManager.withLock(`document-upload:${locations.metadataPath}`, async () => {
      try {
        const existing = await readStagedMetadata(locations.metadataPath);
        if (existing.sha256 !== input.validated.sha256 || existing.fileName !== input.validated.fileName) {
          throw new StorageError("STORAGE_STAGING_ID_CONFLICT", "Upload id already identifies different content.");
        }
        await assertExistingContentMatches(
          locations.contentPath,
          input.validated,
          "STORAGE_STAGING_CONTENT_CORRUPT",
        );
        return existing;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }

      await ensurePrivateDirectoryTree(this.rootDirectory, [
        "threads", input.threadId, "uploads", input.uploadId,
      ]);
      const orphanEntries = await readdir(locations.directory);
      if (orphanEntries.length === 0) {
        await atomicCopyValidatedFile(input.sourcePath, locations.contentPath, input.validated);
      } else if (orphanEntries.length === 1 && orphanEntries[0] === input.validated.fileName) {
        await assertExistingContentMatches(locations.contentPath, input.validated);
      } else {
        throw new StorageError(
          "STORAGE_STAGING_ORPHAN_CONFLICT",
          "Upload directory contains ambiguous orphaned content and cannot be recovered automatically.",
        );
      }
      const metadata: StagedDocument = {
        schemaVersion: 1,
        uploadId: input.uploadId,
        threadId: input.threadId,
        fileName: input.validated.fileName,
        relativePath: locations.relativePath,
        kind: input.validated.kind,
        mediaType: input.validated.mediaType,
        size: input.validated.size,
        sha256: input.validated.sha256,
        status: "staged",
        createdAt: new Date(this.now()).toISOString(),
        ...(input.validated.legacyExcel ? { legacyExcel: input.validated.legacyExcel } : {}),
        ...(input.validated.storedLegacyExcel ? { storedLegacyExcel: input.validated.storedLegacyExcel } : {}),
      };
      await atomicWriteJson(locations.metadataPath, metadata, stagedDocumentSchema);
      return metadata;
    });
  }

  async read(threadId: string, uploadId: string, fileName: string) {
    const locations = this.paths(threadId, uploadId, fileName);
    const metadata = await readStagedMetadata(locations.metadataPath);
    if (metadata.threadId !== threadId || metadata.uploadId !== uploadId || metadata.fileName !== fileName) {
      throw new StorageError("STORAGE_STAGING_METADATA_MISMATCH", "Staged document identity does not match its path.");
    }
    return metadata;
  }

  async readById(threadId: string, uploadId: string) {
    if (!UUID.test(threadId) || !UUID.test(uploadId)) {
      throw new StorageError("STORAGE_STAGING_ID_INVALID", "Thread and upload ids must be UUIDs.");
    }
    const metadataPath = path.join(
      this.rootDirectory,
      "threads",
      threadId,
      "uploads",
      uploadId,
      "upload.json",
    );
    const metadata = await readStagedMetadata(metadataPath);
    if (metadata.threadId !== threadId || metadata.uploadId !== uploadId) {
      throw new StorageError("STORAGE_STAGING_METADATA_MISMATCH", "Staged document identity does not match its path.");
    }
    const expected = this.paths(threadId, uploadId, metadata.fileName);
    if (metadata.relativePath !== expected.relativePath) {
      throw new StorageError("STORAGE_STAGING_METADATA_MISMATCH", "Staged document path does not match its identity.");
    }
    return metadata;
  }

  async resolveContentById(threadId: string, uploadId: string) {
    const document = await this.readById(threadId, uploadId);
    const locations = this.paths(threadId, uploadId, document.fileName);
    await assertExistingContentMatches(locations.contentPath, {
      kind: document.kind,
      fileName: document.fileName,
      mediaType: document.mediaType,
      size: document.size,
      sha256: document.sha256,
      officeEntries: null,
    }, "STORAGE_STAGING_CONTENT_CORRUPT");
    return Object.freeze({ document, absolutePath: locations.contentPath });
  }
}
