import { loadInstallationConfig } from "../src/config/installation";
import {
  DEFAULT_DOCUMENT_TEMPORARY_GRACE_MS,
  DEFAULT_PUBLICATION_CANDIDATE_RETENTION_MS,
  FileDocumentTemporaryMaintenance,
} from "../src/documents/maintenance";

function hasFlag(name: string) {
  return process.argv.slice(2).includes(name);
}

function positiveDuration(argumentName: string, environmentName: string, fallback: number) {
  const index = process.argv.indexOf(argumentName);
  const argument = index >= 0 ? process.argv[index + 1] : undefined;
  if (index >= 0 && (!argument || argument.startsWith("--"))) {
    throw new Error(`${argumentName} requires a positive integer.`);
  }
  const value = argument ?? process.env[environmentName]?.trim();
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${argumentName}/${environmentName} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${argumentName} is too large.`);
  return parsed;
}

async function main() {
  const apply = hasFlag("--apply");
  if (hasFlag("--dry-run") && apply) throw new Error("Use either --dry-run or --apply, not both.");
  const allowed = new Set(["--apply", "--dry-run", "--grace-ms", "--retention-ms"]);
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowed.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (argument === "--grace-ms" || argument === "--retention-ms") index += 1;
  }

  const installation = await loadInstallationConfig();
  const maintenance = new FileDocumentTemporaryMaintenance({
    dataRoot: installation.paths.dataRoot,
    usersRoot: installation.paths.usersRoot,
    installationId: installation.installationId,
    gracePeriodMs: positiveDuration(
      "--grace-ms",
      "AIBRAIN_DOCUMENT_TEMP_GRACE_MS",
      DEFAULT_DOCUMENT_TEMPORARY_GRACE_MS,
    ),
    publicationCandidateRetentionMs: positiveDuration(
      "--retention-ms",
      "AIBRAIN_PUBLICATION_CANDIDATE_RETENTION_MS",
      DEFAULT_PUBLICATION_CANDIDATE_RETENTION_MS,
    ),
  });
  const report = await maintenance.run({ dryRun: !apply });
  process.stdout.write(`${JSON.stringify({
    operation: "document-temporary-maintenance",
    installationId: installation.installationId,
    ...report,
  })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Document temporary maintenance failed."}\n`);
  process.exitCode = 1;
});
