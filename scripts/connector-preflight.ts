import { basename } from "node:path";
import {
  runCodexManagedAppPreflight,
  unavailableCodexManagedAppPreflight,
} from "../src/connectors/preflight";
import { codexManagedAppPreflightRuntimeDependencies } from "../src/connectors/preflight-runtime";

function userIdFromArguments() {
  const position = process.argv.indexOf("--user-id");
  const value = position >= 0 ? process.argv[position + 1] : undefined;
  if (!value || position + 2 !== process.argv.length) {
    throw new Error("Usage: npm run connectors:preflight -- --user-id <local-user-id>");
  }
  return value;
}

async function main() {
  const report = await runCodexManagedAppPreflight(userIdFromArguments(), codexManagedAppPreflightRuntimeDependencies());
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ready) process.exitCode = 1;
}

void main().catch(() => {
  // Do not expose filesystem, configuration, or provider details to an
  // operator-facing artifact. The status code is sufficient for escalation.
  process.stdout.write(`${JSON.stringify(unavailableCodexManagedAppPreflight())}\n`);
  process.stderr.write(`${basename(process.argv[1] ?? "connector-preflight")}: preflight unavailable\n`);
  process.exitCode = 2;
});
