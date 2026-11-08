#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { load as parseYaml } from "js-yaml";

const IMAGE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{7,64}$/u;
const INSTALLATION = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const RELEASE_SCHEMA_VERSION = 3;
const TRANSACTION_SCHEMA_VERSION = 2;
const LOCK_SCHEMA_VERSION = 1;
const TRANSACTION_PHASES = new Set([
  "prepared",
  "inputs-updated",
  "target-healthy",
  "state-committed",
  "recovering-previous",
  "recovery-state-committed",
]);
const BOOLEAN_FALSE_SET = new Set(["0", "false", "no", "off"]);
const BOOLEAN_TRUE_SET = new Set(["1", "true", "yes", "on"]);

// Deployment ownership is an executable boundary, independent of fleet selection
// and human wording such as "all clients". Keep this standalone: host packages
// install this manager without the repository's config directory.
// Reviewed ownership is supplied at install time. An empty registry refuses every
// promotion, so cloning this repository never enrolls a production installation.
function loadReleaseOwnership() {
  const file = process.env.AIBRAIN_RELEASE_OWNERSHIP_FILE;
  if (!file) return Object.freeze({});
  if (!path.isAbsolute(file)) throw new Error("RELEASE_OWNERSHIP_FILE_INVALID");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value;
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.size > 65536 || (metadata.mode & 0o022)) throw new Error("RELEASE_OWNERSHIP_FILE_INVALID");
    value = JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RELEASE_OWNERSHIP_FILE_INVALID");
  const registry = Object.create(null);
  for (const [installationId, owner] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(installationId) || !owner || typeof owner !== "object" || Array.isArray(owner)
      || Object.keys(owner).sort().join(",") !== "egressImageRepository,imageRepository,repository"
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(owner.repository ?? "")
      || !/^[a-z0-9][a-z0-9./_-]+$/.test(owner.imageRepository ?? "")
      || !/^[a-z0-9][a-z0-9./_-]+$/.test(owner.egressImageRepository ?? "")) throw new Error("RELEASE_OWNERSHIP_FILE_INVALID");
    registry[installationId] = Object.freeze({ ...owner });
  }
  return Object.freeze(registry);
}
const RELEASE_OWNERSHIP = loadReleaseOwnership();

function assertReleaseOwnership({ installationId, image, egressImage, sourceRepository = null }) {
  const owner = Object.hasOwn(RELEASE_OWNERSHIP, installationId) ? RELEASE_OWNERSHIP[installationId] : null;
  if (!owner) {
    throw new ReleaseError("RELEASE_OWNERSHIP_UNKNOWN", "Installation has no reviewed release owner; promotion refused.");
  }
  if ((sourceRepository !== null && sourceRepository !== owner.repository)
    || !IMAGE.test(image ?? "") || !IMAGE.test(egressImage ?? "")
    || image.split("@")[0] !== owner.imageRepository
    || egressImage.split("@")[0] !== owner.egressImageRepository) {
    throw new ReleaseError("RELEASE_OWNERSHIP_MISMATCH", `Release source and both images must belong to ${owner.repository} for ${installationId}.`);
  }
  return owner;
}

function assertTargetSourceLabels(options, target) {
  const owner = assertReleaseOwnership({ installationId: options.installationId, ...target });
  for (const image of [target.image, target.egressImage]) {
    const source = runDocker(options, [
      "image", "inspect", "--format", "{{index .Config.Labels \"org.opencontainers.image.source\"}}", image,
    ]);
    if (source !== `https://github.com/${owner.repository}`) {
      throw new ReleaseError("RELEASE_SOURCE_MISMATCH", "OCI source label does not match the installation's reviewed repository.");
    }
  }
}

class ReleaseError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ReleaseError";
    this.code = code;
  }
}

function usage() {
  return [
    "Usage:",
    "  node scripts/manage-release.mjs promote --image <name@sha256:...> --egress-image <name@sha256:...> --revision <git-sha> --installation-id <slug> --env-file <active absolute> --target-env-file <target absolute> --compose-file <target absolute> --current-compose-file <current absolute> --installation-config <target absolute> --state-file <absolute>",
    "  node scripts/manage-release.mjs rollback --installation-id <slug> --env-file <absolute> --state-file <absolute>",
    "Optional: --docker-bin <absolute> --health-timeout-ms <positive integer> --docker-command-timeout-ms <positive integer>",
  ].join("\n");
}

function parseBooleanEnv(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return fallback;
  if (BOOLEAN_FALSE_SET.has(normalized)) return false;
  if (BOOLEAN_TRUE_SET.has(normalized)) return true;
  return fallback;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["promote", "rollback"]).has(command)) {
    throw new ReleaseError("RELEASE_USAGE", usage());
  }
  if (rest.length % 2 !== 0) throw new ReleaseError("RELEASE_USAGE", usage());
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith("--") || !value || values.has(name)) {
      throw new ReleaseError("RELEASE_USAGE", usage());
    }
    values.set(name, value);
  }
  const allowed = new Set([
    "--image",
    "--egress-image",
    "--revision",
    "--installation-id",
    "--env-file",
    "--target-env-file",
    "--compose-file",
    "--current-compose-file",
    "--installation-config",
    "--state-file",
    "--docker-bin",
    "--health-timeout-ms",
    "--docker-command-timeout-ms",
  ]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new ReleaseError("RELEASE_USAGE", `Unknown option ${name}.`);
  }
  const required = ["--installation-id", "--env-file", "--state-file"];
  if (command === "promote") {
    required.push("--image", "--egress-image", "--revision", "--target-env-file", "--compose-file", "--installation-config");
  }
  for (const name of required) {
    if (!values.has(name)) throw new ReleaseError("RELEASE_USAGE", `Missing ${name}.`);
  }
  const installationId = values.get("--installation-id");
  if (!INSTALLATION.test(installationId) || installationId.length < 2) {
    throw new ReleaseError("RELEASE_INSTALLATION_INVALID", "Installation ID is invalid.");
  }
  const image = values.get("--image") ?? null;
  const egressImage = values.get("--egress-image") ?? null;
  const revision = values.get("--revision") ?? null;
  if (image !== null && !IMAGE.test(image)) {
    throw new ReleaseError("RELEASE_IMAGE_MUTABLE", "Release images must use an immutable sha256 digest.");
  }
  if (egressImage !== null && !IMAGE.test(egressImage)) {
    throw new ReleaseError("RELEASE_IMAGE_MUTABLE", "Egress release images must use an immutable sha256 digest.");
  }
  if (revision !== null && !REVISION.test(revision)) {
    throw new ReleaseError("RELEASE_REVISION_INVALID", "Release revision must be a hexadecimal git commit.");
  }
  const timeoutValue = values.get("--health-timeout-ms") ?? "120000";
  if (!POSITIVE_INTEGER.test(timeoutValue) || Number(timeoutValue) > 900_000) {
    throw new ReleaseError("RELEASE_TIMEOUT_INVALID", "Health timeout must be between 1 and 900000 ms.");
  }
  // Compose waits for the gateway's health before application startup. Its
  // subprocess budget must cover that phase within the same release deadline.
  const commandTimeoutValue = values.get("--docker-command-timeout-ms") ?? timeoutValue;
  if (!POSITIVE_INTEGER.test(commandTimeoutValue) || Number(commandTimeoutValue) > 900_000) {
    throw new ReleaseError("RELEASE_TIMEOUT_INVALID", "Docker command timeout must be between 1 and 900000 ms.");
  }
  return {
    command,
    installationId,
    image,
    egressImage,
    revision,
    envFile: safeExistingFile(values.get("--env-file"), "compose env"),
    targetEnvFile: values.has("--target-env-file")
      ? safeExistingFile(values.get("--target-env-file"), "target compose env")
      : null,
    composeFile: values.has("--compose-file")
      ? safeExistingFile(values.get("--compose-file"), "target Compose")
      : null,
    currentComposeFile: values.has("--current-compose-file")
      ? safeExistingFile(values.get("--current-compose-file"), "current Compose")
      : null,
    installationConfig: values.has("--installation-config")
      ? safeExistingFile(values.get("--installation-config"), "target installation config")
      : null,
    automationWorkerEnabled: parseBooleanEnv(process.env.AIBRAIN_AUTOMATION_WORKER_ENABLED, true),
    stateFile: safeStateFile(values.get("--state-file")),
    dockerBin: safeExecutable(values.get("--docker-bin") ?? "/usr/bin/docker"),
    healthTimeoutMs: Number(timeoutValue),
    dockerCommandTimeoutMs: Number(commandTimeoutValue),
  };
}

function safeExistingFile(value, label, options = {}) {
  if (!path.isAbsolute(value)) throw new ReleaseError("RELEASE_PATH_INVALID", `${label} path must be absolute.`);
  const original = lstatSync(value, { throwIfNoEntry: false });
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : original?.uid;
  if (!original?.isFile() || original.isSymbolicLink() || original.nlink !== 1
    || original.uid !== expectedUid || (original.mode & (options.privateFile ? 0o077 : 0o022)) !== 0) {
    throw new ReleaseError("RELEASE_PATH_INVALID", `${label} must be an exclusive owner-controlled regular file.`);
  }
  const canonical = realpathSync(value);
  const metadata = lstatSync(canonical);
  if (metadata.dev !== original.dev || metadata.ino !== original.ino) {
    throw new ReleaseError("RELEASE_PATH_INVALID", `${label} identity changed during validation.`);
  }
  return canonical;
}

