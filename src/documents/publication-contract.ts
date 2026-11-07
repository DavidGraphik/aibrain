import {
  defineVersionedSchema,
  expectArray,
  expectBoolean,
  expectFiniteNumber,
  expectInteger,
  expectIsoDate,
  expectOneOf,
  expectStrictRecord,
  expectString,
  type StorageSchema,
  type ValidationContext,
} from "@/storage/schema";

export const PUBLICATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PUBLICATION_SHA256 = /^[0-9a-f]{64}$/;
export const PUBLICATION_INSTALLATION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const PUBLICATION_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PUBLICATION_STATE_CANDIDATE_PATH = /^candidates\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/candidate(?:\.[a-z0-9]{1,16})?$/;
const PUBLICATION_STATE_VERSION_PATH = /^versions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/original(?:\.[a-z0-9]{1,16})?$/;

export type PublicationStatus =
  | "awaiting_confirmation"
  | "publishing"
  | "published"
  | "declined"
  | "expired"
  | "conflict";

export type PublicationPreviewMetadata = {
  schemaVersion: 1;
  previewId: string;
  threadId: string;
  turnId: string;
  candidateSha256: string;
  status: "ready";
  artifacts: string[];
  createdAt: string;
};

export type PublicationCandidate = {
  fileName: string;
  size: number;
  sha256: string;
  snapshotRelativePath: string;
};

export type PublicationOriginal = {
  exists: boolean;
  size: number | null;
  sha256: string | null;
  mtimeMs: number | null;
};

export type PublicationVersion = {
  size: number;
  sha256: string;
  versionRelativePath: string;
  createdAt: string;
};

export type PublicationResult = {
  size: number;
  sha256: string;
  publishedAt: string;
  recoveredAfterInterruption: boolean;
};

