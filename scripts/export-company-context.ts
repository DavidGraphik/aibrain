import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadInstallationConfig } from "../src/config/installation";
import { companyContextFiles } from "../src/users/provisioner";
import { versionedCompanyContextSeedRoot } from "./seed-company-context";

async function main() {
  const output = process.argv[2];
  if (!output || !path.isAbsolute(output) || process.argv.length !== 3) {
    throw new Error("Usage: company-context:export /absolute/new-private-output-directory");
  }
  const config = await loadInstallationConfig();
  const files = await companyContextFiles(config, await versionedCompanyContextSeedRoot(config));
  // Refuse an existing bundle: no silent replacement of reviewed content.
  await mkdir(output, { mode: 0o700 });
  for (const [relativePath, content] of files) {
    const target = path.join(output, relativePath);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { flag: "wx", mode: 0o600 });
  }
  process.stdout.write(JSON.stringify({ installationId: config.installationId, documents: files.size }) + "\n");
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Context export failed"}\n`);
  process.exitCode = 1;
});
