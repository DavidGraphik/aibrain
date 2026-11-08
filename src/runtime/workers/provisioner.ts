import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, chmod, mkdir, open, realpath, readFile, unlink } from "node:fs/promises";
import { installationOwnerAuthSocket } from "@/runtime/installation-owner-auth";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import {
  atomicWriteJson,
  atomicWriteFile,
  readValidatedJson,
  ResourceLockManager,
  defineVersionedSchema,
  expectIsoDate,
  expectString,
  type StorageSchema,
  type ValidationContext,
} from "@/storage";
import {
  WORKER_PROVISIONING_SCHEMA_VERSION,
  type WorkerEnvironment,
  type WorkerLaunchContext,
  type WorkerProvisioningManifest,
  type WorkerRoots,
} from "@/runtime/workers/types";

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTALLATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CODEX_AUTH_BYTES = 1024 * 1024;
const ROOT_KEYS = [
  "userRoot",
  "runtimeRoot",
  "codexHome",
  "home",
  "xdgRoot",
  "xdgCache",
  "xdgConfig",
  "xdgData",
  "xdgState",
  "workspace",
  "staging",
  "stagingTemp",
  "artifacts",
  "browserRoot",
  "browserProfile",
  "browserDownloads",
  "auditRoot",
  "transportAudit",
  "manifest",
] as const satisfies readonly (keyof WorkerRoots)[];

export class WorkerProvisioningError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "WorkerProvisioningError";
  }
}

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function overlaps(left: string, right: string) {
  return inside(left, right) || inside(right, left);
}

export function validateWorkerUserId(userId: string) {
  if (!USER_ID_PATTERN.test(userId)) {
    throw new WorkerProvisioningError(
      "WORKER_USER_ID_INVALID",
      "Worker userId must be a canonical lowercase UUID.",
    );
  }
  return userId;
}

function workerIdFor(userId: string) {
  return `worker-${userId}`;
}

export function deriveWorkerRoots(config: Readonly<InstallationConfig>, userId: string): WorkerRoots {
  validateWorkerUserId(userId);
  const usersRoot = path.resolve(config.paths.usersRoot);
  const userRoot = path.resolve(usersRoot, userId);
  if (!inside(usersRoot, userRoot) || userRoot === usersRoot) {
    throw new WorkerProvisioningError("WORKER_PATH_ESCAPE", "Worker root escapes usersRoot.");
  }
  const runtimeRoot = path.join(userRoot, "runtime");
  const xdgRoot = path.join(runtimeRoot, "xdg");
  const staging = path.join(userRoot, "staging");
  const browserRoot = path.join(userRoot, "browser");
  const auditRoot = path.join(userRoot, "audit");
  const roots: WorkerRoots = {
    userRoot,
    runtimeRoot,
    codexHome: path.join(runtimeRoot, "codex-home"),
    home: path.join(runtimeRoot, "home"),
    xdgRoot,
    xdgCache: path.join(xdgRoot, "cache"),
    xdgConfig: path.join(xdgRoot, "config"),
    xdgData: path.join(xdgRoot, "data"),
    xdgState: path.join(xdgRoot, "state"),
    workspace: path.join(userRoot, "workspace"),
    staging,
    stagingTemp: path.join(staging, "tmp"),
    artifacts: path.join(userRoot, "artifacts"),
    browserRoot,
    browserProfile: path.join(browserRoot, "profile"),
    browserDownloads: path.join(browserRoot, "downloads"),
    auditRoot,
    transportAudit: path.join(auditRoot, "transport"),
    manifest: path.join(userRoot, "worker.json"),
  };
  const publishWriteRoot = path.resolve(config.paths.publishWriteRoot);
  if (ROOT_KEYS.some((key) => overlaps(path.resolve(roots[key]), publishWriteRoot))) {
    throw new WorkerProvisioningError(
      "WORKER_PUBLISH_PATH_OVERLAP",
      "Worker-owned roots must not overlap publishWriteRoot.",
    );
  }
  return roots;
}

