import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  publicationAuditSchema,
  publicationFreezeReceiptSchema,
  publicationOperationSchema,
  publicationPreviewSchema,
  PUBLICATION_INSTALLATION_ID,
  PUBLICATION_REQUEST_ID,
  PUBLICATION_UUID,
  type PublicationAuditEvent,
  type PublicationAuditEventType,
  type PublicationFreezeReceipt,
  type PublicationOperation,
  type PublicationOriginal,
  type PublicationPreviewMetadata,
  type StoredPublicationOperation,
} from "@/documents/publication-contract";
import { publicationBarrierLock, publicationTargetLock } from "@/documents/publication-locks";
import type { PublicationCapacityGate } from "@/documents/publication-capacity";
import { ensurePrivateDirectoryTree } from "@/documents/staging-store";
import { readRegularFileWithin, UnsafeFilePathError } from "@/security/safe-file";
import { atomicWriteFile, atomicWriteJson } from "@/storage/atomic-file";
import { StorageError } from "@/storage/errors";
import { FileJournal } from "@/storage/journal";
import type { ResourceLockManager } from "@/storage/resource-lock";

const DEFAULT_MAXIMUM_CANDIDATE_BYTES = 200 * 1024 * 1024;
const DEFAULT_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

type PublicationHookStage =
  | "candidate-frozen"
  | "publishing-recorded"
  | "version-created"
  | "target-written"
  | "audit-recorded"
  | "published-recorded";

export type FileDocumentPublisherOptions = {
  installationId: string;
  userId: string;
  stagingRoot: string;
  publishWriteRoot: string;
  stateRoot: string;
  workerVisibleRoots: readonly string[];
  lockManager: ResourceLockManager;
  targetLockManager?: ResourceLockManager;
  confirmationSecret: string | Uint8Array;
  capacityGate: PublicationCapacityGate;
  maximumCandidateBytes?: number;
  confirmationTtlMs?: number;
  now?: () => number;
  onStage?: (stage: PublicationHookStage, operationId: string) => void | Promise<void>;
};

export type FreezePublicationInput = {
  operationId: string;
  clientRequestId: string;
  threadId: string;
  turnId: string;
  candidateRelativePath: string;
  targetRelativePath: string;
  preview: PublicationPreviewMetadata;
};

export type DecidePublicationInput = {
  operationId: string;
  clientRequestId: string;
  threadId: string;
  turnId: string;
  confirmationToken: string;
};

export type PublicationIdentity = {
  operationId: string;
  threadId: string;
  turnId: string;
};

