import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repositoryRoot = process.cwd();
const executable = path.join(repositoryRoot, "node_modules", ".bin", "tsx");
const script = path.join(repositoryRoot, "scripts", "backup.ts");
const replicationScript = path.join(repositoryRoot, "scripts", "replicate-backup.ts");
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-backup-cli-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const backupsRoot = path.join(dataRoot, "backups");
  const companyContextRoot = path.join(dataRoot, "company-context");
  const usersRoot = path.join(dataRoot, "users");
  const sourceReadRoot = path.join(root, "source-ro");
  const publishWriteRoot = path.join(root, "publish-rw");
  await Promise.all([
    mkdir(backupsRoot, { recursive: true, mode: 0o700 }),
    mkdir(companyContextRoot, { recursive: true, mode: 0o700 }),
    mkdir(usersRoot, { recursive: true, mode: 0o700 }),
    mkdir(sourceReadRoot, { recursive: true, mode: 0o700 }),
    mkdir(publishWriteRoot, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(path.join(companyContextRoot, "context.md"), "Company context v1\n", { mode: 0o600 });
  await writeFile(path.join(publishWriteRoot, "published.txt"), "Published document v1\n", { mode: 0o600 });
  const replicaRepository = path.join(root, "fake-restic-repository");
  const replicaPasswordFile = path.join(root, "restic-password");
  const fakeRestic = path.join(root, "fake-restic.mjs");
  await mkdir(replicaRepository, { mode: 0o700 });
  await writeFile(replicaPasswordFile, "synthetic-restic-password\n", { mode: 0o600 });
  await writeFile(fakeRestic, `#!${process.execPath}
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const repository = process.env.RESTIC_REPOSITORY;
if (!repository?.startsWith("local:")) process.exit(70);
const root = repository.slice("local:".length);
await appendFile(path.join(root, "calls.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");
const state = path.join(root, "snapshot.json");
const command = process.argv[2];
if (command === "snapshots") {
  try { process.stdout.write(await readFile(state, "utf8")); }
  catch { process.stdout.write("[]"); }
} else if (command === "backup") {
  const id = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const tags = process.argv.flatMap((value, index, all) => all[index - 1] === "--tag" ? [value] : []);
  await writeFile(state, JSON.stringify([{ id, tags }]));
  process.stdout.write(JSON.stringify({ message_type: "summary", snapshot_id: id }) + "\\n");
} else if (command !== "check") process.exit(64);
`, { mode: 0o700 });
  const configPath = path.join(root, "installation.json");
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    installationId: "backup-cli-qa",
    companyName: "Backup CLI QA",
    companySlug: "backup-cli-qa",
    publicUrl: "https://backup-cli.example.test",
    branding: {
      productName: "Backup CLI Brain",
      logoPath: "/branding/backup-cli-qa/logo.svg",
      faviconPath: "/branding/backup-cli-qa/favicon.svg",
      accentColor: "#123abc",
    },
    paths: { dataRoot, companyContextRoot, usersRoot, sourceReadRoot, publishWriteRoot, backupsRoot },
  })}\n`, { mode: 0o600 });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    AIBRAIN_INSTALLATION_CONFIG: configPath,
    AIBRAIN_RESTIC_BINARY: fakeRestic,
    AIBRAIN_RESTIC_PASSWORD_FILE: replicaPasswordFile,
    AIBRAIN_RESTIC_REPOSITORY: `local:${replicaRepository}`,
    NODE_ENV: "test",
  };
  return {
    root,
    dataRoot,
    publishWriteRoot,
    replicaRepository,
    configPath,
    environment,
  };
}

afterEach(async () => {
  async function makeWritable(directory: string) {
    let entries;
    try {
      await chmod(directory, 0o700);
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
      makeWritable(path.join(directory, entry.name))));
  }
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("backup operational CLI", () => {
  it("creates, verifies and restores a real filesystem snapshot in separate processes", async () => {
    const test = await fixture();
    const created = await execFile(executable, [script, "create"], {
      cwd: repositoryRoot,
      env: test.environment,
    });
    const createReceipt = JSON.parse(created.stdout) as {
      operation: string;
      backupId: string;
      sourceFingerprint: string;
      fileCount: number;
      components: Array<{ component: string; fileCount: number }>;
    };
    expect(createReceipt).toMatchObject({ operation: "create", fileCount: 2 });
    expect(createReceipt.components).toEqual([
      expect.objectContaining({ component: "product-data", fileCount: 1 }),
      expect.objectContaining({ component: "published-documents", fileCount: 1 }),
    ]);
    const snapshotRoot = path.join(test.dataRoot, "backups", "snapshots", createReceipt.backupId);

    const verified = await execFile(executable, [script, "verify", "--snapshot", snapshotRoot], {
      cwd: repositoryRoot,
      env: test.environment,
    });
    expect(JSON.parse(verified.stdout)).toMatchObject({
      operation: "verify",
      verified: true,
      sourceFingerprint: createReceipt.sourceFingerprint,
    });

    const destination = path.join(test.root, "restored");
    const publishDestination = path.join(test.root, "restored-publish");
    const restored = await execFile(executable, [
      script,
      "restore",
      "--snapshot",
      snapshotRoot,
      "--data-destination",
      destination,
      "--publish-destination",
      publishDestination,
    ], { cwd: repositoryRoot, env: test.environment });
    expect(JSON.parse(restored.stdout)).toMatchObject({
      operation: "restore",
      restored: true,
      sourceFingerprint: createReceipt.sourceFingerprint,
    });
    expect(await readFile(path.join(destination, "company-context", "context.md"), "utf8"))
      .toBe("Company context v1\n");
    expect(await readFile(path.join(publishDestination, "published.txt"), "utf8"))
      .toBe("Published document v1\n");
  });

  it("rejects invalid operations and missing absolute arguments with a non-zero exit", async () => {
    const test = await fixture();
    await expect(execFile(executable, [script, "invalid"], {
      cwd: repositoryRoot,
      env: test.environment,
    })).rejects.toMatchObject({ stderr: expect.stringContaining("BACKUP_OPERATION_INVALID") });
    await expect(execFile(executable, [script, "verify"], {
      cwd: repositoryRoot,
      env: test.environment,
    })).rejects.toMatchObject({ stderr: expect.stringContaining("BACKUP_ARGUMENT_INVALID") });
  });

  it("replicates a verified composite snapshot once and replays the durable receipt", async () => {
    const test = await fixture();
    const created = await execFile(executable, [script, "create"], {
      cwd: repositoryRoot,
      env: test.environment,
    });
    const createdReceipt = JSON.parse(created.stdout) as { backupId: string };
    const snapshotRoot = path.join(test.dataRoot, "backups", "snapshots", createdReceipt.backupId);
    const first = await execFile(executable, [replicationScript, "--snapshot", snapshotRoot], {
      cwd: repositoryRoot,
      env: test.environment,
    });
    const firstReceipt = JSON.parse(first.stdout) as { remoteSnapshotId: string; repositoryFingerprint: string };
    expect(firstReceipt).toMatchObject({
      remoteSnapshotId: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      repositoryFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    const replay = await execFile(executable, [replicationScript, "--snapshot", snapshotRoot], {
      cwd: repositoryRoot,
      env: test.environment,
    });
    expect(JSON.parse(replay.stdout)).toEqual(JSON.parse(first.stdout));
    const calls = (await readFile(path.join(test.replicaRepository, "calls.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls.map((arguments_) => arguments_[0])).toEqual(["snapshots", "backup", "snapshots", "check"]);
  });
});