function parseRoots(value: unknown, context: ValidationContext): WorkerRoots {
  if (!value || typeof value !== "object" || Array.isArray(value)) context.fail("expected an object");
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...ROOT_KEYS].sort();
  if (actualKeys.join("\0") !== expectedKeys.join("\0")) {
    context.fail("root keys do not match the worker provisioning contract");
  }
  return Object.fromEntries(ROOT_KEYS.map((key) => [
    key,
    expectString(record[key], context.at(key), { minLength: 2, maxLength: 1_024 }),
  ])) as WorkerRoots;
}

const workerManifestSchema: StorageSchema<WorkerProvisioningManifest> = defineVersionedSchema({
  name: "WorkerProvisioningManifest",
  schemaVersion: WORKER_PROVISIONING_SCHEMA_VERSION,
  keys: ["installationId", "userId", "workerId", "provisionedAt", "roots"],
  parse(record, context) {
    return {
      schemaVersion: WORKER_PROVISIONING_SCHEMA_VERSION,
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 2,
        maxLength: 63,
        pattern: INSTALLATION_ID_PATTERN,
      }),
      userId: expectString(record.userId, context.at("userId"), {
        minLength: 36,
        maxLength: 36,
        pattern: USER_ID_PATTERN,
      }),
      workerId: expectString(record.workerId, context.at("workerId"), {
        minLength: 43,
        maxLength: 43,
        pattern: /^worker-[0-9a-f-]{36}$/,
      }),
      provisionedAt: expectIsoDate(record.provisionedAt, context.at("provisionedAt")),
      roots: parseRoots(record.roots, context.at("roots")),
    };
  },
});

type SharedCodexAuthReceipt = {
  schemaVersion: 1;
  scope: "shared-qa" | "installation-owner";
  userId: string;
  credentialFingerprint: string;
  synchronizedAt: string;
};

const sharedCodexAuthReceiptSchema: StorageSchema<SharedCodexAuthReceipt> = defineVersionedSchema({
  name: "SharedCodexAuthReceipt",
  schemaVersion: 1,
  keys: ["scope", "userId", "credentialFingerprint", "synchronizedAt"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      scope: expectString(record.scope, context.at("scope"), {
        minLength: 9,
        maxLength: 18,
        pattern: /^(shared-qa|installation-owner)$/,
      }) as "shared-qa" | "installation-owner",
      userId: expectString(record.userId, context.at("userId"), {
        minLength: 36,
        maxLength: 36,
        pattern: USER_ID_PATTERN,
      }),
      credentialFingerprint: expectString(
        record.credentialFingerprint,
        context.at("credentialFingerprint"),
        { minLength: 64, maxLength: 64, pattern: SHA256_PATTERN },
      ),
      synchronizedAt: expectIsoDate(record.synchronizedAt, context.at("synchronizedAt")),
    };
  },
});

export type SharedCodexAuth = Readonly<{
  scope: "shared-qa" | "installation-owner";
  sourcePath: string;
}>;

function configuredSharedCodexAuth(
  installationId: string,
  environment: NodeJS.ProcessEnv = process.env,
): SharedCodexAuth | null {
  const scope = environment.AIBRAIN_CODEX_AUTH_SCOPE?.trim() || "per-user";
  const sourcePath = environment.AIBRAIN_SHARED_CODEX_AUTH_SOURCE?.trim() || null;
  if (scope === "per-user") {
    if (sourcePath) {
      throw new WorkerProvisioningError(
        "WORKER_SHARED_AUTH_CONFIG_INVALID",
        "Shared Codex auth source requires an explicit authorization scope.",
      );
    }
    return null;
  }
  if (!["shared-qa", "installation-owner"].includes(scope) || !sourcePath || !path.isAbsolute(sourcePath)
      || scope === "installation-owner" && (installationId !== "trinalum-production" || environment.AIBRAIN_INSTALLATION_OWNER_AUTH_ACK !== installationId)) {
    throw new WorkerProvisioningError(
      "WORKER_SHARED_AUTH_CONFIG_INVALID",
      "Installation authentication requires a private source and explicit installation authorization.",
    );
  }
  return Object.freeze({ scope: scope as SharedCodexAuth["scope"], sourcePath });
}