function safeStateFile(value) {
  if (!path.isAbsolute(value)) throw new ReleaseError("RELEASE_PATH_INVALID", "State path must be absolute.");
  const parent = realpathSync(path.dirname(value));
  const parentMetadata = lstatSync(parent);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : parentMetadata.uid;
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || parentMetadata.uid !== expectedUid
    || (parentMetadata.mode & 0o022) !== 0) {
    throw new ReleaseError("RELEASE_STATE_UNSAFE", "Release state directory must be owner-controlled.");
  }
  const resolved = path.join(parent, path.basename(value));
  if (existsSync(resolved)) {
    const metadata = lstatSync(resolved);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== expectedUid || (metadata.mode & 0o077) !== 0) {
      throw new ReleaseError("RELEASE_STATE_UNSAFE", "Release state must be a private regular file.");
    }
  }
  return resolved;
}

function safeExecutable(value) {
  const executable = safeExistingFile(value, "Docker executable");
  try {
    const descriptor = openSync(executable, constants.O_RDONLY);
    closeSync(descriptor);
  } catch (error) {
    throw new ReleaseError("RELEASE_DOCKER_INVALID", "Docker executable is unavailable.", { cause: error });
  }
  return executable;
}

function parseEnv(contents) {
  const values = new Map();
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new ReleaseError("RELEASE_ENV_INVALID", "Compose env contains an invalid line.");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || values.has(key)) {
      throw new ReleaseError("RELEASE_ENV_INVALID", "Compose env contains an invalid or duplicate key.");
    }
    values.set(key, value);
  }
  return values;
}

function assertNoReleaseSecrets(values) {
  for (const key of values.keys()) {
    if (/(?:^|_)(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_KEY_ID)$/u.test(key)) {
      throw new ReleaseError("RELEASE_ENV_SECRET", "Compose release env must not contain secret values.");
    }
  }
}

const IMMUTABLE_ENV_KEYS = [
  "AIBRAIN_INSTALLATION_ID",
  "AIBRAIN_COMPOSE_PROJECT_NAME",
  "AIBRAIN_INSTALLATION_CONFIG_HOST",
  "AIBRAIN_RUNTIME_ENV_FILE",
  "AIBRAIN_EGRESS_ENV_FILE",
  "AIBRAIN_ALERTS_ENV_FILE",
  "AIBRAIN_REPLICA_ENV_FILE",
  "AIBRAIN_RESTIC_PASSWORD_FILE_HOST",
  "AIBRAIN_HOST_ROOT",
  "AIBRAIN_SOURCE_HOST_PATH",
  "AIBRAIN_PUBLISH_HOST_PATH",
  "AIBRAIN_REPLICA_STATE_HOST_PATH",
  "AIBRAIN_NETWORK_NAME",
  "AIBRAIN_EGRESS_NETWORK_NAME",
  "AIBRAIN_DATA_VOLUME_NAME",
  "AIBRAIN_BACKUP_VOLUME_NAME",
  "AIBRAIN_RESTORE_VOLUME_NAME",
  "AIBRAIN_HTTP_PORT",
  "AIBRAIN_UID",
  "AIBRAIN_GID",
  "AIBRAIN_EGRESS_UID",
  "AIBRAIN_EGRESS_GID",
];

function assertTargetEnvironment(current, target, options) {
  assertNoReleaseSecrets(target);
  if (target.get("AIBRAIN_INSTALLATION_ID") !== options.installationId
    || target.get("AIBRAIN_COMPOSE_PROJECT_NAME") !== `aibrain-${options.installationId}`
    || target.get("AIBRAIN_IMAGE") !== options.image
    || target.get("AIBRAIN_EGRESS_IMAGE") !== options.egressImage
    || target.get("AIBRAIN_REVISION") !== options.revision) {
    throw new ReleaseError("RELEASE_TARGET_ENV_INVALID", "Target env identity, images or revision do not match the requested release.");
  }
  for (const key of IMMUTABLE_ENV_KEYS) {
    if (!current.has(key) || target.get(key) !== current.get(key)) {
      throw new ReleaseError("RELEASE_TARGET_ENV_MIGRATION_REQUIRED", `${key} cannot change in an ordinary release.`);
    }
  }
  for (const value of target.values()) {
    if (/(?:^|[\\/])bgreenly(?:[\\/]|$)/iu.test(value)) {
      throw new ReleaseError("RELEASE_TARGET_ENV_INVALID", "Target env must never address BGreenly.");
    }
  }
}

const INSTALLATION_ROOT_KEYS = [
  "schemaVersion", "installationId", "companyName", "companySlug", "publicUrl", "branding", "paths",
];
const INSTALLATION_OPTIONAL_ROOT_KEYS = ["catalog", "connectors", "usageLimits"];
const INSTALLATION_BRANDING_KEYS = ["productName", "logoPath", "faviconPath", "accentColor"];
const INSTALLATION_PATHS = Object.freeze({
  dataRoot: "/var/lib/aibrain/data",
  companyContextRoot: "/var/lib/aibrain/data/company-context",
  usersRoot: "/var/lib/aibrain/data/users",
  sourceReadRoot: "/srv/aibrain/source-ro",
  publishWriteRoot: "/srv/aibrain/publish-rw",
  backupsRoot: "/var/lib/aibrain/data/backups",
});

function exactObjectKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function installationRootKeysAreValid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return INSTALLATION_ROOT_KEYS.every((key) => actual.includes(key))
    && actual.every((key) => INSTALLATION_ROOT_KEYS.includes(key) || INSTALLATION_OPTIONAL_ROOT_KEYS.includes(key));
}

function validInstallationCatalog(value) {
  if (value === undefined) return true;
  if (!exactObjectKeys(value, ["graphikAIManagedSkills"])
    || !Array.isArray(value.graphikAIManagedSkills)
    || value.graphikAIManagedSkills.length > 80) return false;
  const ids = new Set();
  for (const skill of value.graphikAIManagedSkills) {
    if (!exactObjectKeys(skill, ["id", "label"])
      || typeof skill.id !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(skill.id)
      || !validConfigString(skill.label, 120)
      || ids.has(skill.id)) return false;
    ids.add(skill.id);
  }
  return true;
}

// Keep this standalone gate aligned with config/installation-schema.ts.
function validInstallationUsageLimits(value) {
  const keys = value?.unlimitedUntil === undefined
    ? ["weeklyTokens", "timeZone"]
    : ["weeklyTokens", "timeZone", "unlimitedUntil"];
  const parsedUnlimitedUntil = typeof value?.unlimitedUntil === "string" ? Date.parse(value.unlimitedUntil) : Number.NaN;
  return value === undefined || (exactObjectKeys(value, keys)
    && Number.isSafeInteger(value.weeklyTokens) && value.weeklyTokens > 0
    && value.timeZone === "Europe/Madrid"
    && (value.unlimitedUntil === undefined || (Number.isFinite(parsedUnlimitedUntil)
      && new Date(parsedUnlimitedUntil).toISOString() === value.unlimitedUntil)));
}

function validInstallationConnectors(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !["gmail", "outlook", "composio", "companyMail", "mail"].includes(key))) return false;
  if (value.mail !== undefined && (!exactObjectKeys(value.mail, ["enabled", "provider"])
    || typeof value.mail.enabled !== "boolean" || value.mail.provider !== "nominalia")) return false;
  if (value.companyMail !== undefined) {
    const mail = value.companyMail;
    const dns = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/u;
    if (!exactObjectKeys(mail, ["enabled", "host", "emailDomain"])
      || typeof mail.enabled !== "boolean" || typeof mail.host !== "string" || !dns.test(mail.host)
      || mail.host.endsWith(".localhost") || mail.host.endsWith(".internal") || mail.host.endsWith(".local")
      || typeof mail.emailDomain !== "string" || !dns.test(mail.emailDomain)) return false;
  }
  if (value.composio !== undefined) {
    const c = value.composio;
    if (!exactObjectKeys(c, ["toolkits"]) || !Array.isArray(c.toolkits) || c.toolkits.length > 40
      || !c.toolkits.every(validComposioToolkit)
      || new Set(c.toolkits.map(t => t.slug)).size !== c.toolkits.length) return false;
  }
  if (value.gmail !== undefined && !exactObjectKeys(value.gmail, ["enabled"])) return false;
  if (value.gmail !== undefined && typeof value.gmail.enabled !== "boolean") return false;
  if (value.outlook !== undefined) {
    const outlookKeys = Object.keys(value.outlook ?? {});
    if (!value.outlook || typeof value.outlook !== "object" || Array.isArray(value.outlook)
      || outlookKeys.some((key) => key !== "enabled" && key !== "tenantId")
      || !outlookKeys.includes("enabled") || typeof value.outlook.enabled !== "boolean") return false;
    if (value.outlook.tenantId !== undefined
      && (typeof value.outlook.tenantId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.outlook.tenantId))) return false;
  }
  return true;
}

// Keep the standalone release gate aligned with connectors/composio-config.ts.
function validComposioToolkit(v) {
  return exactObjectKeys(v, ["slug", "label", "authConfigId", "scopes", "readTools"])
    && typeof v.slug === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(v.slug)
    && typeof v.label === "string" && v.label.length > 0 && v.label.length <= 100
    && typeof v.authConfigId === "string" && (v.authConfigId === "on-connect" || /^ac_[A-Za-z0-9_-]{1,120}$/.test(v.authConfigId))
    && Array.isArray(v.scopes) && v.scopes.length > 0 && v.scopes.length <= 32
    && v.scopes.every(s => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(s))
    && new Set(v.scopes).size === v.scopes.length
    && Array.isArray(v.readTools) && v.readTools.length > 0 && v.readTools.length <= 40
    && v.readTools.every(t => exactObjectKeys(t, ["slug", "version"])
      && typeof t.slug === "string" && /^[A-Z][A-Z0-9_]{1,150}$/.test(t.slug)
      && typeof t.version === "string" && /^\d{8}_\d{2}$/.test(t.version))
    && new Set(v.readTools.map(t => t.slug)).size === v.readTools.length;
}

