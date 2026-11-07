#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

process.umask(0o077);

const INSTALLATION = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const BACKUP_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f-]{36}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PHASES = new Set([
  "prepared",
  "drained",
  "app-stopped",
  "snapshot-created",
  "snapshot-verified",
  "app-restarted",
  "admission-resumed",
]);

class BackupOperationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "BackupOperationError";
    this.code = code;
  }
}

function usage() {
  return "Usage: node scripts/orchestrate-backup.mjs backup|recover --installation-id <slug> --env-file <absolute> --compose-file <absolute> --runtime-env <absolute> --state-file <absolute> --maintenance-url <loopback URL> --origin <https origin> [--docker-bin <absolute>]";
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== "backup" && command !== "recover") throw new BackupOperationError("BACKUP_OPERATION_USAGE", usage());
  if (rest.length % 2 !== 0) throw new BackupOperationError("BACKUP_OPERATION_USAGE", usage());
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) throw new BackupOperationError("BACKUP_OPERATION_USAGE", usage());
    values.set(key, value);
  }
  const allowed = new Set([
    "--installation-id", "--env-file", "--compose-file", "--runtime-env",
    "--state-file", "--maintenance-url", "--origin", "--docker-bin",
    "--drain-timeout-ms", "--docker-timeout-ms", "--health-timeout-ms",
  ]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new BackupOperationError("BACKUP_OPERATION_USAGE", `Unknown option ${key}.`);
  for (const key of ["--installation-id", "--env-file", "--compose-file", "--runtime-env", "--state-file", "--maintenance-url", "--origin"]) {
    if (!values.has(key)) throw new BackupOperationError("BACKUP_OPERATION_USAGE", `Missing ${key}.`);
  }
  const installationId = values.get("--installation-id");
  if (!INSTALLATION.test(installationId)) throw new BackupOperationError("BACKUP_OPERATION_INSTALLATION_INVALID", "Installation ID is invalid.");
  const numeric = (key, fallback, maximum) => {
    const raw = values.get(key) ?? fallback;
    if (!/^[1-9][0-9]*$/u.test(raw) || Number(raw) > maximum) throw new BackupOperationError("BACKUP_OPERATION_TIMEOUT_INVALID", `${key} is invalid.`);
    return Number(raw);
  };
  const maintenanceUrl = new URL(values.get("--maintenance-url"));
  if (maintenanceUrl.protocol !== "http:" || maintenanceUrl.hostname !== "127.0.0.1"
    || !maintenanceUrl.port || maintenanceUrl.pathname !== "/api/operations/maintenance"
    || maintenanceUrl.username || maintenanceUrl.password || maintenanceUrl.search || maintenanceUrl.hash) {
    throw new BackupOperationError("BACKUP_OPERATION_URL_INVALID", "Maintenance URL must be the exact loopback operator endpoint.");
  }
  const origin = new URL(values.get("--origin"));
  if (origin.protocol !== "https:" || origin.origin !== values.get("--origin")
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new BackupOperationError("BACKUP_OPERATION_ORIGIN_INVALID", "Origin must be an exact credential-free HTTPS origin.");
  }
  return {
    command,
    installationId,
    envFile: safeFile(values.get("--env-file"), "Compose env"),
    composeFile: safeFile(values.get("--compose-file"), "Compose"),
    runtimeEnv: safeFile(values.get("--runtime-env"), "runtime env", true),
    stateFile: safeStatePath(values.get("--state-file")),
    maintenanceUrl: maintenanceUrl.href,
    origin: origin.origin,
    dockerBin: safeFile(values.get("--docker-bin") ?? "/usr/bin/docker", "Docker executable", false, 128 * 1024 * 1024),
    drainTimeoutMs: numeric("--drain-timeout-ms", "600000", 600_000),
    dockerTimeoutMs: numeric("--docker-timeout-ms", "120000", 900_000),
    healthTimeoutMs: numeric("--health-timeout-ms", "120000", 900_000),
  };
}

