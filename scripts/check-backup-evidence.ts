import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { loadInstallationConfig } from "../src/config/installation";
import { backupManifestSchema, FileBackupService } from "../src/operations/backup";
import { readLatestBackupReplicaReceipt } from "../src/operations/backup-replica";

const MAXIMUM_AGE_MS = 26 * 60 * 60 * 1_000;
const MAXIMUM_RESTORE_MARKER_BYTES = 2 * 1024 * 1024;

function arguments_() {
  const values = process.argv.slice(2);
  if (values.length === 0) return { dataRoot: null, publishRoot: null };
  if (values.length !== 4) throw new Error("Expected both restore evidence roots or no arguments.");
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]!;
    const value = values[index + 1]!;
    if (!["--restore-data-root", "--restore-publish-root"].includes(name)
      || parsed.has(name) || !path.isAbsolute(value)) {
      throw new Error("Restore evidence arguments are invalid.");
    }
    parsed.set(name, path.resolve(value));
  }
  const dataRoot = parsed.get("--restore-data-root") ?? null;
  const publishRoot = parsed.get("--restore-publish-root") ?? null;
  if (!dataRoot || !publishRoot) throw new Error("Restore evidence requires both data and publish roots.");
  return { dataRoot, publishRoot };
}

function isCurrent(isoDate: string, now: number) {
  const age = now - Date.parse(isoDate);
  return Number.isFinite(age) && age >= 0 && age <= MAXIMUM_AGE_MS;
}

async function restoreEvidence(
  installationId: string,
  dataRoot: string | null,
  publishRoot: string | null,
  expected: { backupId: string; sourceFingerprint: string } | null,
) {
  if (!dataRoot && !publishRoot) return { status: "not-checked" as const, contentVerified: false };
  if (!dataRoot || !publishRoot) throw new Error("Restore evidence requires both data and publish roots.");
  const [data, publish] = await Promise.all([lstat(dataRoot), lstat(publishRoot)]);
  if (!data.isDirectory() || data.isSymbolicLink() || !publish.isDirectory() || publish.isSymbolicLink()) {
    throw new Error("Restore evidence roots must be real directories.");
  }
  const markerPath = path.join(dataRoot, ".aibrain-restore.json");
  const marker = await lstat(markerPath);
  if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1
    || marker.size < 2 || marker.size > MAXIMUM_RESTORE_MARKER_BYTES) {
    throw new Error("Restore evidence marker is unsafe or exceeds the read bound.");
  }
  const manifest = backupManifestSchema.parse(JSON.parse(await readFile(markerPath, "utf8")), markerPath);
  const matches = manifest.installationId === installationId
    && expected !== null
    && manifest.backupId === expected.backupId
    && manifest.sourceFingerprint === expected.sourceFingerprint;
  return {
    status: matches ? "receipt-present" as const : "mismatch" as const,
    backupId: manifest.backupId,
    sourceFingerprint: manifest.sourceFingerprint,
    contentVerified: false,
  };
}

async function main() {
  const installation = await loadInstallationConfig();
  const now = Date.now();
  const restoreRoots = arguments_();
  const backupService = new FileBackupService(
    installation.paths.dataRoot,
    installation.paths.backupsRoot,
    installation.paths.publishWriteRoot,
    installation.installationId,
  );
  const backup = await backupService.readVerificationReceipt();
  const replicaStateRoot = process.env.AIBRAIN_REPLICA_STATE_ROOT?.trim();
  const replica = replicaStateRoot
    ? await readLatestBackupReplicaReceipt(path.resolve(replicaStateRoot), installation.installationId)
    : null;
  const backupCurrent = backup !== null
    && isCurrent(backup.backupCreatedAt, now)
    && isCurrent(backup.verifiedAt, now);
  const replicaMatches = backup !== null && replica !== null
    && replica.backupId === backup.backupId
    && replica.sourceFingerprint === backup.sourceFingerprint;
  const replicaCurrent = replicaMatches
    && isCurrent(replica.replicatedAt, now)
    && isCurrent(replica.verifiedAt, now);
  const restore = await restoreEvidence(
    installation.installationId,
    restoreRoots.dataRoot,
    restoreRoots.publishRoot,
    backup,
  );
  const result = {
    operation: "backup-evidence",
    checkedAt: new Date(now).toISOString(),
    status: backupCurrent && replicaCurrent ? "current" : "attention",
    backup: backup === null ? { status: "missing" } : {
      status: backupCurrent ? "verified" : "stale",
      backupId: backup.backupId,
      sourceFingerprint: backup.sourceFingerprint,
      backupCreatedAt: backup.backupCreatedAt,
      verifiedAt: backup.verifiedAt,
    },
    replica: replica === null ? { status: "missing" } : {
      status: !replicaMatches ? "mismatch" : replicaCurrent ? "verified" : "stale",
      backupId: replica.backupId,
      sourceFingerprint: replica.sourceFingerprint,
      remoteSnapshotId: replica.remoteSnapshotId,
      replicatedAt: replica.replicatedAt,
      verifiedAt: replica.verifiedAt,
    },
    restore,
    restoreAcceptance: "not-proven",
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "current" || restore.status === "mismatch") process.exitCode = 2;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Backup evidence check failed."}\n`);
  process.exitCode = 1;
});
