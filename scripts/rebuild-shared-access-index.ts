import path from "node:path";
import { loadInstallationConfig } from "../src/config/installation";
import { SharedAccessIndexMigration } from "../src/workbench/shared-access-migration";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  throw new Error(
    "Usage: npm run workbench:rebuild-shared-access -- --offline --operator-id <uuid> [--dry-run|--apply]",
  );
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (!process.argv.includes("--offline")) usage();
  if (process.argv.includes("--dry-run") && apply) throw new Error("Use either --dry-run or --apply, not both.");
  const allowed = new Set(["--offline", "--operator-id", "--dry-run", "--apply"]);
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (!allowed.has(args[index])) throw new Error(`Unknown argument: ${args[index]}`);
    if (args[index] === "--operator-id") index += 1;
  }
  const operatorUserId = argument("--operator-id");
  if (!operatorUserId) usage();
  const installation = await loadInstallationConfig();
  const report = await new SharedAccessIndexMigration(installation).run({
    operatorUserId,
    dryRun: !apply,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${path.basename(process.argv[1] ?? "rebuild-shared-access-index")}: ${error instanceof Error ? error.message : "Shared access migration failed."}\n`);
  process.exitCode = 1;
});
