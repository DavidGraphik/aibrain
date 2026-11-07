import path from "node:path";
import { ResourceLockTimeoutError, StorageError } from "@/storage/errors";
import { ResourceLockManager, type ResourceLockLease } from "@/storage/resource-lock";

const DEFAULT_MAX_ACTIVE_UPLOADS = 2;
const DEFAULT_RETRY_AFTER_MS = 5_000;

function configuredInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw new StorageError("DOCUMENT_STORAGE_GATE_INVALID", `${name} must be a non-negative integer.`);
  }
  return checkedInteger(name, Number(raw), minimum, maximum);
}

function checkedInteger(name: string, value: number, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new StorageError(
      "DOCUMENT_STORAGE_GATE_INVALID",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export class DocumentStorageBackpressureError extends StorageError {
  readonly retryable = true;
  readonly reason = "busy";

  constructor(readonly retryAfterMs: number) {
    super("DOCUMENT_STORAGE_BACKPRESSURE", "Document storage upload slots are occupied.");
  }
}

export class DocumentStorageFullError extends StorageError {
  constructor(cause: unknown) {
    super("DOCUMENT_STORAGE_FULL", "The filesystem could not persist this document.", { cause });
  }
}

function isFilesystemFull(error: unknown) {
  const visited = new Set<unknown>();
  while (error && typeof error === "object" && !visited.has(error)) {
    visited.add(error);
    if ("code" in error && (error.code === "ENOSPC" || error.code === "EDQUOT")) return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}

/**
 * Installation-wide concurrency admission for the complete upload + preview
 * lifecycle. Attachments do not reserve a fixed or percentage free-space floor;
 * actual filesystem failures remain errors after the operation cleans up.
 */
export class FileDocumentStorageGate {
  readonly rootDirectory: string;
  readonly maxActiveUploads: number;
  readonly retryAfterMs: number;
  private readonly locks: ResourceLockManager;

  constructor(options: {
    rootDirectory: string;
    maxActiveUploads?: number;
    retryAfterMs?: number;
    staleAfterMs?: number;
    heartbeatIntervalMs?: number;
  }) {
    if (
      !path.isAbsolute(options.rootDirectory)
      || options.rootDirectory === path.parse(options.rootDirectory).root
    ) {
      throw new StorageError(
        "DOCUMENT_STORAGE_GATE_INVALID",
        "Storage gate root must be a non-root absolute path.",
      );
    }
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.maxActiveUploads = checkedInteger(
      "maxActiveUploads",
      options.maxActiveUploads ?? configuredInteger(
        "AIBRAIN_DOCUMENT_MAX_ACTIVE_UPLOADS",
        DEFAULT_MAX_ACTIVE_UPLOADS,
        1,
        64,
      ),
      1,
      64,
    );
    this.retryAfterMs = checkedInteger(
      "retryAfterMs",
      options.retryAfterMs ?? configuredInteger(
        "AIBRAIN_DOCUMENT_STORAGE_RETRY_AFTER_MS",
        DEFAULT_RETRY_AFTER_MS,
        1,
        60_000,
      ),
      1,
      60_000,
    );
    this.locks = new ResourceLockManager({
      rootDirectory: this.rootDirectory,
      staleAfterMs: options.staleAfterMs ?? 30_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      defaultTimeoutMs: 0,
    });
  }

  private async acquire(signal?: AbortSignal): Promise<ResourceLockLease> {
    for (let slot = 0; slot < this.maxActiveUploads; slot += 1) {
      try {
        return await this.locks.acquire(`document-storage-slot:${slot}`, { timeoutMs: 0, signal });
      } catch (error) {
        if (!(error instanceof ResourceLockTimeoutError)) throw error;
      }
    }
    throw new DocumentStorageBackpressureError(this.retryAfterMs);
  }

  async run<T>(operation: () => T | Promise<T>, options: { signal?: AbortSignal } = {}) {
    try {
      const lease = await this.acquire(options.signal);
      try {
        return await operation();
      } finally {
        await lease.release();
      }
    } catch (error) {
      if (isFilesystemFull(error)) throw new DocumentStorageFullError(error);
      throw error;
    }
  }
}