function validConfigString(value, maximumLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength
    && value.trim() === value && !/\p{C}/u.test(value);
}

function validPublicAssetPath(value) {
  return validConfigString(value, 300) && value.startsWith("/") && !value.startsWith("//")
    && !/[\\?#%]/u.test(value) && path.posix.normalize(value) === value;
}

function validateVersionedInstallationConfig(contents, installationId) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new ReleaseError("RELEASE_INSTALLATION_CONFIG_INVALID", "InstallationConfig is invalid JSON.", { cause: error });
  }
  const branding = value?.branding;
  const paths = value?.paths;
  if (!installationRootKeysAreValid(value)
    || value.schemaVersion !== 1 || value.installationId !== installationId
    || !exactObjectKeys(branding, INSTALLATION_BRANDING_KEYS)
    || !exactObjectKeys(paths, Object.keys(INSTALLATION_PATHS))
    || !validConfigString(value.companyName, 120)
    || !validConfigString(value.companySlug, 63)
    || value.companySlug.length < 2
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value.companySlug)
    || !validConfigString(value.publicUrl, 300)
    || !validConfigString(branding?.productName, 80)
    || !validPublicAssetPath(branding?.logoPath)
    || !validPublicAssetPath(branding?.faviconPath)
    || !/^#[0-9a-fA-F]{6}$/u.test(branding.accentColor)
    || !validInstallationCatalog(value.catalog)
    || !validInstallationConnectors(value.connectors)
    || !validInstallationUsageLimits(value.usageLimits)
    || Object.entries(INSTALLATION_PATHS).some(([key, expected]) => paths[key] !== expected)) {
    throw new ReleaseError("RELEASE_INSTALLATION_CONFIG_INVALID", "InstallationConfig does not match the installation schema and fixed container paths.");
  }
  let publicUrl;
  try { publicUrl = new URL(value.publicUrl); } catch {
    throw new ReleaseError("RELEASE_INSTALLATION_CONFIG_INVALID", "InstallationConfig publicUrl is invalid.");
  }
  if ((publicUrl.protocol !== "https:" && !(publicUrl.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(publicUrl.hostname)))
    || publicUrl.origin !== value.publicUrl || publicUrl.username || publicUrl.password) {
    throw new ReleaseError("RELEASE_INSTALLATION_CONFIG_INVALID", "InstallationConfig publicUrl must be an approved exact origin.");
  }
}

function validateComposeSafety(contents, installationId) {
  if (/bgreenly/iu.test(contents)
    || /^\s*(?:privileged|network_mode)\s*:/mu.test(contents)
    || /^\s*external\s*:/mu.test(contents)
    || /docker\.sock/iu.test(contents)
    || /^\s*build\s*:/mu.test(contents)
    || !/127\.0\.0\.1:\$\{AIBRAIN_HTTP_PORT:/u.test(contents)
    || !/com\.graphikai\.aibrain\.installation:[^\n]*AIBRAIN_INSTALLATION_ID/u.test(contents)
    || !/aibrain-internal:[\s\S]*internal: true/u.test(contents)
    || !contents.includes("seccomp=./browser/seccomp_profile.json")) {
    throw new ReleaseError("RELEASE_COMPOSE_UNSAFE", `Compose for ${installationId} violates fixed isolation boundaries.`);
  }
  let value;
  try {
    value = parseYaml(contents, { json: true });
  } catch (error) {
    throw new ReleaseError("RELEASE_COMPOSE_INVALID", "Release Compose is invalid YAML.", { cause: error });
  }
  const services = value?.services;
  const networks = value?.networks;
  const volumes = value?.volumes;
  const allowedServices = new Set([
    "app", "automation-worker", "ingress-gateway", "egress-gateway", "alert-dispatcher", "backup-replicator",
  ]);
  const requiredServices = ["app", "automation-worker", "ingress-gateway", "egress-gateway", "alert-dispatcher"];
  const expectedNetworks = {
    app: ["aibrain-internal"],
    "automation-worker": ["aibrain-internal"],
    "ingress-gateway": ["aibrain-ingress", "aibrain-internal"],
    "egress-gateway": ["aibrain-egress", "aibrain-internal"],
    "alert-dispatcher": ["aibrain-egress", "aibrain-internal"],
    "backup-replicator": ["aibrain-egress"],
  };
  const expectedImages = {
    app: "AIBRAIN_IMAGE",
    "automation-worker": "AIBRAIN_IMAGE",
    "ingress-gateway": "AIBRAIN_EGRESS_IMAGE",
    "egress-gateway": "AIBRAIN_EGRESS_IMAGE",
    "alert-dispatcher": "AIBRAIN_IMAGE",
    "backup-replicator": "AIBRAIN_IMAGE",
  };
  const seccompServices = new Set(["app", "automation-worker"]);
  const reviewedSeccomp = "seccomp=./browser/seccomp_profile.json";
  const expectedResourceNames = {
    "aibrain-internal": "AIBRAIN_NETWORK_NAME",
    "aibrain-egress": "AIBRAIN_EGRESS_NETWORK_NAME",
    "aibrain-ingress": "AIBRAIN_INGRESS_NETWORK_NAME",
    "aibrain-data": "AIBRAIN_DATA_VOLUME_NAME",
    "aibrain-backups": "AIBRAIN_BACKUP_VOLUME_NAME",
    "aibrain-restores": "AIBRAIN_RESTORE_VOLUME_NAME",
  };
  const allowedVolumeSources = new Set([
    "aibrain-data", "aibrain-backups", "aibrain-restores",
    "AIBRAIN_INSTALLATION_CONFIG_HOST", "AIBRAIN_SOURCE_HOST_PATH", "AIBRAIN_PUBLISH_HOST_PATH",
    "AIBRAIN_REPLICA_STATE_HOST_PATH", "AIBRAIN_RESTIC_PASSWORD_FILE_HOST",
  ]);
  const dangerousServiceKeys = [
    "build", "devices", "device_cgroup_rules", "external_links", "ipc", "links",
    "network_mode", "pid", "privileged", "uts", "userns_mode",
  ];
  const interpolationKey = (candidate) => typeof candidate === "string"
    ? /^\$\{([A-Z][A-Z0-9_]*)(?::[^}]*)?\}$/u.exec(candidate)?.[1] ?? null
    : null;
  const exactStringSet = (candidate, expected) => Array.isArray(candidate)
    && candidate.every((item) => typeof item === "string")
    && [...candidate].sort().join("\0") === [...expected].sort().join("\0");
  if (!exactObjectKeys(networks, ["aibrain-internal", "aibrain-egress", "aibrain-ingress"])
    || !exactObjectKeys(volumes, ["aibrain-data", "aibrain-backups", "aibrain-restores"])
    || networks["aibrain-internal"]?.internal !== true
    || interpolationKey(value?.name) !== "AIBRAIN_COMPOSE_PROJECT_NAME") {
    throw new ReleaseError("RELEASE_COMPOSE_UNSAFE", "Compose resources do not match the isolated installation topology.");
  }
  for (const [name, key] of Object.entries(expectedResourceNames)) {
    const resource = networks[name] ?? volumes[name];
    if (!resource || resource.external !== undefined || interpolationKey(resource.name) !== key) {
      throw new ReleaseError("RELEASE_COMPOSE_UNSAFE", "Compose resource names must use the installation-owned environment keys.");
    }
  }
  if (!services || typeof services !== "object" || Array.isArray(services)
    || requiredServices.some((name) => !services[name])
    || Object.keys(services).some((name) => !allowedServices.has(name))) {
    throw new ReleaseError("RELEASE_COMPOSE_UNSAFE", "Compose services do not match the reviewed runtime set.");
  }
  for (const [name, service] of Object.entries(services)) {
    if (!service || typeof service !== "object" || Array.isArray(service)
      || dangerousServiceKeys.some((key) => service[key] !== undefined)
      || interpolationKey(service.image) !== expectedImages[name]
      || !exactStringSet(service.networks, expectedNetworks[name])) {
      throw new ReleaseError("RELEASE_COMPOSE_UNSAFE", `Compose service ${name} violates runtime isolation.`);
    }
    const securityOptions = Array.isArray(service.security_opt) ? service.security_opt : [];
    const seccompOptions = securityOptions.filter((option) =>
      typeof option === "string" && option.startsWith("seccomp="));
    if ((seccompServices.has(name) && (seccompOptions.length !== 1 || seccompOptions[0] !== reviewedSeccomp))
      || (!seccompServices.has(name) && seccompOptions.length !== 0)) {
      throw new ReleaseError("RELEASE_COMPOSE_UNSAFE", `Compose service ${name} has an unreviewed seccomp boundary.`);
    }
    if (service.volumes !== undefined) {
      if (!Array.isArray(service.volumes) || service.volumes.some((mount) => {
        if (!mount || typeof mount !== "object" || Array.isArray(mount)) return true;
        const source = interpolationKey(mount.source) ?? mount.source;
        return typeof source !== "string" || !allowedVolumeSources.has(source)
          || typeof mount.target !== "string" || !path.posix.isAbsolute(mount.target);
      })) {
        throw new ReleaseError("RELEASE_COMPOSE_UNSAFE", `Compose service ${name} has an unreviewed mount.`);
      }
    }
    if (name !== "ingress-gateway" && service.ports !== undefined) {
      throw new ReleaseError("RELEASE_COMPOSE_UNSAFE", `Compose service ${name} cannot publish host ports.`);
    }
  }
}

