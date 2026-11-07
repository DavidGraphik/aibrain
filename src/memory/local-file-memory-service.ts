import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { localUserSchema } from "@/auth/local-user-store";
import type { InstallationConfig } from "@/config/installation-schema";
import { readRegularFileWithin } from "@/security/safe-file";
import { atomicWriteJson } from "@/storage/atomic-file";
import { StorageCorruptionError } from "@/storage/errors";
import { FileJournal, type JournalEntry } from "@/storage/journal";
import { ResourceLockManager } from "@/storage/resource-lock";
import {
  IDEMPOTENCY_KEY_PATTERN,
  UUID_PATTERN,
  memoryIndexSchema,
  memoryJournalEventSchema,
  memoryRecordSchema,
  type MemoryJournalEvent,
} from "@/memory/schemas";
import {
  type CompanyContextDocument,
  type EmployeeContext,
  type KnowledgeEntry,
  MEMORY_SCHEMA_VERSION,
  type MemoryContext,
  type MemoryListOptions,
  type MemoryPromptSnapshot,
  type MemoryRecord,
  type MemoryService,
  type RememberInput,
  type RevokeMemoryInput,
} from "@/memory/types";
import { FileMemoryProposalStore } from "@/memory/proposal-store";

const COMPANY_CONTEXT_FILES = [
  "00_SYSTEM.md",
  "10_IDENTITY.md",
  "20_COMPANY.md",
  "30_ORGANIZATION.md",
  "40_WORKFLOWS.md",
  "50_DOCUMENT_RULES.md",
] as const;
const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_COMPANY_CONTEXT_FILES = 128;
const MAX_COMPANY_CONTEXT_DEPTH = 8;
const MAX_KNOWLEDGE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_KNOWLEDGE_ENTRIES = 10_000;
const MAX_KNOWLEDGE_DEPTH = 12;
const KNOWLEDGE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class MemoryServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "MemoryServiceError";
  }
}

type LocalFileMemoryServiceOptions = {
  config: Readonly<InstallationConfig>;
  now?: () => number;
};

type UserStorage = {
  userRoot: string;
  memoryRoot: string;
  journal: FileJournal<MemoryJournalEvent>;
};

function isNodeError(error: unknown, code?: string): error is NodeJS.ErrnoException {
  return Boolean(
    error && typeof error === "object" && "code" in error
    && (code === undefined || (error as NodeJS.ErrnoException).code === code),
  );
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function rejectMemorySecretMaterial(value: string) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*|\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{16,}/iu.test(value)) {
    throw new MemoryServiceError("MEMORY_SECRET_REJECTED", "Credential-shaped content cannot be stored as memory.");
  }
}

function decodeMarkdown(value: Uint8Array, label: string) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new MemoryServiceError(
      "MEMORY_MARKDOWN_INVALID",
      `${label} is not valid UTF-8 Markdown.`,
      { cause: error },
    );
  }
  if (/\p{C}/u.test(text.replace(/[\t\n\r]/g, ""))) {
    throw new MemoryServiceError(
      "MEMORY_MARKDOWN_INVALID",
      `${label} contains disallowed control characters.`,
    );
  }
  rejectMemorySecretMaterial(text);
  return text;
}

function assertUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new MemoryServiceError("MEMORY_ID_INVALID", `${label} must be a canonical lowercase UUID.`);
  }
}

function assertIdempotencyKey(value: string) {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new MemoryServiceError(
      "MEMORY_IDEMPOTENCY_KEY_INVALID",
      "idempotencyKey must contain 1-128 safe identifier characters.",
    );
  }
}

function compareNewest(left: MemoryRecord, right: MemoryRecord) {
  return right.createdAt.localeCompare(left.createdAt) || right.memoryId.localeCompare(left.memoryId);
}

function replayEvents(
  journalPath: string,
  context: MemoryContext,
  entries: readonly JournalEntry<MemoryJournalEvent>[],
) {
  const records = new Map<string, MemoryRecord>();
  for (const { payload } of entries) {
    if (
      payload.installationId !== context.installationId
      || payload.subjectUserId !== context.userId
      || payload.actorUserId !== context.userId
    ) {
      throw new StorageCorruptionError(journalPath, "memory event crosses its installation or user boundary");
    }
    if (payload.eventType === "created") {
      if (!payload.record || records.has(payload.memoryId)) {
        throw new StorageCorruptionError(journalPath, `duplicate or incomplete create event for ${payload.memoryId}`);
      }
      records.set(payload.memoryId, payload.record);
      continue;
    }
    const current = records.get(payload.memoryId);
    if (!current || current.status !== "active" || !payload.revokeReason) {
      throw new StorageCorruptionError(journalPath, `invalid revoke event for ${payload.memoryId}`);
    }
    records.set(payload.memoryId, memoryRecordSchema.parse({
      ...current,
      status: "revoked",
      revokedAt: payload.occurredAt,
      revokedBy: payload.actorUserId,
      revokeReason: payload.revokeReason,
    }, `${journalPath}:replay`));
  }
  return records;
}

