import path from "node:path";
import { statfs } from "node:fs/promises";

export const DOCUMENT_ATTACHMENT_MINIMUM_FREE_BYTES = 1_000_000_000n;
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

export class DocumentStorageCapacityLowError extends StorageError {
  readonly requiredBytes = DOCUMENT_ATTACHMENT_MINIMUM_FREE_BYTES;
  constructor(readonly availableBytes: bigint) {
    super("DOCUMENT_STORAGE_CAPACITY_LOW", "At least 1 GB of free storage is required to admit attachments.");
  }
}

export class DocumentStorageCapacityUnavailableError extends StorageError {
  readonly retryable = true;
  constructor(cause: unknown) {
    super("DOCUMENT_STORAGE_CAPACITY_UNAVAILABLE", "Attachment storage capacity could not be measured safely.", { cause });
  }
}

// A first upload may not have created its destination directory yet. Only an
// absent path permits checking its existing parent, the filesystem it will use.
async function availableBytesAt(directory: string): Promise<bigint> {
  let current = directory;
  for (;;) {
    try {
      const capacity = await statfs(current, { bigint: true });
      if (typeof capacity.bavail !== "bigint" || typeof capacity.bsize !== "bigint"
        || capacity.bavail < 0n || capacity.bsize <= 0n) throw new Error("Invalid filesystem capacity.");
      return capacity.bavail * capacity.bsize;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        const parent = path.dirname(current);
        if (parent !== current) { current = parent; continue; }
      }
      throw new DocumentStorageCapacityUnavailableError(error);
    }
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
 * lifecycle. Each actual attachment destination must independently have at
 * least 1 GB free, regardless of readiness ratios or upload concurrency.
 * This admission check does not reserve bytes; real write failures remain errors.
 */
export class FileDocumentStorageGate {
  readonly rootDirectory: string;
  readonly capacityDirectories: readonly string[];
  readonly maxActiveUploads: number;
  readonly retryAfterMs: number;
  private readonly locks: ResourceLockManager;

  constructor(options: {
    rootDirectory: string;
    capacityDirectories: readonly string[];
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
    if (!Array.isArray(options.capacityDirectories) || options.capacityDirectories.length === 0
      || options.capacityDirectories.some(directory => typeof directory !== "string"
        || !path.isAbsolute(directory) || path.resolve(directory) === path.parse(directory).root)) {
      throw new StorageError("DOCUMENT_STORAGE_GATE_INVALID", "Actual attachment storage destinations are required.");
    }
    this.capacityDirectories = Object.freeze([...new Set(options.capacityDirectories.map(directory => path.resolve(directory)))]);
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
        for (const directory of this.capacityDirectories) {
          const available = await availableBytesAt(directory);
          if (available < DOCUMENT_ATTACHMENT_MINIMUM_FREE_BYTES) throw new DocumentStorageCapacityLowError(available);
        }
        return await operation();
      } finally {
        await lease.release();
      }
    } catch (error) {
      if (error instanceof DocumentStorageCapacityUnavailableError) throw error;
      if (isFilesystemFull(error)) throw new DocumentStorageFullError(error);
      throw error;
    }
  }
}
