import path from "node:path";
import { loadInstallationConfig } from "../src/config/installation";
import {
  UserLifecycleService,
  userLifecycleCommandSchema,
} from "../src/users";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  throw new Error(
    "Usage: npm run users:manage -- --offline --action disable|enable|recover --user-id <uuid> --request-id <uuid>",
  );
}

async function main() {
  if (!process.argv.includes("--offline")) usage();
  const action = argument("--action");
  const userId = argument("--user-id");
  const requestId = argument("--request-id");
  if (!action || !userId || !requestId) usage();
  const config = await loadInstallationConfig();
  const command = userLifecycleCommandSchema.parse({
    schemaVersion: 1,
    action,
    userId,
    requestId,
  }, "users:manage arguments");
  const result = await new UserLifecycleService(config).execute(command);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "User lifecycle operation failed.";
  process.stderr.write(`${path.basename(process.argv[1] ?? "manage-users")}: ${message}\n`);
  process.exitCode = 1;
});