function writeAtomic(file, contents, mode = 0o600, ownership = null) {
  const temporary = `${file}.pending-${process.pid}-${randomUUID()}`;
  let committed = false;
  try {
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    try {
      writeFileSync(descriptor, contents, "utf8");
      fchmodSync(descriptor, mode);
      if (ownership !== null) fchownSync(descriptor, ownership.uid, ownership.gid);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, file);
    committed = true;
    fsyncDirectory(path.dirname(file));
  } catch (error) {
    if (!committed && existsSync(temporary)) {
      try {
        unlinkSync(temporary);
      } catch {
        // A unique pending file is safer to retain than deleting an uncertain path.
      }
    }
    throw new ReleaseError(
      committed ? "RELEASE_ATOMIC_COMMIT_UNCERTAIN" : "RELEASE_ATOMIC_WRITE_FAILED",
      committed
        ? "Atomic file rename completed but directory durability could not be confirmed."
        : "Atomic file update failed before commit.",
      { cause: error },
    );
  }
}

function fsyncDirectory(directory) {
  const parent = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

function unlinkDurably(file) {
  if (!existsSync(file)) return;
  unlinkSync(file);
  fsyncDirectory(path.dirname(file));
}

function runDocker(options, args, timeoutMs = options.dockerCommandTimeoutMs, allowedExitCodes = []) {
  try {
    const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
    return execFileSync(options.dockerBin, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: boundedTimeoutMs,
      killSignal: "SIGKILL",
    }).trim();
  } catch (error) {
    if (error && typeof error === "object" && "status" in error
      && allowedExitCodes.includes(error.status)) {
      return typeof error.stdout === "string" ? error.stdout.trim() : "";
    }
    if (error && typeof error === "object" && "code" in error && error.code === "ETIMEDOUT") {
      throw new ReleaseError("RELEASE_DOCKER_TIMEOUT", "Docker release command exceeded its bounded timeout.", { cause: error });
    }
    throw new ReleaseError("RELEASE_DOCKER_FAILED", "Docker release command failed.", { cause: error });
  }
}

function inspectImage(options, image, expectedRevision = null, deadline = null) {
  if (!IMAGE.test(image)) throw new ReleaseError("RELEASE_IMAGE_MUTABLE", "Stored release image is not immutable.");
  const commandTimeout = deadline === null
    ? options.dockerCommandTimeoutMs
    : remainingDockerTimeout(options, deadline);
  const digestsText = runDocker(
    options,
    ["image", "inspect", "--format", "{{json .RepoDigests}}", image],
    commandTimeout,
  );
  let digests;
  try {
    digests = JSON.parse(digestsText);
  } catch (error) {
    throw new ReleaseError("RELEASE_IMAGE_INVALID", "Docker returned invalid image digests.", { cause: error });
  }
  const expectedDigest = image.slice(image.indexOf("@sha256:"));
  if (!Array.isArray(digests) || !digests.some((item) => typeof item === "string" && item.endsWith(expectedDigest))) {
    throw new ReleaseError("RELEASE_IMAGE_DIGEST_MISMATCH", "Local image does not match the requested digest.");
  }
  const revision = runDocker(
    options,
    ["image", "inspect", "--format", "{{index .Config.Labels \"org.opencontainers.image.revision\"}}", image],
    deadline === null ? options.dockerCommandTimeoutMs : remainingDockerTimeout(options, deadline),
  );
  if (!REVISION.test(revision) || (expectedRevision !== null && revision !== expectedRevision)) {
    throw new ReleaseError("RELEASE_IMAGE_REVISION_MISMATCH", "Image revision label does not match the release.");
  }
  return revision;
}

function activeComposePath(options) {
  return `${options.stateFile}.active.compose.yaml`;
}

function activeSeccompPath(options) {
  return `${options.stateFile}.active.seccomp.json`;
}

function composeArgs(options, release, ...args) {
  return [
    "compose",
    "--env-file", options.envFile,
    "--project-directory", path.dirname(activeComposePath(options)),
    "-f", activeComposePath(options),
    ...args,
  ];
}

function remainingDockerTimeout(options, deadline) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw new ReleaseError("RELEASE_HEALTH_FAILED", "The shared release health deadline expired.");
  }
  return Math.max(1, Math.min(options.dockerCommandTimeoutMs, remaining));
}

function managedServiceSet(includeAutomationWorker) {
  return includeAutomationWorker
    ? ["egress-gateway", "automation-worker", "app", "ingress-gateway", "alert-dispatcher"]
    : ["egress-gateway", "app", "ingress-gateway", "alert-dispatcher"];
}

function releaseAutomationWorkerEnabled(options, release) {
  const environment = parseEnv(releaseContents(release).environment);
  return parseBooleanEnv(
    environment.get("AIBRAIN_AUTOMATION_WORKER_ENABLED"),
    options.automationWorkerEnabled,
  );
}

function stopAutomationWorkerIfRunning(options, release, deadline) {
  const containerId = runDocker(
    options,
    composeArgs(options, release, "ps", "-q", "--status", "running", "automation-worker"),
    remainingDockerTimeout(options, deadline),
    [1],
  );
  if (containerId.length === 0) return;
  runDocker(
    options,
    composeArgs(options, release, "stop", "automation-worker"),
    remainingDockerTimeout(options, deadline),
  );
}

