import { lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { InstallationConfig } from "../src/config/installation-schema";
import { loadInstallationConfig } from "../src/config/installation";
import { UserProvisioner } from "../src/users";

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error
    && (error as NodeJS.ErrnoException).code === code);
}

export async function versionedCompanyContextSeedRoot(
  installation: Readonly<InstallationConfig>,
  repositoryRoot = process.cwd(),
): Promise<string | undefined> {
  const candidate = path.resolve(repositoryRoot, "config", "company-context", installation.companySlug);
  try {
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Versioned company-context seed must be a real directory.");
    }
    return candidate;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function main(): Promise<void> {
  const installation = await loadInstallationConfig();
  const companyContextSeedRoot = await versionedCompanyContextSeedRoot(installation);
  const provisioner = new UserProvisioner(installation, { companyContextSeedRoot });
  await provisioner.ensureInstallationPolicy();
  process.stdout.write(`${JSON.stringify({
    installationId: installation.installationId,
    versionedSeed: Boolean(companyContextSeedRoot),
    existingFilesPreserved: true,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Company-context seed failed.";
    process.stderr.write(`${path.basename(process.argv[1] ?? "seed-company-context")}: ${message}\n`);
    process.exitCode = 1;
  });
}
