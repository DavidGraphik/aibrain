import path from "node:path";
import { loadInstallationConfig } from "../src/config/installation";
import { FileBackupService } from "../src/operations/backup";

class BackupCliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BackupCliError";
  }
}

function argument(name: string, required = true) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && (!value || !path.isAbsolute(value))) {
    throw new BackupCliError("BACKUP_ARGUMENT_INVALID", `${name} requires an absolute path.`);
  }
  return value ? path.resolve(value) : null;
}

async function main() {
  const operation = process.argv[2];
  if (operation !== "create" && operation !== "verify" && operation !== "restore") {
    throw new BackupCliError("BACKUP_OPERATION_INVALID", "Expected create, verify or restore operation.");
  }
  const installation = await loadInstallationConfig();
  const service = new FileBackupService(
    installation.paths.dataRoot,
    installation.paths.backupsRoot,
    installation.paths.publishWriteRoot,
    installation.installationId,
  );
  if (operation === "create") {
    const result = await service.create();
    process.stdout.write(JSON.stringify({
      operation,
      backupId: result.manifest.backupId,
      sourceFingerprint: result.manifest.sourceFingerprint,
      fileCount: result.manifest.files.length,
      components: result.manifest.components,
    }) + "\n");
    return;
  }
  if (operation === "verify") {
    const snapshot = argument("--snapshot")!;
    const result = await service.verify(snapshot);
    process.stdout.write(JSON.stringify({
      operation,
      backupId: result.backupId,
      sourceFingerprint: result.sourceFingerprint,
      fileCount: result.files.length,
      components: result.components,
      verified: true,
    }) + "\n");
    return;
  }
  if (operation === "restore") {
    const snapshot = argument("--snapshot")!;
    const dataDestination = argument("--data-destination")!;
    const publishDestination = argument("--publish-destination")!;
    const result = await service.restore(snapshot, {
      dataRoot: dataDestination,
      publishWriteRoot: publishDestination,
    });
    process.stdout.write(JSON.stringify({
      operation,
      backupId: result.manifest.backupId,
      sourceFingerprint: result.manifest.sourceFingerprint,
      fileCount: result.manifest.files.length,
      components: result.manifest.components,
      restored: true,
    }) + "\n");
    return;
  }
}

void main().catch((error: unknown) => {
  const code = error instanceof BackupCliError ? error.code : "BACKUP_COMMAND_FAILED";
  const message = error instanceof BackupCliError ? error.message : "Backup command failed; inspect protected service logs by code.";
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
});
