import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publicationBarrierLock } from "@/documents/publication-locks";
import { BackupError, FileBackupService } from "@/operations/backup";
import { ResourceLockManager } from "@/storage";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-backup-"));
  roots.push(root);
  const dataRoot = path.join(root, "live-data");
  const backupsRoot = path.join(dataRoot, "backups");
  const publishWriteRoot = path.join(root, "publish-rw");
  await Promise.all([
    mkdir(path.join(dataRoot, "users", "user-one", "state"), { recursive: true }),
    mkdir(path.join(dataRoot, "users", "user-one", "browser", "profile", "Default"), { recursive: true }),
    mkdir(path.join(dataRoot, "users", "user-one", "browser", "downloads"), { recursive: true }),
    mkdir(path.join(dataRoot, "users", "user-one", "runtime", "codex-home"), { recursive: true }),
    mkdir(path.join(dataRoot, "sessions", "records"), { recursive: true }),
    mkdir(path.join(dataRoot, "auth-challenges", "records"), { recursive: true }),
    mkdir(path.join(dataRoot, "auth-rate-limits"), { recursive: true }),
    mkdir(path.join(dataRoot, "secrets"), { recursive: true }),
    mkdir(path.join(dataRoot, "locks", "ephemeral.lock"), { recursive: true }),
    mkdir(path.join(publishWriteRoot, "client-a"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(dataRoot, "users", "user-one", "state", "project.json"), "project-v1\n"),
    writeFile(path.join(dataRoot, "users", "user-one", "browser", "session.json"), "browser-state\n"),
    writeFile(path.join(dataRoot, "users", "user-one", "browser", "downloads", "report.txt"), "report\n"),
    writeFile(path.join(dataRoot, "users", "user-one", "browser", "profile", "Default", "Cookies"), "cookie-secret\n"),
    writeFile(path.join(dataRoot, "users", "user-one", "runtime", "codex-home", "auth.json"), "codex-secret\n"),
    writeFile(path.join(dataRoot, "sessions", "records", "session.json"), "session-v1\n"),
    writeFile(path.join(dataRoot, "auth-challenges", "records", "challenge.json"), "challenge-secret\n"),
    writeFile(path.join(dataRoot, "auth-rate-limits", "login.json"), "opaque-rate-limit-state\n"),
    writeFile(path.join(dataRoot, "secrets", "service.key"), "service-secret\n"),
    writeFile(path.join(dataRoot, ".env.runtime"), "runtime-secret\n"),
    writeFile(path.join(dataRoot, "PERMISSIONS.md"), "permission-v1\n", { mode: 0o400 }),
    writeFile(path.join(dataRoot, "locks", "ephemeral.lock", "owner.json"), "ephemeral\n"),
    writeFile(path.join(publishWriteRoot, "client-a", "report.pdf"), "published-report-v1\n"),
  ]);
  return {
    root,
    dataRoot,
    backupsRoot,
    publishWriteRoot,
    service: new FileBackupService(
      dataRoot,
      backupsRoot,
      publishWriteRoot,
      "synthetic-company-qa",
      () => Date.parse("2026-08-27T12:34:56.000Z"),
    ),
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

describe("FileBackupService", () => {
  it("backs up mailbox invoices and their journal but excludes encrypted credentials on restore", async () => {
    const { root, dataRoot, service } = await fixture();
    const account = "server/company-mail/synthetic-company-qa/00000000-0000-4000-8000-000000000001";
    const invoices = `${account}/invoices/project/mailbox`;
    await mkdir(path.join(dataRoot, account, "credentials"), { recursive: true });
    await mkdir(path.join(dataRoot, invoices, "originals"), { recursive: true });
    await writeFile(path.join(dataRoot, account, "credentials/opaque.json"), "encrypted-password");
    await writeFile(path.join(dataRoot, invoices, "ledger.json"), "durable-journal");
    await writeFile(path.join(dataRoot, invoices, "originals/hash"), "invoice-original");
    await writeFile(path.join(dataRoot, invoices, "facturas.xlsx"), "tracking-workbook");
    const created = await service.create();
    expect(created.manifest.files.map(f => f.path)).toEqual(expect.arrayContaining([`${invoices}/ledger.json`, `${invoices}/originals/hash`, `${invoices}/facturas.xlsx`]));
    expect(created.manifest.files.some(f => f.path.includes("credentials"))).toBe(false);
    const restoredRoot = path.join(root, "restored-mail-data");
    await service.restore(created.snapshotRoot, { dataRoot: restoredRoot, publishWriteRoot: path.join(root, "restored-mail-publish") });
    expect(await readFile(path.join(restoredRoot, invoices, "ledger.json"), "utf8")).toBe("durable-journal");
    expect(await readFile(path.join(restoredRoot, invoices, "originals/hash"), "utf8")).toBe("invoice-original");
    await expect(lstat(path.join(restoredRoot, account, "credentials"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("excludes regenerated runtime links and recovery credentials but retains runtime history", async () => {
    const { dataRoot, service } = await fixture();
    for (const relative of ["app-home/.codex/tmp", "auth-recovery-test/tmp", "users/user-one/runtime/codex-home/tmp", "users/user-one/browser/xdg"]) {
      await mkdir(path.join(dataRoot, relative), { recursive: true });
      await symlink("/missing-runtime-target", path.join(dataRoot, relative, "ephemeral"));
    }
    await writeFile(path.join(dataRoot, "users/user-one/runtime/codex-home/history.jsonl"), "durable-history\n");
    const created = await service.create();
    const paths = created.manifest.files.map((entry) => entry.path);
    expect(paths).toContain("users/user-one/runtime/codex-home/history.jsonl");
    expect(paths.some((entry) => entry.includes("ephemeral"))).toBe(false);
    await expect(service.verify(created.snapshotRoot)).resolves.toEqual(created.manifest);
  });

  it("creates a schema-valid backup id when the clock includes milliseconds", async () => {
    const { dataRoot, backupsRoot, publishWriteRoot } = await fixture();
    const service = new FileBackupService(
      dataRoot,
      backupsRoot,
      publishWriteRoot,
      "synthetic-company-qa",
      () => Date.parse("2026-08-27T12:34:56.789Z"),
    );
    await expect(service.create()).resolves.toMatchObject({
      manifest: { backupId: expect.stringMatching(/^20260827T123456Z-[0-9a-f-]{36}$/u) },
    });
  });

  it("creates an immutable verified snapshot and restores it into a new root", async () => {
    const { root, dataRoot, service } = await fixture();
    const created = await service.create();
    expect(created.manifest.files.map(({ component, path: filePath }) => `${component}/${filePath}`)).toEqual([
      "product-data/PERMISSIONS.md",
      "product-data/users/user-one/browser/downloads/report.txt",
      "product-data/users/user-one/browser/session.json",
      "product-data/users/user-one/state/project.json",
      "published-documents/client-a/report.pdf",
    ]);
    expect(created.manifest.components).toEqual([
      expect.objectContaining({ component: "product-data", fileCount: 4 }),
      expect.objectContaining({ component: "published-documents", fileCount: 1 }),
    ]);
    expect((await lstat(created.snapshotRoot)).mode & 0o777).toBe(0o500);
    expect((await lstat(path.join(created.snapshotRoot, "manifest.json"))).mode & 0o777).toBe(0o400);
    await expect(service.verify(created.snapshotRoot)).resolves.toEqual(created.manifest);
    await expect(service.readVerificationReceipt()).resolves.toMatchObject({
      schemaVersion: 1,
      installationId: "synthetic-company-qa",
      backupId: created.manifest.backupId,
      sourceFingerprint: created.manifest.sourceFingerprint,
      backupCreatedAt: created.manifest.createdAt,
      verifiedAt: "2026-08-27T12:34:56.000Z",
    });

    await writeFile(path.join(dataRoot, "users", "user-one", "state", "project.json"), "project-v2\n");
    const restoreRoot = path.join(root, "restored-data");
    const restoredPublishRoot = path.join(root, "restored-publish");
    const restored = await service.restore(created.snapshotRoot, {
      dataRoot: restoreRoot,
      publishWriteRoot: restoredPublishRoot,
    });
    expect(restored.manifest.sourceFingerprint).toBe(created.manifest.sourceFingerprint);
    expect(await readFile(path.join(restoreRoot, "users", "user-one", "state", "project.json"), "utf8"))
      .toBe("project-v1\n");
    expect(await readFile(path.join(restoredPublishRoot, "client-a", "report.pdf"), "utf8"))
      .toBe("published-report-v1\n");
    await expect(lstat(path.join(restoreRoot, "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(restoreRoot, "auth-challenges"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(restoreRoot, "auth-rate-limits"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(restoreRoot, "secrets"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(restoreRoot, ".env.runtime"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(restoreRoot, "users", "user-one", "browser", "profile")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(restoreRoot, "users", "user-one", "runtime", "codex-home", "auth.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(restoreRoot, "locks"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects snapshot corruption and refuses an existing restore destination", async () => {
    const { root, service } = await fixture();
    const created = await service.create();
    const existing = path.join(root, "existing");
    await mkdir(existing);
    await expect(service.restore(created.snapshotRoot, {
      dataRoot: existing,
      publishWriteRoot: path.join(root, "restore-publish"),
    })).rejects.toMatchObject({
      code: "RESTORE_DESTINATION_EXISTS",
    });

    const target = path.join(created.snapshotRoot, "roots", "product-data", "users", "user-one", "state", "project.json");
    await chmod(path.dirname(target), 0o700);
    await chmod(target, 0o600);
    await writeFile(target, "tampered\n");
    await expect(service.verify(created.snapshotRoot)).rejects.toMatchObject({
      code: "BACKUP_INTEGRITY_FAILED",
    });

  });

  it("does not report a verification receipt whose referenced snapshot disappeared", async () => {
    const { service } = await fixture();
    const created = await service.create();
    await service.verify(created.snapshotRoot);
    const makeWritable = async (directory: string): Promise<void> => {
      await chmod(directory, 0o700);
      const entries = await readdir(directory, { withFileTypes: true });
      await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
        makeWritable(path.join(directory, entry.name))));
    };
    await makeWritable(created.snapshotRoot);
    await rm(created.snapshotRoot, { recursive: true, force: true });
    await expect(service.readVerificationReceipt()).resolves.toBeNull();
  });

  it("fails closed on symbolic links in live state", async () => {
    const { root, dataRoot, service } = await fixture();
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "outside\n");
    await symlink(outside, path.join(dataRoot, "users", "user-one", "state", "linked.txt"));
    await expect(service.create()).rejects.toBeInstanceOf(BackupError);
    await expect(service.create()).rejects.toMatchObject({ code: "BACKUP_SYMLINK_REJECTED" });
  });

  it("fails closed on hard-linked live files", async () => {
    const { root, dataRoot, service } = await fixture();
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "outside\n");
    await link(outside, path.join(dataRoot, "users", "user-one", "state", "hard-linked.txt"));

    await expect(service.create()).rejects.toMatchObject({ code: "BACKUP_FILE_UNSAFE" });
  });

  it("fails closed on symbolic links and hard links in published documents", async () => {
    const first = await fixture();
    const outside = path.join(first.root, "outside-published.txt");
    await writeFile(outside, "outside\n");
    await symlink(outside, path.join(first.publishWriteRoot, "client-a", "linked.txt"));
    await expect(first.service.create()).rejects.toMatchObject({ code: "BACKUP_SYMLINK_REJECTED" });

    const second = await fixture();
    const hardLinkSource = path.join(second.root, "hard-link-source.txt");
    await writeFile(hardLinkSource, "outside\n");
    await link(hardLinkSource, path.join(second.publishWriteRoot, "client-a", "hard-linked.txt"));
    await expect(second.service.create()).rejects.toMatchObject({ code: "BACKUP_FILE_UNSAFE" });
  });

  it("waits for an in-flight publication and snapshots only the completed target", async () => {
    const { dataRoot, publishWriteRoot, service } = await fixture();
    const publicationLocks = new ResourceLockManager({
      rootDirectory: path.join(dataRoot, "locks", "document-publication-targets"),
      retryDelayMs: 5,
    });
    let releasePublication!: () => void;
    const publicationReleased = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let publicationAcquired!: () => void;
    const publicationReady = new Promise<void>((resolve) => {
      publicationAcquired = resolve;
    });
    const publication = publicationLocks.withLock(
      publicationBarrierLock("synthetic-company-qa"),
      async () => {
        publicationAcquired();
        await publicationReleased;
        await writeFile(
          path.join(publishWriteRoot, "client-a", "report.pdf"),
          "published-report-v2\n",
        );
      },
    );
    await publicationReady;

    let backupSettled = false;
    const backup = service.create().finally(() => {
      backupSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(backupSettled).toBe(false);

    releasePublication();
    await publication;
    const created = await backup;
    await expect(readFile(path.join(
      created.snapshotRoot,
      "roots",
      "published-documents",
      "client-a",
      "report.pdf",
    ), "utf8")).resolves.toBe("published-report-v2\n");
  });

  it("detects files added to or removed from an immutable snapshot", async () => {
    const { service } = await fixture();
    const created = await service.create();
    const dataDirectory = path.join(created.snapshotRoot, "roots", "product-data");
    await chmod(created.snapshotRoot, 0o700);
    await chmod(dataDirectory, 0o700);

    const extra = path.join(dataDirectory, "unmanifested.txt");
    await writeFile(extra, "not-in-manifest\n");
    await expect(service.verify(created.snapshotRoot)).rejects.toMatchObject({
      code: "BACKUP_INTEGRITY_FAILED",
    });

    await rm(extra);
    const missing = path.join(dataDirectory, "users", "user-one", "state", "project.json");
    await chmod(path.dirname(missing), 0o700);
    await rm(missing);
    await expect(service.verify(created.snapshotRoot)).rejects.toMatchObject({
      code: "BACKUP_INTEGRITY_FAILED",
    });
  });

  it("never publishes an interrupted pending snapshot and can create the next backup", async () => {
    const { root, dataRoot, backupsRoot, service } = await fixture();
    const outside = path.join(root, "outside.txt");
    const unsafe = path.join(dataRoot, "users", "user-one", "state", "linked.txt");
    await writeFile(outside, "outside\n");
    await symlink(outside, unsafe);

    await expect(service.create()).rejects.toMatchObject({ code: "BACKUP_SYMLINK_REJECTED" });
    const afterFailure = await readdir(path.join(backupsRoot, "snapshots"));
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]).toMatch(/^\..+\.pending$/u);

    await rm(unsafe);
    const created = await service.create();
    const afterRecovery = await readdir(path.join(backupsRoot, "snapshots"));
    expect(afterRecovery).toContain(path.basename(created.snapshotRoot));
    expect(afterRecovery.filter((entry) => !entry.startsWith("."))).toEqual([
      path.basename(created.snapshotRoot),
    ]);
  });

  it("preserves partial data for forensic recovery when restore copying fails", async () => {
    const { root, service } = await fixture();
    const created = await service.create();
    const originalVerify = service.verify.bind(service);
    service.verify = async (snapshotRoot: string) => {
      const manifest = await originalVerify(snapshotRoot);
      const componentRoot = path.join(snapshotRoot, "roots", "product-data");
      const missing = path.join(componentRoot, "users", "user-one", "state", "project.json");
      await chmod(snapshotRoot, 0o700);
      await chmod(path.join(snapshotRoot, "roots"), 0o700);
      await chmod(componentRoot, 0o700);
      await chmod(path.dirname(missing), 0o700);
      await rm(missing);
      return manifest;
    };

    const destination = path.join(root, "failed-restore");
    const publishDestination = path.join(root, "failed-publish-restore");
    await expect(service.restore(created.snapshotRoot, {
      dataRoot: destination,
      publishWriteRoot: publishDestination,
    })).rejects.toMatchObject({
      code: "RESTORE_FAILED",
      message: expect.stringContaining(`${destination}.failed.`),
    });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    const preserved = (await readdir(root)).find((entry) => entry.startsWith("failed-restore.failed."));
    expect(preserved).toBeDefined();
    await expect(readFile(path.join(root, preserved as string, "PERMISSIONS.md"), "utf8"))
      .resolves.toBe("permission-v1\n");
  });
});
