import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repositoryRoot = process.cwd();
const executable = path.join(repositoryRoot, "node_modules", ".bin", "tsx");
const script = path.join(repositoryRoot, "scripts", "maintain-document-temporaries.ts");
const USER_ID = "00000000-0000-4000-8000-000000000001";
const UPLOAD_ID = "10000000-0000-4000-8000-000000000001";
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-document-maintenance-cli-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const usersRoot = path.join(dataRoot, "users");
  const incomingRoot = path.join(usersRoot, USER_ID, "staging", ".incoming");
  const companyContextRoot = path.join(dataRoot, "company");
  const backupsRoot = path.join(dataRoot, "backups");
  const sourceReadRoot = path.join(root, "source-ro");
  const publishWriteRoot = path.join(root, "publish-rw");
  await Promise.all([
    mkdir(incomingRoot, { recursive: true, mode: 0o700 }),
    mkdir(companyContextRoot, { recursive: true, mode: 0o700 }),
    mkdir(backupsRoot, { recursive: true, mode: 0o700 }),
    mkdir(sourceReadRoot, { recursive: true, mode: 0o700 }),
    mkdir(publishWriteRoot, { recursive: true, mode: 0o700 }),
  ]);
  const temporaryPath = path.join(incomingRoot, `${UPLOAD_ID}.upload`);
  await writeFile(temporaryPath, "abandoned", { mode: 0o600 });
  const stale = new Date(Date.now() - 7 * 60 * 60 * 1_000);
  await utimes(temporaryPath, stale, stale);
  const configPath = path.join(root, "installation.json");
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    installationId: "document-maintenance-cli-qa",
    companyName: "Document Maintenance CLI QA",
    companySlug: "document-maintenance-cli-qa",
    publicUrl: "https://document-maintenance.example.test",
    branding: {
      productName: "Document Maintenance QA",
      logoPath: "/branding/document-maintenance/logo.svg",
      faviconPath: "/branding/document-maintenance/favicon.svg",
      accentColor: "#123abc",
    },
    paths: { dataRoot, companyContextRoot, usersRoot, sourceReadRoot, publishWriteRoot, backupsRoot },
  })}\n`, { mode: 0o600 });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    AIBRAIN_INSTALLATION_CONFIG: configPath,
  };
  return {
    environment,
    temporaryPath,
  };
}

async function exists(target: string) {
  return lstat(target).then(() => true).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("documents:maintain CLI", () => {
  it("defaults to dry-run and requires an explicit apply before deletion", async () => {
    const test = await fixture();
    const dryRun = await execFile(executable, [script], {
      cwd: repositoryRoot,
      env: test.environment,
    });
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      operation: "document-temporary-maintenance",
      installationId: "document-maintenance-cli-qa",
      dryRun: true,
      candidates: 1,
    });
    await expect(exists(test.temporaryPath)).resolves.toBe(true);

    const applied = await execFile(executable, [script, "--apply"], {
      cwd: repositoryRoot,
      env: test.environment,
    });
    expect(JSON.parse(applied.stdout)).toMatchObject({ dryRun: false });
    expect(JSON.parse(applied.stdout).removed).toHaveLength(1);
    await expect(exists(test.temporaryPath)).resolves.toBe(false);
  });

  it("rejects an omitted grace value instead of falling back", async () => {
    const test = await fixture();
    await expect(execFile(executable, [script, "--grace-ms"], {
      cwd: repositoryRoot,
      env: test.environment,
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("--grace-ms requires a positive integer"),
    });
    await expect(readFile(test.temporaryPath, "utf8")).resolves.toBe("abandoned");
  });

  it("rejects an omitted publication retention value instead of changing policy", async () => {
    const test = await fixture();
    await expect(execFile(executable, [script, "--retention-ms"], {
      cwd: repositoryRoot,
      env: test.environment,
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("--retention-ms requires a positive integer"),
    });
    await expect(readFile(test.temporaryPath, "utf8")).resolves.toBe("abandoned");
  });
});
