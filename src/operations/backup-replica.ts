import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { BackupManifest } from "@/operations/backup";
import {
  atomicWriteJson,
  defineVersionedSchema,
  expectIsoDate,
  expectString,
  readValidatedJson,
  ResourceLockManager,
} from "@/storage";

const INSTALLATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BACKUP_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f-]{36}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{8,64}$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const FORWARDED_ENVIRONMENT = Object.freeze([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "B2_ACCOUNT_ID",
  "B2_ACCOUNT_KEY",
  "AZURE_ACCOUNT_NAME",
  "AZURE_ACCOUNT_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_PROJECT_ID",
  "HTTPS_PROXY",
  "NO_PROXY",
  "RESTIC_REST_USERNAME",
  "RESTIC_REST_PASSWORD",
  "RCLONE_CONFIG",
  "SSL_CERT_FILE",
] as const);

export class BackupReplicaError extends Error {
  constructor(readonly code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "BackupReplicaError";
  }
}

export type BackupReplicaReceipt = {
  schemaVersion: 1;
  installationId: string;
  backupId: string;
  sourceFingerprint: string;
  repositoryFingerprint: string;
  remoteSnapshotId: string;
  replicatedAt: string;
  verifiedAt: string;
};

export const backupReplicaReceiptSchema = defineVersionedSchema<BackupReplicaReceipt>({
  name: "BackupReplicaReceipt",
  schemaVersion: 1,
  keys: [
    "installationId",
    "backupId",
    "sourceFingerprint",
    "repositoryFingerprint",
    "remoteSnapshotId",
    "replicatedAt",
    "verifiedAt",
  ],
  parse(record, context) {
    return {
      schemaVersion: 1,
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 2,
        maxLength: 63,
        pattern: INSTALLATION_ID_PATTERN,
      }),
      backupId: expectString(record.backupId, context.at("backupId"), {
        minLength: 53,
        maxLength: 53,
        pattern: BACKUP_ID_PATTERN,
      }),
      sourceFingerprint: expectString(record.sourceFingerprint, context.at("sourceFingerprint"), {
        minLength: 64,
        maxLength: 64,
        pattern: HASH_PATTERN,
      }),
      repositoryFingerprint: expectString(record.repositoryFingerprint, context.at("repositoryFingerprint"), {
        minLength: 64,
        maxLength: 64,
        pattern: HASH_PATTERN,
      }),
      remoteSnapshotId: expectString(record.remoteSnapshotId, context.at("remoteSnapshotId"), {
        minLength: 8,
        maxLength: 64,
        pattern: SNAPSHOT_ID_PATTERN,
      }),
      replicatedAt: expectIsoDate(record.replicatedAt, context.at("replicatedAt")),
      verifiedAt: expectIsoDate(record.verifiedAt, context.at("verifiedAt")),
    };
  },
});

export async function readLatestBackupReplicaReceipt(
  stateRoot: string,
  installationId: string,
): Promise<BackupReplicaReceipt | null> {
  if (!path.isAbsolute(stateRoot) || !INSTALLATION_ID_PATTERN.test(installationId)) {
    throw new BackupReplicaError("REPLICA_CONFIG_INVALID", "Replica receipt scope is invalid.");
  }
  const receiptsRoot = path.join(path.resolve(stateRoot), "receipts");
  let entries;
  try {
    const metadata = await lstat(receiptsRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new BackupReplicaError("REPLICA_RECEIPT_UNSAFE", "Replica receipts root is unsafe.");
    }
    entries = await readdir(receiptsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  const receipts: BackupReplicaReceipt[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !BACKUP_ID_PATTERN.test(entry.name.replace(/\.json$/u, "")) || !entry.name.endsWith(".json")) {
      continue;
    }
    const receiptPath = path.join(receiptsRoot, entry.name);
    const metadata = await lstat(receiptPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
      throw new BackupReplicaError("REPLICA_RECEIPT_UNSAFE", "Replica receipt is unsafe.");
    }
    const receipt = await readValidatedJson(receiptPath, backupReplicaReceiptSchema);
    if (receipt.installationId === installationId) receipts.push(receipt);
  }
  return receipts.sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt))[0] ?? null;
}

export type ResticCommandResult = {
  stdout: string;
  stderr: string;
};