export type StoredPublicationOperation = {
  schemaVersion: 1;
  operationId: string;
  installationId: string;
  userId: string;
  threadId: string;
  turnId: string;
  targetRelativePath: string;
  status: PublicationStatus;
  candidate: PublicationCandidate;
  preview: PublicationPreviewMetadata;
  original: PublicationOriginal;
  confirmationTokenHash: string;
  confirmationExpiresAt: string;
  creationRequestHash: string;
  decisionRequestHash: string | null;
  version: PublicationVersion | null;
  result: PublicationResult | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicationOperation = Omit<
  StoredPublicationOperation,
  "confirmationTokenHash" | "creationRequestHash" | "decisionRequestHash" | "candidate" | "version"
> & {
  candidate: Omit<PublicationCandidate, "snapshotRelativePath">;
  version: Omit<PublicationVersion, "versionRelativePath"> | null;
};

export type PublicationFreezeReceipt = {
  schemaVersion: 1;
  requestHash: string;
  requestFingerprint: string;
  operationId: string;
  createdAt: string;
};

export type PublicationAuditEventType = "frozen" | "declined" | "expired" | "conflict" | "published";

export type PublicationAuditEvent = {
  schemaVersion: 1;
  auditKey: string;
  eventType: PublicationAuditEventType;
  operationId: string;
  installationId: string;
  userId: string;
  threadId: string;
  turnId: string;
  targetPathHash: string;
  candidateSha256: string;
  originalSha256: string | null;
  resultSha256: string | null;
  clientRequestHash: string;
  recoveredAfterInterruption: boolean;
  occurredAt: string;
};

function parseNullableString(
  value: unknown,
  context: ValidationContext,
  pattern: RegExp,
) {
  return value === null ? null : expectString(value, context, { pattern });
}

function parseSafeRelativePath(value: unknown, context: ValidationContext) {
  const text = expectString(value, context, { minLength: 1, maxLength: 500 });
  if (
    text.startsWith("/") || text.includes("\\") || /[\u0000-\u001f\u007f]/.test(text) ||
    text.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    context.fail("expected a normalized relative path without traversal");
  }
  return text;
}

function parsePreview(value: unknown, context: ValidationContext): PublicationPreviewMetadata {
  const record = expectStrictRecord(value, [
    "schemaVersion", "previewId", "threadId", "turnId", "candidateSha256",
    "status", "artifacts", "createdAt",
  ], context);
  if (record.schemaVersion !== 1) context.at("schemaVersion").fail("expected literal 1");
  const artifacts = expectArray(record.artifacts, context.at("artifacts"), (item, itemContext) =>
    expectString(item, itemContext, {
      minLength: 1,
      maxLength: 160,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/,
    }), { maxLength: 32 });
  if (artifacts.length === 0) context.at("artifacts").fail("expected at least one preview artifact");
  if (new Set(artifacts).size !== artifacts.length) context.at("artifacts").fail("preview artifacts must be unique");
  return {
    schemaVersion: 1,
    previewId: expectString(record.previewId, context.at("previewId"), { pattern: PUBLICATION_UUID }),
    threadId: expectString(record.threadId, context.at("threadId"), { pattern: PUBLICATION_UUID }),
    turnId: expectString(record.turnId, context.at("turnId"), { pattern: PUBLICATION_UUID }),
    candidateSha256: expectString(record.candidateSha256, context.at("candidateSha256"), { pattern: PUBLICATION_SHA256 }),
    status: expectOneOf(record.status, ["ready"] as const, context.at("status")),
    artifacts,
    createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
  };
}

function parseCandidate(value: unknown, context: ValidationContext): PublicationCandidate {
  const record = expectStrictRecord(value, [
    "fileName", "size", "sha256", "snapshotRelativePath",
  ], context);
  return {
    fileName: expectString(record.fileName, context.at("fileName"), {
      minLength: 1,
      maxLength: 160,
      pattern: /^[^/\\\u0000-\u001f\u007f]+$/,
    }),
    size: expectInteger(record.size, context.at("size"), { minimum: 1, maximum: 200 * 1024 * 1024 }),
    sha256: expectString(record.sha256, context.at("sha256"), { pattern: PUBLICATION_SHA256 }),
    snapshotRelativePath: expectString(record.snapshotRelativePath, context.at("snapshotRelativePath"), {
      minLength: 1,
      maxLength: 500,
      pattern: PUBLICATION_STATE_CANDIDATE_PATH,
    }),
  };
}

function parseOriginal(value: unknown, context: ValidationContext): PublicationOriginal {
  const record = expectStrictRecord(value, ["exists", "size", "sha256", "mtimeMs"], context);
  const exists = expectBoolean(record.exists, context.at("exists"));
  const size = record.size === null
    ? null
    : expectInteger(record.size, context.at("size"), { minimum: 0, maximum: 200 * 1024 * 1024 });
  const sha256 = parseNullableString(record.sha256, context.at("sha256"), PUBLICATION_SHA256);
  const mtimeMs = record.mtimeMs === null
    ? null
    : expectFiniteNumber(record.mtimeMs, context.at("mtimeMs"), { minimum: 0 });
  if (exists !== (size !== null && sha256 !== null && mtimeMs !== null)) {
    context.fail("original presence and metadata are inconsistent");
  }
  return { exists, size, sha256, mtimeMs };
}

function parseVersion(value: unknown, context: ValidationContext): PublicationVersion | null {
  if (value === null) return null;
  const record = expectStrictRecord(value, [
    "size", "sha256", "versionRelativePath", "createdAt",
  ], context);
  return {
    size: expectInteger(record.size, context.at("size"), { minimum: 0, maximum: 200 * 1024 * 1024 }),
    sha256: expectString(record.sha256, context.at("sha256"), { pattern: PUBLICATION_SHA256 }),
    versionRelativePath: expectString(record.versionRelativePath, context.at("versionRelativePath"), {
      minLength: 1,
      maxLength: 500,
      pattern: PUBLICATION_STATE_VERSION_PATH,
    }),
    createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
  };
}

function parseResult(value: unknown, context: ValidationContext): PublicationResult | null {
  if (value === null) return null;
  const record = expectStrictRecord(value, [
    "size", "sha256", "publishedAt", "recoveredAfterInterruption",
  ], context);
  return {
    size: expectInteger(record.size, context.at("size"), { minimum: 1, maximum: 200 * 1024 * 1024 }),
    sha256: expectString(record.sha256, context.at("sha256"), { pattern: PUBLICATION_SHA256 }),
    publishedAt: expectIsoDate(record.publishedAt, context.at("publishedAt")),
    recoveredAfterInterruption: expectBoolean(
      record.recoveredAfterInterruption,
      context.at("recoveredAfterInterruption"),
    ),
  };
}

export const publicationPreviewSchema: StorageSchema<PublicationPreviewMetadata> =
  defineVersionedSchema<PublicationPreviewMetadata>({
    name: "PublicationPreviewMetadata",
    schemaVersion: 1,
    keys: ["previewId", "threadId", "turnId", "candidateSha256", "status", "artifacts", "createdAt"],
    parse: (record, context) => parsePreview(record, context),
  });

export const publicationOperationSchema = defineVersionedSchema<StoredPublicationOperation>({
  name: "StoredPublicationOperation",
  schemaVersion: 1,
  keys: [
    "operationId", "installationId", "userId", "threadId", "turnId",
    "targetRelativePath", "status", "candidate", "preview", "original",
    "confirmationTokenHash", "confirmationExpiresAt", "creationRequestHash",
    "decisionRequestHash", "version", "result", "createdAt", "updatedAt",
  ],
  parse(record, context) {
    const operation: StoredPublicationOperation = {
      schemaVersion: 1,
      operationId: expectString(record.operationId, context.at("operationId"), { pattern: PUBLICATION_UUID }),
      installationId: expectString(record.installationId, context.at("installationId"), { pattern: PUBLICATION_INSTALLATION_ID }),
      userId: expectString(record.userId, context.at("userId"), { pattern: PUBLICATION_UUID }),
      threadId: expectString(record.threadId, context.at("threadId"), { pattern: PUBLICATION_UUID }),
      turnId: expectString(record.turnId, context.at("turnId"), { pattern: PUBLICATION_UUID }),
      targetRelativePath: parseSafeRelativePath(record.targetRelativePath, context.at("targetRelativePath")),
      status: expectOneOf(record.status, [
        "awaiting_confirmation", "publishing", "published", "declined", "expired", "conflict",
      ] as const, context.at("status")),
      candidate: parseCandidate(record.candidate, context.at("candidate")),
      preview: parsePreview(record.preview, context.at("preview")),
      original: parseOriginal(record.original, context.at("original")),
      confirmationTokenHash: expectString(record.confirmationTokenHash, context.at("confirmationTokenHash"), { pattern: PUBLICATION_SHA256 }),
      confirmationExpiresAt: expectIsoDate(record.confirmationExpiresAt, context.at("confirmationExpiresAt")),
      creationRequestHash: expectString(record.creationRequestHash, context.at("creationRequestHash"), { pattern: PUBLICATION_SHA256 }),
      decisionRequestHash: parseNullableString(record.decisionRequestHash, context.at("decisionRequestHash"), PUBLICATION_SHA256),
      version: parseVersion(record.version, context.at("version")),
      result: parseResult(record.result, context.at("result")),
      createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
      updatedAt: expectIsoDate(record.updatedAt, context.at("updatedAt")),
    };
    if (operation.status === "published" && !operation.result) {
      context.at("result").fail("published operation requires a result");
    }
    if (operation.status !== "published" && operation.result) {
      context.at("result").fail("only published operation can have a result");
    }
    if (operation.original.exists && operation.status === "published" && !operation.version) {
      context.at("version").fail("published replacement requires a recovery version");
    }
    if (!operation.original.exists && operation.version) {
      context.at("version").fail("a newly created target cannot have an original recovery version");
    }
    if (operation.candidate.sha256 !== operation.preview.candidateSha256) {
      context.at("preview").fail("preview hash must match the frozen candidate");
    }
    if (operation.threadId !== operation.preview.threadId || operation.turnId !== operation.preview.turnId) {
      context.at("preview").fail("preview scope must match the publication scope");
    }
    if (operation.status === "awaiting_confirmation" && operation.decisionRequestHash !== null) {
      context.at("decisionRequestHash").fail("an undecided publication cannot have a decision request");
    }
    if (operation.status !== "awaiting_confirmation" && operation.decisionRequestHash === null) {
      context.at("decisionRequestHash").fail("a decided publication requires a decision request");
    }
    if ((operation.status === "declined" || operation.status === "expired") && operation.version) {
      context.at("version").fail("declined or expired publication cannot have a recovery version");
    }
    if (Date.parse(operation.updatedAt) < Date.parse(operation.createdAt)) {
      context.at("updatedAt").fail("must not precede createdAt");
    }
    return operation;
  },
});

export const publicationFreezeReceiptSchema = defineVersionedSchema<PublicationFreezeReceipt>({
  name: "PublicationFreezeReceipt",
  schemaVersion: 1,
  keys: ["requestHash", "requestFingerprint", "operationId", "createdAt"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      requestHash: expectString(record.requestHash, context.at("requestHash"), { pattern: PUBLICATION_SHA256 }),
      requestFingerprint: expectString(record.requestFingerprint, context.at("requestFingerprint"), { pattern: PUBLICATION_SHA256 }),
      operationId: expectString(record.operationId, context.at("operationId"), { pattern: PUBLICATION_UUID }),
      createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
    };
  },
});

