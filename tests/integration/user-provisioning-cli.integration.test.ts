import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-provision-cli-"));
  roots.push(root);
  const configPath = path.join(root, "installation.json");
  const inputPath = path.join(root, "users.json");
  const dataRoot = path.join(root, "data");
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    installationId: "provision-cli-qa",
    companyName: "Provision CLI QA",
    companySlug: "provision-cli-qa",
    publicUrl: "http://127.0.0.1:3000",
    branding: {
      productName: "Provision CLI Brain",
      logoPath: "/branding/provision-cli/logo.svg",
      faviconPath: "/branding/provision-cli/favicon.svg",
      accentColor: "#315ee7",
    },
    paths: {
      dataRoot,
      companyContextRoot: path.join(dataRoot, "company"),
      usersRoot: path.join(dataRoot, "users"),
      sourceReadRoot: path.join(root, "documents", "source-ro"),
      publishWriteRoot: path.join(root, "documents", "publish-rw"),
      backupsRoot: path.join(dataRoot, "backups"),
    },
  }));
  const users = Array.from({ length: 20 }, (_, index) => ({
    userId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    email: `employee-${index + 1}@example.test`,
    displayName: `Employee ${index + 1}`,
  }));
  await writeFile(inputPath, JSON.stringify(users));
  return { root, configPath, inputPath };
}

async function provision(configPath: string, inputPath: string) {
  return run(path.join(process.cwd(), "node_modules", ".bin", "tsx"), [
    "scripts/provision-users.ts",
    "--input",
    inputPath,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, AIBRAIN_INSTALLATION_CONFIG: configPath, NODE_ENV: "test" },
  });
}

async function manage(configPath: string, action: "disable" | "enable" | "recover", requestId: string) {
  return run(path.join(process.cwd(), "node_modules", ".bin", "tsx"), [
    "scripts/manage-users.ts",
    "--offline",
    "--action",
    action,
    "--user-id",
    "00000000-0000-4000-8000-000000000001",
    "--request-id",
    requestId,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, AIBRAIN_INSTALLATION_CONFIG: configPath, NODE_ENV: "test" },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("users:provision CLI", () => {
  it("provisions twenty users in a real child process and then reports an idempotent replay", async () => {
    const { configPath, inputPath } = await fixture();
    expect(JSON.parse((await provision(configPath, inputPath)).stdout)).toMatchObject({
      requested: 20,
      created: 20,
      unchanged: 0,
    });
    expect(JSON.parse((await provision(configPath, inputPath)).stdout)).toMatchObject({
      requested: 20,
      created: 0,
      unchanged: 20,
    });
  }, 30_000);

  it("rejects a symlinked operator input", async () => {
    const { root, configPath, inputPath } = await fixture();
    const link = path.join(root, "users-link.json");
    await symlink(inputPath, link);
    await expect(provision(configPath, link)).rejects.toMatchObject({ code: 1 });
  });

  it("executes and replays the offline lifecycle CLI without changing its request", async () => {
    const { configPath, inputPath } = await fixture();
    await provision(configPath, inputPath);
    const requestId = "10000000-0000-4000-8000-000000000010";
    expect(JSON.parse((await manage(configPath, "disable", requestId)).stdout)).toMatchObject({
      action: "disable",
      enabled: false,
      replayed: false,
    });
    expect(JSON.parse((await manage(configPath, "disable", requestId)).stdout)).toMatchObject({
      action: "disable",
      enabled: false,
      replayed: true,
    });
  }, 30_000);
});
