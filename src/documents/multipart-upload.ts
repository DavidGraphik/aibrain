import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import Busboy from "busboy";
import { documentUploadTemporaryLockKey } from "@/documents/maintenance";
import { ensurePrivateDirectoryTree } from "@/documents/staging-store";
import { UploadValidationError } from "@/documents/upload-validation";
import type { ResourceLockManager } from "@/storage/resource-lock";

export const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_MULTIPART_BYTES = 52 * 1024 * 1024;

export type ParsedDocumentUpload = {
  uploadId: string;
  fileName: string;
  declaredMimeType: string;
  temporaryPath: string;
  size: number;
  dispose(): Promise<void>;
};

class MultipartByteLimit extends Transform {
  private received = 0;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ) {
    this.received += chunk.length;
    if (this.received > MAX_MULTIPART_BYTES) {
      callback(new UploadValidationError("UPLOAD_SIZE_INVALID", "Multipart request exceeds the safety limit."));
      return;
    }
    callback(null, chunk);
  }
}

function safeContentLength(request: Request) {
  const raw = request.headers.get("content-length");
  if (raw === null) return;
  if (!/^\d+$/u.test(raw)) {
    throw new UploadValidationError("UPLOAD_MULTIPART_INVALID", "Content-Length is invalid.");
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > MAX_MULTIPART_BYTES) {
    throw new UploadValidationError("UPLOAD_SIZE_INVALID", "Multipart request exceeds the safety limit.");
  }
}

/**
 * Parses the two-field upload contract without materialising either the
 * multipart request or the file in memory. The returned path is random,
 * private, server-owned and must always be disposed by the caller.
 */
