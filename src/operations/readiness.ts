import { constants } from "node:fs";
import { access, lstat, statfs } from "node:fs/promises";
import type { InstallationConfig } from "@/config/installation-schema";

export type ReadinessCheckName =
  | "data-root"
  | "backups-root"
  | "company-context"
  | "users-root"
  | "source-read"
  | "publish-write"
  | "disk-capacity"
  | "publish-capacity"
  | "docker-socket";

export type ReadinessCheck = Readonly<{
  name: ReadinessCheckName;
  status: "pass" | "fail";
  code: string;
}>;

export type ReadinessReport = Readonly<{
  schemaVersion: 1;
  status: "ready" | "degraded";
  checkedAt: string;
  disk: Readonly<{ freeBytes: number; totalBytes: number; freeRatio: number }> | null;
  checks: readonly ReadinessCheck[];
  /** Present only when the composition root supplied component probes. */
  components?: readonly ReadinessComponentCheck[];
}>;

export type ReadinessComponentStatus = "ready" | "degraded" | "unavailable";

export type ReadinessComponentResult = Readonly<{
  status: ReadinessComponentStatus;
  code: string;
  metrics?: Readonly<Record<string, number>>;
}>;

export type ReadinessComponentCheck = ReadinessComponentResult & Readonly<{
  name: string;
  required: boolean;
}>;

/**
 * Side-effect-free adapter owned by the caller. It lets the composition root
 * aggregate worker, browser, Codex or document health without importing a
 * process-global registry into the operations layer.
 */
export type ReadinessComponentProbe = Readonly<{
  name: string;
  required: boolean;
  check(signal: AbortSignal): Promise<ReadinessComponentResult>;
}>;

export type ReadinessOptions = {
  now?: () => number;
  minimumFreeBytes?: number;
  minimumFreeRatio?: number;
  dockerSocketPath?: string;
  componentProbes?: readonly ReadinessComponentProbe[];
  componentTimeoutMs?: number;
  readFilesystemCapacity?: (root: string) => Promise<{
    bavail: bigint;
    bsize: bigint;
    blocks: bigint;
  }>;
};

const SAFE_COMPONENT_NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const SAFE_COMPONENT_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;