function waitUntilHealthy(options, release, service, deadline) {
  const containerId = runDocker(
    options,
    composeArgs(options, release, "ps", "-q", service),
    remainingDockerTimeout(options, deadline),
  );
  if (!/^[a-f0-9]{12,64}$/u.test(containerId)) {
    throw new ReleaseError("RELEASE_CONTAINER_INVALID", `Compose did not return the ${service} container ID.`);
  }
  while (performance.now() <= deadline) {
    const state = runDocker(
      options,
      ["inspect", "--format", "{{.State.Status}} {{.State.Health.Status}}", containerId],
      remainingDockerTimeout(options, deadline),
    );
    const [runtimeStatus, health] = state.split(/\s+/u);
    if (runtimeStatus === "running" && health === "healthy") return;
    if (runtimeStatus !== "running") break;
    // Docker can report `unhealthy` briefly while a readiness dependency
    // recovers (for example immediately after bounded build-cache cleanup).
    // A running container is allowed the complete shared health deadline;
    // only a terminal container state fails immediately.
    const waitMs = Math.min(500, Math.max(0, deadline - performance.now()));
    if (waitMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
  }
  throw new ReleaseError("RELEASE_HEALTH_FAILED", `${service} did not become healthy before the release deadline.`);
}

function verifyRunningService(options, release, service, expectedImage, expectedRevision, deadline) {
  const containerId = runDocker(
    options,
    composeArgs(options, release, "ps", "-q", service),
    remainingDockerTimeout(options, deadline),
  );
  if (!/^[a-f0-9]{12,64}$/u.test(containerId)) {
    throw new ReleaseError("RELEASE_CONTAINER_INVALID", `Compose did not return the ${service} container ID.`);
  }
  const configuredImage = runDocker(
    options,
    ["inspect", "--format", "{{.Config.Image}}", containerId],
    remainingDockerTimeout(options, deadline),
  );
  if (configuredImage !== expectedImage) {
    throw new ReleaseError("RELEASE_RUNNING_IMAGE_MISMATCH", `${service} is not running the requested immutable image.`);
  }
  const revision = runDocker(
    options,
    ["inspect", "--format", "{{index .Config.Labels \"org.opencontainers.image.revision\"}}", containerId],
    remainingDockerTimeout(options, deadline),
  );
  if (revision !== expectedRevision) {
    throw new ReleaseError("RELEASE_RUNNING_REVISION_MISMATCH", `${service} is not running the requested revision.`);
  }
}

function deploy(options, release, deadline = performance.now() + options.healthTimeoutMs) {
  const automationWorkerEnabled = releaseAutomationWorkerEnabled(options, release);
  assertSelectedReleaseInputs(options, release);
  runDocker(options, composeArgs(options, release, "config", "--quiet"), remainingDockerTimeout(options, deadline));
  if (!automationWorkerEnabled) stopAutomationWorkerIfRunning(options, release, deadline);
  // `--no-deps` is deliberate: release inputs are selected transactionally and
  // Compose must not start an implicit, stale dependency set. Start the private
  // egress gateway explicitly first, though. Both application processes run a
  // real App Server acceptance through that gateway in their entrypoint; when
  // every service was recreated in one call they could fail with EX_CONFIG
  // before the new gateway became healthy.
  runDocker(
    options,
    composeArgs(
      options,
      release,
      "up", "-d", "--force-recreate", "--wait", "--no-deps",
      "egress-gateway",
    ),
    remainingDockerTimeout(options, deadline),
  );

  runDocker(
    options,
    composeArgs(
      options,
      release,
      "up", "-d", "--force-recreate", "--no-deps",
      ...managedServiceSet(automationWorkerEnabled).filter((service) => service !== "egress-gateway"),
    ),
    remainingDockerTimeout(options, deadline),
  );
  if (automationWorkerEnabled) waitUntilHealthy(options, release, "automation-worker", deadline);
  waitUntilHealthy(options, release, "app", deadline);
  waitUntilHealthy(options, release, "ingress-gateway", deadline);
  waitUntilHealthy(options, release, "alert-dispatcher", deadline);
  verifyRunningService(options, release, "egress-gateway", release.egressImage, release.revision, deadline);
  if (automationWorkerEnabled) verifyRunningService(options, release, "automation-worker", release.image, release.revision, deadline);
  verifyRunningService(options, release, "app", release.image, release.revision, deadline);
  verifyRunningService(options, release, "ingress-gateway", release.egressImage, release.revision, deadline);
  verifyRunningService(options, release, "alert-dispatcher", release.image, release.revision, deadline);
}

function verifyCurrentDeployment(options, release, deadline = performance.now() + options.healthTimeoutMs) {
  const automationWorkerEnabled = releaseAutomationWorkerEnabled(options, release);
  assertSelectedReleaseInputs(options, release);
  if (!automationWorkerEnabled) stopAutomationWorkerIfRunning(options, release, deadline);
  waitUntilHealthy(options, release, "egress-gateway", deadline);
  if (automationWorkerEnabled) waitUntilHealthy(options, release, "automation-worker", deadline);
  waitUntilHealthy(options, release, "app", deadline);
  waitUntilHealthy(options, release, "ingress-gateway", deadline);
  waitUntilHealthy(options, release, "alert-dispatcher", deadline);
  verifyRunningService(options, release, "egress-gateway", release.egressImage, release.revision, deadline);
  if (automationWorkerEnabled) verifyRunningService(options, release, "automation-worker", release.image, release.revision, deadline);
  verifyRunningService(options, release, "app", release.image, release.revision, deadline);
  verifyRunningService(options, release, "ingress-gateway", release.egressImage, release.revision, deadline);
  verifyRunningService(options, release, "alert-dispatcher", release.image, release.revision, deadline);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

const RELEASE_INPUT_LIMIT = 32 * 1024;
const RELEASE_RECORD_KEYS = [
  "image", "egressImage", "revision", "promotedAt",
  "environment", "environmentSha256",
  "compose", "composeSha256", "composeEffective", "composeEffectiveSha256",
  "seccomp", "seccompSha256", "seccompActivePath",
  "installationConfig", "installationConfigSha256", "installationConfigPath",
];

function readControlledText(file, label, { allowMissing = false } = {}) {
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (allowMissing && error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw new ReleaseError("RELEASE_INPUT_UNSAFE", `${label} could not be opened safely.`, { cause: error });
  }
  try {
    const before = fstatSync(descriptor);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : before.uid;
    if (!before.isFile() || before.nlink !== 1 || before.uid !== expectedUid
      || (before.mode & 0o022) !== 0 || before.size > RELEASE_INPUT_LIMIT) {
      throw new ReleaseError("RELEASE_INPUT_UNSAFE", `${label} must be a bounded exclusive owner-controlled file.`);
    }
    const contents = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (lockIdentity(before) !== lockIdentity(after)) {
      throw new ReleaseError("RELEASE_INPUT_UNSAFE", `${label} changed while it was being read.`);
    }
    if (contents.includes("\0")) throw new ReleaseError("RELEASE_INPUT_UNSAFE", `${label} contains NUL bytes.`);
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

function encodeInput(contents) {
  return Buffer.from(contents, "utf8").toString("base64");
}

function decodeInput(value, expectedHash) {
  if (typeof value !== "string" || value.length > Math.ceil(RELEASE_INPUT_LIMIT * 4 / 3) + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  return Buffer.byteLength(decoded, "utf8") <= RELEASE_INPUT_LIMIT && sha256(decoded) === expectedHash
    ? decoded
    : null;
}

function releaseRecord({
  installationId,
  stateFile,
  image,
  egressImage,
  revision,
  environmentContents,
  composeFile,
  installationConfigSource,
  installationConfigPath,
  promotedAt = new Date().toISOString(),
}) {
  assertNoReleaseSecrets(parseEnv(environmentContents));
  const composeContents = readControlledText(composeFile, "Release Compose input");
  const seccompContents = readControlledText(
    path.join(path.dirname(composeFile), "browser", "seccomp_profile.json"),
    "Release seccomp input",
  );
  const installationConfigContents = readControlledText(installationConfigSource, "Release installation config input");
  validateComposeSafety(composeContents, installationId);
  validateVersionedInstallationConfig(installationConfigContents, installationId);
  let seccomp;
  try { seccomp = JSON.parse(seccompContents); } catch (error) {
    throw new ReleaseError("RELEASE_SECCOMP_INVALID", "Release seccomp profile is invalid JSON.", { cause: error });
  }
  if (seccomp?.defaultAction !== "SCMP_ACT_ERRNO" || !Array.isArray(seccomp.syscalls)) {
    throw new ReleaseError("RELEASE_SECCOMP_INVALID", "Release seccomp profile does not fail closed.");
  }
  const sourceToken = "seccomp=./browser/seccomp_profile.json";
  if (composeContents.split(sourceToken).length !== 3) {
    throw new ReleaseError("RELEASE_COMPOSE_UNSAFE", "Compose must reference the reviewed seccomp profile for both isolated runtimes.");
  }
  const seccompActivePath = `${stateFile}.active.seccomp.json`;
  const composeEffective = composeContents.replaceAll(sourceToken, `seccomp=${seccompActivePath}`);
  return {
    image,
    egressImage,
    revision,
    promotedAt,
    environment: encodeInput(environmentContents),
    environmentSha256: sha256(environmentContents),
    compose: encodeInput(composeContents),
    composeSha256: sha256(composeContents),
    composeEffective: encodeInput(composeEffective),
    composeEffectiveSha256: sha256(composeEffective),
    seccomp: encodeInput(seccompContents),
    seccompSha256: sha256(seccompContents),
    seccompActivePath,
    installationConfig: encodeInput(installationConfigContents),
    installationConfigSha256: sha256(installationConfigContents),
    installationConfigPath,
  };
}

function releaseContents(release) {
  const environment = decodeInput(release.environment, release.environmentSha256);
  const compose = decodeInput(release.compose, release.composeSha256);
  const composeEffective = decodeInput(release.composeEffective, release.composeEffectiveSha256);
  const seccomp = decodeInput(release.seccomp, release.seccompSha256);
  const installationConfig = decodeInput(release.installationConfig, release.installationConfigSha256);
  if (environment === null || compose === null || composeEffective === null || seccomp === null || installationConfig === null) {
    throw new ReleaseError("RELEASE_STATE_INVALID", "Versioned release inputs failed their hashes.");
  }
  return { environment, compose, composeEffective, seccomp, installationConfig };
}

function isIsoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function hasExactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validReleaseRecord(value) {
  const compose = decodeInput(value?.compose, value?.composeSha256);
  const composeEffective = decodeInput(value?.composeEffective, value?.composeEffectiveSha256);
  return hasExactKeys(value, RELEASE_RECORD_KEYS)
    && IMAGE.test(value.image) && IMAGE.test(value.egressImage)
    && REVISION.test(value.revision) && isIsoDate(value.promotedAt)
    && /^[0-9a-f]{64}$/u.test(value.environmentSha256)
    && /^[0-9a-f]{64}$/u.test(value.composeSha256)
    && /^[0-9a-f]{64}$/u.test(value.composeEffectiveSha256)
    && /^[0-9a-f]{64}$/u.test(value.seccompSha256)
    && /^[0-9a-f]{64}$/u.test(value.installationConfigSha256)
    && typeof value.seccompActivePath === "string" && path.isAbsolute(value.seccompActivePath)
    && typeof value.installationConfigPath === "string" && path.isAbsolute(value.installationConfigPath)
    && decodeInput(value.environment, value.environmentSha256) !== null
    && compose !== null
    && composeEffective !== null
    && decodeInput(value.seccomp, value.seccompSha256) !== null
    && decodeInput(value.installationConfig, value.installationConfigSha256) !== null
    && compose.includes("seccomp=./browser/seccomp_profile.json")
    && compose.replaceAll(
      "seccomp=./browser/seccomp_profile.json",
      `seccomp=${value.seccompActivePath}`,
    ) === composeEffective
    && releaseEnvironmentMatches(value);
}

function releaseEnvironmentMatches(value) {
  const contents = decodeInput(value.environment, value.environmentSha256);
  if (contents === null) return false;
  try {
    const env = parseEnv(contents);
    return env.get("AIBRAIN_IMAGE") === value.image
      && env.get("AIBRAIN_EGRESS_IMAGE") === value.egressImage
      && env.get("AIBRAIN_REVISION") === value.revision
      && env.get("AIBRAIN_INSTALLATION_CONFIG_HOST") === value.installationConfigPath;
  } catch {
    return false;
  }
}

function validReleaseState(value, installationId) {
  return hasExactKeys(value, [
    "schemaVersion", "installationId", "composeProject", "updatedAt", "current", "previous",
  ])
    && value.schemaVersion === RELEASE_SCHEMA_VERSION
    && value.installationId === installationId
    && typeof value.composeProject === "string"
    && /^[a-z0-9][a-z0-9_-]{1,127}$/u.test(value.composeProject)
    && isIsoDate(value.updatedAt)
    && validReleaseRecord(value.current)
    && (value.previous === null || validReleaseRecord(value.previous));
}

function writeExistingControlled(file, contents, label) {
  safeExistingFile(file, label);
  const metadata = lstatSync(file);
  writeAtomic(file, contents, metadata.mode & 0o777, { uid: metadata.uid, gid: metadata.gid });
}

function writeManagedFile(target, contents, label) {
  if (existsSync(target)) {
    writeExistingControlled(target, contents, label);
  } else {
    writeAtomic(target, contents, 0o600);
  }
}

function writeActiveRuntimeInputs(options, contents) {
  writeManagedFile(activeSeccompPath(options), contents.seccomp, "Managed active seccomp");
  writeManagedFile(activeComposePath(options), contents.composeEffective, "Managed active Compose");
}

function selectReleaseInputs(options, release) {
  const contents = releaseContents(release);
  writeExistingControlled(release.installationConfigPath, contents.installationConfig, "Active installation config");
  writeExistingControlled(options.envFile, contents.environment, "Active Compose env");
  writeActiveRuntimeInputs(options, contents);
  assertSelectedReleaseInputs(options, release);
}

function selectedReleaseInputHashes(options, release, { allowMissingManaged = false } = {}) {
  const environment = readControlledText(options.envFile, "Active Compose env");
  const installationConfig = readControlledText(release.installationConfigPath, "Active installation config");
  const compose = readControlledText(activeComposePath(options), "Managed active Compose", {
    allowMissing: allowMissingManaged,
  });
  const seccomp = readControlledText(activeSeccompPath(options), "Managed active seccomp", {
    allowMissing: allowMissingManaged,
  });
  return {
    environmentSha256: sha256(environment),
    installationConfigSha256: sha256(installationConfig),
    composeEffectiveSha256: compose === null ? null : sha256(compose),
    seccompSha256: seccomp === null ? null : sha256(seccomp),
  };
}

function assertSelectedReleaseInputs(options, release) {
  const hashes = selectedReleaseInputHashes(options, release);
  if (release.seccompActivePath !== activeSeccompPath(options)
    || hashes.environmentSha256 !== release.environmentSha256
    || hashes.installationConfigSha256 !== release.installationConfigSha256
    || hashes.composeEffectiveSha256 !== release.composeEffectiveSha256
    || hashes.seccompSha256 !== release.seccompSha256) {
    throw new ReleaseError("RELEASE_INPUT_DRIFT", "Compose, seccomp, environment or installation config differs from the selected release.");
  }
}

function safeOptionalRegularFile(file, code, label) {
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw new ReleaseError(code, `${label} could not be opened safely.`, { cause: error });
  }
  try {
    const metadata = fstatSync(descriptor);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== expectedUid
      || (metadata.mode & 0o077) !== 0 || metadata.size > 1024 * 1024) {
      throw new ReleaseError(code, `${label} must be a bounded private owner-controlled file.`);
    }
    const contents = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (lockIdentity(metadata) !== lockIdentity(after)) {
      throw new ReleaseError(code, `${label} changed while it was being read.`);
    }
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

function parseJson(contents, code, label) {
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new ReleaseError(code, `${label} is invalid JSON.`, { cause: error });
  }
}

function readStateSnapshot(options) {
  const contents = safeOptionalRegularFile(options.stateFile, "RELEASE_STATE_UNSAFE", "Release state");
  if (contents === null) return { value: null, hash: null };
  const value = parseJson(contents, "RELEASE_STATE_INVALID", "Release state");
  if (value?.schemaVersion === 2) {
    throw new ReleaseError(
      "RELEASE_STATE_MIGRATION_REQUIRED",
      "Release state V2 lacks Compose/config bytes; archive it and perform the documented controlled V3 bootstrap.",
    );
  }
  if (!validReleaseState(value, options.installationId)) {
    throw new ReleaseError("RELEASE_STATE_INVALID", "Release state failed validation.");
  }
  return { value, hash: sha256(contents) };
}

function transactionPath(options) {
  return `${options.stateFile}.transaction.json`;
}

function validTransaction(value, options) {
  return hasExactKeys(value, [
    "schemaVersion", "installationId", "composeProject", "operation", "phase",
    "environmentBeforeHash", "environmentTargetHash", "stateBeforeHash",
    "current", "target", "nextState", "recoveryState", "createdAt", "updatedAt",
  ])
    && value.schemaVersion === TRANSACTION_SCHEMA_VERSION
    && value.installationId === options.installationId
    && typeof value.composeProject === "string"
    && /^[a-z0-9][a-z0-9_-]{1,127}$/u.test(value.composeProject)
    && (value.operation === "promote" || value.operation === "rollback")
    && TRANSACTION_PHASES.has(value.phase)
    && typeof value.environmentBeforeHash === "string" && /^[0-9a-f]{64}$/u.test(value.environmentBeforeHash)
    && typeof value.environmentTargetHash === "string" && /^[0-9a-f]{64}$/u.test(value.environmentTargetHash)
    && (value.stateBeforeHash === null || (typeof value.stateBeforeHash === "string" && /^[0-9a-f]{64}$/u.test(value.stateBeforeHash)))
    && validReleaseRecord(value.current)
    && validReleaseRecord(value.target)
    && validReleaseState(value.nextState, options.installationId)
    && validReleaseRecord(value.nextState.previous)
    && validReleaseState(value.recoveryState, options.installationId)
    && validReleaseRecord(value.recoveryState.previous)
    && value.environmentBeforeHash === value.current.environmentSha256
    && value.environmentTargetHash === value.target.environmentSha256
    && value.current.installationConfigPath === value.target.installationConfigPath
    && value.nextState.composeProject === value.composeProject
    && releaseRecordsEqual(value.nextState.current, value.target)
    && releaseRecordsEqual(value.nextState.previous, value.current)
    && value.recoveryState.composeProject === value.composeProject
    && releaseRecordsEqual(value.recoveryState.current, value.current)
    && releaseRecordsEqual(value.recoveryState.previous, value.target)
    && isIsoDate(value.createdAt) && isIsoDate(value.updatedAt);
}

function readTransaction(options) {
  const file = transactionPath(options);
  const contents = safeOptionalRegularFile(file, "RELEASE_TRANSACTION_UNSAFE", "Release transaction");
  if (contents === null) return null;
  const value = parseJson(contents, "RELEASE_TRANSACTION_INVALID", "Release transaction");
  if (!validTransaction(value, options)) {
    throw new ReleaseError("RELEASE_TRANSACTION_INVALID", "Release transaction failed validation.");
  }
  return value;
}

function writeTransaction(options, transaction, phase) {
  const updated = { ...transaction, phase, updatedAt: new Date().toISOString() };
  if (!validTransaction(updated, options)) {
    throw new ReleaseError("RELEASE_TRANSACTION_INVALID", "Release transaction failed validation before write.");
  }
  writeAtomic(transactionPath(options), `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

function releaseIdentityMatches(left, right) {
  return Boolean(left && right
    && left.image === right.image
    && left.egressImage === right.egressImage
    && left.revision === right.revision
    && left.environmentSha256 === right.environmentSha256
    && left.composeSha256 === right.composeSha256
    && left.composeEffectiveSha256 === right.composeEffectiveSha256
    && left.seccompSha256 === right.seccompSha256
    && left.installationConfigSha256 === right.installationConfigSha256);
}

function releaseRecordsEqual(left, right) {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

function serializedStateHash(state) {
  return sha256(`${JSON.stringify(state, null, 2)}\n`);
}

function clearTransaction(options) {
  try {
    unlinkDurably(transactionPath(options));
  } catch (error) {
    throw new ReleaseError(
      "RELEASE_COMMITTED_CLEANUP_FAILED",
      "Release environment, runtime and state are coherent, but transaction cleanup failed.",
      { cause: error },
    );
  }
}

function classifyTransactionInputs(options, transaction) {
  const hashes = selectedReleaseInputHashes(options, transaction.current, { allowMissingManaged: true });
  const fields = [
    [hashes.environmentSha256, transaction.current.environmentSha256, transaction.target.environmentSha256],
    [hashes.installationConfigSha256, transaction.current.installationConfigSha256, transaction.target.installationConfigSha256],
    [hashes.composeEffectiveSha256, transaction.current.composeEffectiveSha256, transaction.target.composeEffectiveSha256],
    [hashes.seccompSha256, transaction.current.seccompSha256, transaction.target.seccompSha256],
  ];
  if (fields.some(([actual, current, target]) => actual !== null && actual !== current && actual !== target)) {
    throw new ReleaseError("RELEASE_TRANSACTION_DRIFT", "A versioned release input changed outside the transaction.");
  }
  return {
    current: fields.every(([actual, current]) => actual === current),
    target: fields.every(([actual, , target]) => actual === target),
    currentRecoverable: fields.every(([actual, current, target], index) =>
      actual === current || actual === target || (index >= 2 && actual === null)),
  };
}

function recoverPreviousAfterInterruptedTarget(options, transaction, targetError, commitRollbackState) {
  transaction = writeTransaction(options, transaction, "recovering-previous");
  if (!classifyTransactionInputs(options, transaction).currentRecoverable) {
    throw new ReleaseError("RELEASE_TRANSACTION_DRIFT", "Release inputs cannot be recovered safely.", { cause: targetError });
  }
  selectReleaseInputs(options, transaction.current);
  try {
    deploy(options, transaction.current);
  } catch (rollbackError) {
    throw new ReleaseError(
      "RELEASE_AND_RECOVERY_FAILED",
      "Interrupted target is unhealthy and the previous image could not be recovered automatically.",
      { cause: new AggregateError([targetError, rollbackError]) },
    );
  }
  if (commitRollbackState) {
    writeAtomic(options.stateFile, `${JSON.stringify(transaction.recoveryState, null, 2)}\n`);
    transaction = writeTransaction(options, transaction, "recovery-state-committed");
  }
  clearTransaction(options);
  throw new ReleaseError(
    "RELEASE_INTERRUPTED_RECOVERED",
    "Interrupted target was unhealthy; the previous release was restored and is healthy.",
    { cause: targetError },
  );
}

function recoverPendingTransaction(options, composeProject) {
  let transaction = readTransaction(options);
  if (!transaction) return;
  if (transaction.composeProject !== composeProject) {
    throw new ReleaseError("RELEASE_TRANSACTION_DRIFT", "Pending release transaction belongs to another Compose project.");
  }
  const stateSnapshot = readStateSnapshot(options);
  let inputs = classifyTransactionInputs(options, transaction);
  const stateIsBefore = stateSnapshot.hash === transaction.stateBeforeHash;
  const stateIsTarget = stateSnapshot.hash === serializedStateHash(transaction.nextState);
  const stateIsRecovery = stateSnapshot.hash === serializedStateHash(transaction.recoveryState);

  if (stateIsRecovery) {
    if (!inputs.current && inputs.currentRecoverable) selectReleaseInputs(options, transaction.current);
    if (!classifyTransactionInputs(options, transaction).current) {
      throw new ReleaseError("RELEASE_TRANSACTION_DRIFT", "Recovered release state and versioned inputs disagree.");
    }
    deploy(options, transaction.current);
    clearTransaction(options);
    throw new ReleaseError(
      "RELEASE_INTERRUPTED_RECOVERED",
      "Interrupted rollback state was verified and its previous release is healthy.",
    );
  }

  if (stateIsTarget) {
    if (!inputs.target && inputs.currentRecoverable) selectReleaseInputs(options, transaction.target);
    if (!classifyTransactionInputs(options, transaction).target) {
      throw new ReleaseError("RELEASE_TRANSACTION_DRIFT", "Committed release state and versioned inputs disagree.");
    }
    try {
      deploy(options, transaction.target);
    } catch (error) {
      recoverPreviousAfterInterruptedTarget(options, transaction, error, true);
    }
    transaction = writeTransaction(options, transaction, "state-committed");
    clearTransaction(options);
    return;
  }

  if (!stateIsBefore) {
    throw new ReleaseError("RELEASE_TRANSACTION_DRIFT", "Release state changed during an interrupted transaction.");
  }

  if (transaction.phase === "target-healthy") {
    if (!inputs.target) {
      throw new ReleaseError("RELEASE_TRANSACTION_DRIFT", "Healthy transaction target is not selected in Compose.");
    }
    try {
      deploy(options, transaction.target);
    } catch (error) {
      recoverPreviousAfterInterruptedTarget(options, transaction, error, false);
    }
    writeAtomic(options.stateFile, `${JSON.stringify(transaction.nextState, null, 2)}\n`);
    transaction = writeTransaction(options, transaction, "state-committed");
    clearTransaction(options);
    return;
  }

  if (transaction.phase === "state-committed") {
    throw new ReleaseError("RELEASE_TRANSACTION_DRIFT", "Committed transaction is missing its matching release state.");
  }

  if (transaction.phase === "prepared" && inputs.current) {
    clearTransaction(options);
    return;
  }

  transaction = writeTransaction(options, transaction, "recovering-previous");
  inputs = classifyTransactionInputs(options, transaction);
  if (!inputs.currentRecoverable) {
    throw new ReleaseError("RELEASE_TRANSACTION_DRIFT", "Versioned release inputs cannot be restored safely.");
  }
  if (!inputs.current) selectReleaseInputs(options, transaction.current);
  deploy(options, transaction.current);
  clearTransaction(options);
  throw new ReleaseError(
    "RELEASE_INTERRUPTED_RECOVERED",
    "An interrupted release was recovered to the previous healthy images; retry the requested operation.",
  );
}

function lockIdentity(metadata) {
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(":");
}

function sameFileObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ESRCH") return false;
      if (error.code === "EPERM") return true;
    }
    throw new ReleaseError("RELEASE_LOCK_FAILED", "Release lock owner could not be verified.", { cause: error });
  }
}

function processStartIdentity(pid) {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      const fields = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/u) : [];
      const startTicks = fields[19];
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return startTicks && /^[0-9]+$/u.test(startTicks) && /^[0-9a-f-]{36}$/u.test(bootId)
        ? sha256(`linux:${bootId}:${startTicks}`)
        : null;
    }
    if (process.platform === "darwin") {
      const started = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
      }).trim();
      return started ? sha256(`darwin:${started}`) : null;
    }
    return null;
  } catch (error) {
    if (error && typeof error === "object" && (("code" in error && error.code === "ENOENT")
      || ("status" in error && error.status === 1))) return null;
    throw new ReleaseError("RELEASE_LOCK_FAILED", "Release process start identity could not be read.", { cause: error });
  }
}

function recoverOrRejectLock(options, lockFile) {
  let metadata = lstatSync(lockFile);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.nlink !== 1 && metadata.nlink !== 2)
    || metadata.uid !== expectedUid || (metadata.mode & 0o077) !== 0) {
    throw new ReleaseError("RELEASE_LOCK_UNSAFE", "Existing release lock is not a private owner-controlled file.");
  }
  const value = parseJson(readFileSync(lockFile, "utf8"), "RELEASE_LOCK_INVALID", "Release lock");
  if (!hasExactKeys(value, ["schemaVersion", "installationId", "stateFileHash", "pid", "processStartId", "nonce", "createdAt"])
    || value.schemaVersion !== LOCK_SCHEMA_VERSION
    || value.installationId !== options.installationId
    || value.stateFileHash !== sha256(options.stateFile)
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || typeof value.processStartId !== "string" || !/^[0-9a-f]{64}$/u.test(value.processStartId)
    || typeof value.nonce !== "string" || !/^[0-9a-f-]{36}$/u.test(value.nonce)
    || !isIsoDate(value.createdAt) || Date.parse(value.createdAt) > Date.now() + 60_000) {
    throw new ReleaseError("RELEASE_LOCK_INVALID", "Existing release lock failed identity validation.");
  }
  if (processIsAlive(value.pid)) {
    const actualStartId = processStartIdentity(value.pid);
    if (actualStartId === null || actualStartId === value.processStartId) {
      throw new ReleaseError("RELEASE_LOCKED", "Another live release operation owns the lock.");
    }
  }
  if (metadata.nlink === 2) {
    const pending = `${lockFile}.pending-${value.pid}-${value.nonce}`;
    if (!existsSync(pending) || lockIdentity(lstatSync(pending)) !== lockIdentity(metadata)) {
      throw new ReleaseError("RELEASE_LOCK_UNSAFE", "Dead release lock has an unrecognized hard link.");
    }
    unlinkDurably(pending);
    metadata = lstatSync(lockFile);
  }
  const before = lockIdentity(metadata);
  const confirmed = lstatSync(lockFile);
  if (lockIdentity(confirmed) !== before) {
    throw new ReleaseError("RELEASE_LOCK_CHANGED", "Release lock changed while checking its owner.");
  }
  const orphan = `${lockFile}.orphaned-${value.pid}-${randomUUID()}`;
  renameSync(lockFile, orphan);
  fsyncDirectory(path.dirname(lockFile));
  if (!sameFileObject(lstatSync(orphan), metadata)) {
    throw new ReleaseError("RELEASE_LOCK_CHANGED", "Recovered release lock identity is inconsistent.");
  }
  unlinkDurably(orphan);
}

function acquireReleaseLock(options) {
  const lockFile = `${options.stateFile}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    const nonce = randomUUID();
    const pending = `${lockFile}.pending-${process.pid}-${nonce}`;
    try {
      descriptor = openSync(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      const value = {
        schemaVersion: LOCK_SCHEMA_VERSION,
        installationId: options.installationId,
        stateFileHash: sha256(options.stateFile),
        pid: process.pid,
        processStartId: processStartIdentity(process.pid),
        nonce,
        createdAt: new Date().toISOString(),
      };
      if (value.processStartId === null) {
        throw new ReleaseError("RELEASE_LOCK_FAILED", "Current process start identity is unavailable.");
      }
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      linkSync(pending, lockFile);
      fsyncDirectory(path.dirname(lockFile));
      unlinkDurably(pending);
      return { lockFile, identity: lockIdentity(lstatSync(lockFile)) };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(pending)) unlinkDurably(pending);
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        recoverOrRejectLock(options, lockFile);
        continue;
      }
      if (error instanceof ReleaseError) throw error;
      throw new ReleaseError("RELEASE_LOCK_FAILED", "Release lock could not be created.", { cause: error });
    }
  }
  throw new ReleaseError("RELEASE_LOCK_FAILED", "Release lock could not be acquired after orphan recovery.");
}

function withReleaseLock(options, operation) {
  const owned = acquireReleaseLock(options);
  let result;
  let operationError;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }
  try {
    const current = lstatSync(owned.lockFile);
    if (lockIdentity(current) !== owned.identity) {
      throw new ReleaseError("RELEASE_LOCK_LOST", "Release lock identity changed before cleanup.");
    }
    unlinkDurably(owned.lockFile);
  } catch (cleanupError) {
    if (operationError !== undefined) throw operationError;
    throw new ReleaseError(
      "RELEASE_COMMITTED_LOCK_CLEANUP_FAILED",
      "Release operation committed, but its lock could not be cleaned; durable state remains authoritative.",
      { cause: cleanupError },
    );
  }
  if (operationError !== undefined) throw operationError;
  return result;
}

function executeUnlocked(options) {
  const initialEnvContents = readControlledText(options.envFile, "Active Compose env");
  const initialEnv = parseEnv(initialEnvContents);
  assertNoReleaseSecrets(initialEnv);
  if (initialEnv.get("AIBRAIN_INSTALLATION_ID") !== options.installationId) {
    throw new ReleaseError("RELEASE_INSTALLATION_MISMATCH", "Compose env belongs to another installation.");
  }
  const composeProject = initialEnv.get("AIBRAIN_COMPOSE_PROJECT_NAME");
  if (composeProject !== `aibrain-${options.installationId}`) {
    throw new ReleaseError("RELEASE_PROJECT_MISMATCH", "Compose project must exactly identify the installation.");
  }
  recoverPendingTransaction(options, composeProject);

  const envContents = readControlledText(options.envFile, "Active Compose env");
  const env = parseEnv(envContents);
  assertNoReleaseSecrets(env);
  if (env.get("AIBRAIN_INSTALLATION_ID") !== options.installationId
    || env.get("AIBRAIN_COMPOSE_PROJECT_NAME") !== composeProject) {
    throw new ReleaseError("RELEASE_ENV_DRIFT", "Compose identity changed during release recovery.");
  }
  const currentImage = env.get("AIBRAIN_IMAGE");
  const currentEgressImage = env.get("AIBRAIN_EGRESS_IMAGE");
  const envRevision = env.get("AIBRAIN_REVISION");
  const activeInstallationConfig = env.get("AIBRAIN_INSTALLATION_CONFIG_HOST");
  if (!currentImage || !IMAGE.test(currentImage) || !currentEgressImage || !IMAGE.test(currentEgressImage)
    || !envRevision || !REVISION.test(envRevision)) {
    throw new ReleaseError("RELEASE_IMAGE_MUTABLE", "Current Compose images and revision must be immutable and exact.");
  }
  if (!activeInstallationConfig || !path.isAbsolute(activeInstallationConfig)) {
    throw new ReleaseError("RELEASE_ENV_INVALID", "AIBRAIN_INSTALLATION_CONFIG_HOST must be absolute.");
  }
  const activeConfigCanonical = safeExistingFile(activeInstallationConfig, "active installation config");
  if (activeConfigCanonical !== activeInstallationConfig) {
    throw new ReleaseError("RELEASE_ENV_INVALID", "AIBRAIN_INSTALLATION_CONFIG_HOST must be canonical.");
  }
  const stateSnapshot = readStateSnapshot(options);
  const state = stateSnapshot.value;
  if (state && (state.composeProject !== composeProject
      || state.current.image !== currentImage || state.current.egressImage !== currentEgressImage
      || state.current.revision !== envRevision
      || state.current.installationConfigPath !== activeConfigCanonical)) {
    throw new ReleaseError(
      "RELEASE_STATE_DRIFT",
      "Compose image does not match the current durable release state.",
    );
  }
  if (state) assertSelectedReleaseInputs(options, state.current);
  if (options.command === "promote") assertTargetSourceLabels(options, options);
  const operationDeadline = performance.now() + options.healthTimeoutMs;
  const currentRevision = inspectImage(options, currentImage, envRevision, operationDeadline);
  inspectImage(options, currentEgressImage, currentRevision, operationDeadline);
  let current;
  if (state) {
    current = state.current;
  } else {
    if (options.command === "rollback") {
      throw new ReleaseError("RELEASE_ROLLBACK_UNAVAILABLE", "No versioned previous release is recorded.");
    }
    if (!options.currentComposeFile) {
      throw new ReleaseError("RELEASE_BOOTSTRAP_REQUIRED", "The first promotion requires --current-compose-file.");
    }
    current = releaseRecord({
      installationId: options.installationId,
      stateFile: options.stateFile,
      image: currentImage,
      egressImage: currentEgressImage,
      revision: currentRevision,
      environmentContents: envContents,
      composeFile: options.currentComposeFile,
      installationConfigSource: activeConfigCanonical,
      installationConfigPath: activeConfigCanonical,
    });
    writeActiveRuntimeInputs(options, releaseContents(current));
  }
  verifyCurrentDeployment(options, current, operationDeadline);
  let target;
  if (options.command === "promote") {
    const revision = inspectImage(options, options.image, options.revision, operationDeadline);
    inspectImage(options, options.egressImage, options.revision, operationDeadline);
    const targetEnvContents = readControlledText(options.targetEnvFile, "Target Compose env");
    assertTargetEnvironment(env, parseEnv(targetEnvContents), options);
    target = releaseRecord({
      installationId: options.installationId,
      stateFile: options.stateFile,
      image: options.image,
      egressImage: options.egressImage,
      revision,
      environmentContents: targetEnvContents,
      composeFile: options.composeFile,
      installationConfigSource: options.installationConfig,
      installationConfigPath: current.installationConfigPath,
    });
  } else {
    target = state?.previous;
  }
  if (!target) throw new ReleaseError("RELEASE_ROLLBACK_UNAVAILABLE", "No previous release is recorded.");
  if (options.command === "rollback") {
    // Historical private Arnall images may remain as evidence/recovery inputs;
    // they cannot be selected as a new rollback after the public return.
    assertTargetSourceLabels(options, target);
    inspectImage(options, target.image, target.revision, operationDeadline);
    inspectImage(options, target.egressImage, target.revision, operationDeadline);
  }
  if (releaseIdentityMatches(target, current)) {
    throw new ReleaseError("RELEASE_NO_CHANGE", "Target release is already current.");
  }

  const nextState = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    installationId: options.installationId,
    composeProject,
    updatedAt: new Date().toISOString(),
    current: target,
    previous: current,
  };
  const createdAt = new Date().toISOString();
  const recoveryState = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    installationId: options.installationId,
    composeProject,
    updatedAt: createdAt,
    current,
    previous: target,
  };
  let transaction = writeTransaction(options, {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    installationId: options.installationId,
    composeProject,
    operation: options.command,
    phase: "prepared",
    environmentBeforeHash: current.environmentSha256,
    environmentTargetHash: target.environmentSha256,
    stateBeforeHash: stateSnapshot.hash,
    current,
    target,
    nextState,
    recoveryState,
    createdAt,
    updatedAt: createdAt,
  }, "prepared");
  try {
    selectReleaseInputs(options, target);
    transaction = writeTransaction(options, transaction, "inputs-updated");
    deploy(options, target, operationDeadline);
  } catch (error) {
    classifyTransactionInputs(options, transaction);
    transaction = writeTransaction(options, transaction, "recovering-previous");
    selectReleaseInputs(options, current);
    try {
      deploy(options, current);
    } catch (rollbackError) {
      throw new ReleaseError(
        "RELEASE_AND_RECOVERY_FAILED",
        "Release failed and the previous image could not be recovered automatically.",
        { cause: new AggregateError([error, rollbackError]) },
      );
    }
    clearTransaction(options);
    throw new ReleaseError("RELEASE_RECOVERED", "Release failed; the previous image was restored and is healthy.", { cause: error });
  }
  transaction = writeTransaction(options, transaction, "target-healthy");
  writeAtomic(options.stateFile, `${JSON.stringify(nextState, null, 2)}\n`);
  transaction = writeTransaction(options, transaction, "state-committed");
  clearTransaction(options);
  return nextState;
}

