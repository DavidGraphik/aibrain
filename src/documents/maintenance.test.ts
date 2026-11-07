import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileDocumentTemporaryMaintenance,
  documentPreviewTemporaryLockKey,
  documentUploadTemporaryLockKey,
} from "@/documents/maintenance";
import { ResourceLockManager, ResourceLockTimeoutError, StorageError } from "@/storage";

const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const THREAD_ID = "10000000-0000-4000-8000-000000000001";
const UPLOAD_A = "20000000-0000-4000-8000-000000000001";
const UPLOAD_B = "20000000-0000-4000-8000-000000000002";
const QUARANTINE_A = "30000000-0000-4000-8000-000000000001";
const QUARANTINE_B = "30000000-0000-4000-8000-000000000002";
const OPERATION_ID = "40000000-0000-4000-8000-000000000001";
const TURN_ID = "50000000-0000-4000-8000-000000000001";
const PREVIEW_ID = "60000000-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const GRACE_MS = 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

type Fixture = Awaited<ReturnType<typeof fixture>>;
const roots: string[] = [];

async function fixture(userId = USER_A) {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-document-maintenance-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const usersRoot = path.join(dataRoot, "users");
  const userRoot = path.join(usersRoot, userId);
  const incomingRoot = path.join(userRoot, "staging", ".incoming");
  const previewDirectory = path.join(userRoot, "state", "document-previews", THREAD_ID, UPLOAD_A);
  await Promise.all([
    mkdir(incomingRoot, { recursive: true, mode: 0o700 }),
    mkdir(previewDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmodPrivate(dataRoot),
    chmodPrivate(usersRoot),
    chmodPrivate(userRoot),
    chmodPrivate(path.join(userRoot, "staging")),
    chmodPrivate(incomingRoot),
    chmodPrivate(path.join(userRoot, "state")),
    chmodPrivate(path.join(userRoot, "state", "document-previews")),
    chmodPrivate(path.join(userRoot, "state", "document-previews", THREAD_ID)),
    chmodPrivate(previewDirectory),
  ]);
  return { root, dataRoot, usersRoot, userRoot, userId, incomingRoot, previewDirectory };
}

async function chmodPrivate(target: string) {
  const { chmod } = await import("node:fs/promises");
  await chmod(target, 0o700);
}

async function old(target: string) {
  const timestamp = new Date(NOW - GRACE_MS - 1_000);
  await utimes(target, timestamp, timestamp);
}

async function staleUpload(test: Fixture, uploadId = UPLOAD_A) {
  const filePath = path.join(test.incomingRoot, `${uploadId}.upload`);
  await writeFile(filePath, "temporary", { mode: 0o600 });
  await old(filePath);
  return filePath;
}

async function staleWork(test: Fixture, name = ".work-Ab12Cd") {
  const work = path.join(test.previewDirectory, name);
  await mkdir(work, { mode: 0o700 });
  await writeFile(path.join(work, "input.docx"), "temporary", { mode: 0o600 });
  await old(work);
  return work;
}

function service(test: Fixture, lockManager?: ResourceLockManager) {
  return new FileDocumentTemporaryMaintenance({
    dataRoot: test.dataRoot,
    usersRoot: test.usersRoot,
    gracePeriodMs: GRACE_MS,
    publicationCandidateRetentionMs: RETENTION_MS,
    installationId: "maintenance-qa",
    now: () => NOW,
    lockManager,
  });
}

async function publication(test: Fixture, options: {
  status?: "awaiting_confirmation" | "declined";
  updatedAtMs?: number;
} = {}) {
  const content = Buffer.from("frozen candidate");
  const snapshotRelativePath = path.posix.join(
    "candidates",
    test.userId,
    THREAD_ID,
    OPERATION_ID,
    "candidate.txt",
  );
  const publicationsRoot = path.join(test.userRoot, "state", "publications");
  const candidatePath = path.join(publicationsRoot, snapshotRelativePath);
  const operationPath = path.join(publicationsRoot, "operations", test.userId, `${OPERATION_ID}.json`);
  await Promise.all([
    mkdir(path.dirname(candidatePath), { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(operationPath), { recursive: true, mode: 0o700 }),
  ]);
  const updatedAt = new Date(options.updatedAtMs ?? NOW - RETENTION_MS - 1_000).toISOString();
  const status = options.status ?? "declined";
  const sha256 = createHash("sha256").update(content).digest("hex");
  const operation = {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    installationId: "maintenance-qa",
    userId: test.userId,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    targetRelativePath: "knowledge/report.txt",
    status,
    candidate: { fileName: "candidate.txt", size: content.byteLength, sha256, snapshotRelativePath },
    preview: {
      schemaVersion: 1,
      previewId: PREVIEW_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      candidateSha256: sha256,
      status: "ready",
      artifacts: ["preview.pdf"],
      createdAt: updatedAt,
    },
    original: { exists: false, size: null, sha256: null, mtimeMs: null },
    confirmationTokenHash: "a".repeat(64),
    confirmationExpiresAt: new Date(NOW + 60_000).toISOString(),
    creationRequestHash: "b".repeat(64),
    decisionRequestHash: status === "awaiting_confirmation" ? null : "c".repeat(64),
    version: null,
    result: null,
    createdAt: updatedAt,
    updatedAt,
  };
  await Promise.all([
    writeFile(candidatePath, content, { mode: 0o600 }),
    writeFile(operationPath, `${JSON.stringify(operation)}\n`, { mode: 0o600 }),
  ]);
  return { candidatePath, operationPath, publicationsRoot };
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

describe("FileDocumentTemporaryMaintenance", () => {
  it("dry-runs and then removes only stale known temporaries, including abandoned quarantines", async () => {
    const test = await fixture();
    const staleIncoming = await staleUpload(test);
    const youngIncoming = path.join(test.incomingRoot, `${UPLOAD_B}.upload`);
    await writeFile(youngIncoming, "young", { mode: 0o600 });
    await utimes(youngIncoming, new Date(NOW), new Date(NOW));
    const stalePreview = await staleWork(test);
    const durablePreview = path.join(test.previewDirectory, "preview.json");
    await writeFile(durablePreview, "{}", { mode: 0o600 });
    const unrelated = path.join(test.incomingRoot, "keep.txt");
    await writeFile(unrelated, "keep", { mode: 0o600 });

    const quarantinedUpload = path.join(test.incomingRoot, `.gc-upload-${QUARANTINE_A}`);
    await writeFile(quarantinedUpload, "abandoned", { mode: 0o600 });
    await old(quarantinedUpload);
    const quarantinedPreview = await staleWork(test, `.gc-preview-${QUARANTINE_B}`);

    const dryRun = await service(test).run({ dryRun: true });
    expect(dryRun).toMatchObject({
      dryRun: true,
      scannedUsers: 1,
      candidates: 5,
      removed: [],
    });
    expect(dryRun.wouldRemove.map(({ relativePath }) => relativePath)).toHaveLength(4);
    expect(dryRun.skippedYoung.map(({ relativePath }) => relativePath)).toEqual([
      path.posix.join(USER_A, "staging", ".incoming", `${UPLOAD_B}.upload`),
    ]);
    await expect(Promise.all([
      exists(staleIncoming),
      exists(stalePreview),
      exists(quarantinedUpload),
      exists(quarantinedPreview),
    ])).resolves.toEqual([true, true, true, true]);

    const applied = await service(test).run({ dryRun: false });
    expect(applied.removed).toHaveLength(4);
    expect(applied.wouldRemove).toEqual([]);
    await expect(Promise.all([
      exists(staleIncoming),
      exists(stalePreview),
      exists(quarantinedUpload),
      exists(quarantinedPreview),
    ])).resolves.toEqual([false, false, false, false]);
    await expect(readFile(youngIncoming, "utf8")).resolves.toBe("young");
    await expect(readFile(durablePreview, "utf8")).resolves.toBe("{}");
    await expect(readFile(unrelated, "utf8")).resolves.toBe("keep");
  });

  it("fails closed for symlinks, hardlinks, unsafe roots, and unexpected temporary names", async () => {
    const test = await fixture();
    const outsideFile = path.join(test.root, "outside-file");
    const outsideDirectory = path.join(test.root, "outside-directory");
    await writeFile(outsideFile, "outside", { mode: 0o600 });
    await mkdir(outsideDirectory, { mode: 0o700 });
    await writeFile(path.join(outsideDirectory, "keep"), "outside", { mode: 0o600 });

    const symlinkUpload = path.join(test.incomingRoot, `${UPLOAD_A}.upload`);
    await symlink(outsideFile, symlinkUpload);
    const hardlinkUpload = path.join(test.incomingRoot, `${UPLOAD_B}.upload`);
    await link(outsideFile, hardlinkUpload);
    await old(hardlinkUpload);
    const symlinkWork = path.join(test.previewDirectory, ".work-Ab12Cd");
    await symlink(outsideDirectory, symlinkWork);
    const unexpected = path.join(test.incomingRoot, "not-a-uuid.upload");
    await writeFile(unexpected, "unexpected", { mode: 0o600 });
    await old(unexpected);

    const report = await service(test).run({ dryRun: false });
    expect(report.removed).toEqual([]);
    expect(report.skippedUnsafe).toHaveLength(4);
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside");
    await expect(readFile(path.join(outsideDirectory, "keep"), "utf8")).resolves.toBe("outside");
    await expect(Promise.all([
      exists(symlinkUpload),
      exists(hardlinkUpload),
      exists(symlinkWork),
      exists(unexpected),
    ])).resolves.toEqual([true, true, true, true]);

    await rm(test.usersRoot, { recursive: true, force: true });
    await symlink(outsideDirectory, test.usersRoot);
    await expect(service(test).run({ dryRun: false })).rejects.toMatchObject({
      code: "DOCUMENT_MAINTENANCE_ROOT_UNSAFE",
    });
    await expect(readFile(path.join(outsideDirectory, "keep"), "utf8")).resolves.toBe("outside");
  });

  it("skips active upload and preview locks, then removes both after release", async () => {
    const test = await fixture();
    const upload = await staleUpload(test);
    const work = await staleWork(test);
    const documentLocks = new ResourceLockManager({
      rootDirectory: path.join(test.userRoot, "state", ".locks", "documents"),
    });
    const uploadLease = await documentLocks.acquire(documentUploadTemporaryLockKey(upload));
    const previewLease = await documentLocks.acquire(documentPreviewTemporaryLockKey(test.previewDirectory));
    try {
      const locked = await service(test).run({ dryRun: false });
      expect(locked.skippedLocked.map(({ relativePath }) => relativePath)).toEqual([
        path.posix.join(USER_A, "staging", ".incoming", `${UPLOAD_A}.upload`),
        path.posix.join(USER_A, "state", "document-previews", THREAD_ID, UPLOAD_A, ".work-Ab12Cd"),
      ].sort());
      await expect(Promise.all([exists(upload), exists(work)])).resolves.toEqual([true, true]);
    } finally {
      await previewLease.release();
      await uploadLease.release();
    }

    const released = await service(test).run({ dryRun: false });
    expect(released.removed).toHaveLength(2);
    await expect(Promise.all([exists(upload), exists(work)])).resolves.toEqual([false, false]);
  });

  it("serializes maintenance runs with an installation lock", async () => {
    const test = await fixture();
    const globalLocks = new ResourceLockManager({
      rootDirectory: path.join(test.dataRoot, "locks", "document-maintenance"),
    });
    const lease = await globalLocks.acquire(`document-temporary-maintenance:${test.usersRoot}`);
    try {
      await expect(service(test, globalLocks).run({ dryRun: true, lockTimeoutMs: 0 }))
        .rejects.toBeInstanceOf(ResourceLockTimeoutError);
    } finally {
      await lease.release();
    }
  });

  it("rejects invalid roots and grace periods before scanning", async () => {
    const test = await fixture();
    expect(() => new FileDocumentTemporaryMaintenance({
      dataRoot: test.dataRoot,
      usersRoot: test.root,
    })).toThrow(StorageError);
    expect(() => new FileDocumentTemporaryMaintenance({
      dataRoot: test.dataRoot,
      usersRoot: test.usersRoot,
      gracePeriodMs: 0,
    })).toThrow(StorageError);
  });

  it("does not follow a UUID-shaped user-root symlink", async () => {
    const test = await fixture();
    const outsideUser = path.join(test.root, "outside-user");
    const outsideIncoming = path.join(outsideUser, "staging", ".incoming");
    await mkdir(outsideIncoming, { recursive: true, mode: 0o700 });
    await writeFile(path.join(outsideIncoming, `${UPLOAD_A}.upload`), "outside", { mode: 0o600 });
    await symlink(outsideUser, path.join(test.usersRoot, USER_B));

    const report = await service(test).run({ dryRun: false });
    expect(report.scannedUsers).toBe(1);
    expect(report.skippedUnsafe).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: USER_B, reason: "user root is not a private real directory" }),
    ]));
    await expect(readFile(path.join(outsideIncoming, `${UPLOAD_A}.upload`), "utf8")).resolves.toBe("outside");
  });

  it("removes only terminal frozen candidate bytes after 30 days and retains durable state", async () => {
    const test = await fixture();
    const terminal = await publication(test);
    const durableReceipt = path.join(terminal.publicationsRoot, "requests", USER_A, `decision-${"d".repeat(64)}.json`);
    const durableAudit = path.join(terminal.publicationsRoot, "audit", "maintenance-qa", "publication.jsonl");
    await Promise.all([
      mkdir(path.dirname(durableReceipt), { recursive: true, mode: 0o700 }),
      mkdir(path.dirname(durableAudit), { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      writeFile(durableReceipt, "receipt", { mode: 0o600 }),
      writeFile(durableAudit, "audit", { mode: 0o600 }),
    ]);

    const dryRun = await service(test).run({ dryRun: true });
    expect(dryRun.publicationCandidateRetentionMs).toBe(RETENTION_MS);
    expect(dryRun.wouldRemove).toEqual([
      expect.objectContaining({ kind: "publication-candidate" }),
    ]);
    await expect(readFile(terminal.candidatePath, "utf8")).resolves.toBe("frozen candidate");

    const applied = await service(test).run({ dryRun: false });
    expect(applied.removed).toEqual([
      expect.objectContaining({ kind: "publication-candidate" }),
    ]);
    await expect(exists(terminal.candidatePath)).resolves.toBe(false);
    await expect(Promise.all([
      readFile(terminal.operationPath, "utf8"),
      readFile(durableReceipt, "utf8"),
      readFile(durableAudit, "utf8"),
    ])).resolves.toEqual([expect.stringContaining(OPERATION_ID), "receipt", "audit"]);
  });

  it("retains pending and young publication candidates and preserves unsafe candidate state", async () => {
    const pendingTest = await fixture();
    const pending = await publication(pendingTest, { status: "awaiting_confirmation" });
    const pendingReport = await service(pendingTest).run({ dryRun: false });
    expect(pendingReport.removed).toEqual([]);
    await expect(exists(pending.candidatePath)).resolves.toBe(true);

    const youngTest = await fixture(USER_B);
    const young = await publication(youngTest, { updatedAtMs: NOW - RETENTION_MS + 1_000 });
    const youngReport = await service(youngTest).run({ dryRun: false });
    expect(youngReport.removed).toEqual([]);
    expect(youngReport.skippedYoung).toEqual([
      expect.objectContaining({ kind: "publication-candidate" }),
    ]);
    await expect(exists(young.candidatePath)).resolves.toBe(true);

    await writeFile(young.candidatePath, "wrong size", { mode: 0o600 });
    const corruptReport = await new FileDocumentTemporaryMaintenance({
      dataRoot: youngTest.dataRoot,
      usersRoot: youngTest.usersRoot,
      installationId: "maintenance-qa",
      publicationCandidateRetentionMs: 1,
      gracePeriodMs: GRACE_MS,
      now: () => NOW,
    }).run({ dryRun: false });
    expect(corruptReport.skippedUnsafe).toEqual([
      expect.objectContaining({
        kind: "publication-candidate",
        reason: "publication candidate size differs from versioned operation state",
      }),
    ]);
    await expect(readFile(young.candidatePath, "utf8")).resolves.toBe("wrong size");
  });
});