function safeFile(file, label, privateFile = false, maximumBytes = 1024 * 1024) {
  if (!path.isAbsolute(file)) throw new BackupOperationError("BACKUP_OPERATION_PATH_INVALID", `${label} path must be absolute.`);
  const before = lstatSync(file, { throwIfNoEntry: false });
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : before?.uid;
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== expectedUid
    || (before.mode & (privateFile ? 0o077 : 0o022)) !== 0 || before.size > maximumBytes) {
    throw new BackupOperationError("BACKUP_OPERATION_PATH_INVALID", `${label} is not an exclusive owner-controlled file.`);
  }
  const canonical = realpathSync(file);
  const after = lstatSync(canonical);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new BackupOperationError("BACKUP_OPERATION_PATH_INVALID", `${label} identity changed.`);
  return canonical;
}

function safeStatePath(file) {
  if (!path.isAbsolute(file)) throw new BackupOperationError("BACKUP_OPERATION_PATH_INVALID", "State path must be absolute.");
  const parent = realpathSync(path.dirname(file));
  const metadata = lstatSync(parent);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUid || (metadata.mode & 0o022) !== 0) {
    throw new BackupOperationError("BACKUP_OPERATION_PATH_INVALID", "State directory is unsafe.");
  }
  return path.join(parent, path.basename(file));
}

