import { statfs } from "node:fs/promises";
import path from "node:path";
import { ResourceLockManager, ResourceLockTimeoutError, StorageError } from "@/storage";

const MEBIBYTE = 1024 * 1024;
const PARTS_PER_MILLION = 1_000_000;

type FilesystemCapacity = { bavail: bigint; bsize: bigint; blocks: bigint };

export interface PublicationCapacityGate {
  run<T>(requiredBytes: number, operation: () => T | Promise<T>): Promise<T>;
}

function integer(name: string, value: number, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new StorageError(
      "PUBLICATION_CAPACITY_GATE_INVALID",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function configuredInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw new StorageError("PUBLICATION_CAPACITY_GATE_INVALID", `${name} must be a non-negative integer.`);
  }
  return integer(name, Number(raw), minimum, maximum);
}

function configuredRatioPpm() {
  const raw = process.env.AIBRAIN_MINIMUM_FREE_RATIO?.trim();
  if (!raw) return 50_000;
  if (!/^(?:0(?:\.[0-9]{1,6})?|0?\.[0-9]{1,6})$/u.test(raw)) {
    throw new StorageError(
      "PUBLICATION_CAPACITY_GATE_INVALID",
      "AIBRAIN_MINIMUM_FREE_RATIO must be between zero and 0.95 with at most six decimals.",
    );
  }
  return integer(
    "AIBRAIN_MINIMUM_FREE_RATIO",
    Math.ceil(Number(raw) * PARTS_PER_MILLION),
    0,
    950_000,
  );
}

function ratioBytes(totalBytes: bigint, ratioPpm: number) {
  const numerator = totalBytes * BigInt(ratioPpm);
  return (numerator + BigInt(PARTS_PER_MILLION - 1)) / BigInt(PARTS_PER_MILLION);
}

export class PublicationStorageBackpressureError extends StorageError {
  readonly retryable = true;

  constructor(
    readonly retryAfterMs: number,
    readonly availableBytes: bigint,
    readonly requiredBytes: bigint,
  ) {
    super(
      "PUBLICATION_STORAGE_BACKPRESSURE",
      "The official document volume does not have enough safety headroom for publication.",
    );
  }
}

export class PublicationStorageCapacityUnavailableError extends StorageError {
  readonly retryable = true;

  constructor(options: { cause?: unknown } = {}) {
    super(
      "PUBLICATION_STORAGE_CAPACITY_UNAVAILABLE",
      "The official document volume capacity could not be measured safely.",
      options,
    );
  }
}

/** Installation-wide, process-safe admission held for the complete atomic publish. */
export class FilePublicationCapacityGate implements PublicationCapacityGate {
  readonly capacityRoot: string;
  readonly minimumFreeBytes: number;
  readonly minimumFreeRatioPpm: number;
  readonly retryAfterMs: number;
  private readonly locks: ResourceLockManager;
  private readonly readCapacity: () => Promise<FilesystemCapacity>;

  constructor(options: {
    rootDirectory: string;
    capacityRoot: string;
    minimumFreeBytes?: number;
    minimumFreeRatioPpm?: number;
    retryAfterMs?: number;
    readCapacity?: () => Promise<FilesystemCapacity>;
  }) {
    if (
      !path.isAbsolute(options.rootDirectory)
      || options.rootDirectory === path.parse(options.rootDirectory).root
      || !path.isAbsolute(options.capacityRoot)
      || options.capacityRoot === path.parse(options.capacityRoot).root
    ) {
      throw new StorageError(
        "PUBLICATION_CAPACITY_GATE_INVALID",
        "Publication capacity roots must be non-root absolute paths.",
      );
    }
    this.capacityRoot = path.resolve(options.capacityRoot);
    this.minimumFreeBytes = integer(
      "minimumFreeBytes",
      options.minimumFreeBytes ?? configuredInteger(
        "AIBRAIN_MINIMUM_FREE_BYTES",
        1024 * MEBIBYTE,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      0,
      Number.MAX_SAFE_INTEGER,
    );
    this.minimumFreeRatioPpm = integer(
      "minimumFreeRatioPpm",
      options.minimumFreeRatioPpm ?? configuredRatioPpm(),
      0,
      950_000,
    );
    this.retryAfterMs = integer(
      "retryAfterMs",
      options.retryAfterMs ?? configuredInteger(
        "AIBRAIN_DOCUMENT_STORAGE_RETRY_AFTER_MS",
        5_000,
        1,
        60_000,
      ),
      1,
      60_000,
    );
    this.locks = new ResourceLockManager({
      rootDirectory: path.resolve(options.rootDirectory),
      defaultTimeoutMs: 0,
    });
    this.readCapacity = options.readCapacity ?? (async () => statfs(this.capacityRoot, { bigint: true }));
  }

  private async assertCapacity(requiredBytes: number) {
    integer("requiredBytes", requiredBytes, 1, 200 * MEBIBYTE);
    let capacity: FilesystemCapacity;
    try {
      capacity = await this.readCapacity();
    } catch (error) {
      throw new PublicationStorageCapacityUnavailableError({ cause: error });
    }
    if (capacity.bavail < 0n || capacity.bsize <= 0n || capacity.blocks <= 0n) {
      throw new PublicationStorageCapacityUnavailableError();
    }
    const availableBytes = capacity.bavail * capacity.bsize;
    const totalBytes = capacity.blocks * capacity.bsize;
    const ratioFloor = ratioBytes(totalBytes, this.minimumFreeRatioPpm);
    const floorBytes = BigInt(this.minimumFreeBytes) > ratioFloor
      ? BigInt(this.minimumFreeBytes)
      : ratioFloor;
    const neededBytes = floorBytes + BigInt(requiredBytes);
    if (availableBytes < neededBytes) {
      throw new PublicationStorageBackpressureError(this.retryAfterMs, availableBytes, neededBytes);
    }
  }

  async run<T>(requiredBytes: number, operation: () => T | Promise<T>) {
    let lease;
    try {
      lease = await this.locks.acquire(`document-publication-capacity:${this.capacityRoot}`, { timeoutMs: 0 });
    } catch (error) {
      if (error instanceof ResourceLockTimeoutError) {
        throw new PublicationStorageBackpressureError(this.retryAfterMs, 0n, BigInt(requiredBytes));
      }
      throw error;
    }
    try {
      await this.assertCapacity(requiredBytes);
      return await operation();
    } finally {
      await lease.release();
    }
  }
}
