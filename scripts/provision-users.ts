import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { loadInstallationConfig } from "../src/config/installation";
import { UserProvisioner, type UserProvisioningInput } from "../src/users";
import { versionedCompanyContextSeedRoot } from "./seed-company-context";

function usage(): never {
  throw new Error(
    "Usage: npm run users:provision -- --input /absolute/path/to/users.json",
  );
}

function inputPath() {
  const index = process.argv.indexOf("--input");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !path.isAbsolute(value)) usage();
  return path.resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseInputs(value: unknown): UserProvisioningInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Provisioning input must be a non-empty JSON array.");
  }
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`users[${index}] must be an object.`);
    const allowed = new Set([
      "userId",
      "email",
      "displayName",
      "enabled",
      "requireInitialPasswordChange",
    ]);
    const unknown = Object.keys(candidate).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new Error(`users[${index}] contains unknown fields: ${unknown.sort().join(", ")}.`);
    }
    if (
      typeof candidate.userId !== "string"
      || typeof candidate.email !== "string"
      || typeof candidate.displayName !== "string"
      || (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean")
      || (candidate.requireInitialPasswordChange !== undefined
        && typeof candidate.requireInitialPasswordChange !== "boolean")
    ) {
      throw new Error(`users[${index}] does not satisfy the provisioning contract.`);
    }
    return {
      userId: candidate.userId,
      email: candidate.email,
      displayName: candidate.displayName,
      enabled: candidate.enabled,
      requireInitialPasswordChange: candidate.requireInitialPasswordChange,
    };
  });
}

async function main() {
  const filePath = inputPath();
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
    throw new Error("Provisioning input must be a regular JSON file no larger than 1 MiB.");
  }
  const input: unknown = JSON.parse(await readFile(filePath, "utf8"));
  const users = parseInputs(input);
  if (new Set(users.map(({ userId }) => userId)).size !== users.length) {
    throw new Error("Provisioning input repeats a userId.");
  }
  const installation = await loadInstallationConfig();
  const companyContextSeedRoot = await versionedCompanyContextSeedRoot(installation);
  const provisioner = new UserProvisioner(installation, { companyContextSeedRoot });
  let created = 0;
  for (const user of users) {
    const result = await provisioner.provision(user);
    if (result.created) created += 1;
  }
  process.stdout.write(JSON.stringify({
    installationId: installation.installationId,
    requested: users.length,
    created,
    unchanged: users.length - created,
  }) + "\n");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "User provisioning failed.";
  process.stderr.write(`${path.basename(process.argv[1] ?? "provision-users")}: ${message}\n`);
  process.exitCode = 1;
});
