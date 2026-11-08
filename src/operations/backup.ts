import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import { publicationBarrierLock } from "@/documents/publication-locks";
import {
  atomicWriteJson,
  defineVersionedSchema,
  expectArray,
  expectInteger,
  expectIsoDate,
  expectOneOf,
  expectStrictRecord,
  expectString,
  fsyncDirectory,
  parseJson,
  readValidatedJson,
  ResourceLockManager,
  type ValidationContext,
} from "@/storage";
import { readRegularFileWithin } from "@/security/safe-file";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const INSTALLATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BACKUP_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f-]{36}$/;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const SENSITIVE_ROOT_DIRECTORIES = new Set([
  "auth-challenges",
  "auth-rate-limits",
  "secrets",
  "sessions",
]);

export class BackupError extends Error {
  constructor(readonly code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "BackupError";
  }
}

export type BackupManifestEntry = {
  component: BackupComponent;
  path: string;
  size: number;
  sha256: string;
  mode: number;
};

export type BackupComponent = "product-data" | "published-documents";

export type BackupManifestComponent = {
  component: BackupComponent;
  fileCount: number;
  size: number;
  sourceFingerprint: string;
};

export type BackupManifest = {
  schemaVersion: 2;
  backupId: string;
  installationId: string;
  createdAt: string;
  sourceFingerprint: string;
  components: BackupManifestComponent[];
  files: BackupManifestEntry[];
};

export type RestoreDestinations = {
  dataRoot: string;
  publishWriteRoot: string;
};

export type BackupVerificationReceipt = {
  schemaVersion: 1;
  installationId: string;
  backupId: string;
  sourceFingerprint: string;
  backupCreatedAt: string;
  verifiedAt: string;
};

export const backupVerificationReceiptSchema = defineVersionedSchema<BackupVerificationReceipt>({
  name: "BackupVerificationReceipt",
  schemaVersion: 1,
  keys: ["installationId", "backupId", "sourceFingerprint", "backupCreatedAt", "verifiedAt"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 2, maxLength: 63, pattern: INSTALLATION_ID_PATTERN,
      }),
      backupId: expectString(record.backupId, context.at("backupId"), {
        minLength: 53, maxLength: 53, pattern: BACKUP_ID_PATTERN,
      }),
      sourceFingerprint: expectString(record.sourceFingerprint, context.at("sourceFingerprint"), {
        minLength: 64, maxLength: 64, pattern: HASH_PATTERN,
      }),
      backupCreatedAt: expectIsoDate(record.backupCreatedAt, context.at("backupCreatedAt")),
      verifiedAt: expectIsoDate(record.verifiedAt, context.at("verifiedAt")),
    };
  },
});

function parseEntry(value: unknown, context: ValidationContext): BackupManifestEntry {
  const record = expectStrictRecord(value, ["component", "path", "size", "sha256", "mode"], context);
  const relativePath = expectString(record.path, context.at("path"), {
    minLength: 1,
    maxLength: 4_096,
  });
  if (!safeRelativePath(relativePath)) context.at("path").fail("expected a safe POSIX relative path");
  return {
    component: expectOneOf(record.component, ["product-data", "published-documents"] as const, context.at("component")),
    path: relativePath,
    size: expectInteger(record.size, context.at("size"), { minimum: 0 }),
    sha256: expectString(record.sha256, context.at("sha256"), {
      minLength: 64,
      maxLength: 64,
      pattern: HASH_PATTERN,
    }),
    mode: expectInteger(record.mode, context.at("mode"), { minimum: 0, maximum: 0o700 }),
  };
}

function parseComponent(value: unknown, context: ValidationContext): BackupManifestComponent {
  const record = expectStrictRecord(
    value,
    ["component", "fileCount", "size", "sourceFingerprint"],
    context,
  );
  return {
    component: expectOneOf(record.component, ["product-data", "published-documents"] as const, context.at("component")),
    fileCount: expectInteger(record.fileCount, context.at("fileCount"), { minimum: 0 }),
    size: expectInteger(record.size, context.at("size"), { minimum: 0 }),
    sourceFingerprint: expectString(record.sourceFingerprint, context.at("sourceFingerprint"), {
      minLength: 64,
      maxLength: 64,
      pattern: HASH_PATTERN,
    }),
  };
}

