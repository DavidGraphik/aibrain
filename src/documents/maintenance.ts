import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  publicationOperationSchema,
  type StoredPublicationOperation,
} from "@/documents/publication-contract";
import { readRegularFileWithin } from "@/security/safe-file";
import {
  ResourceLockManager,
  ResourceLockTimeoutError,
  StorageError,
  type ResourceLockLease,
  type ResourceLockManagerOptions,
} from "@/storage";

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const THREAD_OR_UPLOAD_ID = USER_ID;
const INCOMING_UPLOAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.upload$/u;
const PREVIEW_WORK = /^\.work-[A-Za-z0-9]{6}$/u;
const QUARANTINED_UPLOAD = /^\.gc-upload-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const QUARANTINED_PREVIEW = /^\.gc-preview-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PUBLICATION_OPERATION = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
const QUARANTINED_CANDIDATE = /^\.gc-candidate-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TERMINAL_PUBLICATION_STATUSES = new Set<StoredPublicationOperation["status"]>([
  "published",
  "declined",
  "expired",
  "conflict",
]);
const INSTALLATION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MAX_PUBLICATION_OPERATION_BYTES = 1024 * 1024;

export const DEFAULT_DOCUMENT_TEMPORARY_GRACE_MS = 6 * 60 * 60 * 1_000;
export const DEFAULT_PUBLICATION_CANDIDATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type DocumentTemporaryKind = "incoming-upload" | "preview-work" | "publication-candidate";

export type DocumentTemporaryMaintenanceItem = {
  kind: DocumentTemporaryKind;
  relativePath: string;
};

export type UnsafeDocumentTemporary = DocumentTemporaryMaintenanceItem & {
  reason: string;
};

export type DocumentTemporaryMaintenanceReport = {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  gracePeriodMs: number;
  publicationCandidateRetentionMs: number;
  scannedUsers: number;
  candidates: number;
  removed: DocumentTemporaryMaintenanceItem[];
  wouldRemove: DocumentTemporaryMaintenanceItem[];
  skippedYoung: DocumentTemporaryMaintenanceItem[];
  skippedLocked: DocumentTemporaryMaintenanceItem[];
  skippedUnsafe: UnsafeDocumentTemporary[];
};

export type FileDocumentTemporaryMaintenanceOptions = {
  dataRoot: string;
  usersRoot: string;
  installationId?: string;
  gracePeriodMs?: number;
  publicationCandidateRetentionMs?: number;
  lockManager?: ResourceLockManager;
  documentLockOptions?: Pick<
    ResourceLockManagerOptions,
    "staleAfterMs" | "heartbeatIntervalMs" | "retryDelayMs" | "maxRetryDelayMs"
  >;
  now?: () => number;
};

type Candidate = DocumentTemporaryMaintenanceItem & {
  absolutePath: string;
  quarantinePrefix: ".gc-upload-" | ".gc-preview-" | ".gc-candidate-";
  expectedType: "file" | "directory";
  expectedSize?: number;
  eligibleAtMs?: number;
  lockKey?: string;
  lockManager?: ResourceLockManager;
  revalidate?: () => Promise<"eligible" | "retained" | "missing">;
};

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateOptions(options: FileDocumentTemporaryMaintenanceOptions) {
  const dataRoot = path.resolve(options.dataRoot);
  const usersRoot = path.resolve(options.usersRoot);
  if (!path.isAbsolute(options.dataRoot) || !path.isAbsolute(options.usersRoot) || dataRoot === usersRoot || !inside(dataRoot, usersRoot)) {
    throw new StorageError(
      "DOCUMENT_MAINTENANCE_OPTIONS_INVALID",
      "Document maintenance requires absolute usersRoot strictly inside dataRoot.",
    );
  }
  const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_DOCUMENT_TEMPORARY_GRACE_MS;
  const publicationCandidateRetentionMs = options.publicationCandidateRetentionMs
    ?? DEFAULT_PUBLICATION_CANDIDATE_RETENTION_MS;
  if (!Number.isSafeInteger(gracePeriodMs) || gracePeriodMs < 1 ||
      !Number.isSafeInteger(publicationCandidateRetentionMs) || publicationCandidateRetentionMs < 1 ||
      (options.installationId !== undefined && !INSTALLATION_ID.test(options.installationId))) {
    throw new StorageError(
      "DOCUMENT_MAINTENANCE_OPTIONS_INVALID",
      "Document maintenance identity and retention periods are invalid.",
    );
  }
  return {
    dataRoot,
    usersRoot,
    gracePeriodMs,
    publicationCandidateRetentionMs,
    installationId: options.installationId ?? null,
  };
}

