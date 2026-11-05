import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  isCanonicalInstallationId,
  isCanonicalRoleId,
  isCanonicalTurnId,
  isCanonicalUuid,
} from "@/permissions/markdown-parser";
import type {
  PermissionResolutionAuditEvent,
  PermissionResolutionAuditSink,
  PermissionResolutionAuditSource,
} from "@/permissions/types";
import {
  FileJournal,
  ResourceLockManager,
  ValidationContext,
  expectArray,
  expectInteger,
  expectIsoDate,
  expectLiteral,
  expectOneOf,
  expectStrictRecord,
  expectString,
  type JournalEntry,
  type StorageSchema,
} from "@/storage";

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ERROR_CODE_PATTERN = /^PERMISSION_[A-Z_]+$/;
const AUDIT_FILE_NAME = "permission-resolutions.jsonl";

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}

function parseNullableIdentifier(
  value: unknown,
  context: ValidationContext,
  validator: (candidate: string) => boolean,
) {
  if (value === null) return null;
  const candidate = expectString(value, context, { minLength: 1, maxLength: 128 });
  if (!validator(candidate)) context.fail("expected a canonical identifier or null");
  return candidate;
}

function parseSource(value: unknown, context: ValidationContext): PermissionResolutionAuditSource {
  const record = expectStrictRecord(
    value,
    ["scope", "precedence", "policyVersion", "fingerprint"],
    context,
  );
  return {
    scope: expectOneOf(record.scope, [
      "installation",
      "role",
      "project",
      "user",
      "user-project",
    ] as const, context.at("scope")),
    precedence: expectInteger(record.precedence, context.at("precedence"), {
      minimum: 100,
      maximum: 500,
    }),
    policyVersion: expectInteger(record.policyVersion, context.at("policyVersion"), {
      minimum: 1,
    }),
    fingerprint: expectString(record.fingerprint, context.at("fingerprint"), {
      minLength: 64,
      maxLength: 64,
      pattern: FINGERPRINT_PATTERN,
    }),
  };
}

export const permissionResolutionAuditEventSchema: StorageSchema<PermissionResolutionAuditEvent> = {
  name: "PermissionResolutionAuditEvent",
  parse(value: unknown, source = "PermissionResolutionAuditEvent") {
    const context = new ValidationContext("PermissionResolutionAuditEvent", source);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      context.fail("expected an object");
    }
    const outcome = (value as Record<string, unknown>).outcome;
    const keys = outcome === "resolved"
      ? [
          "schemaVersion",
          "eventId",
          "occurredAt",
          "turnId",
          "installationId",
          "userId",
          "roleId",
          "projectId",
          "outcome",
          "fingerprint",
          "effectiveRuleCount",
          "sources",
        ]
      : [
          "schemaVersion",
          "eventId",
          "occurredAt",
          "turnId",
          "installationId",
          "userId",
          "roleId",
          "projectId",
          "outcome",
          "errorCode",
          "sources",
        ];
    const record = expectStrictRecord(value, keys, context);
    const common = {
      schemaVersion: expectLiteral(record.schemaVersion, 1, context.at("schemaVersion")),
      eventId: expectString(record.eventId, context.at("eventId"), {
        minLength: 36,
        maxLength: 36,
        pattern: UUID_PATTERN,
      }),
      occurredAt: expectIsoDate(record.occurredAt, context.at("occurredAt")),
      turnId: expectString(record.turnId, context.at("turnId"), {
        minLength: 1,
        maxLength: 128,
      }),
      installationId: expectString(record.installationId, context.at("installationId"), {
        minLength: 2,
        maxLength: 63,
      }),
      userId: expectString(record.userId, context.at("userId"), {
        minLength: 36,
        maxLength: 36,
        pattern: UUID_PATTERN,
      }),
      roleId: parseNullableIdentifier(record.roleId, context.at("roleId"), isCanonicalRoleId),
      projectId: parseNullableIdentifier(record.projectId, context.at("projectId"), isCanonicalUuid),
      sources: expectArray(record.sources, context.at("sources"), parseSource, { maxLength: 5 }),
    };
    if (!isCanonicalTurnId(common.turnId)) context.at("turnId").fail("expected a canonical turn id");
    if (!isCanonicalInstallationId(common.installationId)) {
      context.at("installationId").fail("expected a canonical installation id");
    }
    if (outcome === "resolved") {
      return {
        ...common,
        outcome: expectLiteral(record.outcome, "resolved", context.at("outcome")),
        fingerprint: expectString(record.fingerprint, context.at("fingerprint"), {
          minLength: 64,
          maxLength: 64,
          pattern: FINGERPRINT_PATTERN,
        }),
        effectiveRuleCount: expectInteger(
          record.effectiveRuleCount,
          context.at("effectiveRuleCount"),
          { minimum: 0, maximum: 256 },
        ),
      };
    }
    return {
      ...common,
      outcome: expectLiteral(record.outcome, "rejected", context.at("outcome")),
      errorCode: expectString(record.errorCode, context.at("errorCode"), {
        minLength: 12,
        maxLength: 80,
        pattern: ERROR_CODE_PATTERN,
      }),
    };
  },
};