function execute(options) {
  // Reject an ineligible target before recovery, input writes or Docker Compose.
  // Current images may be historical: a public Arnall target must still be able
  // to replace the incorrectly installed private release safely.
  if (options.command === "promote") assertReleaseOwnership(options);
  return withReleaseLock(options, () => executeUnlocked(options));
}

function advisoryLockInvocation(options, argv) {
  const script = realpathSync(fileURLToPath(import.meta.url));
  const lockFile = `${options.stateFile}.advisory`;
  if (existsSync(lockFile)) {
    const metadata = lstatSync(lockFile);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.uid !== expectedUid) {
      throw new ReleaseError("RELEASE_LOCK_UNSAFE", "OS advisory lock path is not an owner-controlled regular file.");
    }
  }
  if (process.platform === "darwin") {
    // Current macOS installations can lack lockf. Keep the same exclusive,
    // nonblocking OS lock rather than bypassing release serialization in QA.
    if (!existsSync("/usr/bin/lockf")) {
      return {
        executable: "/usr/bin/python3",
        args: [path.join(path.dirname(script), "release-advisory-lock.py"), lockFile, process.execPath, script, ...argv],
        conflictStatus: 75,
      };
    }
    return {
      executable: "/usr/bin/lockf",
      args: ["-t", "0", lockFile, process.execPath, script, ...argv],
      conflictStatus: 75,
    };
  }
  if (process.platform === "linux") {
    return {
      executable: "/usr/bin/flock",
      args: ["--exclusive", "--nonblock", "--conflict-exit-code", "73", lockFile, process.execPath, script, ...argv],
      conflictStatus: 73,
    };
  }
  throw new ReleaseError("RELEASE_LOCK_PLATFORM_UNSUPPORTED", "An OS advisory lock helper is required on this host.");
}