async function assertDirectory(directory: string) {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new WorkerProvisioningError(
      "WORKER_SYMLINK_REJECTED",
      `Worker path must be a real directory: ${directory}`,
    );
  }
  await chmod(directory, 0o700);
}

async function ensureDirectory(directory: string) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  await assertDirectory(directory);
}

async function ensureDescendantTree(root: string, target: string) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkerProvisioningError("WORKER_PATH_ESCAPE", "Worker directory escapes its secure root.");
  }
  const canonicalRoot = await realpath(root);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    await ensureDirectory(current);
    const canonicalCurrent = await realpath(current);
    if (!inside(canonicalRoot, canonicalCurrent)) {
      throw new WorkerProvisioningError("WORKER_PATH_ESCAPE", "Worker directory resolves outside its secure root.");
    }
  }
}

async function assertManifestIsRegular(manifestPath: string) {
  try {
    const metadata = await lstat(manifestPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new WorkerProvisioningError(
        "WORKER_SYMLINK_REJECTED",
        "Worker provisioning manifest must be a regular file.",
      );
    }
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function manifestsMatch(
  existing: WorkerProvisioningManifest,
  expected: Omit<WorkerProvisioningManifest, "provisionedAt">,
) {
  return existing.schemaVersion === expected.schemaVersion
    && existing.installationId === expected.installationId
    && existing.userId === expected.userId
    && existing.workerId === expected.workerId
    && ROOT_KEYS.every((key) => existing.roots[key] === expected.roots[key]);
}

export type WorkerProvisionerOptions = {
  config: Readonly<InstallationConfig>;
  lockManager?: ResourceLockManager;
  now?: () => number;
  sharedCodexAuth?: SharedCodexAuth | null;
};

export class WorkerProvisioner {
  readonly config: Readonly<InstallationConfig>;
  readonly lockManager: ResourceLockManager;
  private readonly now: () => number;
  private readonly lockRoot: string;
  private readonly sharedCodexAuth: SharedCodexAuth | null;

  constructor(options: WorkerProvisionerOptions) {
    this.config = options.config;
    this.lockRoot = path.join(this.config.paths.dataRoot, "locks", "worker-provisioning");
    this.lockManager = options.lockManager ?? new ResourceLockManager({
      rootDirectory: this.lockRoot,
    });
    this.now = options.now ?? Date.now;
    this.sharedCodexAuth = options.sharedCodexAuth === undefined
      ? configuredSharedCodexAuth(this.config.installationId)
      : options.sharedCodexAuth;
    if (this.sharedCodexAuth?.scope === "installation-owner" && this.config.installationId !== "trinalum-production") {
      throw new WorkerProvisioningError("WORKER_SHARED_AUTH_CONFIG_INVALID", "Owner service authentication is authorized only for this installation.");
    }
  }

  async provision(userId: string): Promise<WorkerProvisioningManifest> {
    const roots = deriveWorkerRoots(this.config, userId);
    await mkdir(this.config.paths.dataRoot, { recursive: true, mode: 0o700 });
    await assertDirectory(this.config.paths.dataRoot);
    await ensureDescendantTree(this.config.paths.dataRoot, this.config.paths.usersRoot);
    await ensureDescendantTree(this.config.paths.dataRoot, this.lockRoot);

    return this.lockManager.withLock(
      `worker-provision:${this.config.installationId}:${userId}`,
      async () => {
        await ensureDescendantTree(this.config.paths.usersRoot, roots.userRoot);
        const directories = ROOT_KEYS
          .filter((key) => key !== "userRoot" && key !== "manifest")
          .map((key) => roots[key])
          .sort((left, right) => left.split(path.sep).length - right.split(path.sep).length);
        for (const directory of directories) {
          await ensureDescendantTree(roots.userRoot, directory);
        }
        // Uploads are exposed only through this read-only child mount; the
        // separate staging temporary remains the worker's writable scratch space.
        await ensureDescendantTree(roots.userRoot, path.join(roots.staging, "threads"));
        await this.synchronizeSharedCodexAuth(roots, userId);

        const expected = {
          schemaVersion: WORKER_PROVISIONING_SCHEMA_VERSION,
          installationId: this.config.installationId,
          userId,
          workerId: workerIdFor(userId),
          roots,
        } as const;
        if (await assertManifestIsRegular(roots.manifest)) {
          const existing = await readValidatedJson(roots.manifest, workerManifestSchema);
          if (!manifestsMatch(existing, expected)) {
            throw new WorkerProvisioningError(
              "WORKER_MANIFEST_MISMATCH",
              "Existing worker provisioning does not match this installation or user.",
            );
          }
          await chmod(roots.manifest, 0o600);
          return existing;
        }

        const created = workerManifestSchema.parse({
          ...expected,
          provisionedAt: new Date(this.now()).toISOString(),
        }, roots.manifest);
        await atomicWriteJson(roots.manifest, created, workerManifestSchema, { mode: 0o600 });
        await chmod(roots.manifest, 0o600);
        return created;
      },
    );
  }

  private async synchronizeSharedCodexAuth(roots: WorkerRoots, userId: string) {
    const shared = this.sharedCodexAuth;
    if (!shared) return;
    const ownerSocket = installationOwnerAuthSocket(this.config.installationId);
    if (ownerSocket && shared.scope === "installation-owner") {
      const targetPath = path.join(roots.codexHome, "auth.json");
      try {
        const target = await lstat(targetPath);
        const receipt = JSON.parse(await readFile(path.join(roots.auditRoot, "codex-auth-scope.json"), "utf8"));
        if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1
            || target.uid !== process.geteuid?.() || (target.mode & 0o077) !== 0
            || receipt.scope !== "installation-owner" || receipt.userId !== userId) {
          throw new WorkerProvisioningError("WORKER_SHARED_AUTH_SOURCE_UNSAFE", "Owner credential migration cannot replace unrelated credentials.");
        }
        await unlink(targetPath);
      } catch (error) { if (!isNodeError(error, "ENOENT")) throw error; }
      await atomicWriteJson(path.join(roots.auditRoot, "codex-auth-scope.json"), {
        schemaVersion: 1, scope: shared.scope, userId,
        credentialFingerprint: createHash("sha256").update(`external-access:${ownerSocket}`).digest("hex"),
        synchronizedAt: new Date(this.now()).toISOString(),
      }, sharedCodexAuthReceiptSchema, { mode: 0o600 });
      return;
    }
    const dataRoot = path.resolve(this.config.paths.dataRoot);
    const sourcePath = path.resolve(/* turbopackIgnore: true */ shared.sourcePath);
    if (
      path.basename(sourcePath) !== "auth.json"
      || sourcePath === dataRoot
      || !inside(dataRoot, sourcePath)
    ) {
      throw new WorkerProvisioningError(
        "WORKER_SHARED_AUTH_SOURCE_UNSAFE",
        "Shared Codex auth source must be a private auth.json inside dataRoot.",
      );
    }

    let canonicalDataRoot: string;
    let canonicalSource: string;
    try {
      [canonicalDataRoot, canonicalSource] = await Promise.all([
        realpath(dataRoot),
        realpath(sourcePath),
      ]);
    } catch (error) {
      throw new WorkerProvisioningError(
        "WORKER_SHARED_AUTH_SOURCE_UNAVAILABLE",
        "Shared Codex auth source is unavailable.",
        { cause: error },
      );
    }
    if (!inside(canonicalDataRoot, canonicalSource)) {
      throw new WorkerProvisioningError(
        "WORKER_SHARED_AUTH_SOURCE_UNSAFE",
        "Shared Codex auth source resolves outside dataRoot.",
      );
    }

    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let authBytes: Buffer;
    try {
      handle = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const metadata = await handle.stat();
      const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : null;
      if (
        !metadata.isFile()
        || metadata.nlink !== 1
        || (metadata.mode & 0o077) !== 0
        || (effectiveUid !== null && metadata.uid !== effectiveUid)
        || metadata.size < 2
        || metadata.size > MAX_CODEX_AUTH_BYTES
      ) {
        throw new WorkerProvisioningError(
          "WORKER_SHARED_AUTH_SOURCE_UNSAFE",
          "Shared Codex auth source must be a private owner-controlled regular file.",
        );
      }
      authBytes = await handle.readFile();
    } catch (error) {
      if (error instanceof WorkerProvisioningError) throw error;
      throw new WorkerProvisioningError(
        "WORKER_SHARED_AUTH_SOURCE_UNSAFE",
        "Shared Codex auth source could not be read safely.",
        { cause: error },
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }

    try {
      const parsed: unknown = JSON.parse(authBytes.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    } catch (error) {
      throw new WorkerProvisioningError(
        "WORKER_SHARED_AUTH_SOURCE_INVALID",
        "Shared Codex auth source is not a valid JSON object.",
        { cause: error },
      );
    }

    const targetPath = path.join(roots.codexHome, "auth.json");
    const fingerprint = createHash("sha256").update(authBytes).digest("hex");
    if (shared.scope === "installation-owner") {
      // Preserve provider refreshes in each private home. An operator source
      // rotation explicitly replaces credentials; routine provisioning does not.
      try {
        const receipt = JSON.parse(await readFile(path.join(roots.auditRoot, "codex-auth-scope.json"), "utf8"));
        const target = await lstat(targetPath);
        if (receipt.scope === shared.scope && receipt.userId === userId && receipt.credentialFingerprint === fingerprint && target.isFile() && !target.isSymbolicLink() && target.nlink === 1 && (target.mode & 0o077) === 0 && target.uid === process.geteuid?.()) return;
      } catch (error) { if (!isNodeError(error, "ENOENT")) throw error; }
    }
    if (path.resolve(targetPath) !== sourcePath) {
      // Shared-QA workers use the external broker lane. The existing private
      // installation-owner mode retains its per-home rotation contract when
      // no owner socket is configured; the socket migration returned above.
      await atomicWriteFile(targetPath, shared.scope === "installation-owner" ? authBytes : "{}", { mode: 0o600 });
    }
    await chmod(targetPath, 0o600);
    await atomicWriteJson(
      path.join(roots.auditRoot, "codex-auth-scope.json"),
      {
        schemaVersion: 1,
        scope: shared.scope,
        userId,
        credentialFingerprint: fingerprint,
        synchronizedAt: new Date(this.now()).toISOString(),
      },
      sharedCodexAuthReceiptSchema,
      { mode: 0o600 },
    );
  }
}

/** Read existing provisioning only. Metadata diagnostics must never provision,
 * synchronize auth, repair permissions or start/stop the employee runtime. */
export async function readExistingWorkerLaunchContext(config: Readonly<InstallationConfig>, userId: string) {
  const roots = deriveWorkerRoots(config, userId);
  const userDirectory = await lstat(roots.userRoot);
  if (!userDirectory.isDirectory() || userDirectory.isSymbolicLink() || (userDirectory.mode & 0o077) !== 0 ||
      await realpath(roots.userRoot) !== roots.userRoot) throw new WorkerProvisioningError("WORKER_PATH_INVALID", "Existing worker root is unsafe.");
  const manifestPath = roots.manifest;
  const metadata = await lstat(manifestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
    throw new WorkerProvisioningError("WORKER_MANIFEST_INVALID", "Existing worker manifest is unsafe.");
  }
  const manifest = await readValidatedJson(manifestPath, workerManifestSchema);
  const context = buildWorkerLaunchContext(config, manifest);
  for (const directory of [roots.workspace, roots.transportAudit, ...Object.values(context.environment)]) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
        await realpath(directory) !== directory) throw new WorkerProvisioningError("WORKER_PATH_INVALID", "Existing worker directory is unsafe.");
  }
  return context;
}

export function buildWorkerLaunchContext(
  config: Readonly<InstallationConfig>,
  manifest: WorkerProvisioningManifest,
): WorkerLaunchContext {
  const expectedRoots = deriveWorkerRoots(config, manifest.userId);
  if (
    manifest.installationId !== config.installationId
    || manifest.workerId !== workerIdFor(manifest.userId)
    || ROOT_KEYS.some((key) => manifest.roots[key] !== expectedRoots[key])
  ) {
    throw new WorkerProvisioningError(
      "WORKER_MANIFEST_MISMATCH",
      "Worker manifest does not belong to this installation.",
    );
  }
  const environment: WorkerEnvironment = Object.freeze({
    HOME: expectedRoots.home,
    CODEX_HOME: expectedRoots.codexHome,
    XDG_CACHE_HOME: expectedRoots.xdgCache,
    XDG_CONFIG_HOME: expectedRoots.xdgConfig,
    XDG_DATA_HOME: expectedRoots.xdgData,
    XDG_STATE_HOME: expectedRoots.xdgState,
    TMPDIR: expectedRoots.stagingTemp,
  });
  return Object.freeze({
    installationId: config.installationId,
    userId: manifest.userId,
    workerId: manifest.workerId,
    environment,
    mounts: Object.freeze({
      runtimeReadOnly: Object.freeze([
        config.paths.companyContextRoot,
        config.paths.sourceReadRoot,
        path.join(expectedRoots.staging, "threads"),
      ]),
      runtimeReadWrite: Object.freeze([
        expectedRoots.codexHome,
        expectedRoots.home,
        expectedRoots.xdgRoot,
        expectedRoots.workspace,
        expectedRoots.stagingTemp,
        expectedRoots.artifacts,
        expectedRoots.transportAudit,
      ]),
      browserReadWrite: Object.freeze([
        expectedRoots.browserProfile,
        expectedRoots.browserDownloads,
      ]),
    }),
    workspace: expectedRoots.workspace,
    staging: expectedRoots.staging,
    artifacts: expectedRoots.artifacts,
    transportAudit: expectedRoots.transportAudit,
    browser: Object.freeze({
      profile: expectedRoots.browserProfile,
      downloads: expectedRoots.browserDownloads,
    }),
  });
}

export async function resolveWorkerOwnedPath(
  root: string,
  relativePath: string,
) {
  const segments = relativePath.split(/[\\/]/u);
  if (
    !path.isAbsolute(root)
    || path.isAbsolute(relativePath)
    || relativePath.length === 0
    || relativePath.includes("\\")
    || /\p{C}/u.test(relativePath)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new WorkerProvisioningError("WORKER_PATH_INVALID", "Worker path boundary is invalid.");
  }
  const target = path.resolve(root, relativePath);
  if (!inside(path.resolve(root), target)) {
    throw new WorkerProvisioningError("WORKER_PATH_ESCAPE", "Worker path escapes its private root.");
  }
  await assertDirectory(root);
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new WorkerProvisioningError("WORKER_SYMLINK_REJECTED", "Worker path contains a symbolic link.");
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) break;
      throw error;
    }
  }
  return target;
}
