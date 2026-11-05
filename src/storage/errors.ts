export class StorageError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.cause = options.cause;
  }
}

export class SchemaValidationError extends StorageError {
  readonly schemaName: string;
  readonly validationPath: string;

  constructor(
    schemaName: string,
    validationPath: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(
      "STORAGE_SCHEMA_INVALID",
      `${schemaName} is invalid at ${validationPath}: ${message}`,
      options,
    );
    this.schemaName = schemaName;
    this.validationPath = validationPath;
  }
}

export class StorageCorruptionError extends StorageError {
  readonly filePath: string;

  constructor(filePath: string, message: string, options: { cause?: unknown } = {}) {
    super("STORAGE_CORRUPT", `${filePath}: ${message}`, options);
    this.filePath = filePath;
  }
}

export class ResourceLockTimeoutError extends StorageError {
  readonly resourceKey: string;
  readonly timeoutMs: number;

  constructor(resourceKey: string, timeoutMs: number) {
    super(
      "STORAGE_LOCK_TIMEOUT",
      `Timed out after ${timeoutMs}ms while waiting for resource lock.`,
    );
    this.resourceKey = resourceKey;
    this.timeoutMs = timeoutMs;
  }
}

export class ResourceLockOwnershipLostError extends StorageError {
  readonly resourceKey: string;

  constructor(resourceKey: string) {
    super(
      "STORAGE_LOCK_OWNERSHIP_LOST",
      "The resource lock is no longer owned by this lease.",
    );
    this.resourceKey = resourceKey;
  }
}
