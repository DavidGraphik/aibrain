import {
  defineVersionedSchema,
  expectArray,
  expectInteger,
  expectIsoDate,
  expectLiteral,
  expectOneOf,
  expectStrictRecord,
  expectString,
  type ValidationContext,
} from "@/storage/schema";
import {
  MEMORY_SCHEMA_VERSION,
  type MemoryKind,
  type MemoryProvenance,
  type MemoryRecord,
  type MemorySourceType,
} from "@/memory/types";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INSTALLATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MEMORY_KINDS = ["recollection", "decision"] as const;
const MEMORY_STATUSES = ["active", "revoked"] as const;
const SOURCE_TYPES = ["manual", "thread", "project", "document", "decision"] as const;

function boundedText(
  value: unknown,
  context: ValidationContext,
  options: { minLength?: number; maxLength: number },
) {
  const text = expectString(value, context, options);
  if (/\p{C}/u.test(text.replace(/[\t\n\r]/g, ""))) {
    context.fail("contains disallowed control characters");
  }
  return text;
}

function nullableIsoDate(value: unknown, context: ValidationContext) {
  return value === null ? null : expectIsoDate(value, context);
}

function nullableUserId(value: unknown, context: ValidationContext) {
  return value === null
    ? null
    : expectString(value, context, { minLength: 36, maxLength: 36, pattern: UUID_PATTERN });
}

function nullableReason(value: unknown, context: ValidationContext) {
  return value === null ? null : boundedText(value, context, { minLength: 1, maxLength: 2_000 });
}

export function parseMemoryProvenance(
  value: unknown,
  context: ValidationContext,
): MemoryProvenance {
  const record = expectStrictRecord(
    value,
    ["sourceType", "sourceId", "sourceExcerpt", "capturedAt"],
    context,
  );
  return {
    sourceType: expectOneOf(record.sourceType, SOURCE_TYPES, context.at("sourceType")) as MemorySourceType,
    sourceId: boundedText(record.sourceId, context.at("sourceId"), {
      minLength: 1,
      maxLength: 512,
    }),
    sourceExcerpt: boundedText(record.sourceExcerpt, context.at("sourceExcerpt"), {
      minLength: 1,
      maxLength: 4_000,
    }),
    capturedAt: expectIsoDate(record.capturedAt, context.at("capturedAt")),
  };
}

export const memoryRecordSchema = defineVersionedSchema<MemoryRecord>({
  name: "MemoryRecord",
  schemaVersion: MEMORY_SCHEMA_VERSION,
  keys: [
    "memoryId",
    "installationId",
    "subjectUserId",
    "kind",
    "content",
    "provenance",
    "explicit",
    "createdBy",
    "createdAt",
    "status",
    "revokedAt",
    "revokedBy",
    "revokeReason",
    "idempotencyKey",
  ],
  parse(record, context) {
    const status = expectOneOf(record.status, MEMORY_STATUSES, context.at("status"));
    const revokedAt = nullableIsoDate(record.revokedAt, context.at("revokedAt"));
    const revokedBy = nullableUserId(record.revokedBy, context.at("revokedBy"));
    const revokeReason = nullableReason(record.revokeReason, context.at("revokeReason"));
    if (status === "active" && (revokedAt !== null || revokedBy !== null || revokeReason !== null)) {
      context.fail("active memory must not include revocation metadata");
    }
    if (status === "revoked" && (revokedAt === null || revokedBy === null || revokeReason === null)) {
      context.fail("revoked memory requires complete revocation metadata");
    }
    return {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      memoryId: expectString(record.memoryId, context.at("memoryId"), {
        minLength: 36,
        maxLength: 36,
        pattern: UUID_PATTERN,
      }),
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 2,
        maxLength: 63,
        pattern: INSTALLATION_ID_PATTERN,
      }),
      subjectUserId: expectString(record.subjectUserId, context.at("subjectUserId"), {
        minLength: 36,
        maxLength: 36,
        pattern: UUID_PATTERN,
      }),
      kind: expectOneOf(record.kind, MEMORY_KINDS, context.at("kind")) as MemoryKind,
      content: boundedText(record.content, context.at("content"), {
        minLength: 1,
        maxLength: 32_000,
      }),
      provenance: parseMemoryProvenance(record.provenance, context.at("provenance")),
      explicit: expectLiteral(record.explicit, true, context.at("explicit")),
      createdBy: expectString(record.createdBy, context.at("createdBy"), {
        minLength: 36,
        maxLength: 36,
        pattern: UUID_PATTERN,
      }),
      createdAt: expectIsoDate(record.createdAt, context.at("createdAt")),
      status,
      revokedAt,
      revokedBy,
      revokeReason,
      idempotencyKey: expectString(record.idempotencyKey, context.at("idempotencyKey"), {
        minLength: 1,
        maxLength: 128,
        pattern: IDEMPOTENCY_KEY_PATTERN,
      }),
    };
  },
});