type TargetSnapshot = {
  metadata: PublicationOriginal;
  data: Buffer | null;
};

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error && typeof error === "object" && "code" in error &&
    (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function pathsOverlap(left: string, right: string) {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateAbsoluteRoot(name: string, value: string) {
  if (!path.isAbsolute(value)) {
    throw new StorageError("PUBLICATION_OPTIONS_INVALID", `${name} must be an absolute path.`);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new StorageError("PUBLICATION_OPTIONS_INVALID", `${name} must not be a filesystem root.`);
  }
  return resolved;
}

function validateRequestId(value: string) {
  if (!PUBLICATION_REQUEST_ID.test(value)) {
    throw new StorageError("PUBLICATION_INPUT_INVALID", "clientRequestId has an invalid format.");
  }
  return value;
}

function validateUuid(name: string, value: string) {
  if (!PUBLICATION_UUID.test(value)) {
    throw new StorageError("PUBLICATION_INPUT_INVALID", `${name} must be a lowercase UUID.`);
  }
  return value;
}

function validateRelativeFilePath(name: string, value: string) {
  if (
    value.length < 1 || value.length > 500 || path.posix.isAbsolute(value) ||
    value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new StorageError("PUBLICATION_PATH_INVALID", `${name} is not a safe relative path.`);
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    path.posix.normalize(value) !== value
  ) {
    throw new StorageError("PUBLICATION_PATH_INVALID", `${name} contains an unsafe path segment.`);
  }
  return value;
}

function safeExtension(fileName: string) {
  const extension = path.posix.extname(fileName);
  return /^\.[A-Za-z0-9]{1,16}$/.test(extension) ? extension.toLowerCase() : "";
}

function canonicalFreezeFingerprint(input: {
  operationId: string;
  threadId: string;
  turnId: string;
  candidateRelativePath: string;
  targetRelativePath: string;
  preview: PublicationPreviewMetadata;
}) {
  return sha256(JSON.stringify({
    action: "freeze",
    operationId: input.operationId,
    threadId: input.threadId,
    turnId: input.turnId,
    candidateRelativePath: input.candidateRelativePath,
    targetRelativePath: input.targetRelativePath,
    preview: {
      schemaVersion: input.preview.schemaVersion,
      previewId: input.preview.previewId,
      threadId: input.preview.threadId,
      turnId: input.preview.turnId,
      candidateSha256: input.preview.candidateSha256,
      status: input.preview.status,
      artifacts: input.preview.artifacts,
      createdAt: input.preview.createdAt,
    },
  }));
}

function canonicalDecisionFingerprint(
  decision: "confirm" | "decline",
  input: DecidePublicationInput,
) {
  return sha256(JSON.stringify({
    action: decision,
    operationId: input.operationId,
    threadId: input.threadId,
    turnId: input.turnId,
    confirmationTokenHash: sha256(input.confirmationToken),
  }));
}

/**
 * Server-side publication capability.
 *
 * The write root is an ECMAScript private field and never appears in returned
 * records. The service must only be constructed in the trusted Next.js server
 * process; workers receive staging/source roots, never this capability.
 */
export class FileDocumentPublisher {
  readonly installationId: string;
  readonly userId: string;
  readonly maximumCandidateBytes: number;
  readonly confirmationTtlMs: number;

  readonly #stagingRoot: string;
  readonly #publishWriteRoot: string;
  readonly #stateRoot: string;
  readonly #lockManager: ResourceLockManager;
  readonly #targetLockManager: ResourceLockManager;
  readonly #confirmationSecret: Buffer;
  readonly #capacityGate: PublicationCapacityGate;
  readonly #now: () => number;
  readonly #onStage?: FileDocumentPublisherOptions["onStage"];
  readonly #audit: FileJournal<PublicationAuditEvent>;

  constructor(options: FileDocumentPublisherOptions) {
    if (!PUBLICATION_INSTALLATION_ID.test(options.installationId)) {
      throw new StorageError("PUBLICATION_OPTIONS_INVALID", "installationId has an invalid format.");
    }
    if (!PUBLICATION_UUID.test(options.userId)) {
      throw new StorageError("PUBLICATION_OPTIONS_INVALID", "userId must be a lowercase UUID.");
    }
    const stagingRoot = validateAbsoluteRoot("stagingRoot", options.stagingRoot);
    const publishWriteRoot = validateAbsoluteRoot("publishWriteRoot", options.publishWriteRoot);
    const stateRoot = validateAbsoluteRoot("stateRoot", options.stateRoot);
    const roots = [stagingRoot, publishWriteRoot, stateRoot];
    for (let left = 0; left < roots.length; left += 1) {
      for (let right = left + 1; right < roots.length; right += 1) {
        if (pathsOverlap(roots[left], roots[right]) || pathsOverlap(roots[right], roots[left])) {
          throw new StorageError("PUBLICATION_OPTIONS_INVALID", "Staging, publication and state roots must not overlap.");
        }
      }
    }
    if (options.workerVisibleRoots.length === 0) {
      throw new StorageError("PUBLICATION_OPTIONS_INVALID", "workerVisibleRoots must explicitly declare the worker filesystem boundary.");
    }
    for (const rawWorkerRoot of options.workerVisibleRoots) {
      const workerRoot = validateAbsoluteRoot("workerVisibleRoots entry", rawWorkerRoot);
      if (pathsOverlap(workerRoot, publishWriteRoot) || pathsOverlap(publishWriteRoot, workerRoot)) {
        throw new StorageError("PUBLICATION_WORKER_BOUNDARY_INVALID", "Publication write root overlaps a worker-visible root.");
      }
    }
    const secret = Buffer.from(options.confirmationSecret);
    if (secret.byteLength < 32) {
      throw new StorageError("PUBLICATION_OPTIONS_INVALID", "confirmationSecret must contain at least 32 bytes.");
    }
    const maximumCandidateBytes = options.maximumCandidateBytes ?? DEFAULT_MAXIMUM_CANDIDATE_BYTES;
    const confirmationTtlMs = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    if (!Number.isSafeInteger(maximumCandidateBytes) || maximumCandidateBytes < 1 || maximumCandidateBytes > DEFAULT_MAXIMUM_CANDIDATE_BYTES) {
      throw new StorageError("PUBLICATION_OPTIONS_INVALID", "maximumCandidateBytes must be between 1 and 200 MiB.");
    }
    if (!Number.isSafeInteger(confirmationTtlMs) || confirmationTtlMs < 1) {
      throw new StorageError("PUBLICATION_OPTIONS_INVALID", "confirmationTtlMs must be a positive safe integer.");
    }
    if (!options.capacityGate || typeof options.capacityGate.run !== "function") {
      throw new StorageError("PUBLICATION_OPTIONS_INVALID", "capacityGate is required.");
    }

    this.installationId = options.installationId;
    this.userId = options.userId;
    this.maximumCandidateBytes = maximumCandidateBytes;
    this.confirmationTtlMs = confirmationTtlMs;
    this.#stagingRoot = stagingRoot;
    this.#publishWriteRoot = publishWriteRoot;
    this.#stateRoot = stateRoot;
    this.#lockManager = options.lockManager;
    this.#targetLockManager = options.targetLockManager ?? options.lockManager;
    this.#confirmationSecret = secret;
    this.#capacityGate = options.capacityGate;
    this.#now = options.now ?? Date.now;
    this.#onStage = options.onStage;
    this.#audit = new FileJournal({
      filePath: path.join(stateRoot, "audit", options.installationId, "publication.jsonl"),
      lockManager: options.lockManager,
      payloadSchema: publicationAuditSchema,
      now: this.#now,
    });
  }

  #operationRelativePath(operationId: string) {
    return path.posix.join("operations", this.userId, `${operationId}.json`);
  }

  #operationPath(operationId: string) {
    return path.join(this.#stateRoot, this.#operationRelativePath(operationId));
  }

  #receiptRelativePath(kind: "freeze" | "decision", requestHash: string) {
    return path.posix.join("requests", this.userId, `${kind}-${requestHash}.json`);
  }

  #candidateRelativePath(threadId: string, operationId: string, extension: string) {
    return path.posix.join("candidates", this.userId, threadId, operationId, `candidate${extension}`);
  }

  #versionRelativePath(operationId: string, extension: string) {
    return path.posix.join("versions", this.userId, operationId, `original${extension}`);
  }

  #operationLock(operationId: string) {
    return `document-publication:${this.installationId}:${this.userId}:${operationId}`;
  }

  #receiptLock(kind: "freeze" | "decision", requestHash: string) {
    return `document-publication-request:${this.installationId}:${this.userId}:${kind}:${requestHash}`;
  }

  #targetLock(targetRelativePath: string) {
    return publicationTargetLock(this.installationId, targetRelativePath);
  }

  #timestamp() {
    return new Date(this.#now()).toISOString();
  }

  async #ensureStateDirectories(segments: readonly string[]) {
    return ensurePrivateDirectoryTree(this.#stateRoot, segments);
  }

  async #readStateJson<T>(relativePath: string, schema: { parse(value: unknown, source?: string): T }) {
    try {
      const data = await readRegularFileWithin(this.#stateRoot, relativePath, 1024 * 1024);
      return schema.parse(JSON.parse(data.toString("utf8")), path.join(this.#stateRoot, relativePath));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new StorageError("PUBLICATION_STATE_CORRUPT", "Publication state contains invalid JSON.", { cause: error });
      }
      throw error;
    }
  }

  async #readOperation(operationId: string) {
    try {
      return await this.#readStateJson(this.#operationRelativePath(operationId), publicationOperationSchema);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new StorageError("PUBLICATION_NOT_FOUND", "Publication operation was not found.");
      }
      throw error;
    }
  }

  async #writeOperation(operation: StoredPublicationOperation) {
    await this.#ensureStateDirectories(["operations", this.userId]);
    await atomicWriteJson(this.#operationPath(operation.operationId), operation, publicationOperationSchema);
  }

  #assertIdentity(operation: StoredPublicationOperation, identity: PublicationIdentity) {
    if (
      operation.installationId !== this.installationId || operation.userId !== this.userId ||
      operation.operationId !== identity.operationId || operation.threadId !== identity.threadId ||
      operation.turnId !== identity.turnId
    ) {
      throw new StorageError("PUBLICATION_SCOPE_MISMATCH", "Publication operation does not belong to this user, thread and turn.");
    }
  }

  #redact(operation: StoredPublicationOperation): PublicationOperation {
    const {
      confirmationTokenHash: _confirmationTokenHash,
      creationRequestHash: _creationRequestHash,
      decisionRequestHash: _decisionRequestHash,
      candidate,
      version,
      ...visible
    } = operation;
    return {
      ...visible,
      candidate: {
        fileName: candidate.fileName,
        size: candidate.size,
        sha256: candidate.sha256,
      },
      version: version ? {
        size: version.size,
        sha256: version.sha256,
        createdAt: version.createdAt,
      } : null,
    };
  }

  #tokenFor(operation: StoredPublicationOperation) {
    const payload = [
      "v1", operation.installationId, operation.userId, operation.threadId,
      operation.turnId, operation.operationId, operation.confirmationExpiresAt,
    ].join(":");
    const signature = createHmac("sha256", this.#confirmationSecret).update(payload).digest("base64url");
    return `v1.${Date.parse(operation.confirmationExpiresAt)}.${signature}`;
  }

  #assertConfirmationToken(operation: StoredPublicationOperation, supplied: string) {
    const expected = this.#tokenFor(operation);
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    if (
      suppliedBuffer.byteLength !== expectedBuffer.byteLength ||
      !timingSafeEqual(suppliedBuffer, expectedBuffer) ||
      sha256(supplied) !== operation.confirmationTokenHash
    ) {
      throw new StorageError("PUBLICATION_TOKEN_INVALID", "Publication confirmation token is invalid.");
    }
  }

  async #writeReceipt(
    kind: "freeze" | "decision",
    requestHash: string,
    requestFingerprint: string,
    operationId: string,
  ) {
    const relativePath = this.#receiptRelativePath(kind, requestHash);
    const absolutePath = path.join(this.#stateRoot, relativePath);
    try {
      const existing = await this.#readStateJson(relativePath, publicationFreezeReceiptSchema);
      if (existing.requestFingerprint !== requestFingerprint || existing.operationId !== operationId) {
        throw new StorageError("PUBLICATION_REQUEST_CONFLICT", "clientRequestId was already used for a different publication request.");
      }
      return existing;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    const receipt: PublicationFreezeReceipt = {
      schemaVersion: 1,
      requestHash,
      requestFingerprint,
      operationId,
      createdAt: this.#timestamp(),
    };
    await this.#ensureStateDirectories(["requests", this.userId]);
    await atomicWriteJson(absolutePath, receipt, publicationFreezeReceiptSchema);
    return receipt;
  }

  async #assertSafeTargetParent(targetRelativePath: string) {
    const rootMetadata = await lstat(this.#publishWriteRoot);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new StorageError("PUBLICATION_TARGET_UNSAFE", "Publication root is not a regular directory.");
    }
    const canonicalRoot = await realpath(this.#publishWriteRoot);
    let current = this.#publishWriteRoot;
    const parentSegments = targetRelativePath.split("/").slice(0, -1);
    for (const segment of parentSegments) {
      current = path.join(current, segment);
      let metadata;
      try {
        metadata = await lstat(current);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) {
          throw new StorageError("PUBLICATION_TARGET_PARENT_MISSING", "Publication target directory does not exist.");
        }
        throw error;
      }
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new StorageError("PUBLICATION_TARGET_UNSAFE", "Publication target path contains a symbolic link or non-directory.");
      }
      const canonicalCurrent = await realpath(current);
      if (!pathsOverlap(canonicalRoot, canonicalCurrent)) {
        throw new StorageError("PUBLICATION_TARGET_UNSAFE", "Publication target resolves outside the write root.");
      }
    }
  }

  async #readTarget(targetRelativePath: string): Promise<TargetSnapshot> {
    await this.#assertSafeTargetParent(targetRelativePath);
    const absolutePath = path.join(this.#publishWriteRoot, targetRelativePath);
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { metadata: { exists: false, size: null, sha256: null, mtimeMs: null }, data: null };
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new StorageError("PUBLICATION_TARGET_UNSAFE", "Publication target must be a regular file.");
    }
    let data: Buffer;
    try {
      data = await readRegularFileWithin(this.#publishWriteRoot, targetRelativePath, this.maximumCandidateBytes);
    } catch (error) {
      if (error instanceof UnsafeFilePathError) {
        throw new StorageError("PUBLICATION_TARGET_UNSAFE", error.message, { cause: error });
      }
      throw error;
    }
    const after = await lstat(absolutePath);
    if (
      after.isSymbolicLink() || !after.isFile() || after.dev !== metadata.dev || after.ino !== metadata.ino ||
      after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs
    ) {
      throw new StorageError("PUBLICATION_TARGET_CHANGED", "Publication target changed while it was being inspected.");
    }
    return {
      metadata: {
        exists: true,
        size: data.byteLength,
        sha256: sha256(data),
        mtimeMs: after.mtimeMs,
      },
      data,
    };
  }

  #sameOriginal(left: PublicationOriginal, right: PublicationOriginal) {
    return left.exists === right.exists && left.size === right.size && left.sha256 === right.sha256 && left.mtimeMs === right.mtimeMs;
  }

  async #auditEvent(
    operation: StoredPublicationOperation,
    eventType: PublicationAuditEventType,
    clientRequestHash: string,
    options: {
      resultSha256?: string | null;
      recoveredAfterInterruption?: boolean;
      occurredAt?: string;
    } = {},
  ) {
    await this.#ensureStateDirectories(["audit", this.installationId]);
    const auditKey = sha256([
      operation.installationId, operation.userId, operation.operationId,
      eventType, clientRequestHash,
    ].join(":"));
    const event: PublicationAuditEvent = {
      schemaVersion: 1,
      auditKey,
      eventType,
      operationId: operation.operationId,
      installationId: operation.installationId,
      userId: operation.userId,
      threadId: operation.threadId,
      turnId: operation.turnId,
      targetPathHash: sha256(operation.targetRelativePath),
      candidateSha256: operation.candidate.sha256,
      originalSha256: operation.original.sha256,
      resultSha256: options.resultSha256 ?? null,
      clientRequestHash,
      recoveredAfterInterruption: options.recoveredAfterInterruption ?? false,
      occurredAt: options.occurredAt ?? this.#timestamp(),
    };
    await this.#audit.appendIf(event, (entries) =>
      !entries.some((entry) => entry.payload.auditKey === auditKey));
    await this.#onStage?.("audit-recorded", operation.operationId);
  }

  #expirationRequestHash(operation: StoredPublicationOperation) {
    return sha256([
      "publication-expiration-v1",
      operation.installationId,
      operation.userId,
      operation.threadId,
      operation.turnId,
      operation.operationId,
      operation.confirmationExpiresAt,
    ].join(":"));
  }

  async #reconcileExpiration(operation: StoredPublicationOperation) {
    if (operation.status === "expired") {
      await this.#auditEvent(
        operation,
        "expired",
        operation.decisionRequestHash ?? this.#expirationRequestHash(operation),
        { occurredAt: operation.confirmationExpiresAt },
      );
      return operation;
    }
    if (
      operation.status !== "awaiting_confirmation" ||
      this.#now() < Date.parse(operation.confirmationExpiresAt)
    ) {
      return operation;
    }
    const expirationRequestHash = this.#expirationRequestHash(operation);
    const expired: StoredPublicationOperation = {
      ...operation,
      status: "expired",
      decisionRequestHash: expirationRequestHash,
      updatedAt: operation.confirmationExpiresAt,
    };
    await this.#writeOperation(expired);
    await this.#auditEvent(expired, "expired", expirationRequestHash, {
      occurredAt: expired.confirmationExpiresAt,
    });
    return expired;
  }

  async freezeCandidate(input: FreezePublicationInput) {
    const operationId = validateUuid("operationId", input.operationId);
    const threadId = validateUuid("threadId", input.threadId);
    const turnId = validateUuid("turnId", input.turnId);
    const clientRequestId = validateRequestId(input.clientRequestId);
    const candidateRelativePath = validateRelativeFilePath("candidateRelativePath", input.candidateRelativePath);
    const targetRelativePath = validateRelativeFilePath("targetRelativePath", input.targetRelativePath);
    const preview = publicationPreviewSchema.parse(input.preview);
    if (preview.threadId !== threadId || preview.turnId !== turnId) {
      throw new StorageError("PUBLICATION_PREVIEW_MISMATCH", "Preview does not belong to this thread and turn.");
    }
    const requestHash = sha256(clientRequestId);
    const requestFingerprint = canonicalFreezeFingerprint({
      operationId, threadId, turnId, candidateRelativePath, targetRelativePath, preview,
    });

    return this.#lockManager.withLock(this.#receiptLock("freeze", requestHash), async () => {
      await this.#writeReceipt("freeze", requestHash, requestFingerprint, operationId);
      return this.#lockManager.withLock(this.#operationLock(operationId), async () => {
        try {
          let existing = await this.#readOperation(operationId);
          this.#assertIdentity(existing, { operationId, threadId, turnId });
          if (existing.creationRequestHash !== requestFingerprint) {
            throw new StorageError("PUBLICATION_REQUEST_CONFLICT", "Operation id already identifies a different frozen candidate.");
          }
          await this.#auditEvent(existing, "frozen", requestHash);
          existing = await this.#reconcileExpiration(existing);
          return { operation: this.#redact(existing), confirmationToken: this.#tokenFor(existing) };
        } catch (error) {
          if (!(error instanceof StorageError && error.code === "PUBLICATION_NOT_FOUND")) throw error;
        }

        let candidateData: Buffer;
        try {
          candidateData = await readRegularFileWithin(this.#stagingRoot, candidateRelativePath, this.maximumCandidateBytes);
        } catch (error) {
          if (error instanceof UnsafeFilePathError) {
            throw new StorageError("PUBLICATION_CANDIDATE_UNSAFE", error.message, { cause: error });
          }
          throw error;
        }
        if (candidateData.byteLength === 0) {
          throw new StorageError("PUBLICATION_CANDIDATE_INVALID", "Publication candidate must not be empty.");
        }
        const candidateSha256 = sha256(candidateData);
        if (candidateSha256 !== preview.candidateSha256) {
          throw new StorageError("PUBLICATION_PREVIEW_MISMATCH", "Preview hash does not match the staged candidate.");
        }
        const original = await this.#lockManager.withLock(
          this.#targetLock(targetRelativePath),
          async () => (await this.#readTarget(targetRelativePath)).metadata,
        );
        const extension = safeExtension(path.posix.basename(candidateRelativePath));
        const snapshotRelativePath = this.#candidateRelativePath(threadId, operationId, extension);
        await this.#ensureStateDirectories(["candidates", this.userId, threadId, operationId]);
        const snapshotPath = path.join(this.#stateRoot, snapshotRelativePath);
        try {
          const existingSnapshot = await readRegularFileWithin(this.#stateRoot, snapshotRelativePath, this.maximumCandidateBytes);
          if (sha256(existingSnapshot) !== candidateSha256) {
            throw new StorageError("PUBLICATION_STATE_CORRUPT", "Frozen candidate snapshot contains different content.");
          }
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
          await atomicWriteFile(snapshotPath, candidateData, { mode: 0o400 });
        }
        await this.#onStage?.("candidate-frozen", operationId);
        const createdAt = this.#timestamp();
        const partial: Omit<StoredPublicationOperation, "confirmationTokenHash"> = {
          schemaVersion: 1,
          operationId,
          installationId: this.installationId,
          userId: this.userId,
          threadId,
          turnId,
          targetRelativePath,
          status: "awaiting_confirmation",
          candidate: {
            fileName: path.posix.basename(candidateRelativePath),
            size: candidateData.byteLength,
            sha256: candidateSha256,
            snapshotRelativePath,
          },
          preview,
          original,
          confirmationExpiresAt: new Date(this.#now() + this.confirmationTtlMs).toISOString(),
          creationRequestHash: requestFingerprint,
          decisionRequestHash: null,
          version: null,
          result: null,
          createdAt,
          updatedAt: createdAt,
        };
        const token = this.#tokenFor({ ...partial, confirmationTokenHash: "0".repeat(64) });
        const operation: StoredPublicationOperation = {
          ...partial,
          confirmationTokenHash: sha256(token),
        };
        await this.#writeOperation(operation);
        await this.#auditEvent(operation, "frozen", requestHash);
        return { operation: this.#redact(operation), confirmationToken: token };
      });
    });
  }

  async confirm(input: DecidePublicationInput) {
    return this.#decide("confirm", input);
  }

  async decline(input: DecidePublicationInput) {
    return this.#decide("decline", input);
  }

  async #decide(decision: "confirm" | "decline", input: DecidePublicationInput) {
    const operationId = validateUuid("operationId", input.operationId);
    const threadId = validateUuid("threadId", input.threadId);
    const turnId = validateUuid("turnId", input.turnId);
    const clientRequestId = validateRequestId(input.clientRequestId);
    if (typeof input.confirmationToken !== "string" || input.confirmationToken.length > 256) {
      throw new StorageError("PUBLICATION_TOKEN_INVALID", "Publication confirmation token is invalid.");
    }
    const requestHash = sha256(clientRequestId);
    const fingerprint = canonicalDecisionFingerprint(decision, input);
    return this.#lockManager.withLock(this.#receiptLock("decision", requestHash), async () => {
      await this.#writeReceipt("decision", requestHash, fingerprint, operationId);
      return this.#lockManager.withLock(this.#operationLock(operationId), async () => {
        let operation = await this.#readOperation(operationId);
        this.#assertIdentity(operation, { operationId, threadId, turnId });
        this.#assertConfirmationToken(operation, input.confirmationToken);
        operation = await this.#reconcileExpiration(operation);

        if (operation.status === "expired") {
          if (decision === "decline") return this.#redact(operation);
          throw new StorageError("PUBLICATION_TOKEN_EXPIRED", "Publication confirmation token has expired.");
        }

        if (operation.status === "declined") {
          if (decision === "decline" && operation.decisionRequestHash === requestHash) {
            await this.#auditEvent(operation, "declined", requestHash);
            return this.#redact(operation);
          }
          throw new StorageError("PUBLICATION_ALREADY_DECIDED", "Publication was already declined.");
        }
        if (operation.status === "published") {
          if (decision === "confirm" && operation.decisionRequestHash === requestHash) {
            await this.#auditEvent(operation, "published", requestHash, {
              resultSha256: operation.result?.sha256,
              recoveredAfterInterruption: operation.result?.recoveredAfterInterruption,
            });
            return this.#redact(operation);
          }
          throw new StorageError("PUBLICATION_ALREADY_DECIDED", "Publication was already published.");
        }
        if (operation.status === "conflict") {
          if (decision === "confirm" && operation.decisionRequestHash === requestHash) {
            await this.#auditEvent(operation, "conflict", requestHash);
            return this.#redact(operation);
          }
          throw new StorageError("PUBLICATION_ALREADY_DECIDED", "Publication ended with an original-file conflict.");
        }
        if (operation.status === "publishing" && operation.decisionRequestHash !== requestHash) {
          throw new StorageError("PUBLICATION_ALREADY_DECIDED", "Publication is already being completed by another request.");
        }
        if (decision === "decline") {
          if (operation.status !== "awaiting_confirmation") {
            throw new StorageError("PUBLICATION_ALREADY_DECIDED", "A publishing operation cannot be declined.");
          }
          operation = {
            ...operation,
            status: "declined",
            decisionRequestHash: requestHash,
            updatedAt: this.#timestamp(),
          };
          await this.#writeOperation(operation);
          await this.#auditEvent(operation, "declined", requestHash);
          return this.#redact(operation);
        }

        return this.#capacityGate.run(operation.candidate.size, async () => {
          if (operation.status === "awaiting_confirmation") {
            operation = {
              ...operation,
              status: "publishing",
              decisionRequestHash: requestHash,
              updatedAt: this.#timestamp(),
            };
            await this.#writeOperation(operation);
            await this.#onStage?.("publishing-recorded", operationId);
          }

          const candidateData = await readRegularFileWithin(
            this.#stateRoot,
            operation.candidate.snapshotRelativePath,
            this.maximumCandidateBytes,
          );
          if (candidateData.byteLength !== operation.candidate.size || sha256(candidateData) !== operation.candidate.sha256) {
            throw new StorageError("PUBLICATION_STATE_CORRUPT", "Frozen publication candidate failed integrity verification.");
          }

          return this.#targetLockManager.withLock(publicationBarrierLock(this.installationId), () =>
          this.#targetLockManager.withLock(this.#targetLock(operation.targetRelativePath), async () => {
          let current = await this.#readTarget(operation.targetRelativePath);
          const targetAlreadyContainsCandidate =
            current.metadata.exists && current.metadata.size === operation.candidate.size &&
            current.metadata.sha256 === operation.candidate.sha256;

        if (!targetAlreadyContainsCandidate || (operation.original.exists && !operation.version)) {
          if (!this.#sameOriginal(operation.original, current.metadata)) {
            operation = {
              ...operation,
              status: "conflict",
              updatedAt: this.#timestamp(),
            };
            await this.#writeOperation(operation);
            await this.#auditEvent(operation, "conflict", requestHash);
            return this.#redact(operation);
          }

          if (operation.original.exists && !operation.version) {
            if (!current.data) {
              throw new StorageError("PUBLICATION_STATE_CORRUPT", "Original content disappeared before versioning.");
            }
            const extension = safeExtension(path.posix.basename(operation.targetRelativePath));
            const versionRelativePath = this.#versionRelativePath(operationId, extension);
            await this.#ensureStateDirectories(["versions", this.userId, operationId]);
            await atomicWriteFile(path.join(this.#stateRoot, versionRelativePath), current.data, { mode: 0o400 });
            operation = {
              ...operation,
              version: {
                size: current.data.byteLength,
                sha256: sha256(current.data),
                versionRelativePath,
                createdAt: this.#timestamp(),
              },
              updatedAt: this.#timestamp(),
            };
            await this.#writeOperation(operation);
            await this.#onStage?.("version-created", operationId);
          }

          current = await this.#readTarget(operation.targetRelativePath);
          if (!this.#sameOriginal(operation.original, current.metadata)) {
            operation = {
              ...operation,
              status: "conflict",
              updatedAt: this.#timestamp(),
            };
            await this.#writeOperation(operation);
            await this.#auditEvent(operation, "conflict", requestHash);
            return this.#redact(operation);
          }
          await this.#assertSafeTargetParent(operation.targetRelativePath);
          try {
            await atomicWriteFile(
              path.join(this.#publishWriteRoot, operation.targetRelativePath),
              candidateData,
              {
                mode: 0o600,
                onStage: async (stage) => {
                  if (stage !== "temporary-synced") return;
                  const justBeforeRename = await this.#readTarget(operation.targetRelativePath);
                  if (!this.#sameOriginal(operation.original, justBeforeRename.metadata)) {
                    throw new StorageError(
                      "PUBLICATION_ORIGINAL_CONFLICT",
                      "Original changed while the candidate was being prepared for atomic publication.",
                    );
                  }
                },
              },
            );
          } catch (error) {
            if (!(error instanceof StorageError && error.code === "PUBLICATION_ORIGINAL_CONFLICT")) throw error;
            operation = {
              ...operation,
              status: "conflict",
              updatedAt: this.#timestamp(),
            };
            await this.#writeOperation(operation);
            await this.#auditEvent(operation, "conflict", requestHash);
            return this.#redact(operation);
          }
          await this.#onStage?.("target-written", operationId);
          current = await this.#readTarget(operation.targetRelativePath);
        } else if (operation.version) {
          const versionData = await readRegularFileWithin(
            this.#stateRoot,
            operation.version.versionRelativePath,
            this.maximumCandidateBytes,
          );
          if (versionData.byteLength !== operation.version.size || sha256(versionData) !== operation.version.sha256) {
            throw new StorageError("PUBLICATION_STATE_CORRUPT", "Recovery version failed integrity verification.");
          }
        }

        if (
          !current.metadata.exists || current.metadata.size !== operation.candidate.size ||
          current.metadata.sha256 !== operation.candidate.sha256
        ) {
          throw new StorageError("PUBLICATION_TARGET_CHANGED", "Publication target failed post-write integrity verification.");
        }
        const recoveredAfterInterruption = targetAlreadyContainsCandidate;
        const publishedAt = this.#timestamp();
        await this.#auditEvent(operation, "published", requestHash, {
          resultSha256: operation.candidate.sha256,
          recoveredAfterInterruption,
        });
        operation = {
          ...operation,
          status: "published",
          result: {
            size: operation.candidate.size,
            sha256: operation.candidate.sha256,
            publishedAt,
            recoveredAfterInterruption,
          },
          updatedAt: publishedAt,
        };
        await this.#writeOperation(operation);
        await this.#onStage?.("published-recorded", operationId);
        return this.#redact(operation);
          }));
        });
      });
    });
  }

  async getOperation(identity: PublicationIdentity) {
    validateUuid("operationId", identity.operationId);
    validateUuid("threadId", identity.threadId);
    validateUuid("turnId", identity.turnId);
    return this.#lockManager.withLock(this.#operationLock(identity.operationId), async () => {
      let operation = await this.#readOperation(identity.operationId);
      this.#assertIdentity(operation, identity);
      operation = await this.#reconcileExpiration(operation);
      return this.#redact(operation);
    });
  }

  async readRecoveryVersion(identity: PublicationIdentity) {
    validateUuid("operationId", identity.operationId);
    validateUuid("threadId", identity.threadId);
    validateUuid("turnId", identity.turnId);
    return this.#lockManager.withLock(this.#operationLock(identity.operationId), async () => {
      const operation = await this.#readOperation(identity.operationId);
      this.#assertIdentity(operation, identity);
      if (!operation.version) {
        throw new StorageError("PUBLICATION_VERSION_NOT_FOUND", "Publication has no recovery version.");
      }
      const data = await readRegularFileWithin(
        this.#stateRoot,
        operation.version.versionRelativePath,
        this.maximumCandidateBytes,
      );
      if (data.byteLength !== operation.version.size || sha256(data) !== operation.version.sha256) {
        throw new StorageError("PUBLICATION_STATE_CORRUPT", "Recovery version failed integrity verification.");
      }
      return data;
    });
  }

  async readAudit() {
    return (await this.#audit.read())
      .map((entry) => entry.payload)
      .filter((event) => event.installationId === this.installationId && event.userId === this.userId);
  }
}
