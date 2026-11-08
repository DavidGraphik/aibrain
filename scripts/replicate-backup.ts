import path from "node:path";
import { loadInstallationConfig } from "../src/config/installation";
import { FileBackupService } from "../src/operations/backup";
import { ResticBackupReplicator } from "../src/operations/backup-replica";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} requires an absolute path.`);
  return path.resolve(value);
}

function environment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  const installation = await loadInstallationConfig();
  const service = new FileBackupService(
    installation.paths.dataRoot,
    installation.paths.backupsRoot,
    installation.paths.publishWriteRoot,
    installation.installationId,
  );
  const replicator = new ResticBackupReplicator({
    installationId: installation.installationId,
    resticBinary: process.env.AIBRAIN_RESTIC_BINARY?.trim() || "/usr/bin/restic",
    repository: environment("AIBRAIN_RESTIC_REPOSITORY"),
    passwordFile: environment("AIBRAIN_RESTIC_PASSWORD_FILE"),
    stateRoot: process.env.AIBRAIN_REPLICA_STATE_ROOT?.trim()
      ? path.resolve(process.env.AIBRAIN_REPLICA_STATE_ROOT)
      : path.join(installation.paths.backupsRoot, "replication"),
    verifySnapshot: (snapshotRoot) => service.verify(snapshotRoot, { writeReceipt: false }),
  });
  const receipt = await replicator.replicate(argument("--snapshot"));
  process.stdout.write(`${JSON.stringify({
    operation: "replicate",
    installationId: receipt.installationId,
    backupId: receipt.backupId,
    sourceFingerprint: receipt.sourceFingerprint,
    repositoryFingerprint: receipt.repositoryFingerprint,
    remoteSnapshotId: receipt.remoteSnapshotId,
    replicatedAt: receipt.replicatedAt,
    verifiedAt: receipt.verifiedAt,
  })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write("BACKUP_REPLICATION_FAILED: Backup replication failed; inspect protected service logs by code.\n");
  process.exitCode = 1;
});