function privateRegularFile(metadata: Stats) {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && (metadata.mode & 0o077) === 0;
}

function privateDirectory(metadata: Stats) {
  return metadata.isDirectory()
    && !metadata.isSymbolicLink()
    && (metadata.mode & 0o077) === 0;
}

function sameInode(before: Stats, after: Stats) {
  return before.dev === after.dev && before.ino === after.ino;
}

function sortItems<T extends DocumentTemporaryMaintenanceItem>(items: T[]) {
  return items.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/**
 * Canonical lock used by the multipart parser while an `.incoming` file is
 * being written or awaiting staging. Maintenance never waits for this lock.
 */
export function documentUploadTemporaryLockKey(temporaryPath: string) {
  if (!path.isAbsolute(temporaryPath)) {
    throw new StorageError("DOCUMENT_MAINTENANCE_PATH_INVALID", "Upload temporary path must be absolute.");
  }
  return `document-upload-temporary:${path.resolve(temporaryPath)}`;
}

/** Matches the lock held by DocumentPreviewService for one upload preview. */
export function documentPreviewTemporaryLockKey(previewDirectory: string) {
  if (!path.isAbsolute(previewDirectory)) {
    throw new StorageError("DOCUMENT_MAINTENANCE_PATH_INVALID", "Preview directory must be absolute.");
  }
  return `document-preview:${path.join(path.resolve(previewDirectory), "preview.json")}`;
}

async function directoryEntries(directory: string): Promise<Dirent[] | null> {
  try {
    return (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

export class FileDocumentTemporaryMaintenance {
  readonly dataRoot: string;
  readonly usersRoot: string;
  readonly gracePeriodMs: number;
  readonly publicationCandidateRetentionMs: number;
  readonly lockManager: ResourceLockManager;
  private readonly installationId: string | null;
  private readonly documentLockOptions: FileDocumentTemporaryMaintenanceOptions["documentLockOptions"];
  private readonly now: () => number;

  constructor(options: FileDocumentTemporaryMaintenanceOptions) {
    const validated = validateOptions(options);
    this.dataRoot = validated.dataRoot;
    this.usersRoot = validated.usersRoot;
    this.gracePeriodMs = validated.gracePeriodMs;
    this.publicationCandidateRetentionMs = validated.publicationCandidateRetentionMs;
    this.installationId = validated.installationId;
    this.lockManager = options.lockManager ?? new ResourceLockManager({
      rootDirectory: path.join(this.dataRoot, "locks", "document-maintenance"),
    });
    if (
      this.lockManager.rootDirectory === this.dataRoot
      || !inside(this.dataRoot, this.lockManager.rootDirectory)
    ) {
      throw new StorageError(
        "DOCUMENT_MAINTENANCE_OPTIONS_INVALID",
        "Document maintenance lock root must be strictly inside dataRoot.",
      );
    }
    this.documentLockOptions = options.documentLockOptions;
    this.now = options.now ?? Date.now;
  }

  private relativeItem(candidate: Pick<Candidate, "kind" | "relativePath">) {
    return { kind: candidate.kind, relativePath: candidate.relativePath };
  }

  private async assertRoot() {
    const [dataMetadata, usersMetadata] = await Promise.all([
      lstat(this.dataRoot),
      lstat(this.usersRoot),
    ]);
    if (!privateDirectory(dataMetadata) || !privateDirectory(usersMetadata)) {
      throw new StorageError(
        "DOCUMENT_MAINTENANCE_ROOT_UNSAFE",
        "Document maintenance roots must be private real directories.",
      );
    }
    const [canonicalData, canonicalUsers] = await Promise.all([
      realpath(this.dataRoot),
      realpath(this.usersRoot),
    ]);
    if (!inside(canonicalData, canonicalUsers) || canonicalData === canonicalUsers) {
      throw new StorageError(
        "DOCUMENT_MAINTENANCE_ROOT_UNSAFE",
        "Canonical usersRoot escapes dataRoot.",
      );
    }
    return canonicalUsers;
  }

  private unsafe(
    report: DocumentTemporaryMaintenanceReport,
    candidate: Pick<Candidate, "kind" | "relativePath">,
    reason: string,
  ) {
    report.skippedUnsafe.push({ ...this.relativeItem(candidate), reason });
  }

  private async scanIncoming(
    userId: string,
    userRoot: string,
    documentLocks: ResourceLockManager,
    report: DocumentTemporaryMaintenanceReport,
  ) {
    const stagingRoot = path.join(userRoot, "staging");
    const incomingRoot = path.join(stagingRoot, ".incoming");
    let stagingMetadata: Stats;
    try {
      stagingMetadata = await lstat(stagingRoot);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    if (!privateDirectory(stagingMetadata)) {
      this.unsafe(report, {
        kind: "incoming-upload",
        relativePath: path.posix.join(userId, "staging"),
      }, "staging root is not a private real directory");
      return [];
    }
    let rootMetadata: Stats;
    try {
      rootMetadata = await lstat(incomingRoot);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    if (!privateDirectory(rootMetadata)) {
      this.unsafe(report, {
        kind: "incoming-upload",
        relativePath: path.posix.join(userId, "staging", ".incoming"),
      }, "incoming root is not a private real directory");
      return [];
    }
    const entries = await directoryEntries(incomingRoot);
    if (entries === null) return [];

    const candidates: Candidate[] = [];
    for (const entry of entries) {
      const relativePath = path.posix.join(userId, "staging", ".incoming", entry.name);
      if (INCOMING_UPLOAD.test(entry.name)) {
        const absolutePath = path.join(incomingRoot, entry.name);
        candidates.push({
          kind: "incoming-upload",
          relativePath,
          absolutePath,
          quarantinePrefix: ".gc-upload-",
          expectedType: "file",
          lockKey: documentUploadTemporaryLockKey(absolutePath),
          lockManager: documentLocks,
        });
      } else if (QUARANTINED_UPLOAD.test(entry.name)) {
        candidates.push({
          kind: "incoming-upload",
          relativePath,
          absolutePath: path.join(incomingRoot, entry.name),
          quarantinePrefix: ".gc-upload-",
          expectedType: "file",
        });
      } else if (entry.name.endsWith(".upload") || entry.name.startsWith(".gc-upload-")) {
        this.unsafe(report, { kind: "incoming-upload", relativePath }, "unexpected incoming temporary name");
      }
    }
    return candidates;
  }

  private async scanPreviews(
    userId: string,
    userRoot: string,
    documentLocks: ResourceLockManager,
    report: DocumentTemporaryMaintenanceReport,
  ) {
    const stateRoot = path.join(userRoot, "state");
    const previewRoot = path.join(stateRoot, "document-previews");
    let stateMetadata: Stats;
    try {
      stateMetadata = await lstat(stateRoot);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    if (!privateDirectory(stateMetadata)) {
      this.unsafe(report, {
        kind: "preview-work",
        relativePath: path.posix.join(userId, "state"),
      }, "state root is not a private real directory");
      return [];
    }
    let previewRootMetadata: Stats;
    try {
      previewRootMetadata = await lstat(previewRoot);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    if (!privateDirectory(previewRootMetadata)) {
      this.unsafe(report, {
        kind: "preview-work",
        relativePath: path.posix.join(userId, "state", "document-previews"),
      }, "preview root is not a private real directory");
      return [];
    }
    const threads = await directoryEntries(previewRoot);
    if (threads === null) return [];

    const candidates: Candidate[] = [];
    for (const thread of threads) {
      if (!THREAD_OR_UPLOAD_ID.test(thread.name)) continue;
      const threadRoot = path.join(previewRoot, thread.name);
      let threadMetadata: Stats;
      try {
        threadMetadata = await lstat(threadRoot);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) continue;
        throw error;
      }
      if (!privateDirectory(threadMetadata)) {
        this.unsafe(report, {
          kind: "preview-work",
          relativePath: path.posix.join(userId, "state", "document-previews", thread.name),
        }, "preview thread root is not a private real directory");
        continue;
      }
      const uploads = await directoryEntries(threadRoot);
      if (uploads === null) continue;
      for (const upload of uploads) {
        if (!THREAD_OR_UPLOAD_ID.test(upload.name)) continue;
        const uploadRoot = path.join(threadRoot, upload.name);
        let uploadMetadata: Stats;
        try {
          uploadMetadata = await lstat(uploadRoot);
        } catch (error) {
          if (isNodeError(error, "ENOENT")) continue;
          throw error;
        }
        if (!privateDirectory(uploadMetadata)) {
          this.unsafe(report, {
            kind: "preview-work",
            relativePath: path.posix.join(userId, "state", "document-previews", thread.name, upload.name),
          }, "preview upload root is not a private real directory");
          continue;
        }
        const workEntries = await directoryEntries(uploadRoot);
        if (workEntries === null) continue;
        for (const work of workEntries) {
          const relativePath = path.posix.join(
            userId,
            "state",
            "document-previews",
            thread.name,
            upload.name,
            work.name,
          );
          if (PREVIEW_WORK.test(work.name)) {
            candidates.push({
              kind: "preview-work",
              relativePath,
              absolutePath: path.join(uploadRoot, work.name),
              quarantinePrefix: ".gc-preview-",
              expectedType: "directory",
              lockKey: documentPreviewTemporaryLockKey(uploadRoot),
              lockManager: documentLocks,
            });
          } else if (QUARANTINED_PREVIEW.test(work.name)) {
            candidates.push({
              kind: "preview-work",
              relativePath,
              absolutePath: path.join(uploadRoot, work.name),
              quarantinePrefix: ".gc-preview-",
              expectedType: "directory",
            });
          } else if (work.name.startsWith(".work-") || work.name.startsWith(".gc-preview-")) {
            this.unsafe(report, { kind: "preview-work", relativePath }, "unexpected preview temporary name");
          }
        }
      }
    }
    return candidates;
  }

  private async readPublicationOperation(operationPath: string) {
    let before: Stats;
    try {
      before = await lstat(operationPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
    if (!privateRegularFile(before) || before.size > MAX_PUBLICATION_OPERATION_BYTES) {
      throw new StorageError(
        "DOCUMENT_MAINTENANCE_PUBLICATION_UNSAFE",
        "Publication operation is not a bounded private regular file.",
      );
    }
    const serialized = await readRegularFileWithin(
      path.dirname(operationPath),
      path.basename(operationPath),
      MAX_PUBLICATION_OPERATION_BYTES,
    );
    const after = await lstat(operationPath);
    if (!privateRegularFile(after) || !sameInode(before, after) || before.size !== after.size) {
      throw new StorageError(
        "DOCUMENT_MAINTENANCE_PUBLICATION_RACE",
        "Publication operation changed while it was being read.",
      );
    }
    try {
      return publicationOperationSchema.parse(JSON.parse(serialized.toString("utf8")), operationPath);
    } catch (error) {
      throw new StorageError(
        "DOCUMENT_MAINTENANCE_PUBLICATION_CORRUPT",
        "Publication operation is not valid versioned state.",
        { cause: error },
      );
    }
  }

  private async privateDirectoryChain(root: string, relativeDirectory: string) {
    let current = root;
    for (const segment of relativeDirectory.split(path.posix.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let metadata: Stats;
      try {
        metadata = await lstat(current);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return false;
        throw error;
      }
      if (!privateDirectory(metadata)) return false;
    }
    return true;
  }

  private publicationIdentityMatches(
    operation: StoredPublicationOperation,
    userId: string,
    operationId: string,
  ) {
    return operation.userId === userId
      && operation.operationId === operationId
      && (this.installationId === null || operation.installationId === this.installationId);
  }

  private async scanPublications(
    userId: string,
    userRoot: string,
    documentLocks: ResourceLockManager,
    report: DocumentTemporaryMaintenanceReport,
  ) {
    // Durable publication retention is installation-scoped and stays disabled
    // for library callers that did not bind an explicit installation identity.
    if (this.installationId === null) return [];
    const stateRoot = path.join(userRoot, "state");
    const publicationsRoot = path.join(stateRoot, "publications");
    const operationsRoot = path.join(publicationsRoot, "operations");
    const userOperationsRoot = path.join(operationsRoot, userId);
    for (const [rootIndex, root] of [stateRoot, publicationsRoot, operationsRoot, userOperationsRoot].entries()) {
      let metadata: Stats;
      try {
        metadata = await lstat(root);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return [];
        throw error;
      }
      if (!privateDirectory(metadata)) {
        const suffix = ["state", "publications", "operations", userId].slice(0, rootIndex + 1);
        this.unsafe(report, {
          kind: "publication-candidate",
          relativePath: path.posix.join(userId, ...suffix),
        }, "publication state root is not a private real directory");
        return [];
      }
    }
    const entries = await directoryEntries(userOperationsRoot);
    if (entries === null) return [];
    const canonicalPublications = await realpath(publicationsRoot);
    const candidates: Candidate[] = [];

    for (const entry of entries) {
      const match = PUBLICATION_OPERATION.exec(entry.name);
      if (!match) continue;
      const operationId = match[1]!;
      const operationPath = path.join(userOperationsRoot, entry.name);
      let operation: StoredPublicationOperation | null;
      try {
        operation = await this.readPublicationOperation(operationPath);
      } catch {
        this.unsafe(report, {
          kind: "publication-candidate",
          relativePath: path.posix.join(userId, "state", "publications", "operations", userId, entry.name),
        }, "publication operation is unsafe or corrupt");
        continue;
      }
      if (operation === null) continue;
      if (!this.publicationIdentityMatches(operation, userId, operationId)) {
        this.unsafe(report, {
          kind: "publication-candidate",
          relativePath: path.posix.join(userId, "state", "publications", "operations", userId, entry.name),
        }, "publication operation scope does not match its installation or path");
        continue;
      }
      if (!TERMINAL_PUBLICATION_STATUSES.has(operation.status)) continue;
      const updatedAtMs = Date.parse(operation.updatedAt);
      const eligibleAtMs = updatedAtMs + this.publicationCandidateRetentionMs;
      if (!Number.isFinite(updatedAtMs) || !Number.isSafeInteger(eligibleAtMs)) {
        this.unsafe(report, {
          kind: "publication-candidate",
          relativePath: path.posix.join(userId, "state", "publications", "operations", userId, entry.name),
        }, "publication retention timestamp is invalid");
        continue;
      }
      const candidatePath = path.join(publicationsRoot, operation.candidate.snapshotRelativePath);
      const relativeParent = path.posix.dirname(operation.candidate.snapshotRelativePath);
      const candidateParent = path.dirname(candidatePath);
      if (
        !inside(publicationsRoot, candidatePath)
        || !await this.privateDirectoryChain(publicationsRoot, relativeParent)
      ) {
        this.unsafe(report, {
          kind: "publication-candidate",
          relativePath: path.posix.join(userId, "state", "publications", operation.candidate.snapshotRelativePath),
        }, "publication candidate path has an unsafe directory chain");
        continue;
      }
      const canonicalParent = await realpath(candidateParent);
      if (!inside(canonicalPublications, canonicalParent) || canonicalParent === canonicalPublications) {
        this.unsafe(report, {
          kind: "publication-candidate",
          relativePath: path.posix.join(userId, "state", "publications", operation.candidate.snapshotRelativePath),
        }, "canonical publication candidate path escapes publication state");
        continue;
      }

      const expectedSnapshot = operation.candidate.snapshotRelativePath;
      const expectedUpdatedAt = operation.updatedAt;
      const revalidate = async (): Promise<"eligible" | "retained" | "missing"> => {
        let refreshed: StoredPublicationOperation | null;
        try {
          refreshed = await this.readPublicationOperation(operationPath);
        } catch {
          return "retained";
        }
        if (refreshed === null) return "missing";
        if (
          !this.publicationIdentityMatches(refreshed, userId, operationId)
          || !TERMINAL_PUBLICATION_STATUSES.has(refreshed.status)
          || refreshed.candidate.snapshotRelativePath !== expectedSnapshot
          || refreshed.updatedAt !== expectedUpdatedAt
          || !await this.privateDirectoryChain(publicationsRoot, relativeParent)
        ) {
          return "retained";
        }
        const refreshedParent = await realpath(candidateParent).catch(() => null);
        if (
          refreshedParent === null
          || !inside(canonicalPublications, refreshedParent)
          || refreshedParent === canonicalPublications
        ) {
          return "retained";
        }
        return this.now() >= eligibleAtMs ? "eligible" : "retained";
      };
      const base: Omit<Candidate, "absolutePath" | "relativePath"> = {
        kind: "publication-candidate",
        quarantinePrefix: ".gc-candidate-",
        expectedType: "file",
        expectedSize: operation.candidate.size,
        eligibleAtMs,
        lockKey: `document-publication:${operation.installationId}:${userId}:${operationId}`,
        lockManager: documentLocks,
        revalidate,
      };
      const candidateEntries = await directoryEntries(candidateParent) ?? [];
      for (const candidateEntry of candidateEntries) {
        const isCandidate = candidateEntry.name === path.basename(candidatePath);
        const isQuarantine = QUARANTINED_CANDIDATE.test(candidateEntry.name);
        if (isCandidate || isQuarantine) {
          candidates.push({
            ...base,
            absolutePath: path.join(candidateParent, candidateEntry.name),
            relativePath: path.posix.join(userId, "state", "publications", relativeParent, candidateEntry.name),
          });
        } else if (candidateEntry.name.startsWith(".gc-candidate-")) {
          this.unsafe(report, {
            kind: "publication-candidate",
            relativePath: path.posix.join(userId, "state", "publications", relativeParent, candidateEntry.name),
          }, "unexpected publication candidate quarantine name");
        }
      }
    }
    return candidates;
  }

  private async acquireCandidateLock(candidate: Candidate): Promise<ResourceLockLease | null | "locked"> {
    if (!candidate.lockKey || !candidate.lockManager) return null;
    try {
      return await candidate.lockManager.acquire(candidate.lockKey, { timeoutMs: 0 });
    } catch (error) {
      if (error instanceof ResourceLockTimeoutError) return "locked";
      throw error;
    }
  }

  private async processCandidate(
    candidate: Candidate,
    report: DocumentTemporaryMaintenanceReport,
    dryRun: boolean,
  ) {
    report.candidates += 1;
    const item = this.relativeItem(candidate);
    const lease = await this.acquireCandidateLock(candidate);
    if (lease === "locked") {
      report.skippedLocked.push(item);
      return;
    }
    try {
      const retentionState = await candidate.revalidate?.();
      if (retentionState === "missing") return;
      if (retentionState === "retained") {
        report.skippedYoung.push(item);
        return;
      }
      let metadata: Stats;
      try {
        metadata = await lstat(candidate.absolutePath);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return;
        throw error;
      }
      const safeType = candidate.expectedType === "file"
        ? privateRegularFile(metadata)
        : privateDirectory(metadata);
      if (!safeType) {
        this.unsafe(report, candidate, `${candidate.expectedType} temporary is not private and real`);
        return;
      }
      if (candidate.expectedSize !== undefined && metadata.size !== candidate.expectedSize) {
        this.unsafe(report, candidate, "publication candidate size differs from versioned operation state");
        return;
      }
      const remainsRetained = candidate.eligibleAtMs !== undefined
        ? this.now() < candidate.eligibleAtMs
        : this.now() - metadata.mtimeMs < this.gracePeriodMs;
      if (remainsRetained) {
        report.skippedYoung.push(item);
        return;
      }
      if (dryRun) {
        report.wouldRemove.push(item);
        return;
      }

      const parent = path.dirname(candidate.absolutePath);
      const quarantinePath = path.join(parent, `${candidate.quarantinePrefix}${randomUUID()}`);
      await rename(candidate.absolutePath, quarantinePath);
      let quarantined: Stats;
      try {
        quarantined = await lstat(quarantinePath);
      } catch (error) {
        throw new StorageError(
          "DOCUMENT_MAINTENANCE_RACE",
          "Quarantined document temporary disappeared before verification.",
          { cause: error },
        );
      }
      if (!sameInode(metadata, quarantined)) {
        await rename(quarantinePath, candidate.absolutePath).catch(() => undefined);
        this.unsafe(report, candidate, "temporary identity changed during quarantine");
        return;
      }
      if (candidate.expectedType === "file") {
        await unlink(quarantinePath);
      } else {
        await rm(quarantinePath, { recursive: true, force: false });
      }
      report.removed.push(item);
    } finally {
      await lease?.release();
    }
  }

  async run(options: { dryRun?: boolean; lockTimeoutMs?: number; signal?: AbortSignal } = {}) {
    const dryRun = options.dryRun ?? true;
    const startedAtMs = this.now();
    const report: DocumentTemporaryMaintenanceReport = {
      schemaVersion: 1,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(startedAtMs).toISOString(),
      dryRun,
      gracePeriodMs: this.gracePeriodMs,
      publicationCandidateRetentionMs: this.publicationCandidateRetentionMs,
      scannedUsers: 0,
      candidates: 0,
      removed: [],
      wouldRemove: [],
      skippedYoung: [],
      skippedLocked: [],
      skippedUnsafe: [],
    };

    // Validate configured roots before creating even the maintenance lock, then
    // repeat the validation after acquiring it to fail closed on root swaps.
    await this.assertRoot();
    await mkdir(this.lockManager.rootDirectory, { recursive: true, mode: 0o700 });
    return this.lockManager.withLock(
      `document-temporary-maintenance:${this.usersRoot}`,
      async () => {
        const canonicalUsers = await this.assertRoot();
        const users = await directoryEntries(this.usersRoot) ?? [];
        for (const user of users) {
          if (!USER_ID.test(user.name)) continue;
          const userRoot = path.join(this.usersRoot, user.name);
          let userMetadata: Stats;
          try {
            userMetadata = await lstat(userRoot);
          } catch (error) {
            if (isNodeError(error, "ENOENT")) continue;
            throw error;
          }
          if (!privateDirectory(userMetadata)) {
            this.unsafe(report, { kind: "incoming-upload", relativePath: user.name }, "user root is not a private real directory");
            continue;
          }
          const canonicalUser = await realpath(userRoot);
          if (!inside(canonicalUsers, canonicalUser) || canonicalUser === canonicalUsers) {
            this.unsafe(report, { kind: "incoming-upload", relativePath: user.name }, "canonical user root escapes usersRoot");
            continue;
          }
          report.scannedUsers += 1;
          const documentLocks = new ResourceLockManager({
            rootDirectory: path.join(userRoot, "state", ".locks", "documents"),
            ...this.documentLockOptions,
          });
          const candidates = [
            ...await this.scanIncoming(user.name, userRoot, documentLocks, report),
            ...await this.scanPreviews(user.name, userRoot, documentLocks, report),
            ...await this.scanPublications(user.name, userRoot, documentLocks, report),
          ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
          for (const candidate of candidates) {
            await this.processCandidate(candidate, report, dryRun);
          }
        }
        report.finishedAt = new Date(this.now()).toISOString();
        sortItems(report.removed);
        sortItems(report.wouldRemove);
        sortItems(report.skippedYoung);
        sortItems(report.skippedLocked);
        sortItems(report.skippedUnsafe);
        return report;
      },
      { timeoutMs: options.lockTimeoutMs, signal: options.signal },
    );
  }
}
