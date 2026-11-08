import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupManifestSchema, type BackupManifest } from "@/operations/backup";
import {
  BackupReplicaError,
  ResticBackupReplicator,
  readLatestBackupReplicaReceipt,
  runResticCommand,
  type ResticCommandRunner,
} from "@/operations/backup-replica";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SNAPSHOT_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const roots: string[] = [];

function manifest(): BackupManifest {
  return backupManifestSchema.parse({
    schemaVersion: 2,
    backupId: "20260827T123456Z-11111111-1111-4111-8111-111111111111",
    installationId: "replica-qa",
    createdAt: "2026-08-27T12:34:56.000Z",
    sourceFingerprint: EMPTY_SHA256,
    components: [
      { component: "product-data", fileCount: 0, size: 0, sourceFingerprint: EMPTY_SHA256 },
      { component: "published-documents", fileCount: 0, size: 0, sourceFingerprint: EMPTY_SHA256 },
    ],
    files: [],
  });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-replica-"));
  roots.push(root);
  const passwordFile = path.join(root, "restic-password");
  await writeFile(passwordFile, "synthetic-password\n", { mode: 0o600 });
  return {
    root,
    passwordFile,
    snapshotRoot: path.join(root, "snapshot"),
    stateRoot: path.join(root, "state"),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ResticBackupReplicator", () => {
  it("replicates, reads back, checks and records one idempotent encrypted snapshot", async () => {
    const test = await fixture();
    const calls: Array<{ arguments_: readonly string[]; environment: NodeJS.ProcessEnv }> = [];
    let lookup = 0;
    const runner: ResticCommandRunner = async (_binary, arguments_, options) => {
      calls.push({ arguments_, environment: options.environment });
      if (arguments_[0] === "snapshots") {
        lookup += 1;
        return {
          stdout: lookup === 1 ? "[]" : JSON.stringify([{
            id: SNAPSHOT_ID,
            tags: [
              "aibrain-installation=replica-qa",
              `aibrain-backup=${manifest().backupId}`,
              `aibrain-source=${EMPTY_SHA256}`,
            ],
          }]),
          stderr: "",
        };
      }
      if (arguments_[0] === "backup") {
        return { stdout: `${JSON.stringify({ message_type: "summary", snapshot_id: SNAPSHOT_ID })}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    let verifyCount = 0;
    const replicator = new ResticBackupReplicator({
      installationId: "replica-qa",
      resticBinary: process.execPath,
      repository: "s3:https://storage.example.test/aibrain-replica-qa",
      passwordFile: test.passwordFile,
      stateRoot: test.stateRoot,
      verifySnapshot: async () => {
        verifyCount += 1;
        return manifest();
      },
      environment: {
        NODE_ENV: "test",
        AWS_ACCESS_KEY_ID: "synthetic-access",
        AWS_SECRET_ACCESS_KEY: "synthetic-secret",
        UNRELATED_SECRET: "must-not-cross-boundary",
      },
      now: () => Date.parse("2026-08-27T13:00:00.000Z"),
      runCommand: runner,
    });

    const first = await replicator.replicate(test.snapshotRoot);
    expect(first).toMatchObject({
      schemaVersion: 1,
      installationId: "replica-qa",
      backupId: manifest().backupId,
      sourceFingerprint: EMPTY_SHA256,
      remoteSnapshotId: SNAPSHOT_ID,
      replicatedAt: "2026-08-27T13:00:00.000Z",
      verifiedAt: "2026-08-27T13:00:00.000Z",
    });
    expect(calls.map((call) => call.arguments_[0])).toEqual(["snapshots", "backup", "snapshots", "check"]);
    expect(calls[1]?.arguments_).toContain(test.snapshotRoot);
    expect(calls[0]?.arguments_.join(" ")).toContain(`aibrain-source=${EMPTY_SHA256}`);
    expect(calls[0]?.environment).toMatchObject({
      RESTIC_REPOSITORY: "s3:https://storage.example.test/aibrain-replica-qa",
      RESTIC_PASSWORD_FILE: test.passwordFile,
      AWS_ACCESS_KEY_ID: "synthetic-access",
      AWS_SECRET_ACCESS_KEY: "synthetic-secret",
    });
    expect(calls[0]?.environment).not.toHaveProperty("UNRELATED_SECRET");

    await expect(replicator.replicate(test.snapshotRoot)).resolves.toEqual(first);
    expect(calls).toHaveLength(4);
    expect(verifyCount).toBe(2);
    const receipt = await readFile(path.join(test.stateRoot, "receipts", `${manifest().backupId}.json`), "utf8");
    expect(receipt).not.toContain("storage.example.test");
    expect(receipt).not.toContain("synthetic-secret");
    await expect(readLatestBackupReplicaReceipt(test.stateRoot, "replica-qa"))
      .resolves.toEqual(first);
  });

  it("reuses an already tagged remote snapshot after a local interruption", async () => {
    const test = await fixture();
    const calls: string[] = [];
    const replicator = new ResticBackupReplicator({
      installationId: "replica-qa",
      resticBinary: process.execPath,
      repository: "rest:https://backup.example.test/repository",
      passwordFile: test.passwordFile,
      stateRoot: test.stateRoot,
      verifySnapshot: async () => manifest(),
      runCommand: async (_binary, arguments_) => {
        calls.push(arguments_[0] as string);
        if (arguments_[0] === "snapshots") {
          return {
            stdout: JSON.stringify([{
              id: SNAPSHOT_ID,
              tags: [
                "aibrain-installation=replica-qa",
                `aibrain-backup=${manifest().backupId}`,
                `aibrain-source=${EMPTY_SHA256}`,
              ],
            }]),
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      },
    });
    await expect(replicator.replicate(test.snapshotRoot)).resolves.toMatchObject({
      remoteSnapshotId: SNAPSHOT_ID,
    });
    expect(calls).toEqual(["snapshots", "snapshots", "check"]);
  });

  it("rejects a group-readable password file before invoking Restic", async () => {
    const test = await fixture();
    await chmod(test.passwordFile, 0o640);
    const replicator = new ResticBackupReplicator({
      installationId: "replica-qa",
      resticBinary: process.execPath,
      repository: "local:/safe/repository",
      passwordFile: test.passwordFile,
      stateRoot: test.stateRoot,
      verifySnapshot: async () => manifest(),
      runCommand: async () => {
        throw new Error("must not run");
      },
    });
    await expect(replicator.replicate(test.snapshotRoot)).rejects.toMatchObject({
      code: "REPLICA_SECRET_UNSAFE",
    });
  });
});

describe("runResticCommand", () => {
  it("executes without a shell and captures bounded output", async () => {
    const test = await fixture();
    const script = path.join(test.root, "fake-restic.mjs");
    await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", { mode: 0o600 });
    const result = await runResticCommand(process.execPath, [script, "$(touch should-not-run)", "plain"], {
      environment: { NODE_ENV: "test", PATH: "/usr/local/bin:/usr/bin:/bin" },
      timeoutMs: 5_000,
    });
    expect(JSON.parse(result.stdout)).toEqual(["$(touch should-not-run)", "plain"]);
  });

  it("terminates a hung process at the configured deadline", async () => {
    const test = await fixture();
    const script = path.join(test.root, "hung-restic.mjs");
    await writeFile(script, "setInterval(() => undefined, 1000);\n", { mode: 0o600 });
    await expect(runResticCommand(process.execPath, [script], {
      environment: { NODE_ENV: "test", PATH: "/usr/local/bin:/usr/bin:/bin" },
      timeoutMs: 1_000,
    })).rejects.toBeInstanceOf(BackupReplicaError);
  });
});
