import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  SchemaValidationError,
  StorageCorruptionError,
  StorageError,
} from "@/storage/errors";
import { parseJson, type StorageSchema } from "@/storage/schema";

export type AtomicWriteStage =
  | "temporary-created"
  | "temporary-synced"
  | "renamed"
  | "directory-synced";

export type AtomicWriteOptions = {
  mode?: number;
  preserveTemporaryOnError?: boolean;
  onStage?: (stage: AtomicWriteStage, temporaryPath: string) => void | Promise<void>;
};

export type AtomicRecoveryReport<T> = {
  value: T;
  recovered: boolean;
  recoveredFrom: string | null;
  quarantined: string[];
};

type Candidate<T> = {
  filePath: string;
  modifiedAtMs: number;
  value: T;
};

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}

export function atomicTemporaryPath(targetPath: string, identifier: string = randomUUID()) {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(identifier)) {
    throw new StorageError("STORAGE_TEMP_ID_INVALID", "Atomic temporary identifier is invalid.");
  }
  const resolved = path.resolve(targetPath);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.${identifier}.tmp`);
}

function atomicTemporaryPrefix(targetPath: string) {
  const resolved = path.resolve(targetPath);
  return `.${path.basename(resolved)}.`;
}

export async function fsyncDirectory(directoryPath: string) {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertTargetIsNotSymlink(targetPath: string) {
  try {
    const target = await lstat(targetPath);
    if (target.isSymbolicLink()) {
      throw new StorageError(
        "STORAGE_SYMLINK_REJECTED",
        `Refusing to replace symbolic link ${targetPath}.`,
      );
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

export async function atomicWriteFile(
  targetPath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
) {
  return atomicWriteFileChunks(targetPath, [data], options);
}

/** Bounded producers retain the same fsync/rename and failure cleanup boundary. */
export async function atomicWriteFileChunks(
  targetPath: string,
  chunks: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>,
  options: AtomicWriteOptions = {},
) {
  const target = path.resolve(targetPath);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertTargetIsNotSymlink(target);

  const temporary = atomicTemporaryPath(target);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let renamed = false;
  try {
    handle = await open(temporary, "wx", options.mode ?? 0o600);
    await options.onStage?.("temporary-created", temporary);
    for await (const chunk of chunks) await handle.writeFile(chunk);
    await handle.sync();
    await options.onStage?.("temporary-synced", temporary);
    await handle.close();
    handle = null;
    await rename(temporary, target);
    renamed = true;
    await options.onStage?.("renamed", temporary);
    await fsyncDirectory(directory);
    await options.onStage?.("directory-synced", temporary);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    if (!renamed && !options.preserveTemporaryOnError) {
      await unlink(temporary).catch((unlinkError: unknown) => {
        if (!isNodeError(unlinkError, "ENOENT")) throw unlinkError;
      });
    }
    throw error;
  }
}

export async function atomicWriteJson<T>(
  targetPath: string,
  value: T,
  schema: StorageSchema<T>,
  options: AtomicWriteOptions = {},
) {
  const validated = schema.parse(value, targetPath);
  await atomicWriteFile(targetPath, `${JSON.stringify(validated, null, 2)}\n`, options);
}

export async function readValidatedJson<T>(targetPath: string, schema: StorageSchema<T>) {
  try {
    return parseJson(schema, await readFile(targetPath, "utf8"), targetPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw error;
    if (!(error instanceof SchemaValidationError)) throw error;
    throw new StorageCorruptionError(targetPath, "file does not satisfy its storage schema", {
      cause: error,
    });
  }
}

export async function listAtomicTemporaryFiles(targetPath: string) {
  const target = path.resolve(targetPath);
  const directory = path.dirname(target);
  const prefix = atomicTemporaryPrefix(target);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".tmp"))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

async function quarantine(filePath: string, reason: "corrupt" | "orphaned") {
  const destination = `${filePath}.${reason}.${randomUUID()}`;
  try {
    await rename(filePath, destination);
    return destination;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function tryReadCandidate<T>(
  filePath: string,
  schema: StorageSchema<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: parseJson(schema, await readFile(filePath, "utf8"), filePath) };
  } catch (error) {
    if (!(error instanceof SchemaValidationError)) throw error;
    return { ok: false, error };
  }
}

/**
 * Recovers a versioned JSON file after an interrupted atomic write.
 *
 * The caller must hold the resource lock for `targetPath`. A valid target is
 * always authoritative: a temporary file only becomes visible when the target
 * is absent or corrupt. Invalid and superseded temporaries are quarantined so
 * no recovery attempt silently destroys forensic evidence.
 */
export async function recoverAtomicJsonFile<T>(
  targetPath: string,
  schema: StorageSchema<T>,
  options: { minimumTemporaryAgeMs?: number; now?: () => number } = {},
): Promise<AtomicRecoveryReport<T>> {
  const target = path.resolve(targetPath);
  const now = options.now ?? Date.now;
  const minimumAge = options.minimumTemporaryAgeMs ?? 0;
  if (!Number.isFinite(minimumAge) || minimumAge < 0) {
    throw new StorageError(
      "STORAGE_RECOVERY_OPTIONS_INVALID",
      "minimumTemporaryAgeMs must be a non-negative finite number.",
    );
  }

  let targetResult: Awaited<ReturnType<typeof tryReadCandidate<T>>> | null = null;
  try {
    targetResult = await tryReadCandidate(target, schema);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  if (targetResult && !targetResult.ok && isNodeError(targetResult.error, "ENOENT")) {
    targetResult = null;
  }

  const validCandidates: Candidate<T>[] = [];
  const corruptCandidates: string[] = [];
  for (const temporary of await listAtomicTemporaryFiles(target)) {
    let metadata;
    try {
      metadata = await stat(temporary);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      throw error;
    }
    // Some filesystems expose sub-millisecond mtimes that can appear a
    // fraction ahead of Date.now(). A zero safety window means "consider all
    // candidates", including a temporary written in this same millisecond.
    if (minimumAge > 0 && now() - metadata.mtimeMs < minimumAge) continue;
    const result = await tryReadCandidate(temporary, schema);
    if (result.ok) {
      validCandidates.push({
        filePath: temporary,
        modifiedAtMs: metadata.mtimeMs,
        value: result.value,
      });
    } else {
      corruptCandidates.push(temporary);
    }
  }

  validCandidates.sort((left, right) =>
    right.modifiedAtMs - left.modifiedAtMs || right.filePath.localeCompare(left.filePath));

  const quarantined: string[] = [];
  const quarantineAll = async (candidates: string[], reason: "corrupt" | "orphaned") => {
    for (const candidate of candidates) {
      const destination = await quarantine(candidate, reason);
      if (destination) quarantined.push(destination);
    }
  };

  if (targetResult?.ok) {
    await quarantineAll(corruptCandidates, "corrupt");
    await quarantineAll(validCandidates.map((candidate) => candidate.filePath), "orphaned");
    if (quarantined.length > 0) await fsyncDirectory(path.dirname(target));
    return {
      value: targetResult.value,
      recovered: false,
      recoveredFrom: null,
      quarantined,
    };
  }

  const selected = validCandidates.shift();
  if (!selected) {
    await quarantineAll(corruptCandidates, "corrupt");
    if (quarantined.length > 0) await fsyncDirectory(path.dirname(target));
    if (targetResult && !targetResult.ok) {
      throw new StorageCorruptionError(target, "target and all recovery candidates are invalid", {
        cause: targetResult.error,
      });
    }
    const missing = new Error(`ENOENT: no storage file or recoverable temporary for ${target}`) as NodeJS.ErrnoException;
    missing.code = "ENOENT";
    throw missing;
  }

  if (targetResult && !targetResult.ok) {
    const destination = await quarantine(target, "corrupt");
    if (destination) quarantined.push(destination);
  }
  await rename(selected.filePath, target);
  await quarantineAll(corruptCandidates, "corrupt");
  await quarantineAll(validCandidates.map((candidate) => candidate.filePath), "orphaned");
  await fsyncDirectory(path.dirname(target));
  return {
    value: selected.value,
    recovered: true,
    recoveredFrom: selected.filePath,
    quarantined,
  };
}