function validateKnowledgeRelativePath(relativePath: string) {
  if (
    !relativePath
    || path.posix.isAbsolute(relativePath)
    || relativePath.includes("\\")
    || path.posix.normalize(relativePath) !== relativePath
  ) {
    throw new MemoryServiceError("MEMORY_KNOWLEDGE_PATH_INVALID", "Knowledge path is not normalized.");
  }
  const segments = relativePath.split("/");
  if (
    segments.length > MAX_KNOWLEDGE_DEPTH
    || segments.some((segment) => !KNOWLEDGE_SEGMENT_PATTERN.test(segment))
    || !relativePath.toLowerCase().endsWith(".md")
  ) {
    throw new MemoryServiceError(
      "MEMORY_KNOWLEDGE_PATH_INVALID",
      "Knowledge path must be a bounded relative Markdown path.",
    );
  }
}

export class LocalFileMemoryService implements MemoryService {
  private readonly config: Readonly<InstallationConfig>;
  private readonly now: () => number;
  private readonly lockManager: ResourceLockManager;

  constructor(options: LocalFileMemoryServiceOptions) {
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.lockManager = new ResourceLockManager({
      rootDirectory: path.join(this.config.paths.dataRoot, "locks", "memory"),
    });
  }

  private async assertContext(context: MemoryContext) {
    if (context.installationId !== this.config.installationId) {
      throw new MemoryServiceError(
        "MEMORY_INSTALLATION_MISMATCH",
        "Memory context belongs to another installation.",
      );
    }
    assertUuid(context.userId, "userId");
    const userRoot = path.join(this.config.paths.usersRoot, context.userId);
    let metadata;
    let usersRootMetadata;
    let dataRootMetadata;
    try {
      [metadata, usersRootMetadata, dataRootMetadata] = await Promise.all([
        lstat(userRoot),
        lstat(this.config.paths.usersRoot),
        lstat(this.config.paths.dataRoot),
      ]);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new MemoryServiceError("MEMORY_USER_NOT_FOUND", "Local memory user does not exist.");
      }
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new MemoryServiceError("MEMORY_PATH_UNSAFE", "User memory root must be a real directory.");
    }
    if (
      !usersRootMetadata.isDirectory()
      || usersRootMetadata.isSymbolicLink()
      || !dataRootMetadata.isDirectory()
      || dataRootMetadata.isSymbolicLink()
    ) {
      throw new MemoryServiceError("MEMORY_PATH_UNSAFE", "Configured memory roots must be real directories.");
    }
    const [canonicalDataRoot, canonicalUsersRoot, canonicalUserRoot] = await Promise.all([
      realpath(this.config.paths.dataRoot),
      realpath(this.config.paths.usersRoot),
      realpath(userRoot),
    ]);
    if (
      !isInside(canonicalDataRoot, canonicalUsersRoot)
      || !isInside(canonicalUsersRoot, canonicalUserRoot)
    ) {
      throw new MemoryServiceError("MEMORY_PATH_UNSAFE", "User memory root escapes usersRoot.");
    }
    let user;
    try {
      const raw = await readRegularFileWithin(
        this.config.paths.usersRoot,
        path.join(context.userId, "user.json"),
        32 * 1024,
      );
      user = localUserSchema.parse(JSON.parse(raw.toString("utf8")), "memory user.json");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new MemoryServiceError("MEMORY_USER_NOT_FOUND", "Local memory user does not exist.");
      }
      throw error;
    }
    if (user.userId !== context.userId || !user.enabled) {
      throw new MemoryServiceError("MEMORY_USER_DISABLED", "Local memory user is disabled or mismatched.");
    }
    return userRoot;
  }

  private async userStorage(context: MemoryContext): Promise<UserStorage> {
    const userRoot = await this.assertContext(context);
    const memoryRoot = path.join(userRoot, "memory");
    try {
      await mkdir(memoryRoot, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const metadata = await lstat(memoryRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new MemoryServiceError("MEMORY_PATH_UNSAFE", "Memory root must be a real directory.");
    }
    await chmod(memoryRoot, 0o700);
    if (!isInside(await realpath(userRoot), await realpath(memoryRoot))) {
      throw new MemoryServiceError("MEMORY_PATH_UNSAFE", "Memory root escapes its employee root.");
    }
    return {
      userRoot,
      memoryRoot,
      journal: new FileJournal({
        filePath: path.join(memoryRoot, "events.jsonl"),
        lockManager: this.lockManager,
        payloadSchema: memoryJournalEventSchema,
        now: this.now,
      }),
    };
  }

  private operationKey(context: MemoryContext) {
    return `memory-operation:${context.installationId}:${context.userId}`;
  }

  private async syncIndex(
    context: MemoryContext,
    storage: UserStorage,
    entries: readonly JournalEntry<MemoryJournalEvent>[],
    records: ReadonlyMap<string, MemoryRecord>,
  ) {
    await atomicWriteJson(
      path.join(storage.memoryRoot, "index.json"),
      {
        schemaVersion: 1,
        installationId: context.installationId,
        subjectUserId: context.userId,
        lastSequence: entries.at(-1)?.sequence ?? 0,
        records: [...records.values()].sort(compareNewest),
      },
      memoryIndexSchema,
      { mode: 0o600 },
    );
  }

  async remember(context: MemoryContext, input: RememberInput) {
    rejectMemorySecretMaterial(input.content);
    rejectMemorySecretMaterial(input.provenance.sourceExcerpt);
    assertIdempotencyKey(input.idempotencyKey);
    const occurredAt = new Date(this.now()).toISOString();
    const candidate = memoryRecordSchema.parse({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      memoryId: randomUUID(),
      installationId: context.installationId,
      subjectUserId: context.userId,
      kind: input.kind,
      content: input.content,
      provenance: input.provenance,
      explicit: input.explicit,
      createdBy: context.userId,
      createdAt: occurredAt,
      status: "active",
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      idempotencyKey: input.idempotencyKey,
    }, "remember input");
    const requestHash = sha256({
      operation: "remember",
      installationId: context.installationId,
      subjectUserId: context.userId,
      kind: candidate.kind,
      content: candidate.content,
      provenance: {
        sourceType: candidate.provenance.sourceType,
        sourceId: candidate.provenance.sourceId,
        sourceExcerpt: candidate.provenance.sourceExcerpt,
      },
      explicit: candidate.explicit,
    });
    const storage = await this.userStorage(context);
    return this.lockManager.withLock(this.operationKey(context), async () => {
      const entries = await storage.journal.read();
      const previous = entries.find(({ payload }) => payload.idempotencyKey === input.idempotencyKey);
      const records = replayEvents(storage.journal.filePath, context, entries);
      if (previous) {
        if (previous.payload.eventType !== "created" || previous.payload.requestHash !== requestHash) {
          throw new MemoryServiceError(
            "MEMORY_IDEMPOTENCY_CONFLICT",
            "idempotencyKey was already used for a different memory operation.",
          );
        }
        const memory = records.get(previous.payload.memoryId);
        if (!memory) throw new StorageCorruptionError(storage.journal.filePath, "idempotent memory is missing");
        await this.syncIndex(context, storage, entries, records);
        return { memory, created: false };
      }

      const appended = await storage.journal.append({
        schemaVersion: 1,
        eventType: "created",
        installationId: context.installationId,
        subjectUserId: context.userId,
        actorUserId: context.userId,
        memoryId: candidate.memoryId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        occurredAt,
        record: candidate,
        revokeReason: null,
      });
      const updatedEntries = [...entries, appended];
      const updatedRecords = replayEvents(storage.journal.filePath, context, updatedEntries);
      await this.syncIndex(context, storage, updatedEntries, updatedRecords);
      return { memory: candidate, created: true };
    });
  }

  private async readState(context: MemoryContext) {
    const storage = await this.userStorage(context);
    return this.lockManager.withLock(this.operationKey(context), async () => {
      const entries = await storage.journal.read();
      const records = replayEvents(storage.journal.filePath, context, entries);
      await this.syncIndex(context, storage, entries, records);
      return records;
    });
  }

  async read(context: MemoryContext, memoryId: string) {
    assertUuid(memoryId, "memoryId");
    return (await this.readState(context)).get(memoryId) ?? null;
  }

  async list(context: MemoryContext, options: MemoryListOptions = {}) {
    const status = options.status ?? "active";
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new MemoryServiceError("MEMORY_LIST_INVALID", "Memory list limit must be between 1 and 10000.");
    }
    if (options.kind !== undefined && options.kind !== "recollection" && options.kind !== "decision") {
      throw new MemoryServiceError("MEMORY_LIST_INVALID", "Memory kind is invalid.");
    }
    if (status !== "active" && status !== "revoked" && status !== "all") {
      throw new MemoryServiceError("MEMORY_LIST_INVALID", "Memory status is invalid.");
    }
    return [...(await this.readState(context)).values()]
      .filter((memory) => status === "all" || memory.status === status)
      .filter((memory) => options.kind === undefined || memory.kind === options.kind)
      .sort(compareNewest)
      .slice(0, limit);
  }

  async revoke(context: MemoryContext, input: RevokeMemoryInput) {
    assertUuid(input.memoryId, "memoryId");
    assertIdempotencyKey(input.idempotencyKey);
    if (input.explicit !== true) {
      throw new MemoryServiceError("MEMORY_EXPLICIT_REQUIRED", "Memory revocation must be explicit.");
    }
    const reason = input.reason.trim();
    if (!reason || reason.length > 2_000 || /\p{C}/u.test(reason.replace(/[\t\n\r]/g, ""))) {
      throw new MemoryServiceError("MEMORY_REVOKE_INVALID", "Memory revoke reason is invalid.");
    }
    const requestHash = sha256({
      operation: "revoke",
      installationId: context.installationId,
      subjectUserId: context.userId,
      memoryId: input.memoryId,
      reason,
      explicit: true,
    });
    const storage = await this.userStorage(context);
    return this.lockManager.withLock(this.operationKey(context), async () => {
      const entries = await storage.journal.read();
      const previous = entries.find(({ payload }) => payload.idempotencyKey === input.idempotencyKey);
      let records = replayEvents(storage.journal.filePath, context, entries);
      if (previous) {
        if (
          previous.payload.eventType !== "revoked"
          || previous.payload.requestHash !== requestHash
          || previous.payload.memoryId !== input.memoryId
        ) {
          throw new MemoryServiceError(
            "MEMORY_IDEMPOTENCY_CONFLICT",
            "idempotencyKey was already used for a different memory operation.",
          );
        }
        const memory = records.get(input.memoryId);
        if (!memory) throw new StorageCorruptionError(storage.journal.filePath, "revoked memory is missing");
        await this.syncIndex(context, storage, entries, records);
        return { memory, changed: false };
      }
      const current = records.get(input.memoryId);
      if (!current) {
        throw new MemoryServiceError("MEMORY_NOT_FOUND", "Memory does not exist for this employee.");
      }
      if (current.status === "revoked") {
        await this.syncIndex(context, storage, entries, records);
        return { memory: current, changed: false };
      }
      const occurredAt = new Date(this.now()).toISOString();
      const appended = await storage.journal.append({
        schemaVersion: 1,
        eventType: "revoked",
        installationId: context.installationId,
        subjectUserId: context.userId,
        actorUserId: context.userId,
        memoryId: input.memoryId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        occurredAt,
        record: null,
        revokeReason: reason,
      });
      const updatedEntries = [...entries, appended];
      records = replayEvents(storage.journal.filePath, context, updatedEntries);
      await this.syncIndex(context, storage, updatedEntries, records);
      const memory = records.get(input.memoryId);
      if (!memory) throw new StorageCorruptionError(storage.journal.filePath, "revoked memory is missing");
      return { memory, changed: true };
    });
  }

  async readCompanyContext(context: MemoryContext): Promise<CompanyContextDocument[]> {
    const companyRoot = await this.companyContextRoot(context);
    const canonicalRoot = await realpath(companyRoot);
    const nested: string[] = [];
    const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
      if (depth > MAX_COMPANY_CONTEXT_DEPTH) {
        throw new MemoryServiceError("MEMORY_COMPANY_CONTEXT_LIMIT", "Company context tree is too deep.");
      }
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || !isInside(canonicalRoot, await realpath(directory))) {
        throw new MemoryServiceError("MEMORY_PATH_UNSAFE", "Company context directory escapes its root.");
      }
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new MemoryServiceError("MEMORY_PATH_UNSAFE", `Company context symlink rejected: ${relativePath}`);
        }
        if (entry.isDirectory()) {
          if (relativePath === "knowledge") continue;
          await visit(target, relativePath, depth + 1);
          continue;
        }
        if (!entry.isFile() || !relativePath.toLocaleLowerCase().endsWith(".md")) continue;
        if (relativePath === "PERMISSIONS.md" || relativePath === "KNOWLEDGE_INDEX.md" || COMPANY_CONTEXT_FILES.includes(relativePath as typeof COMPANY_CONTEXT_FILES[number])) continue;
        const fileMetadata = await lstat(target);
        if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink() || fileMetadata.size > MAX_CONTEXT_BYTES) {
          throw new MemoryServiceError("MEMORY_COMPANY_CONTEXT_LIMIT", `Company context file is invalid: ${relativePath}`);
        }
        nested.push(relativePath);
        if (nested.length + COMPANY_CONTEXT_FILES.length > MAX_COMPANY_CONTEXT_FILES) {
          throw new MemoryServiceError("MEMORY_COMPANY_CONTEXT_LIMIT", "Company context has too many files.");
        }
      }
    };
    await visit(companyRoot, "", 0);
    const files = [...COMPANY_CONTEXT_FILES, ...nested];
    return Promise.all(files.map(async (fileName) => {
      const raw = await readRegularFileWithin(
        companyRoot,
        fileName,
        MAX_CONTEXT_BYTES,
      );
      return { fileName, content: decodeMarkdown(raw, fileName) };
    }));
  }

  async readKnowledgeIndex(context: MemoryContext) {
    const companyRoot = await this.companyContextRoot(context);
    const raw = await readRegularFileWithin(
      companyRoot,
      "KNOWLEDGE_INDEX.md",
      MAX_CONTEXT_BYTES,
    );
    return decodeMarkdown(raw, "KNOWLEDGE_INDEX.md");
  }

  private async companyContextRoot(context: MemoryContext) {
    await this.assertContext(context);
    const root = this.config.paths.companyContextRoot;
    const [metadata, dataRootMetadata] = await Promise.all([
      lstat(root),
      lstat(this.config.paths.dataRoot),
    ]);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || !dataRootMetadata.isDirectory()
      || dataRootMetadata.isSymbolicLink()
    ) {
      throw new MemoryServiceError("MEMORY_PATH_UNSAFE", "Company context root must be a real directory.");
    }
    const [canonicalDataRoot, canonicalCompanyRoot] = await Promise.all([
      realpath(this.config.paths.dataRoot),
      realpath(root),
    ]);
    if (!isInside(canonicalDataRoot, canonicalCompanyRoot)) {
      throw new MemoryServiceError("MEMORY_PATH_UNSAFE", "Company context root escapes dataRoot.");
    }
    return root;
  }

  private async knowledgeRoot(context: MemoryContext) {
    const companyRoot = await this.companyContextRoot(context);
    const root = path.join(companyRoot, "knowledge");
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new MemoryServiceError("MEMORY_PATH_UNSAFE", "Knowledge root must be a real directory.");
    }
    if (!isInside(await realpath(companyRoot), await realpath(root))) {
      throw new MemoryServiceError("MEMORY_PATH_UNSAFE", "Knowledge root escapes company context.");
    }
    return root;
  }

  async listKnowledge(context: MemoryContext): Promise<KnowledgeEntry[]> {
    const root = await this.knowledgeRoot(context);
    const canonicalRoot = await realpath(root);
    const entries: KnowledgeEntry[] = [];
    const walk = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
      if (depth > MAX_KNOWLEDGE_DEPTH) {
        throw new MemoryServiceError("MEMORY_KNOWLEDGE_LIMIT", "Knowledge tree is too deep.");
      }
      const directoryMetadata = await lstat(directory);
      if (
        !directoryMetadata.isDirectory()
        || directoryMetadata.isSymbolicLink()
        || !isInside(canonicalRoot, await realpath(directory))
      ) {
        throw new MemoryServiceError("MEMORY_PATH_UNSAFE", "Knowledge directory escapes its root.");
      }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relativePath = relativeDirectory
          ? path.posix.join(relativeDirectory, entry.name)
          : entry.name;
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new MemoryServiceError("MEMORY_PATH_UNSAFE", `Knowledge symlink rejected: ${relativePath}`);
        }
        if (entry.isDirectory()) {
          await walk(target, relativePath, depth + 1);
          continue;
        }
        if (!entry.isFile()) {
          throw new MemoryServiceError("MEMORY_PATH_UNSAFE", `Knowledge entry is not regular: ${relativePath}`);
        }
        if (!relativePath.toLowerCase().endsWith(".md")) continue;
        validateKnowledgeRelativePath(relativePath);
        const metadata = await lstat(target);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new MemoryServiceError("MEMORY_PATH_UNSAFE", `Knowledge file is not regular: ${relativePath}`);
        }
        if (metadata.size > MAX_KNOWLEDGE_FILE_BYTES) {
          throw new MemoryServiceError("MEMORY_KNOWLEDGE_LIMIT", `Knowledge file is too large: ${relativePath}`);
        }
        entries.push({
          relativePath,
          sizeBytes: metadata.size,
          modifiedAt: new Date(metadata.mtimeMs).toISOString(),
        });
        if (entries.length > MAX_KNOWLEDGE_ENTRIES) {
          throw new MemoryServiceError("MEMORY_KNOWLEDGE_LIMIT", "Knowledge tree has too many files.");
        }
      }
    };
    await walk(root, "", 0);
    return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  async readKnowledge(context: MemoryContext, relativePath: string) {
    validateKnowledgeRelativePath(relativePath);
    const root = await this.knowledgeRoot(context);
    return decodeMarkdown(
      await readRegularFileWithin(root, relativePath, MAX_KNOWLEDGE_FILE_BYTES),
      relativePath,
    );
  }

  async readEmployeeContext(context: MemoryContext): Promise<EmployeeContext> {
    await this.assertContext(context);
    const [profile, preferences] = await Promise.all([
      readRegularFileWithin(this.config.paths.usersRoot, path.join(context.userId, "PROFILE.md"), MAX_CONTEXT_BYTES),
      readRegularFileWithin(this.config.paths.usersRoot, path.join(context.userId, "PREFERENCES.md"), MAX_CONTEXT_BYTES),
    ]);
    return {
      profile: decodeMarkdown(profile, "PROFILE.md"),
      preferences: decodeMarkdown(preferences, "PREFERENCES.md"),
    };
  }

  async buildPromptSnapshot(
    context: MemoryContext,
    options: { maxItems?: number; maxCharacters?: number; query?: string } = {},
  ): Promise<MemoryPromptSnapshot> {
    const maxItems = options.maxItems ?? 20;
    const maxCharacters = options.maxCharacters ?? 12_000;
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 100) {
      throw new MemoryServiceError("MEMORY_SNAPSHOT_INVALID", "maxItems must be between 1 and 100.");
    }
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 2_048 || maxCharacters > 64_000) {
      throw new MemoryServiceError(
        "MEMORY_SNAPSHOT_INVALID",
        "maxCharacters must be between 2048 and 64000.",
      );
    }
    // Keep validation sequential so a rejected Markdown source cannot leave
    // another snapshot branch writing an index after the turn has failed.
    const companyDocuments = await this.readCompanyContext(context);
    const knowledgeIndexContent = await this.readKnowledgeIndex(context);
    const employeeContext = await this.readEmployeeContext(context);
    const memories = await this.list(context, { status: "active", limit: 10_000 });
    const governed = context.projectId
      ? await new FileMemoryProposalStore({ config: this.config, now: this.now }).listRecords({
          installationId: context.installationId,
          userId: context.userId,
          projectId: context.projectId,
        })
      : [];
    const companyContext = companyDocuments.map(({ fileName, content }) => ({
      fileName,
      content,
      contentTruncated: false,
    }));
    const knowledgeIndex = {
      fileName: "KNOWLEDGE_INDEX.md",
      content: knowledgeIndexContent,
      contentTruncated: false,
    };
    const employee = {
      profile: employeeContext.profile,
      profileTruncated: false,
      preferences: employeeContext.preferences,
      preferencesTruncated: false,
    };
    const queryTokens = [...new Set((options.query ?? "").normalize("NFKD").replace(/\p{M}/gu, "")
      .toLocaleLowerCase("es").match(/[a-z0-9]{3,}/gu) ?? [])].slice(0, 64);
    const relevance = (content: string, excerpt: string) => {
      if (queryTokens.length === 0) return 0;
      const haystack = `${content} ${excerpt}`.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("es");
      return queryTokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
    };
    const selected = [
      ...memories.map((memory) => ({ type: "explicit" as const, memory, score: relevance(memory.content, memory.provenance.sourceExcerpt), updatedAt: memory.createdAt })),
      ...governed.map((memory) => ({ type: "governed" as const, memory, score: relevance(memory.content, memory.provenance.sourceExcerpt) + (memory.scope === "project" ? 1 : 0), updatedAt: memory.updatedAt })),
    ].sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt)).slice(0, maxItems);
    const explicitMemories = selected.filter((item) => item.type === "explicit").map(({ memory }) => ({
      memoryId: memory.memoryId,
      kind: memory.kind,
      content: memory.content,
      contentTruncated: false,
      provenance: { ...memory.provenance },
      sourceExcerptTruncated: false,
    }));
    const governedMemories = selected.filter((item) => item.type === "governed").map(({ memory }) => ({
      memoryId: memory.memoryId,
      kind: memory.kind,
      scope: memory.scope,
      projectId: memory.projectId,
      content: memory.content,
      contentTruncated: false,
      provenance: { ...memory.provenance },
      sourceExcerptTruncated: false,
      revision: memory.revision,
    }));
    const payload = {
      schemaVersion: 1,
      trust: "untrusted-data-only",
      companyContext,
      knowledgeIndex,
      employeeContext: employee,
      explicitMemories,
      governedMemories,
    };
    type Truncatable = {
      get(): string;
      set(value: string): void;
      mark(): void;
    };
    const truncatable: Truncatable[] = [
      ...companyContext.map((document) => ({
        get: () => document.content,
        set: (value: string) => { document.content = value; },
        mark: () => { document.contentTruncated = true; },
      })),
      {
        get: () => knowledgeIndex.content,
        set: (value) => { knowledgeIndex.content = value; },
        mark: () => { knowledgeIndex.contentTruncated = true; },
      },
      {
        get: () => employee.profile,
        set: (value) => { employee.profile = value; },
        mark: () => { employee.profileTruncated = true; },
      },
      {
        get: () => employee.preferences,
        set: (value) => { employee.preferences = value; },
        mark: () => { employee.preferencesTruncated = true; },
      },
      ...explicitMemories.flatMap((memory) => ([
        {
          get: () => memory.content,
          set: (value: string) => { memory.content = value; },
          mark: () => { memory.contentTruncated = true; },
        },
        {
          get: () => memory.provenance.sourceExcerpt,
          set: (value: string) => { memory.provenance.sourceExcerpt = value; },
          mark: () => { memory.sourceExcerptTruncated = true; },
        },
      ])),
      ...governedMemories.flatMap((memory) => ([
        {
          get: () => memory.content,
          set: (value: string) => { memory.content = value; },
          mark: () => { memory.contentTruncated = true; },
        },
        {
          get: () => memory.provenance.sourceExcerpt,
          set: (value: string) => { memory.provenance.sourceExcerpt = value; },
          mark: () => { memory.sourceExcerptTruncated = true; },
        },
      ])),
    ];
    let truncated = memories.length + governed.length > explicitMemories.length + governedMemories.length;
    let text = JSON.stringify(payload);
    while (text.length > maxCharacters) {
      const longest = truncatable.reduce<Truncatable | null>((selected, candidate) => (
        candidate.get().length > (selected?.get().length ?? 0) ? candidate : selected
      ), null);
      if (longest && longest.get().length > 0) {
        const overflow = text.length - maxCharacters;
        const current = longest.get();
        // Share the loss across large sources. Removing the entire overflow
        // from one document can erase its workflow while equally long, less
        // relevant documents remain intact.
        const reduction = Math.min(overflow, Math.max(1, Math.ceil(current.length / 10)));
        longest.set(current.slice(0, Math.max(0, current.length - reduction)));
        longest.mark();
        truncated = true;
      } else if (explicitMemories.length > 0) {
        explicitMemories.pop();
        truncated = true;
      } else if (governedMemories.length > 0) {
        governedMemories.pop();
        truncated = true;
      } else {
        throw new MemoryServiceError(
          "MEMORY_SNAPSHOT_INVALID",
          "Snapshot metadata cannot fit inside the configured global character limit.",
        );
      }
      text = JSON.stringify(payload);
    }
    return {
      text,
      memoryIds: [...explicitMemories, ...governedMemories].map(({ memoryId }) => memoryId),
      truncated,
    };
  }
}