export const publicationAuditSchema = defineVersionedSchema<PublicationAuditEvent>({
  name: "PublicationAuditEvent",
  schemaVersion: 1,
  keys: [
    "auditKey", "eventType", "operationId", "installationId", "userId",
    "threadId", "turnId", "targetPathHash", "candidateSha256", "originalSha256",
    "resultSha256", "clientRequestHash", "recoveredAfterInterruption", "occurredAt",
  ],
  parse(record, context) {
    const event: PublicationAuditEvent = {
      schemaVersion: 1,
      auditKey: expectString(record.auditKey, context.at("auditKey"), { pattern: PUBLICATION_SHA256 }),
      eventType: expectOneOf(record.eventType, ["frozen", "declined", "expired", "conflict", "published"] as const, context.at("eventType")),
      operationId: expectString(record.operationId, context.at("operationId"), { pattern: PUBLICATION_UUID }),
      installationId: expectString(record.installationId, context.at("installationId"), { pattern: PUBLICATION_INSTALLATION_ID }),
      userId: expectString(record.userId, context.at("userId"), { pattern: PUBLICATION_UUID }),
      threadId: expectString(record.threadId, context.at("threadId"), { pattern: PUBLICATION_UUID }),
      turnId: expectString(record.turnId, context.at("turnId"), { pattern: PUBLICATION_UUID }),
      targetPathHash: expectString(record.targetPathHash, context.at("targetPathHash"), { pattern: PUBLICATION_SHA256 }),
      candidateSha256: expectString(record.candidateSha256, context.at("candidateSha256"), { pattern: PUBLICATION_SHA256 }),
      originalSha256: parseNullableString(record.originalSha256, context.at("originalSha256"), PUBLICATION_SHA256),
      resultSha256: parseNullableString(record.resultSha256, context.at("resultSha256"), PUBLICATION_SHA256),
      clientRequestHash: expectString(record.clientRequestHash, context.at("clientRequestHash"), { pattern: PUBLICATION_SHA256 }),
      recoveredAfterInterruption: expectBoolean(record.recoveredAfterInterruption, context.at("recoveredAfterInterruption")),
      occurredAt: expectIsoDate(record.occurredAt, context.at("occurredAt")),
    };
    if (event.eventType === "published" && event.resultSha256 === null) {
      context.at("resultSha256").fail("published audit event requires a result hash");
    }
    if (event.eventType !== "published" && event.resultSha256 !== null) {
      context.at("resultSha256").fail("only a published audit event can include a result hash");
    }
    if (event.eventType !== "published" && event.recoveredAfterInterruption) {
      context.at("recoveredAfterInterruption").fail("only publication recovery can be marked recovered");
    }
    return event;
  },
});