export const backupManifestSchema = defineVersionedSchema<BackupManifest>({
  name: "BackupManifest",
  schemaVersion: 2,
  keys: ["backupId", "installationId", "createdAt", "sourceFingerprint", "components", "files"],
  parse(record, context) {
    const files = expectArray(record.files, context.at("files"), parseEntry, { maxLength: 1_000_000 });
    const paths = files.map((entry) => `${entry.component}/${entry.path}`);
    if (new Set(paths).size !== paths.length) context.at("files").fail("contains duplicate paths");
    if (paths.some((entry, index) => index > 0 && paths[index - 1].localeCompare(entry) >= 0)) {
      context.at("files").fail("must be sorted by path");
    }
    const components = expectArray(record.components, context.at("components"), parseComponent, { maxLength: 2 });
    if (components.length !== 2 || components[0]?.component !== "product-data" || components[1]?.component !== "published-documents") {
      context.at("components").fail("must contain product-data and published-documents in canonical order");
    }
    for (const component of components) {
      const componentFiles = files.filter((entry) => entry.component === component.component);
      if (component.fileCount !== componentFiles.length
        || component.size !== componentFiles.reduce((total, entry) => total + entry.size, 0)
        || component.sourceFingerprint !== sourceFingerprint(componentFiles)) {
        context.at("components").fail(`summary mismatch for ${component.component}`);
      }
    }
    return {
      schemaVersion: 2,
      backupId: expectString(record.backupId, context.at("backupId"), {
        minLength: 53,
        maxLength: 53,
        pattern: BACKUP_ID_PATTERN,
      }),
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 2,
        maxLength: 63,
        pattern: INSTALLATION_ID_PATTERN,
      }),
      createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
      sourceFingerprint: expectString(record.sourceFingerprint, context.at("sourceFingerprint"), {
        minLength: 64,
        maxLength: 64,
        pattern: HASH_PATTERN,
      }),
      components,
      files,
    };
  },
});

function safeRelativePath(value: string) {
  return !path.posix.isAbsolute(value)
    && !value.includes("\\")
    && !value.includes("\0")
    && path.posix.normalize(value) === value
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Credentials and browser identity must never enter a product-state snapshot.
 * The policy is based on canonical paths relative to dataRoot, never on file
 * contents, so a backup cannot leak a secret while trying to classify it.
 */
export function excludedBackupPath(relativePath: string) {
  if (!safeRelativePath(relativePath)) return false;
  const segments = relativePath.split("/");
  const basename = segments.at(-1) as string;
  if (segments[0] === "server" && segments[1] === "company-mail" && segments[4] === "credentials") return true;
  if (SENSITIVE_ROOT_DIRECTORIES.has(segments[0])) return true;
  // Recovery homes can contain authentication material; runtime tmp and XDG
  // sockets are regenerated and must not be treated as durable product files.
  if (segments[0].startsWith("auth-recovery-")) return true;
  if (segments[0] === "app-home" && segments[1] === ".codex" && segments[2] === "tmp") return true;
  if (segments[0] === "users" && segments[2] === "runtime" &&
    segments[3] === "codex-home" && segments[4] === "tmp") return true;
  if (segments[0] === "users" && segments[2] === "browser" && segments[3] === "xdg") return true;
  if (basename === "auth.json" || basename === ".env" || basename.startsWith(".env.")) {
    return true;
  }
  return segments.length >= 4 && segments[0] === "users" &&
    segments[2] === "browser" && segments[3] === "profile";
}

function backupId(now: number) {
  const timestamp = new Date(now).toISOString()
    .replace(/\.\d{3}Z$/u, "Z")
    .replace(/[-:]/g, "");
  return `${timestamp}-${randomUUID()}`;
}

function sourceFingerprint(files: readonly BackupManifestEntry[]) {
  const hash = createHash("sha256");
  for (const entry of files) {
    hash.update(entry.component).update("\0");
    hash.update(entry.path).update("\0");
    hash.update(String(entry.size)).update("\0");
    hash.update(entry.sha256).update("\0");
    hash.update(String(entry.mode)).update("\n");
  }
  return hash.digest("hex");
}

async function assertRealDirectory(directory: string) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new BackupError("BACKUP_PATH_UNSAFE", "Backup boundary must be a real directory.");
  }
}