function validNonNegativeInteger(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer.`);
  return value;
}

function validRatio(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("minimumFreeRatio must be between 0 and 1.");
  }
  return value;
}

function validPositiveInteger(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function validateComponentResult(result: ReadinessComponentResult) {
  if (!["ready", "degraded", "unavailable"].includes(result.status)) {
    throw new Error("Readiness component returned an invalid status.");
  }
  if (!SAFE_COMPONENT_CODE.test(result.code)) {
    throw new Error("Readiness component returned an invalid code.");
  }
  if (result.metrics) {
    for (const [key, value] of Object.entries(result.metrics)) {
      if (!SAFE_COMPONENT_NAME.test(key) || !Number.isFinite(value)) {
        throw new Error("Readiness component returned invalid metrics.");
      }
    }
  }
  return result;
}

async function checkComponent(probe: ReadinessComponentProbe, timeoutMs: number) {
  if (!SAFE_COMPONENT_NAME.test(probe.name) || probe.name.length > 96) {
    throw new Error("Readiness component names must be safe lowercase identifiers.");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("readiness timeout"));
      }, timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([probe.check(controller.signal), timeout]);
    if (controller.signal.aborted) throw new Error("readiness timeout");
    return Object.freeze({ name: probe.name, required: probe.required, ...validateComponentResult(result) });
  } catch {
    return Object.freeze({
      name: probe.name,
      required: probe.required,
      status: "unavailable" as const,
      code: controller.signal.aborted ? "COMPONENT_TIMEOUT" : "COMPONENT_CHECK_FAILED",
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function directoryCheck(
  name: ReadinessCheckName,
  directory: string,
  mode: number,
  code: string,
) {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("unsafe directory");
    await access(directory, mode);
    return { name, status: "pass", code: "OK" } as const;
  } catch {
    return { name, status: "fail", code } as const;
  }
}

async function readOnlyDirectoryCheck(name: ReadinessCheckName, directory: string) {
  const readable = await directoryCheck(
    name,
    directory,
    constants.R_OK | constants.X_OK,
    "SOURCE_READ_UNAVAILABLE",
  );
  if (readable.status === "fail") return readable;
  try {
    await access(directory, constants.W_OK);
    return { name, status: "fail", code: "SOURCE_READ_WRITABLE" } as const;
  } catch {
    return readable;
  }
}

async function dockerSocketCheck(socketPath: string) {
  try {
    await lstat(socketPath);
    return { name: "docker-socket", status: "fail", code: "DOCKER_SOCKET_PRESENT" } as const;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { name: "docker-socket", status: "pass", code: "OK" } as const;
    }
    return { name: "docker-socket", status: "fail", code: "DOCKER_SOCKET_CHECK_FAILED" } as const;
  }
}

function safeFilesystemNumber(value: bigint) {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(value > maximum ? maximum : value);
}

export async function checkInstallationReadiness(
  config: Readonly<InstallationConfig>,
  options: ReadinessOptions = {},
): Promise<ReadinessReport> {
  const now = options.now ?? Date.now;
  const minimumFreeBytes = validNonNegativeInteger(
    "minimumFreeBytes",
    options.minimumFreeBytes ?? 1024 * 1024 * 1024,
  );
  const minimumFreeRatio = validRatio(options.minimumFreeRatio ?? 0.05);
  const componentTimeoutMs = validPositiveInteger("componentTimeoutMs", options.componentTimeoutMs ?? 2_000);
  const componentProbes = options.componentProbes ?? [];
  const readFilesystemCapacity = options.readFilesystemCapacity
    ?? (async (root: string) => statfs(root, { bigint: true }));
  if (new Set(componentProbes.map(({ name }) => name)).size !== componentProbes.length) {
    throw new Error("Readiness component names must be unique.");
  }
  const checks: ReadinessCheck[] = await Promise.all([
    directoryCheck("data-root", config.paths.dataRoot, constants.R_OK | constants.W_OK | constants.X_OK, "DATA_ROOT_UNAVAILABLE"),
    directoryCheck("backups-root", config.paths.backupsRoot, constants.R_OK | constants.W_OK | constants.X_OK, "BACKUPS_ROOT_UNAVAILABLE"),
    directoryCheck("company-context", config.paths.companyContextRoot, constants.R_OK | constants.X_OK, "COMPANY_CONTEXT_UNAVAILABLE"),
    directoryCheck("users-root", config.paths.usersRoot, constants.R_OK | constants.W_OK | constants.X_OK, "USERS_ROOT_UNAVAILABLE"),
    readOnlyDirectoryCheck("source-read", config.paths.sourceReadRoot),
    directoryCheck("publish-write", config.paths.publishWriteRoot, constants.R_OK | constants.W_OK | constants.X_OK, "PUBLISH_WRITE_UNAVAILABLE"),
    dockerSocketCheck(options.dockerSocketPath ?? "/var/run/docker.sock"),
  ]);

  let disk: ReadinessReport["disk"] = null;
  try {
    const filesystem = await readFilesystemCapacity(config.paths.dataRoot);
    const freeBytes = safeFilesystemNumber(filesystem.bavail * filesystem.bsize);
    const totalBytes = safeFilesystemNumber(filesystem.blocks * filesystem.bsize);
    const freeRatio = totalBytes === 0 ? 0 : freeBytes / totalBytes;
    disk = Object.freeze({ freeBytes, totalBytes, freeRatio });
    checks.push({
      name: "disk-capacity",
      status: freeBytes >= minimumFreeBytes && freeRatio >= minimumFreeRatio ? "pass" : "fail",
      code: freeBytes >= minimumFreeBytes && freeRatio >= minimumFreeRatio ? "OK" : "DISK_CAPACITY_LOW",
    });
  } catch {
    checks.push({ name: "disk-capacity", status: "fail", code: "DISK_CAPACITY_UNAVAILABLE" });
  }

  try {
    const filesystem = await readFilesystemCapacity(config.paths.publishWriteRoot);
    const freeBytes = safeFilesystemNumber(filesystem.bavail * filesystem.bsize);
    const totalBytes = safeFilesystemNumber(filesystem.blocks * filesystem.bsize);
    const freeRatio = totalBytes === 0 ? 0 : freeBytes / totalBytes;
    const available = freeBytes >= minimumFreeBytes && freeRatio >= minimumFreeRatio;
    checks.push({
      name: "publish-capacity",
      status: available ? "pass" : "fail",
      code: available ? "OK" : "PUBLISH_CAPACITY_LOW",
    });
  } catch {
    checks.push({ name: "publish-capacity", status: "fail", code: "PUBLISH_CAPACITY_UNAVAILABLE" });
  }

  const components = await Promise.all(componentProbes.map((probe) => checkComponent(probe, componentTimeoutMs)));
  const componentFailure = components.some((component) => component.required && component.status !== "ready");

  return Object.freeze({
    schemaVersion: 1,
    status: checks.some((check) => check.status === "fail") || componentFailure ? "degraded" : "ready",
    checkedAt: new Date(now()).toISOString(),
    disk,
    checks: Object.freeze(checks),
    ...(components.length > 0 ? { components: Object.freeze(components) } : {}),
  });
}