function runCli(argv) {
  const options = parseArguments(argv);
  if (options.command === "promote") assertReleaseOwnership(options);
  const advisoryIdentity = sha256(options.stateFile);
  if (process.env.AIBRAIN_RELEASE_ADVISORY_LOCK !== advisoryIdentity) {
    const invocation = advisoryLockInvocation(options, argv);
    try {
      execFileSync(invocation.executable, invocation.args, {
        stdio: "inherit",
        env: { ...process.env, AIBRAIN_RELEASE_ADVISORY_LOCK: advisoryIdentity },
        timeout: Math.min(1_800_000, options.healthTimeoutMs * 2 + options.dockerCommandTimeoutMs * 8),
        killSignal: "SIGKILL",
      });
      return;
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === invocation.conflictStatus) {
        throw new ReleaseError("RELEASE_LOCKED", "Another live release operation owns the OS advisory lock.");
      }
      if (error && typeof error === "object" && "status" in error && Number.isInteger(error.status)) {
        process.exitCode = error.status;
        return;
      }
      throw new ReleaseError("RELEASE_LOCK_HELPER_FAILED", "OS advisory lock helper failed.", { cause: error });
    }
  }
  const result = execute(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export { ReleaseError, RELEASE_OWNERSHIP, assertReleaseOwnership, execute, parseArguments, runCli, validInstallationConnectors };

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof ReleaseError ? error.code : "RELEASE_FAILED";
    const message = error instanceof Error ? error.message : "Release failed.";
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  }
}