export type ResticCommandRunner = (
  executable: string,
  arguments_: readonly string[],
  options: { environment: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<ResticCommandResult>;

function appendBounded(current: string, chunk: Buffer | string) {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
    throw new BackupReplicaError("REPLICA_OUTPUT_LIMIT", "Restic output exceeded the safety limit.");
  }
  return next;
}

export const runResticCommand: ResticCommandRunner = (executable, arguments_, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      env: options.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let outputError: unknown = null;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, options.timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      if (outputError) return;
      try {
        stdout = appendBounded(stdout, chunk);
      } catch (error) {
        outputError = error;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (outputError) return;
      try {
        stderr = appendBounded(stderr, chunk);
      } catch (error) {
        outputError = error;
        child.kill("SIGTERM");
      }
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new BackupReplicaError("REPLICA_PROCESS_FAILED", "Restic could not be started.", { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outputError) return reject(outputError);
      if (signal) {
        return reject(new BackupReplicaError(
          signal === "SIGTERM" || signal === "SIGKILL" ? "REPLICA_TIMEOUT" : "REPLICA_PROCESS_FAILED",
          "Restic did not complete within the allowed time.",
        ));
      }
      if (code !== 0) {
        return reject(new BackupReplicaError(
          "REPLICA_COMMAND_FAILED",
          `Restic command failed with exit code ${String(code)}.`,
        ));
      }
      resolve({ stdout, stderr });
    });
  });

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeConfigurationValue(name: string, value: string, maximumLength: number) {
  if (!value || value.length > maximumLength || /[\0\r\n]/u.test(value)) {
    throw new BackupReplicaError("REPLICA_CONFIG_INVALID", `${name} is invalid.`);
  }
  return value;
}

function tag(name: string, value: string) {
  return `${name}=${value}`;
}

function snapshotIds(output: string, requiredTags: readonly string[]): string[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output) as unknown;
  } catch (error) {
    throw new BackupReplicaError("REPLICA_RESPONSE_INVALID", "Restic returned invalid snapshot JSON.", { cause: error });
  }
  if (!Array.isArray(decoded)) {
    throw new BackupReplicaError("REPLICA_RESPONSE_INVALID", "Restic snapshot response is not an array.");
  }
  const result: string[] = [];
  for (const item of decoded) {
    if (!item || typeof item !== "object") continue;
    const tags = "tags" in item && Array.isArray(item.tags)
      ? item.tags.filter((value: unknown): value is string => typeof value === "string")
      : [];
    if (requiredTags.some((required) => !tags.includes(required))) continue;
    const id = "id" in item ? item.id : "short_id" in item ? item.short_id : null;
    if (typeof id === "string" && SNAPSHOT_ID_PATTERN.test(id)) result.push(id);
  }
  return result;
}

function backupSnapshotId(output: string) {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && "snapshot_id" in value
        && typeof value.snapshot_id === "string" && SNAPSHOT_ID_PATTERN.test(value.snapshot_id)) {
        return value.snapshot_id;
      }
    } catch {
      // Restic may mix progress lines; only the final JSON summary is authoritative.
    }
  }
  throw new BackupReplicaError("REPLICA_RESPONSE_INVALID", "Restic backup did not return a snapshot id.");
}

function sameReceipt(
  receipt: BackupReplicaReceipt,
  manifest: BackupManifest,
  installationId: string,
  repositoryFingerprint: string,
) {
  return receipt.installationId === installationId
    && receipt.backupId === manifest.backupId
    && receipt.sourceFingerprint === manifest.sourceFingerprint
    && receipt.repositoryFingerprint === repositoryFingerprint;
}

export type ResticBackupReplicatorOptions = {
  installationId: string;
  resticBinary: string;
  repository: string;
  passwordFile: string;
  stateRoot: string;
  verifySnapshot: (snapshotRoot: string) => Promise<BackupManifest>;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  runCommand?: ResticCommandRunner;
};

export class ResticBackupReplicator {
  readonly #installationId: string;
  readonly #resticBinary: string;
  readonly #repository: string;
  readonly #passwordFile: string;
  readonly #stateRoot: string;
  readonly #verifySnapshot: ResticBackupReplicatorOptions["verifySnapshot"];
  readonly #timeoutMs: number;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #now: () => number;
  readonly #runCommand: ResticCommandRunner;
  readonly #locks: ResourceLockManager;