async function listSourceFiles(
  sourceRoot: string,
  options: {
    excludedRoot?: string;
    exclude?: (relativePath: string) => boolean;
  } = {},
  current = sourceRoot,
): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, entry.name);
    if (options.excludedRoot
      && (inside(options.excludedRoot, absolute) || inside(absolute, options.excludedRoot))) continue;
    const relative = path.relative(sourceRoot, absolute).split(path.sep).join("/");
    if (options.exclude?.(relative)) continue;
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new BackupError("BACKUP_SYMLINK_REJECTED", `Refusing symbolic link ${relative}.`);
    }
    if (metadata.isDirectory()) {
      results.push(...await listSourceFiles(sourceRoot, options, absolute));
      continue;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new BackupError("BACKUP_FILE_UNSAFE", `Refusing non-regular or hard-linked file ${relative}.`);
    }
    if (!safeRelativePath(relative)) {
      throw new BackupError("BACKUP_PATH_UNSAFE", "Source contains an unsafe relative path.");
    }
    results.push(relative);
  }
  return results.sort((left, right) => left.localeCompare(right));
}

async function copyAndHash(
  source: string,
  destination: string,
  expected?: Pick<BackupManifestEntry, "size" | "sha256">,
) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const sourceHandle = await open(source, constants.O_RDONLY | noFollow);
  const destinationHandle = await open(destination, "wx", 0o600);
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new BackupError("BACKUP_FILE_UNSAFE", "Backup source is not an exclusive regular file.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await destinationHandle.write(chunk);
      position += bytesRead;
    }
    await destinationHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || BigInt(position) !== after.size
    ) {
      throw new BackupError("BACKUP_SOURCE_CHANGED", "Source changed while the snapshot was being copied.");
    }
    const sha256 = hash.digest("hex");
    if (expected && (expected.size !== position || expected.sha256 !== sha256)) {
      throw new BackupError("BACKUP_INTEGRITY_FAILED", "Backup content does not match its manifest.");
    }
    return { size: position, sha256, mode: Number(before.mode & 0o700n) };
  } finally {
    await Promise.allSettled([sourceHandle.close(), destinationHandle.close()]);
  }
}

async function freezeTree(root: string, freezeRoot = true) {
  const directories: string[] = [];
  async function walk(directory: string) {
    directories.push(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else await chmod(target, 0o400);
    }
  }
  await walk(root);
  for (const directory of directories.reverse()) {
    if (directory !== root || freezeRoot) await chmod(directory, 0o500);
  }
}

function componentSummary(
  component: BackupComponent,
  files: readonly BackupManifestEntry[],
): BackupManifestComponent {
  const selected = files.filter((entry) => entry.component === component);
  return {
    component,
    fileCount: selected.length,
    size: selected.reduce((total, entry) => total + entry.size, 0),
    sourceFingerprint: sourceFingerprint(selected),
  };
}

function dataPathExcluded(relativePath: string) {
  return relativePath.split("/").includes("locks") || excludedBackupPath(relativePath);
}

async function sameFileList(
  sourceRoot: string,
  expected: readonly string[],
  options: Parameters<typeof listSourceFiles>[1],
) {
  const after = await listSourceFiles(sourceRoot, options);
  return after.length === expected.length && after.every((entry, index) => entry === expected[index]);
}