export type MemoryJournalEvent = {
  schemaVersion: 1;
  eventType: "created" | "revoked";
  installationId: string;
  subjectUserId: string;
  actorUserId: string;
  memoryId: string;
  idempotencyKey: string;
  requestHash: string;
  occurredAt: string;
  record: MemoryRecord | null;
  revokeReason: string | null;
};

export const memoryJournalEventSchema = defineVersionedSchema<MemoryJournalEvent>({
  name: "MemoryJournalEvent",
  schemaVersion: 1,
  keys: [
    "eventType",
    "installationId",
    "subjectUserId",
    "actorUserId",
    "memoryId",
    "idempotencyKey",
    "requestHash",
    "occurredAt",
    "record",
    "revokeReason",
  ],
  parse(record, context) {
    const eventType = expectOneOf(record.eventType, ["created", "revoked"] as const, context.at("eventType"));
    const parsedRecord = record.record === null
      ? null
      : memoryRecordSchema.parse(record.record, `${context.source}${context.at("record").path}`);
    const revokeReason = nullableReason(record.revokeReason, context.at("revokeReason"));
    const memoryId = expectString(record.memoryId, context.at("memoryId"), {
      minLength: 36,
      maxLength: 36,
      pattern: UUID_PATTERN,
    });
    const installationId = expectString(record.installationId, context.at("installationId"), {
      minLength: 2,
      maxLength: 63,
      pattern: INSTALLATION_ID_PATTERN,
    });
    const subjectUserId = expectString(record.subjectUserId, context.at("subjectUserId"), {
      minLength: 36,
      maxLength: 36,
      pattern: UUID_PATTERN,
    });
    const actorUserId = expectString(record.actorUserId, context.at("actorUserId"), {
      minLength: 36,
      maxLength: 36,
      pattern: UUID_PATTERN,
    });
    if (eventType === "created") {
      if (!parsedRecord) context.fail("created event requires a record");
      if (revokeReason !== null) context.fail("created event must not include a revoke reason");
      const createdRecord = parsedRecord as MemoryRecord;
      if (
        createdRecord.memoryId !== memoryId
        || createdRecord.installationId !== installationId
        || createdRecord.subjectUserId !== subjectUserId
        || createdRecord.createdBy !== actorUserId
        || createdRecord.idempotencyKey !== record.idempotencyKey
        || createdRecord.createdAt !== record.occurredAt
      ) {
        context.fail("created event identity does not match its record");
      }
    } else if (parsedRecord !== null || revokeReason === null) {
      context.fail("revoked event requires a reason and no record");
    }
    return {
      schemaVersion: 1,
      eventType,
      installationId,
      subjectUserId,
      actorUserId,
      memoryId,
      idempotencyKey: expectString(record.idempotencyKey, context.at("idempotencyKey"), {
        minLength: 1,
        maxLength: 128,
        pattern: IDEMPOTENCY_KEY_PATTERN,
      }),
      requestHash: expectString(record.requestHash, context.at("requestHash"), {
        minLength: 64,
        maxLength: 64,
        pattern: SHA256_PATTERN,
      }),
      occurredAt: expectIsoDate(record.occurredAt, context.at("occurredAt")),
      record: parsedRecord,
      revokeReason,
    };
  },
});

export type MemoryIndex = {
  schemaVersion: 1;
  installationId: string;
  subjectUserId: string;
  lastSequence: number;
  records: MemoryRecord[];
};

export const memoryIndexSchema = defineVersionedSchema<MemoryIndex>({
  name: "MemoryIndex",
  schemaVersion: 1,
  keys: ["installationId", "subjectUserId", "lastSequence", "records"],
  parse(record, context) {
    return {
      schemaVersion: 1,
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 2,
        maxLength: 63,
        pattern: INSTALLATION_ID_PATTERN,
      }),
      subjectUserId: expectString(record.subjectUserId, context.at("subjectUserId"), {
        minLength: 36,
        maxLength: 36,
        pattern: UUID_PATTERN,
      }),
      lastSequence: expectInteger(record.lastSequence, context.at("lastSequence"), { minimum: 0 }),
      records: expectArray(
        record.records,
        context.at("records"),
        (item, itemContext) => memoryRecordSchema.parse(item, `${itemContext.source}${itemContext.path}`),
        { maxLength: 100_000 },
      ),
    };
  },
});