async function assertPrivateDirectory(directory: string, requireOwnerOnly: boolean) {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Permission audit directories must be real directories.");
  }
  const forbiddenBits = requireOwnerOnly ? 0o077 : 0o022;
  if ((metadata.mode & forbiddenBits) !== 0) {
    throw new Error("Permission audit directory permissions are unsafe.");
  }
}

async function ensurePrivateDirectory(directory: string) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  await assertPrivateDirectory(directory, true);
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export type FilePermissionResolutionAuditSinkOptions = {
  installationId: string;
  userId: string;
  usersRoot: string;
  now?: () => number;
};

export class FilePermissionResolutionAuditSink implements PermissionResolutionAuditSink {
  readonly installationId: string;
  readonly userId: string;
  readonly userRoot: string;
  readonly auditRoot: string;
  readonly filePath: string;
  private readonly journal: FileJournal<PermissionResolutionAuditEvent>;

  constructor(options: FilePermissionResolutionAuditSinkOptions) {
    if (!isCanonicalInstallationId(options.installationId)) {
      throw new Error("Permission audit installationId is invalid.");
    }
    if (!isCanonicalUuid(options.userId)) {
      throw new Error("Permission audit userId is invalid.");
    }
    if (!path.isAbsolute(options.usersRoot)) {
      throw new Error("Permission audit usersRoot must be absolute.");
    }
    this.installationId = options.installationId;
    this.userId = options.userId;
    const usersRoot = path.resolve(options.usersRoot);
    this.userRoot = path.resolve(usersRoot, options.userId);
    if (this.userRoot === usersRoot || !isInside(usersRoot, this.userRoot)) {
      throw new Error("Permission audit user root escapes usersRoot.");
    }
    this.auditRoot = path.join(this.userRoot, "audit", "permissions");
    this.filePath = path.join(this.auditRoot, AUDIT_FILE_NAME);
    const lockManager = new ResourceLockManager({
      rootDirectory: path.join(this.auditRoot, "locks"),
      ...(options.now ? { now: options.now } : {}),
    });
    this.journal = new FileJournal({
      filePath: this.filePath,
      lockManager,
      payloadSchema: permissionResolutionAuditEventSchema,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  private async preparePrivatePath() {
    const usersRoot = path.dirname(this.userRoot);
    await assertPrivateDirectory(usersRoot, false);
    await assertPrivateDirectory(this.userRoot, true);
    const canonicalUsersRoot = await realpath(usersRoot);
    const canonicalUserRoot = await realpath(this.userRoot);
    if (!isInside(canonicalUsersRoot, canonicalUserRoot) || canonicalUsersRoot === canonicalUserRoot) {
      throw new Error("Permission audit user root is outside usersRoot.");
    }
    const auditDirectory = path.join(this.userRoot, "audit");
    await ensurePrivateDirectory(auditDirectory);
    await ensurePrivateDirectory(this.auditRoot);
    await ensurePrivateDirectory(path.join(this.auditRoot, "locks"));
  }

  async record(event: PermissionResolutionAuditEvent) {
    if (event.installationId !== this.installationId || event.userId !== this.userId) {
      throw new Error("Permission audit event does not match its private user sink.");
    }
    await this.preparePrivatePath();
    await this.journal.append(event);
  }

  async read(): Promise<readonly JournalEntry<PermissionResolutionAuditEvent>[]> {
    await this.preparePrivatePath();
    return this.journal.read();
  }
}