  constructor(options: ResticBackupReplicatorOptions) {
    if (!INSTALLATION_ID_PATTERN.test(options.installationId)) {
      throw new BackupReplicaError("REPLICA_CONFIG_INVALID", "installationId is invalid.");
    }
    if (!path.isAbsolute(options.resticBinary)
      || !path.isAbsolute(options.passwordFile)
      || !path.isAbsolute(options.stateRoot)) {
      throw new BackupReplicaError("REPLICA_CONFIG_INVALID", "Restic paths must be absolute.");
    }
    const timeoutMs = options.timeoutMs ?? 30 * 60 * 1_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 6 * 60 * 60 * 1_000) {
      throw new BackupReplicaError("REPLICA_CONFIG_INVALID", "Restic timeout is invalid.");
    }
    this.#installationId = options.installationId;
    this.#resticBinary = path.resolve(options.resticBinary);
    this.#repository = safeConfigurationValue("repository", options.repository, 2_048);
    this.#passwordFile = path.resolve(options.passwordFile);
    this.#stateRoot = path.resolve(options.stateRoot);
    this.#verifySnapshot = options.verifySnapshot;
    this.#timeoutMs = timeoutMs;
    this.#environment = options.environment ?? process.env;
    this.#now = options.now ?? Date.now;
    this.#runCommand = options.runCommand ?? runResticCommand;
    this.#locks = new ResourceLockManager({ rootDirectory: path.join(this.#stateRoot, "locks") });
  }

  async replicate(snapshotRoot: string) {
    if (!path.isAbsolute(snapshotRoot)) {
      throw new BackupReplicaError("REPLICA_SNAPSHOT_INVALID", "Snapshot root must be absolute.");
    }
    const [binary, password] = await Promise.all([
      lstat(this.#resticBinary),
      lstat(this.#passwordFile),
    ]);
    if (!binary.isFile() || binary.isSymbolicLink() || (binary.mode & 0o111) === 0) {
      throw new BackupReplicaError("REPLICA_BINARY_UNSAFE", "Restic binary must be a real executable file.");
    }
    if (!password.isFile() || password.isSymbolicLink() || password.nlink !== 1 || (password.mode & 0o077) !== 0) {
      throw new BackupReplicaError("REPLICA_SECRET_UNSAFE", "Restic password file must be private and exclusive.");
    }

    const manifest = await this.#verifySnapshot(path.resolve(snapshotRoot));
    const repositoryFingerprint = sha256(this.#repository);
    return this.#locks.withLock(`backup-replica:${this.#installationId}:${manifest.backupId}`, async () => {
      const receiptPath = path.join(this.#stateRoot, "receipts", `${manifest.backupId}.json`);
      try {
        const receipt = await readValidatedJson(receiptPath, backupReplicaReceiptSchema);
        if (!sameReceipt(receipt, manifest, this.#installationId, repositoryFingerprint)) {
          throw new BackupReplicaError("REPLICA_RECEIPT_CONFLICT", "Replica receipt conflicts with this snapshot or repository.");
        }
        return receipt;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }

      const environment: NodeJS.ProcessEnv = {
        NODE_ENV: "production",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        RESTIC_CACHE_DIR: "/tmp/restic-cache",
        RESTIC_REPOSITORY: this.#repository,
        RESTIC_PASSWORD_FILE: this.#passwordFile,
        TMPDIR: "/tmp",
      };
      for (const name of FORWARDED_ENVIRONMENT) {
        const value = this.#environment[name];
        if (value !== undefined) environment[name] = safeConfigurationValue(name, value, 8_192);
      }
      const tags = [
        tag("aibrain-installation", this.#installationId),
        tag("aibrain-backup", manifest.backupId),
        tag("aibrain-source", manifest.sourceFingerprint),
      ];
      const command = (arguments_: readonly string[]) => this.#runCommand(
        this.#resticBinary,
        arguments_,
        { environment, timeoutMs: this.#timeoutMs },
      );
      const lookupArguments = [
        "snapshots",
        "--json",
        "--latest",
        "1",
        ...tags.flatMap((value) => ["--tag", value]),
      ];
      let ids = snapshotIds((await command(lookupArguments)).stdout, tags);
      const replicatedAt = new Date(this.#now()).toISOString();
      let snapshotId = ids.at(-1) ?? null;
      if (!snapshotId) {
        const backupResult = await command([
          "backup",
          path.resolve(snapshotRoot),
          "--json",
          "--host",
          `aibrain-${this.#installationId}`,
          ...tags.flatMap((value) => ["--tag", value]),
        ]);
        snapshotId = backupSnapshotId(backupResult.stdout);
      }
      ids = snapshotIds((await command(lookupArguments)).stdout, tags);
      if (!ids.includes(snapshotId)) {
        throw new BackupReplicaError("REPLICA_REMOTE_MISMATCH", "The replicated snapshot cannot be read back by its exact tags.");
      }
      await command(["check"]);
      const verifiedAt = new Date(this.#now()).toISOString();
      const receipt = backupReplicaReceiptSchema.parse({
        schemaVersion: 1,
        installationId: this.#installationId,
        backupId: manifest.backupId,
        sourceFingerprint: manifest.sourceFingerprint,
        repositoryFingerprint,
        remoteSnapshotId: snapshotId,
        replicatedAt,
        verifiedAt,
      });
      await atomicWriteJson(receiptPath, receipt, backupReplicaReceiptSchema, { mode: 0o600 });
      return receipt;
    });
  }
}

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error && typeof error === "object" && "code" in error
    && (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}