async function assertRestoreDestinationAvailable(destination: string, minimumBytes: number) {
  try {
    await lstat(destination);
    throw new BackupError("RESTORE_DESTINATION_EXISTS", `Restore destination already exists: ${destination}`);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const parent = path.dirname(destination);
  await assertRealDirectory(parent);
  await access(parent, constants.R_OK | constants.W_OK | constants.X_OK);
  const capacity = await statfs(parent, { bigint: true });
  const availableBytes = capacity.bavail * capacity.bsize;
  const requiredBytes = BigInt(minimumBytes) + 1024n * 1024n;
  if (availableBytes < requiredBytes) {
    throw new BackupError(
      "RESTORE_CAPACITY_INSUFFICIENT",
      `Restore destination does not have enough free space: ${destination}`,
    );
  }
}

async function existingPath(candidates: readonly string[]) {
  for (const candidate of candidates) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  return null;
}

export class FileBackupService {
  private readonly lockManager: ResourceLockManager;
  private readonly publicationLockManager: ResourceLockManager;

  constructor(
    readonly dataRoot: string,
    readonly backupsRoot: string,
    readonly publishWriteRoot: string,
    readonly installationId: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!path.isAbsolute(dataRoot) || !path.isAbsolute(backupsRoot) || !path.isAbsolute(publishWriteRoot)) {
      throw new BackupError("BACKUP_PATH_INVALID", "Backup roots must be absolute.");
    }
    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      throw new BackupError("BACKUP_INSTALLATION_INVALID", "Installation id is invalid.");
    }
    this.dataRoot = path.resolve(dataRoot);
    this.backupsRoot = path.resolve(backupsRoot);
    this.publishWriteRoot = path.resolve(publishWriteRoot);
    if (!inside(this.dataRoot, this.backupsRoot) || this.dataRoot === this.backupsRoot) {
      throw new BackupError("BACKUP_PATH_INVALID", "backupsRoot must be below dataRoot.");
    }
    if (inside(this.dataRoot, this.publishWriteRoot) || inside(this.publishWriteRoot, this.dataRoot)) {
      throw new BackupError("BACKUP_PATH_INVALID", "publishWriteRoot must not overlap dataRoot.");
    }
    this.lockManager = new ResourceLockManager({
      rootDirectory: path.join(this.backupsRoot, "locks"),
    });
    this.publicationLockManager = new ResourceLockManager({
      rootDirectory: path.join(this.dataRoot, "locks", "document-publication-targets"),
    });
  }

  async create() {
    return this.lockManager.withLock(`backup:${this.installationId}`, async () => {
      return this.publicationLockManager.withLock(publicationBarrierLock(this.installationId), async () => {
        await Promise.all([assertRealDirectory(this.dataRoot), assertRealDirectory(this.publishWriteRoot)]);
        await mkdir(path.join(this.backupsRoot, "snapshots"), { recursive: true, mode: 0o700 });
        const id = backupId(this.now());
        const pendingRoot = path.join(this.backupsRoot, "snapshots", `.${id}.pending`);
        const finalRoot = path.join(this.backupsRoot, "snapshots", id);
        await mkdir(path.join(pendingRoot, "roots"), { recursive: true, mode: 0o700 });
        const files: BackupManifestEntry[] = [];
        const sources: Array<{
          component: BackupComponent;
          root: string;
          options: Parameters<typeof listSourceFiles>[1];
        }> = [
          {
            component: "product-data",
            root: this.dataRoot,
            options: { excludedRoot: this.backupsRoot, exclude: dataPathExcluded },
          },
          {
            component: "published-documents",
            root: this.publishWriteRoot,
            options: {},
          },
        ];
        for (const sourceDefinition of sources) {
          await mkdir(path.join(pendingRoot, "roots", sourceDefinition.component), {
            recursive: true,
            mode: 0o700,
          });
          const relativePaths = await listSourceFiles(sourceDefinition.root, sourceDefinition.options);
          for (const relativePath of relativePaths) {
            const source = path.join(sourceDefinition.root, ...relativePath.split("/"));
            const destination = path.join(
              pendingRoot,
              "roots",
              sourceDefinition.component,
              ...relativePath.split("/"),
            );
            const copied = await copyAndHash(source, destination);
            files.push({ component: sourceDefinition.component, path: relativePath, ...copied });
          }
          if (!await sameFileList(sourceDefinition.root, relativePaths, sourceDefinition.options)) {
            throw new BackupError("BACKUP_SOURCE_CHANGED", `${sourceDefinition.component} changed while the snapshot was being copied.`);
          }
        }
        files.sort((left, right) => `${left.component}/${left.path}`.localeCompare(`${right.component}/${right.path}`));
        const manifest = backupManifestSchema.parse({
          schemaVersion: 2,
          backupId: id,
          installationId: this.installationId,
          createdAt: new Date(this.now()).toISOString(),
          sourceFingerprint: sourceFingerprint(files),
          components: [
            componentSummary("product-data", files),
            componentSummary("published-documents", files),
          ],
          files,
        });
        await atomicWriteJson(path.join(pendingRoot, "manifest.json"), manifest, backupManifestSchema, {
          mode: 0o400,
        });
        await freezeTree(pendingRoot, false);
        await rename(pendingRoot, finalRoot);
        await chmod(finalRoot, 0o500);
        await fsyncDirectory(path.dirname(finalRoot));
        return { manifest, snapshotRoot: finalRoot };
      });
    });
  }

  async verify(snapshotRoot: string, options: { writeReceipt?: boolean } = {}) {
    const root = path.resolve(snapshotRoot);
    const canonicalSnapshots = await realpath(path.join(this.backupsRoot, "snapshots"));
    const canonicalRoot = await realpath(root);
    if (!inside(canonicalSnapshots, canonicalRoot) || canonicalRoot === canonicalSnapshots) {
      throw new BackupError("BACKUP_PATH_UNSAFE", "Snapshot is outside backupsRoot.");
    }
    const manifestContents = await readRegularFileWithin(root, "manifest.json", MAX_MANIFEST_BYTES);
    const manifest = parseJson(backupManifestSchema, manifestContents.toString("utf8"), "manifest.json");
    if (manifest.installationId !== this.installationId || path.basename(root) !== manifest.backupId) {
      throw new BackupError("BACKUP_MANIFEST_MISMATCH", "Snapshot does not belong to this installation.");
    }
    const actual: string[] = [];
    for (const component of ["product-data", "published-documents"] as const) {
      const componentRoot = path.join(root, "roots", component);
      await assertRealDirectory(componentRoot);
      const paths = await listSourceFiles(componentRoot);
      actual.push(...paths.map((entry) => `${component}/${entry}`));
    }
    const expected = manifest.files.map((entry) => `${entry.component}/${entry.path}`);
    if (actual.length !== expected.length
      || actual.some((entry, index) => entry !== expected[index])) {
      throw new BackupError("BACKUP_INTEGRITY_FAILED", "Snapshot files do not match the manifest.");
    }
    for (const entry of manifest.files) {
      const source = path.join(root, "roots", entry.component, ...entry.path.split("/"));
      const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        while (true) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          hash.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        if (position !== entry.size || hash.digest("hex") !== entry.sha256) {
          throw new BackupError("BACKUP_INTEGRITY_FAILED", `Snapshot file failed verification: ${entry.path}.`);
        }
      } finally {
        await handle.close();
      }
    }
    if (sourceFingerprint(manifest.files) !== manifest.sourceFingerprint) {
      throw new BackupError("BACKUP_INTEGRITY_FAILED", "Snapshot manifest fingerprint is invalid.");
    }
    const receipt: BackupVerificationReceipt = {
      schemaVersion: 1,
      installationId: this.installationId,
      backupId: manifest.backupId,
      sourceFingerprint: manifest.sourceFingerprint,
      backupCreatedAt: manifest.createdAt,
      verifiedAt: new Date(this.now()).toISOString(),
    };
    if (options.writeReceipt !== false) {
      await this.lockManager.withLock(`backup-verification:${this.installationId}`, async () => {
        await atomicWriteJson(this.verificationReceiptPath(), receipt, backupVerificationReceiptSchema, { mode: 0o600 });
      });
    }
    return manifest;
  }

  async readVerificationReceipt() {
    try {
      const receipt = await readValidatedJson(this.verificationReceiptPath(), backupVerificationReceiptSchema);
      if (receipt.installationId !== this.installationId) {
        throw new BackupError("BACKUP_RECEIPT_MISMATCH", "Backup verification receipt belongs to another installation.");
      }
      const snapshotRoot = path.join(this.backupsRoot, "snapshots", receipt.backupId);
      try {
        const snapshot = await lstat(snapshotRoot);
        if (!snapshot.isDirectory() || snapshot.isSymbolicLink() || (snapshot.mode & 0o077) !== 0) {
          throw new BackupError("BACKUP_RECEIPT_MISMATCH", "Verified backup snapshot root is unsafe.");
        }
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return null;
        throw error;
      }
      return receipt;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }

  async restore(snapshotRoot: string, destinations: RestoreDestinations) {
    if (!path.isAbsolute(destinations.dataRoot) || !path.isAbsolute(destinations.publishWriteRoot)) {
      throw new BackupError("RESTORE_PATH_INVALID", "Restore destinations must be absolute.");
    }
    const destination = {
      dataRoot: path.resolve(destinations.dataRoot),
      publishWriteRoot: path.resolve(destinations.publishWriteRoot),
    };
    const liveRoots = [this.dataRoot, this.publishWriteRoot];
    for (const candidate of Object.values(destination)) {
      if (liveRoots.some((root) => inside(root, candidate) || inside(candidate, root))) {
        throw new BackupError("RESTORE_PATH_INVALID", "Restore destinations must be separate from live roots.");
      }
    }
    if (inside(destination.dataRoot, destination.publishWriteRoot)
      || inside(destination.publishWriteRoot, destination.dataRoot)) {
      throw new BackupError("RESTORE_PATH_INVALID", "Restore destinations must not overlap each other.");
    }
    const manifest = await this.verify(snapshotRoot);
    const totalSize = manifest.files.reduce((total, entry) => total + entry.size, 0);
    await Promise.all([
      assertRestoreDestinationAvailable(destination.dataRoot, totalSize),
      assertRestoreDestinationAvailable(destination.publishWriteRoot, totalSize),
    ]);
    const restoreId = randomUUID();
    const staging = {
      dataRoot: `${destination.dataRoot}.pending.${restoreId}`,
      publishWriteRoot: `${destination.publishWriteRoot}.pending.${restoreId}`,
    };
    await Promise.all([
      mkdir(staging.dataRoot, { mode: 0o700 }),
      mkdir(staging.publishWriteRoot, { mode: 0o700 }),
    ]);
    let dataCommitted = false;
    let publishedCommitted = false;
    try {
      for (const entry of manifest.files) {
        const source = path.join(snapshotRoot, "roots", entry.component, ...entry.path.split("/"));
        const targetRoot = entry.component === "product-data"
          ? staging.dataRoot
          : staging.publishWriteRoot;
        const target = path.join(targetRoot, ...entry.path.split("/"));
        await copyAndHash(source, target, entry);
        await chmod(target, entry.mode & 0o600);
      }
      await atomicWriteJson(
        path.join(staging.dataRoot, ".aibrain-restore.json"),
        manifest,
        backupManifestSchema,
        { mode: 0o400 },
      );
      await Promise.all([fsyncDirectory(staging.dataRoot), fsyncDirectory(staging.publishWriteRoot)]);
      await rename(staging.dataRoot, destination.dataRoot);
      dataCommitted = true;
      try {
        await rename(staging.publishWriteRoot, destination.publishWriteRoot);
        publishedCommitted = true;
      } catch (error) {
        await rename(destination.dataRoot, staging.dataRoot);
        dataCommitted = false;
        throw error;
      }
      await Promise.all([
        fsyncDirectory(path.dirname(destination.dataRoot)),
        fsyncDirectory(path.dirname(destination.publishWriteRoot)),
      ]);
      return {
        manifest,
        dataDestinationRoot: destination.dataRoot,
        publishDestinationRoot: destination.publishWriteRoot,
      };
    } catch (error) {
      const failedId = randomUUID();
      const dataSource = await existingPath([
        dataCommitted ? destination.dataRoot : staging.dataRoot,
        staging.dataRoot,
      ]);
      const publishSource = await existingPath([
        publishedCommitted ? destination.publishWriteRoot : staging.publishWriteRoot,
        staging.publishWriteRoot,
      ]);
      const preserved: string[] = [];
      if (dataSource) {
        const failed = `${destination.dataRoot}.failed.${failedId}`;
        await rename(dataSource, failed).catch(() => undefined);
        preserved.push(failed);
      }
      if (publishSource) {
        const failed = `${destination.publishWriteRoot}.failed.${failedId}`;
        await rename(publishSource, failed).catch(() => undefined);
        preserved.push(failed);
      }
      throw new BackupError("RESTORE_FAILED", `Restore failed; partial data was preserved at ${preserved.join(", ")}.`, {
        cause: error,
      });
    }
  }

  private verificationReceiptPath() {
    return path.join(this.backupsRoot, "verification", "latest.json");
  }
}

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error && typeof error === "object" && "code" in error
    && (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}