function parseEnv(contents) {
  const values = new Map();
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new BackupOperationError("BACKUP_OPERATION_ENV_INVALID", "Environment file is invalid.");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || values.has(key)) throw new BackupOperationError("BACKUP_OPERATION_ENV_INVALID", "Environment file has an invalid key.");
    values.set(key, value);
  }
  return values;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeAtomic(file, contents) {
  const pending = `${file}.pending-${process.pid}-${randomUUID()}`;
  let committed = false;
  try {
    const descriptor = openSync(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(descriptor, contents, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(pending, file);
    committed = true;
    fsyncDirectory(path.dirname(file));
  } finally {
    if (!committed && existsSync(pending)) unlinkSync(pending);
  }
}

function unlinkDurably(file) {
  if (!existsSync(file)) return;
  unlinkSync(file);
  fsyncDirectory(path.dirname(file));
}

function validJournal(value, options) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [
      "backupId", "createdAt", "installationId", "phase", "schemaVersion",
      "sourceFingerprint", "updatedAt",
    ].sort().join("\0")
    && value.schemaVersion === 1 && value.installationId === options.installationId
    && PHASES.has(value.phase)
    && (value.backupId === null || BACKUP_ID.test(value.backupId))
    && (value.sourceFingerprint === null || SHA256.test(value.sourceFingerprint))
    && Number.isFinite(Date.parse(value.createdAt)) && Number.isFinite(Date.parse(value.updatedAt));
}

function readJournal(options) {
  if (!existsSync(options.stateFile)) return null;
  safeFile(options.stateFile, "backup operation state", true);
  let value;
  try { value = JSON.parse(readFileSync(options.stateFile, "utf8")); } catch (error) {
    throw new BackupOperationError("BACKUP_OPERATION_STATE_INVALID", "Backup operation state is invalid.", { cause: error });
  }
  if (!validJournal(value, options)) throw new BackupOperationError("BACKUP_OPERATION_STATE_INVALID", "Backup operation state failed validation.");
  return value;
}

function writeJournal(options, journal, phase, patch = {}) {
  const updated = { ...journal, ...patch, phase, updatedAt: new Date().toISOString() };
  if (!validJournal(updated, options)) throw new BackupOperationError("BACKUP_OPERATION_STATE_INVALID", "Backup operation state failed validation before write.");
  writeAtomic(options.stateFile, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

function runDocker(options, args) {
  try {
    return execFileSync(options.dockerBin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
      timeout: options.dockerTimeoutMs,
      killSignal: "SIGKILL",
    }).trim();
  } catch (error) {
    throw new BackupOperationError("BACKUP_OPERATION_DOCKER_FAILED", "A bounded Docker backup operation failed.", { cause: error });
  }
}

function composeArgs(options, ...args) {
  return ["compose", "--env-file", options.envFile, "-f", options.composeFile, ...args];
}

function parseBackupOutput(output, operation) {
  let value;
  // The production entrypoint runs protocol acceptance before the requested
  // command. Keep that check enabled and admit only its exact success banner.
  const lines = output.split(/\r?\n/u);
  if (lines[0]?.startsWith('{"privateFilesystemAcceptance":')) {
    let acceptance;
    try { acceptance = JSON.parse(lines.shift()); } catch { /* strict validation below */ }
    const expected = ["privateFilesystemAcceptance", "syntheticFixturesOnly", "privateReadsDenied",
      "symlinkAliasDenied", "helperReadsAllowed", "exactWorkspaceWriteAllowed"];
    if (!acceptance || Object.keys(acceptance).length !== expected.length
      || !expected.every((key) => acceptance[key] === true)) {
      throw new BackupOperationError("BACKUP_OPERATION_OUTPUT_INVALID", "Filesystem acceptance output is invalid.");
    }
  }
  if (lines[0] === "Codex App Server container acceptance passed.") lines.shift();
  const json = lines.join("\n");
  try { value = JSON.parse(json); } catch (error) {
    throw new BackupOperationError("BACKUP_OPERATION_OUTPUT_INVALID", `Backup ${operation} returned invalid output.`, { cause: error });
  }
  if (value?.operation !== operation || !BACKUP_ID.test(value.backupId)
    || !SHA256.test(value.sourceFingerprint) || (operation === "verify" && value.verified !== true)) {
    throw new BackupOperationError("BACKUP_OPERATION_OUTPUT_INVALID", `Backup ${operation} output failed validation.`);
  }
  return value;
}

function createSnapshot(options) {
  return parseBackupOutput(runDocker(options, composeArgs(
    options, "run", "--rm", "--no-deps", "app", "aibrain-backup", "create",
  )), "create");
}

function verifySnapshot(options, backupId, expectedFingerprint = null) {
  const value = parseBackupOutput(runDocker(options, composeArgs(
    options, "run", "--rm", "--no-deps", "app", "aibrain-backup", "verify",
    "--snapshot", `/var/lib/aibrain/data/backups/snapshots/${backupId}`,
  )), "verify");
  if (value.backupId !== backupId || (expectedFingerprint && value.sourceFingerprint !== expectedFingerprint)) {
    throw new BackupOperationError("BACKUP_OPERATION_VERIFY_MISMATCH", "Verified snapshot identity does not match the created snapshot.");
  }
  return value;
}

function startAndWaitForApp(options) {
  runDocker(options, composeArgs(options, "up", "-d", "--no-deps", "app", "alert-dispatcher"));
  const deadline = performance.now() + options.healthTimeoutMs;
  const containerId = runDocker(options, composeArgs(options, "ps", "-q", "app"));
  if (!/^[a-f0-9]{12,64}$/u.test(containerId)) throw new BackupOperationError("BACKUP_OPERATION_APP_INVALID", "Compose did not return the app container.");
  while (performance.now() <= deadline) {
    const health = runDocker(options, ["inspect", "--format", "{{.State.Health.Status}}", containerId]);
    if (health === "healthy") return;
    if (health === "unhealthy") break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(500, Math.max(1, deadline - performance.now())));
  }
  throw new BackupOperationError("BACKUP_OPERATION_APP_UNHEALTHY", "App did not become healthy within the recovery deadline.");
}

async function maintenance(options, secret, action) {
  let response;
  try {
    response = await fetch(options.maintenanceUrl, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${secret}`,
        Origin: options.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(action === "drain" ? { action, timeoutMs: options.drainTimeoutMs } : { action }),
      signal: AbortSignal.timeout(options.drainTimeoutMs + 5_000),
    });
  } catch (error) {
    throw new BackupOperationError("BACKUP_OPERATION_MAINTENANCE_UNAVAILABLE", "Maintenance endpoint is unavailable.", { cause: error });
  }
  const text = await response.text();
  if (text.length > 64 * 1024) throw new BackupOperationError("BACKUP_OPERATION_MAINTENANCE_INVALID", "Maintenance response is too large.");
  let value;
  try { value = JSON.parse(text); } catch (error) {
    throw new BackupOperationError("BACKUP_OPERATION_MAINTENANCE_INVALID", "Maintenance response is invalid.", { cause: error });
  }
  const expected = action === "drain" ? "maintenance" : "accepting";
  if (!response.ok || value?.phase !== expected || value?.activeActivities !== 0) {
    throw new BackupOperationError("BACKUP_OPERATION_MAINTENANCE_FAILED", `Maintenance did not reach ${expected}.`);
  }
}

function writeReceipt(options, journal, status) {
  const completedAt = new Date().toISOString();
  const receipt = {
    schemaVersion: 1,
    installationId: options.installationId,
    status,
    backupId: journal.backupId,
    sourceFingerprint: journal.sourceFingerprint,
    createdAt: journal.createdAt,
    completedAt,
  };
  const suffix = journal.backupId ?? journal.createdAt.replace(/[^0-9]/gu, "");
  const receiptPath = `${options.stateFile}.receipt-${suffix}.json`;
  if (existsSync(receiptPath)) {
    safeFile(receiptPath, "backup operation receipt", true);
    const existing = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (existing.installationId !== receipt.installationId || existing.status !== status
      || existing.backupId !== receipt.backupId || existing.sourceFingerprint !== receipt.sourceFingerprint) {
      throw new BackupOperationError("BACKUP_OPERATION_RECEIPT_CONFLICT", "Backup operation receipt conflicts with recovered state.");
    }
    return existing;
  }
  writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

async function recover(options, secret, journal, interrupted) {
  let recovered = journal;
  let status = "aborted";
  if (journal.backupId && ["snapshot-created", "snapshot-verified", "app-restarted", "admission-resumed"].includes(journal.phase)) {
    const verified = verifySnapshot(options, journal.backupId, journal.sourceFingerprint);
    recovered = writeJournal(options, recovered, "snapshot-verified", {
      backupId: verified.backupId,
      sourceFingerprint: verified.sourceFingerprint,
    });
    status = "verified";
  }
  startAndWaitForApp(options);
  recovered = writeJournal(options, recovered, "app-restarted");
  await maintenance(options, secret, "resume");
  recovered = writeJournal(options, recovered, "admission-resumed");
  const receipt = writeReceipt(options, recovered, status);
  unlinkDurably(options.stateFile);
  if (interrupted) throw new BackupOperationError(
    "BACKUP_OPERATION_INTERRUPTED_RECOVERED",
    status === "verified"
      ? "Interrupted backup was verified and service recovery completed; rerun deliberately for a fresh backup."
      : "Interrupted backup was aborted and service recovery completed; rerun deliberately.",
  );
  return receipt;
}

async function execute(options) {
  const composeEnv = parseEnv(readFileSync(options.envFile, "utf8"));
  if (composeEnv.get("AIBRAIN_INSTALLATION_ID") !== options.installationId
    || composeEnv.get("AIBRAIN_COMPOSE_PROJECT_NAME") !== `aibrain-${options.installationId}`) {
    throw new BackupOperationError("BACKUP_OPERATION_ENV_INVALID", "Compose env belongs to another installation.");
  }
  const runtime = parseEnv(readFileSync(options.runtimeEnv, "utf8"));
  const secret = runtime.get("AIBRAIN_MAINTENANCE_SECRET") ?? "";
  if (secret.length < 32 || secret.length > 512 || /\s/u.test(secret)) {
    throw new BackupOperationError("BACKUP_OPERATION_SECRET_INVALID", "Maintenance secret is invalid.");
  }
  const pending = readJournal(options);
  if (pending) return recover(options, secret, pending, options.command === "backup");
  if (options.command === "recover") {
    return { schemaVersion: 1, installationId: options.installationId, status: "no-pending-operation" };
  }
  const now = new Date().toISOString();
  let journal = writeJournal(options, {
    schemaVersion: 1,
    installationId: options.installationId,
    phase: "prepared",
    backupId: null,
    sourceFingerprint: null,
    createdAt: now,
    updatedAt: now,
  }, "prepared");
  try {
    await maintenance(options, secret, "drain");
    journal = writeJournal(options, journal, "drained");
    runDocker(options, composeArgs(options, "stop", "app"));
    journal = writeJournal(options, journal, "app-stopped");
    const created = createSnapshot(options);
    journal = writeJournal(options, journal, "snapshot-created", {
      backupId: created.backupId,
      sourceFingerprint: created.sourceFingerprint,
    });
    const verified = verifySnapshot(options, created.backupId, created.sourceFingerprint);
    journal = writeJournal(options, journal, "snapshot-verified");
    startAndWaitForApp(options);
    journal = writeJournal(options, journal, "app-restarted");
    await maintenance(options, secret, "resume");
    journal = writeJournal(options, journal, "admission-resumed");
    const receipt = writeReceipt(options, journal, "verified");
    unlinkDurably(options.stateFile);
    return { ...receipt, sourceFingerprint: verified.sourceFingerprint };
  } catch (error) {
    try {
      await recover(options, secret, readJournal(options) ?? journal, false);
    } catch (recoveryError) {
      throw new BackupOperationError("BACKUP_OPERATION_AND_RECOVERY_FAILED", "Backup and service recovery both failed; keep the journal and recover before retrying.", {
        cause: new AggregateError([error, recoveryError]),
      });
    }
    throw new BackupOperationError("BACKUP_OPERATION_RECOVERED", "Backup failed; app and admission were restored without claiming an unverified backup.", { cause: error });
  }
}

function advisoryInvocation(options, argv) {
  const lockFile = `${options.stateFile}.advisory`;
  if (existsSync(lockFile)) safeFile(lockFile, "backup advisory lock", true);
  const script = realpathSync(fileURLToPath(import.meta.url));
  if (process.platform === "darwin") {
    if (!existsSync("/usr/bin/lockf")) return { executable: "/usr/bin/python3",
      args: [path.join(path.dirname(script), "release-advisory-lock.py"), lockFile, process.execPath, script, ...argv], conflict: 75 };
    return { executable: "/usr/bin/lockf", args: ["-t", "0", lockFile, process.execPath, script, ...argv], conflict: 75 };
  }
  if (process.platform === "linux") return { executable: "/usr/bin/flock", args: ["--exclusive", "--nonblock", "--conflict-exit-code", "73", lockFile, process.execPath, script, ...argv], conflict: 73 };
  throw new BackupOperationError("BACKUP_OPERATION_LOCK_UNAVAILABLE", "OS advisory locking is required.");
}

async function runCli(argv) {
  const options = parseArguments(argv);
  const identity = sha256(options.stateFile);
  if (process.env.AIBRAIN_BACKUP_OPERATION_LOCK !== identity) {
    const invocation = advisoryInvocation(options, argv);
    try {
      execFileSync(invocation.executable, invocation.args, {
        stdio: "inherit",
        env: { ...process.env, AIBRAIN_BACKUP_OPERATION_LOCK: identity },
        timeout: 1_800_000,
        killSignal: "SIGKILL",
      });
      return;
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === invocation.conflict) {
        throw new BackupOperationError("BACKUP_OPERATION_LOCKED", "Another backup operation owns the installation lock.");
      }
      if (error && typeof error === "object" && "status" in error && Number.isInteger(error.status)) {
        process.exitCode = error.status;
        return;
      }
      throw new BackupOperationError("BACKUP_OPERATION_LOCK_FAILED", "Backup advisory lock failed.", { cause: error });
    }
  }
  const result = await execute(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export { BackupOperationError, execute, parseArguments, runCli };

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).catch((error) => {
    const code = error instanceof BackupOperationError ? error.code : "BACKUP_OPERATION_FAILED";
    const message = error instanceof Error ? error.message : "Backup operation failed.";
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  });
}
