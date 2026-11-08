import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const executable = path.resolve("node_modules/.bin/tsx");
const script = path.resolve("scripts/check-backup-evidence.ts");
const roots: string[] = [];
const backupId = "20260831T010000Z-11111111-1111-4111-8111-111111111111";
const emptyFingerprint = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function fixture(withEvidence: boolean) {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-backup-evidence-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const backupsRoot = path.join(dataRoot, "backups");
  const publishWriteRoot = path.join(root, "publish");
  const companyContextRoot = path.join(dataRoot, "company");
  const usersRoot = path.join(dataRoot, "users");
  const sourceReadRoot = path.join(root, "source");
  const replicaRoot = path.join(root, "replication");
  const restoreDataRoot = path.join(root, "restore-data");
  const restorePublishRoot = path.join(root, "restore-publish");
  await Promise.all([
    mkdir(path.join(backupsRoot, "snapshots", backupId), { recursive: true, mode: 0o700 }),
    mkdir(path.join(backupsRoot, "verification"), { recursive: true, mode: 0o700 }),
    mkdir(companyContextRoot, { recursive: true, mode: 0o700 }),
    mkdir(usersRoot, { recursive: true, mode: 0o700 }),
    mkdir(sourceReadRoot, { recursive: true, mode: 0o700 }),
    mkdir(publishWriteRoot, { recursive: true, mode: 0o700 }),
    mkdir(path.join(replicaRoot, "receipts"), { recursive: true, mode: 0o700 }),
    mkdir(restoreDataRoot, { mode: 0o700 }),
    mkdir(restorePublishRoot, { mode: 0o700 }),
  ]);
  const now = new Date().toISOString();
  const manifest = {
    schemaVersion: 2,
    backupId,
    installationId: "evidence-qa",
    createdAt: now,
    sourceFingerprint: emptyFingerprint,
    components: [
      { component: "product-data", fileCount: 0, size: 0, sourceFingerprint: emptyFingerprint },
      { component: "published-documents", fileCount: 0, size: 0, sourceFingerprint: emptyFingerprint },
    ],
    files: [],
  };
  if (withEvidence) {
    await Promise.all([
      writeFile(path.join(backupsRoot, "verification", "latest.json"), `${JSON.stringify({
        schemaVersion: 1,
        installationId: "evidence-qa",
        backupId,
        sourceFingerprint: emptyFingerprint,
        backupCreatedAt: now,
        verifiedAt: now,
      })}\n`, { mode: 0o600 }),
      writeFile(path.join(replicaRoot, "receipts", `${backupId}.json`), `${JSON.stringify({
        schemaVersion: 1,
        installationId: "evidence-qa",
        backupId,
        sourceFingerprint: emptyFingerprint,
        repositoryFingerprint: "a".repeat(64),
        remoteSnapshotId: "b".repeat(64),
        replicatedAt: now,
        verifiedAt: now,
      })}\n`, { mode: 0o600 }),
      writeFile(path.join(restoreDataRoot, ".aibrain-restore.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o400 }),
    ]);
  }
  const config = path.join(root, "installation.json");
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    installationId: "evidence-qa",
    companyName: "Evidence QA",
    companySlug: "evidence-qa",
    publicUrl: "https://evidence.example.test",
    branding: {
      productName: "Evidence Brain",
      logoPath: "/branding/evidence/logo.svg",
      faviconPath: "/branding/evidence/favicon.svg",
      accentColor: "#123abc",
    },
    paths: { dataRoot, backupsRoot, publishWriteRoot, companyContextRoot, usersRoot, sourceReadRoot },
  })}\n`, { mode: 0o600 });
  const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      AIBRAIN_INSTALLATION_CONFIG: config,
      AIBRAIN_REPLICA_STATE_ROOT: replicaRoot,
  };
  return {
    environment,
    restoreDataRoot,
    restorePublishRoot,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("backup evidence CLI", () => {
  it("correlates current local, replica and restore-marker evidence without claiming restore acceptance", async () => {
    const test = await fixture(true);
    const result = await execFile(executable, [
      script,
      "--restore-data-root", test.restoreDataRoot,
      "--restore-publish-root", test.restorePublishRoot,
    ], { env: test.environment });
    expect(JSON.parse(result.stdout)).toMatchObject({
      operation: "backup-evidence",
      status: "current",
      backup: { status: "verified", backupId },
      replica: { status: "verified", backupId },
      restore: { status: "receipt-present", backupId, contentVerified: false },
      restoreAcceptance: "not-proven",
    });
    expect(result.stdout).not.toContain(test.restoreDataRoot);
    expect(result.stdout).not.toContain(test.restorePublishRoot);
  });

  it("returns bounded attention evidence when backup and replica receipts are absent", async () => {
    const test = await fixture(false);
    await expect(execFile(executable, [script], { env: test.environment })).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"status":"attention"'),
    });
  });
});