export async function parseStreamingDocumentUpload(
  request: Request,
  stagingRoot: string,
  lockManager: ResourceLockManager,
): Promise<ParsedDocumentUpload> {
  safeContentLength(request);
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new UploadValidationError("UPLOAD_MULTIPART_INVALID", "Expected multipart/form-data.");
  }
  if (!request.body) {
    throw new UploadValidationError("UPLOAD_MULTIPART_INVALID", "Multipart request has no body.");
  }

  const incomingRoot = await ensurePrivateDirectoryTree(stagingRoot, [".incoming"]);
  const incomingMetadata = await lstat(incomingRoot);
  if (incomingMetadata.isSymbolicLink() || !incomingMetadata.isDirectory() || (incomingMetadata.mode & 0o077) !== 0) {
    throw new UploadValidationError("UPLOAD_SOURCE_UNSAFE", "Incoming upload directory is not private.");
  }
  const temporaryPath = path.join(incomingRoot, `${randomUUID()}.upload`);
  let uploadId: string | null = null;
  let fileName: string | null = null;
  let declaredMimeType: string | null = null;
  let fileSize = 0;
  let fields = 0;
  let files = 0;
  let contractError: UploadValidationError | null = null;
  const fileCompletions: Promise<void>[] = [];

  const rejectContract = (code: string, message: string) => {
    contractError ??= new UploadValidationError(code, message);
  };

  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: { "content-type": contentType },
      // Browser FormData sends ordinary filename parameters as UTF-8. Latin-1
      // decoding corrupts employee names and breaks exact attachment matching.
      defParamCharset: "utf8",
      limits: {
        fieldNameSize: 64,
        headerPairs: 32,
        fieldSize: 128,
        fields: 1,
        fileSize: MAX_UPLOAD_FILE_BYTES,
        files: 1,
        // Busboy emits partsLimit when the limit itself is reached, so three
        // means the required two parts are accepted and any third is rejected.
        parts: 3,
      },
    });
  } catch (error) {
    throw new UploadValidationError("UPLOAD_MULTIPART_INVALID", "Multipart boundary is invalid.", { cause: error });
  }

  parser.on("field", (name, value, info) => {
    fields += 1;
    if (name !== "uploadId" || info.nameTruncated || info.valueTruncated || uploadId !== null) {
      rejectContract("UPLOAD_MULTIPART_CONTRACT_INVALID", "Multipart must contain exactly one uploadId field.");
      return;
    }
    uploadId = value;
  });
  parser.on("file", (name, file, info) => {
    files += 1;
    // Busboy can emit a trailing-file error after its parent parser rejects an
    // incomplete form; retain a listener after nested pipeline cleanup.
    file.on("error", () => undefined);
    if (name !== "file" || files !== 1 || !info.filename) {
      rejectContract("UPLOAD_MULTIPART_CONTRACT_INVALID", "Multipart must contain exactly one file.");
      file.resume();
      return;
    }
    fileName = info.filename;
    declaredMimeType = info.mimeType;
    file.pause();
    file.on("data", (chunk: Buffer) => {
      fileSize += chunk.length;
    });
    file.on("limit", () => {
      rejectContract("UPLOAD_SIZE_INVALID", "Upload exceeds the file safety limit.");
    });
    fileCompletions.push((async () => {
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        handle = await open(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        const destination = createWriteStream(temporaryPath, { fd: handle.fd, autoClose: false });
        file.resume();
        await pipeline(file, destination);
        await handle.sync();
      } catch (error) {
        file.resume();
        if (!contractError) {
          contractError = error instanceof UploadValidationError
            ? error
            : new UploadValidationError("UPLOAD_MULTIPART_INVALID", "Could not persist multipart upload.", { cause: error });
        }
      } finally {
        await handle?.close().catch(() => undefined);
      }
    })());
  });
  parser.on("fieldsLimit", () => rejectContract(
    "UPLOAD_MULTIPART_CONTRACT_INVALID",
    "Multipart contains too many fields.",
  ));
  parser.on("filesLimit", () => rejectContract(
    "UPLOAD_MULTIPART_CONTRACT_INVALID",
    "Multipart contains too many files.",
  ));
  parser.on("partsLimit", () => rejectContract(
    "UPLOAD_MULTIPART_CONTRACT_INVALID",
    "Multipart contains too many parts.",
  ));
  // Keep a listener after pipeline removes its temporary listeners: Busboy can
  // report an incomplete trailing file on the following microtask.
  parser.on("error", () => undefined);

  const temporaryLease = await lockManager.acquire(documentUploadTemporaryLockKey(temporaryPath));
  try {
    const source = Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>);
    await pipeline(source, new MultipartByteLimit(), parser, { signal: request.signal });
    await Promise.all(fileCompletions);
    if (contractError) throw contractError;
    if (fields !== 1 || files !== 1 || uploadId === null || fileName === null || declaredMimeType === null) {
      throw new UploadValidationError(
        "UPLOAD_MULTIPART_CONTRACT_INVALID",
        "Multipart must contain exactly uploadId and file.",
      );
    }
    if (fileSize < 1 || fileSize > MAX_UPLOAD_FILE_BYTES) {
      throw new UploadValidationError("UPLOAD_SIZE_INVALID", "Upload size is outside the safety limit.");
    }
    let disposed = false;
    return {
      uploadId,
      fileName,
      declaredMimeType,
      temporaryPath,
      size: fileSize,
      async dispose() {
        if (disposed) return;
        disposed = true;
        try {
          await unlink(temporaryPath).catch((error: unknown) => {
            if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
          });
        } finally {
          await temporaryLease.release();
        }
      },
    };
  } catch (error) {
    await Promise.allSettled(fileCompletions);
    try {
      await unlink(temporaryPath).catch(() => undefined);
    } finally {
      await temporaryLease.release();
    }
    if (error instanceof UploadValidationError) throw error;
    if (request.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new UploadValidationError("UPLOAD_ABORTED", "Upload was aborted before completion.", { cause: error });
    }
    throw new UploadValidationError("UPLOAD_MULTIPART_INVALID", "Multipart body is malformed.", { cause: error });
  }
}
