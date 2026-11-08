import path from "node:path";
import { ResourceLockTimeoutError, StorageError } from "@/storage/errors";
import { ResourceLockManager, type ResourceLockLease } from "@/storage/resource-lock";

const DEFAULT_MAX_CONCURRENT_CONVERSIONS = 2;
const DEFAULT_RETRY_AFTER_MS = 1_000;

function positiveInteger(name: string, value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new StorageError(
      "DOCUMENT_CONVERSION_GATE_INVALID",
      `${name} must be an integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

function configuredInteger(name: string, fallback: number, maximum: number) {
  const configured = process.env[name]?.trim();
  if (!configured) return fallback;
  if (!/^[1-9][0-9]*$/u.test(configured)) {
    throw new StorageError("DOCUMENT_CONVERSION_GATE_INVALID", `${name} must be a positive integer.`);
  }
  return positiveInteger(name, Number(configured), maximum);
}

export class DocumentConversionBackpressureError extends StorageError {
  readonly retryable = true;

  constructor(readonly retryAfterMs: number) {
    super(
      "DOCUMENT_CONVERSION_BACKPRESSURE",
      "Document conversion capacity is saturated; retry later.",
    );
  }
}

export interface DocumentConversionAdmission {
  run<T>(operation: () => T | Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
}

/**
 * Installation-wide conversion admission. Slot ownership is represented by
 * heartbeat-backed filesystem locks, so separate Next processes and users
 * share one capacity boundary and abandoned slots recover after a crash.
 */
export class FileDocumentConversionGate implements DocumentConversionAdmission {
  readonly rootDirectory: string;
  readonly maxConcurrent: number;
  readonly retryAfterMs: number;
  private readonly locks: ResourceLockManager;

  constructor(options: {
    rootDirectory: string;
    maxConcurrent?: number;
    retryAfterMs?: number;
    staleAfterMs?: number;
    heartbeatIntervalMs?: number;
  }) {
    if (!path.isAbsolute(options.rootDirectory) || options.rootDirectory === path.parse(options.rootDirectory).root) {
      throw new StorageError(
        "DOCUMENT_CONVERSION_GATE_INVALID",
        "Conversion gate root must be a non-root absolute path.",
      );
    }
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.maxConcurrent = positiveInteger(
      "maxConcurrent",
      options.maxConcurrent ?? configuredInteger(
        "AIBRAIN_DOCUMENT_MAX_CONVERSIONS",
        DEFAULT_MAX_CONCURRENT_CONVERSIONS,
        64,
      ),
      64,
    );
    this.retryAfterMs = positiveInteger(
      "retryAfterMs",
      options.retryAfterMs ?? configuredInteger(
        "AIBRAIN_DOCUMENT_RETRY_AFTER_MS",
        DEFAULT_RETRY_AFTER_MS,
        60_000,
      ),
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
    for (let slot = 0; slot < this.maxConcurrent; slot += 1) {
      try {
        return await this.locks.acquire(`document-conversion-slot:${slot}`, {
          timeoutMs: 0,
          signal,
        });
      } catch (error) {
        if (!(error instanceof ResourceLockTimeoutError)) throw error;
      }
    }
    throw new DocumentConversionBackpressureError(this.retryAfterMs);
  }

  async run<T>(operation: () => T | Promise<T>, options: { signal?: AbortSignal } = {}) {
    const lease = await this.acquire(options.signal);
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }
}
