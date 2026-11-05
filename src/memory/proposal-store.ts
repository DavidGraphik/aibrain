import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import {
  atomicWriteJson,
  defineVersionedSchema,
  expectArray,
  expectInteger,
  expectIsoDate,
  expectLiteral,
  expectOneOf,
  expectString,
  FileJournal,
  recoverAtomicJsonFile,
  ResourceLockManager,
  ValidationContext,
} from "@/storage";
import type { MemoryKind } from "@/memory/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTALLATION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type MemoryScope = "private" | "project" | "company";
export type MemoryProposalProvenance = {
  sourceType: "tool-assisted-chat" | "background-conversation";
  threadId: string;
  turnId: string;
  callId: string;
  toolNames: string[];
  sourceExcerpt: string;
  capturedAt: string;
};
export type MemoryProposal = {
  schemaVersion: 1;
  proposalId: string;
  installationId: string;
  userId: string;
  projectId: string;
  kind: MemoryKind;
  content: string;
  proposedScope: MemoryScope;
  provenance: MemoryProposalProvenance;
  status: "pending" | "confirmed" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
  confirmedMemoryId: string | null;
  rejectionReason: string | null;
  requestHash: string;
};
export type GovernedMemoryRecord = {
  schemaVersion: 1;
  memoryId: string;
  proposalId: string;
  installationId: string;
  ownerUserId: string;
  projectId: string | null;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  provenance: MemoryProposalProvenance;
  status: "active" | "deleted";
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
};
type ProposalState = { schemaVersion: 1; installationId: string; userId: string; proposals: MemoryProposal[] };
type RecordState = { schemaVersion: 1; installationId: string; owner: string; records: GovernedMemoryRecord[] };
export type MemoryGovernanceAuditEvent = {
  schemaVersion: 1;
  installationId: string;
  actorUserId: string;
  action: "memory.proposed" | "memory.confirmed" | "memory.rejected" | "memory.updated" | "memory.deleted" | "memory.restored" |
    "memory.auto_saved" | "memory.deduplicated" | "memory.versioned" | "memory.auto_suppressed";
  targetId: string;
  scope: MemoryScope;
  projectId: string | null;
  occurredAt: string;
  summary: string;
};

export class MemoryProposalError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "MemoryProposalError"; }
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function inside(root: string, candidate: string) { const relative = path.relative(root, candidate); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }
function missing(error: unknown) { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"); }
function boundedText(value: unknown, context: ValidationContext, maximum: number) {
  const text = expectString(value, context, { minLength: 1, maxLength: maximum });
  if (/\p{C}/u.test(text.replace(/[\t\n\r]/gu, ""))) context.fail("contains disallowed control characters");
  return text;
}
function nullableDate(value: unknown, context: ValidationContext) { return value === null ? null : expectIsoDate(value, context); }
function nullableUuid(value: unknown, context: ValidationContext) { return value === null ? null : expectString(value, context, { pattern: UUID }); }
function nullableText(value: unknown, context: ValidationContext, maximum: number) { return value === null ? null : boundedText(value, context, maximum); }
function sha256(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function normalizedMemoryText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("es").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function automaticSemanticKey(callId: string) {
  const match = /^automatic:([a-z0-9-]{3,80}):/u.exec(callId);
  return match?.[1] ?? null;
}
function assertNoSecretMaterial(value: string) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*|\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{16,}/iu.test(value)) {
    throw new MemoryProposalError("MEMORY_SECRET_REJECTED", "Credential-shaped content cannot be stored as memory.");
  }
}

function parseProvenance(value: unknown, context: ValidationContext): MemoryProposalProvenance {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["callId", "capturedAt", "sourceExcerpt", "sourceType", "threadId", "toolNames", "turnId"].sort().join("\0")) context.fail("expected exact proposal provenance");
  return {
    sourceType: expectOneOf(value.sourceType, ["tool-assisted-chat", "background-conversation"] as const, context.at("sourceType")),
    threadId: expectString(value.threadId, context.at("threadId"), { pattern: OPAQUE_ID }),
    turnId: expectString(value.turnId, context.at("turnId"), { pattern: OPAQUE_ID }),
    callId: expectString(value.callId, context.at("callId"), { pattern: OPAQUE_ID }),
    toolNames: expectArray(value.toolNames, context.at("toolNames"), (item, itemContext) => expectString(item, itemContext, { pattern: TOOL_NAME }), { maxLength: 32 }),
    sourceExcerpt: boundedText(value.sourceExcerpt, context.at("sourceExcerpt"), 4_000),
    capturedAt: expectIsoDate(value.capturedAt, context.at("capturedAt")),
  };
}

function parseProposal(value: unknown, context: ValidationContext): MemoryProposal {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["confirmedMemoryId", "content", "createdAt", "installationId", "kind", "projectId", "proposalId", "proposedScope", "provenance", "rejectionReason", "requestHash", "resolvedAt", "schemaVersion", "status", "userId"].sort().join("\0")) context.fail("expected exact memory proposal");
  const status = expectOneOf(value.status, ["pending", "confirmed", "rejected"] as const, context.at("status"));
  const resolvedAt = nullableDate(value.resolvedAt, context.at("resolvedAt"));
  const confirmedMemoryId = nullableUuid(value.confirmedMemoryId, context.at("confirmedMemoryId"));
  const rejectionReason = nullableText(value.rejectionReason, context.at("rejectionReason"), 2_000);
  if ((status === "pending" && (resolvedAt || confirmedMemoryId || rejectionReason)) || (status === "confirmed" && (!resolvedAt || !confirmedMemoryId || rejectionReason)) || (status === "rejected" && (!resolvedAt || confirmedMemoryId || !rejectionReason))) context.fail("proposal resolution metadata is inconsistent");
  const tools = parseProvenance(value.provenance, context.at("provenance"));
  if (new Set(tools.toolNames).size !== tools.toolNames.length) context.at("provenance.toolNames").fail("tool names must be unique");
  return {
    schemaVersion: expectLiteral(value.schemaVersion, 1, context.at("schemaVersion")), proposalId: expectString(value.proposalId, context.at("proposalId"), { pattern: UUID }),
    installationId: expectString(value.installationId, context.at("installationId"), { pattern: INSTALLATION_ID }), userId: expectString(value.userId, context.at("userId"), { pattern: UUID }),
    projectId: expectString(value.projectId, context.at("projectId"), { pattern: UUID }), kind: expectOneOf(value.kind, ["recollection", "decision"] as const, context.at("kind")),
    content: boundedText(value.content, context.at("content"), 32_000), proposedScope: expectOneOf(value.proposedScope, ["private", "project", "company"] as const, context.at("proposedScope")),
    provenance: tools, status, createdAt: expectIsoDate(value.createdAt, context.at("createdAt")), resolvedAt, confirmedMemoryId, rejectionReason,
    requestHash: expectString(value.requestHash, context.at("requestHash"), { minLength: 64, maxLength: 64, pattern: /^[0-9a-f]{64}$/u }),
  };
}

function parseGovernedRecord(value: unknown, context: ValidationContext): GovernedMemoryRecord {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["content", "createdAt", "deletedAt", "deletedBy", "installationId", "kind", "memoryId", "ownerUserId", "projectId", "proposalId", "provenance", "revision", "schemaVersion", "scope", "status", "updatedAt"].sort().join("\0")) context.fail("expected exact governed memory record");
  const scope = expectOneOf(value.scope, ["private", "project", "company"] as const, context.at("scope"));
  const projectId = nullableUuid(value.projectId, context.at("projectId"));
  if ((scope === "project") !== (projectId !== null)) context.at("projectId").fail("project scope requires exactly one project id");
  const status = expectOneOf(value.status, ["active", "deleted"] as const, context.at("status"));
  const deletedAt = nullableDate(value.deletedAt, context.at("deletedAt")); const deletedBy = nullableUuid(value.deletedBy, context.at("deletedBy"));
  if ((status === "deleted") !== (deletedAt !== null && deletedBy !== null)) context.fail("deletion metadata is inconsistent");
  return {
    schemaVersion: expectLiteral(value.schemaVersion, 1, context.at("schemaVersion")), memoryId: expectString(value.memoryId, context.at("memoryId"), { pattern: UUID }), proposalId: expectString(value.proposalId, context.at("proposalId"), { pattern: UUID }),
    installationId: expectString(value.installationId, context.at("installationId"), { pattern: INSTALLATION_ID }), ownerUserId: expectString(value.ownerUserId, context.at("ownerUserId"), { pattern: UUID }), projectId, scope,
    kind: expectOneOf(value.kind, ["recollection", "decision"] as const, context.at("kind")), content: boundedText(value.content, context.at("content"), 32_000), provenance: parseProvenance(value.provenance, context.at("provenance")), status,
    revision: expectInteger(value.revision, context.at("revision"), { minimum: 1 }), createdAt: expectIsoDate(value.createdAt, context.at("createdAt")), updatedAt: expectIsoDate(value.updatedAt, context.at("updatedAt")), deletedAt, deletedBy,
  };
}

const proposalStateSchema = defineVersionedSchema<ProposalState>({ name: "MemoryProposalState", schemaVersion: 1, keys: ["installationId", "userId", "proposals"], parse(record, context) { const installationId = expectString(record.installationId, context.at("installationId"), { pattern: INSTALLATION_ID }); const userId = expectString(record.userId, context.at("userId"), { pattern: UUID }); const proposals = expectArray(record.proposals, context.at("proposals"), parseProposal, { maxLength: 100_000 }); if (proposals.some((item) => item.installationId !== installationId || item.userId !== userId) || new Set(proposals.map(({ proposalId }) => proposalId)).size !== proposals.length) context.at("proposals").fail("proposal identities are not isolated"); return { schemaVersion: 1, installationId, userId, proposals }; } });
const recordStateSchema = defineVersionedSchema<RecordState>({ name: "GovernedMemoryState", schemaVersion: 1, keys: ["installationId", "owner", "records"], parse(record, context) { const installationId = expectString(record.installationId, context.at("installationId"), { pattern: INSTALLATION_ID }); const owner = expectString(record.owner, context.at("owner"), { minLength: 7, maxLength: 64 }); const records = expectArray(record.records, context.at("records"), parseGovernedRecord, { maxLength: 100_000 }); if (records.some((item) => item.installationId !== installationId) || new Set(records.map(({ memoryId }) => memoryId)).size !== records.length) context.at("records").fail("record identities are not isolated"); return { schemaVersion: 1, installationId, owner, records }; } });
const auditSchema = defineVersionedSchema<MemoryGovernanceAuditEvent>({ name: "MemoryGovernanceAuditEvent", schemaVersion: 1, keys: ["installationId", "actorUserId", "action", "targetId", "scope", "projectId", "occurredAt", "summary"], parse(record, context) { return { schemaVersion: 1, installationId: expectString(record.installationId, context.at("installationId"), { pattern: INSTALLATION_ID }), actorUserId: expectString(record.actorUserId, context.at("actorUserId"), { pattern: UUID }), action: expectOneOf(record.action, ["memory.proposed", "memory.confirmed", "memory.rejected", "memory.updated", "memory.deleted", "memory.restored", "memory.auto_saved", "memory.deduplicated", "memory.versioned", "memory.auto_suppressed"] as const, context.at("action")), targetId: expectString(record.targetId, context.at("targetId"), { pattern: UUID }), scope: expectOneOf(record.scope, ["private", "project", "company"] as const, context.at("scope")), projectId: nullableUuid(record.projectId, context.at("projectId")), occurredAt: expectIsoDate(record.occurredAt, context.at("occurredAt")), summary: boundedText(record.summary, context.at("summary"), 500) }; } });

export type MemoryProposalContext = { installationId: string; userId: string; projectId: string };

export class FileMemoryProposalStore {
  private readonly config: Readonly<InstallationConfig>; private readonly now: () => number; private readonly locks: ResourceLockManager; private readonly beforeAuditAppend?: (event: MemoryGovernanceAuditEvent) => void | Promise<void>;
  constructor(options: { config: Readonly<InstallationConfig>; now?: () => number; beforeAuditAppend?: (event: MemoryGovernanceAuditEvent) => void | Promise<void> }) { this.config = options.config; this.now = options.now ?? Date.now; this.beforeAuditAppend = options.beforeAuditAppend; this.locks = new ResourceLockManager({ rootDirectory: path.join(this.config.paths.dataRoot, "locks", "memory-proposals") }); }
  private async roots(context: MemoryProposalContext) {
    if (context.installationId !== this.config.installationId || !UUID.test(context.userId) || !UUID.test(context.projectId)) throw new MemoryProposalError("MEMORY_PROPOSAL_CONTEXT_INVALID", "Memory proposal context is invalid.");
    const usersRoot = path.resolve(this.config.paths.usersRoot); const userRoot = path.join(usersRoot, context.userId);
    const [usersMetadata, userMetadata] = await Promise.all([lstat(usersRoot), lstat(userRoot)]);
    if (!usersMetadata.isDirectory() || usersMetadata.isSymbolicLink() || !userMetadata.isDirectory() || userMetadata.isSymbolicLink() || (userMetadata.mode & 0o077) !== 0 || !inside(await realpath(usersRoot), await realpath(userRoot))) throw new MemoryProposalError("MEMORY_PROPOSAL_PATH_UNSAFE", "Memory proposal user root is unsafe.");
    const proposalRoot = path.join(userRoot, "memory", "proposals"); const userRecordsRoot = path.join(userRoot, "memory", "governed"); const companyRoot = path.join(path.resolve(this.config.paths.dataRoot), "memory", "company"); const auditRoot = path.join(userRoot, "audit", "memory-governance");
    for (const root of [proposalRoot, userRecordsRoot, companyRoot, auditRoot]) { await mkdir(root, { recursive: true, mode: 0o700 }); const metadata = await lstat(root); if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new MemoryProposalError("MEMORY_PROPOSAL_PATH_UNSAFE", "Memory proposal storage is unsafe."); await chmod(root, 0o700); }
    if (!inside(await realpath(userRoot), await realpath(proposalRoot)) || !inside(await realpath(userRoot), await realpath(userRecordsRoot)) || !inside(await realpath(this.config.paths.dataRoot), await realpath(companyRoot))) throw new MemoryProposalError("MEMORY_PROPOSAL_PATH_UNSAFE", "Memory proposal storage escapes its configured root.");
    return { userRoot, proposalPath: path.join(proposalRoot, "state.json"), userRecordsPath: path.join(userRecordsRoot, "state.json"), companyRecordsPath: path.join(companyRoot, "state.json"), auditRoot };
  }
  private async readProposals(filePath: string, context: MemoryProposalContext) { try { const state = (await recoverAtomicJsonFile(filePath, proposalStateSchema)).value; if (state.installationId !== context.installationId || state.userId !== context.userId) throw new MemoryProposalError("MEMORY_PROPOSAL_TENANT_MISMATCH", "Memory proposal state belongs to another identity."); return state; } catch (error) { if (!missing(error)) throw error; const state = proposalStateSchema.parse({ schemaVersion: 1, installationId: context.installationId, userId: context.userId, proposals: [] }); await atomicWriteJson(filePath, state, proposalStateSchema, { mode: 0o600 }); return state; } }
  private async readRecords(filePath: string, owner: string) { try { const state = (await recoverAtomicJsonFile(filePath, recordStateSchema)).value; if (state.installationId !== this.config.installationId || state.owner !== owner) throw new MemoryProposalError("MEMORY_PROPOSAL_TENANT_MISMATCH", "Governed memory state belongs to another identity."); return state; } catch (error) { if (!missing(error)) throw error; const state = recordStateSchema.parse({ schemaVersion: 1, installationId: this.config.installationId, owner, records: [] }); await atomicWriteJson(filePath, state, recordStateSchema, { mode: 0o600 }); return state; } }
  private audit(roots: Awaited<ReturnType<FileMemoryProposalStore["roots"]>>) { return new FileJournal({ filePath: path.join(roots.auditRoot, "events.jsonl"), lockManager: new ResourceLockManager({ rootDirectory: path.join(roots.auditRoot, "locks") }), payloadSchema: auditSchema, now: this.now }); }
  private async appendAudit(roots: Awaited<ReturnType<FileMemoryProposalStore["roots"]>>, event: Omit<MemoryGovernanceAuditEvent, "schemaVersion" | "installationId" | "occurredAt">) { await this.audit(roots).append({ schemaVersion: 1, installationId: this.config.installationId, ...event, occurredAt: new Date(this.now()).toISOString() }); }
  private transitionAuditPayload(event: Omit<MemoryGovernanceAuditEvent, "schemaVersion" | "installationId" | "occurredAt">): MemoryGovernanceAuditEvent {
    return { schemaVersion: 1, installationId: this.config.installationId, ...event, occurredAt: new Date(this.now()).toISOString() };
  }
  private sameTransitionAudit(left: MemoryGovernanceAuditEvent, right: MemoryGovernanceAuditEvent) {
    return left.installationId === right.installationId &&
      left.actorUserId === right.actorUserId &&
      left.action === right.action &&
      left.targetId === right.targetId &&
      left.scope === right.scope &&
      left.projectId === right.projectId &&
      left.summary === right.summary;
  }
  private async appendTransitionAudit(roots: Awaited<ReturnType<FileMemoryProposalStore["roots"]>>, event: Omit<MemoryGovernanceAuditEvent, "schemaVersion" | "installationId" | "occurredAt">) {
    const payload = this.transitionAuditPayload(event);
    await this.audit(roots).appendIf(payload, async (entries) => {
      const alreadyDurable = entries.some(({ payload: existing }) => this.sameTransitionAudit(existing, payload));
      if (alreadyDurable) return false;
      await this.beforeAuditAppend?.(payload);
      return true;
    });
  }
  private async requireTransitionAudit(roots: Awaited<ReturnType<FileMemoryProposalStore["roots"]>>, event: Omit<MemoryGovernanceAuditEvent, "schemaVersion" | "installationId" | "occurredAt">) {
    const payload = this.transitionAuditPayload(event);
    const durable = (await this.audit(roots).read()).some(({ payload: existing }) => this.sameTransitionAudit(existing, payload));
    if (!durable) throw new MemoryProposalError("MEMORY_AUDIT_MISSING", "Memory transition has no durable audit record.");
  }
  async propose(context: MemoryProposalContext, input: { kind: MemoryKind; content: string; proposedScope: MemoryScope; threadId: string; turnId: string; callId: string; toolNames: string[]; sourceExcerpt: string }) {
    assertNoSecretMaterial(input.content); assertNoSecretMaterial(input.sourceExcerpt);
    const roots = await this.roots(context); const now = new Date(this.now()).toISOString();
    const requestHash = sha256({ context, ...input, toolNames: [...new Set(input.toolNames)].sort() });
    return this.locks.withLock(`memory-propose:${context.installationId}:${context.userId}`, async () => { const state = await this.readProposals(roots.proposalPath, context); const existing = state.proposals.find(({ provenance }) => provenance.callId === input.callId); if (existing) { if (existing.requestHash !== requestHash) throw new MemoryProposalError("MEMORY_PROPOSAL_REPLAY_CONFLICT", "Memory proposal call was replayed with different content."); return { proposal: existing, created: false }; }
      const proposal = parseProposal({ schemaVersion: 1, proposalId: randomUUID(), installationId: context.installationId, userId: context.userId, projectId: context.projectId, kind: input.kind, content: input.content, proposedScope: input.proposedScope, provenance: { sourceType: "tool-assisted-chat", threadId: input.threadId, turnId: input.turnId, callId: input.callId, toolNames: [...new Set(input.toolNames)].sort(), sourceExcerpt: input.sourceExcerpt, capturedAt: now }, status: "pending", createdAt: now, resolvedAt: null, confirmedMemoryId: null, rejectionReason: null, requestHash }, new ValidationContext("MemoryProposal", "propose"));
      state.proposals.unshift(proposal); await atomicWriteJson(roots.proposalPath, state, proposalStateSchema, { mode: 0o600 }); await this.appendAudit(roots, { actorUserId: context.userId, action: "memory.proposed", targetId: proposal.proposalId, scope: proposal.proposedScope, projectId: proposal.projectId, summary: "Propuesta creada; todavía no es memoria." }); return { proposal, created: true }; });
  }
  async rememberAutomatically(context: MemoryProposalContext, input: { kind: MemoryKind; content: string; scope: "private" | "project"; semanticKey: string; threadId: string; turnId: string; extractionId: string; toolNames: string[]; sourceExcerpt: string }) {
    assertNoSecretMaterial(input.content); assertNoSecretMaterial(input.sourceExcerpt);
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/u.test(input.semanticKey) ||
        input.extractionId !== `automatic:${input.semanticKey}:${input.turnId}` || !OPAQUE_ID.test(input.extractionId)) {
      throw new MemoryProposalError("MEMORY_AUTOMATIC_INPUT_INVALID", "Automatic memory identity is invalid.");
    }
    const roots = await this.roots(context);
    const requestHash = sha256({ context, ...input, toolNames: [...new Set(input.toolNames)].sort() });
    return this.locks.withLock(`memory-governance:${context.installationId}`, async () => {
      const proposals = await this.readProposals(roots.proposalPath, context);
      const records = await this.readRecords(roots.userRecordsPath, context.userId);
      const replay = proposals.proposals.find(({ provenance }) => provenance.callId === input.extractionId);
      if (replay) {
        if (replay.requestHash !== requestHash) throw new MemoryProposalError("MEMORY_PROPOSAL_REPLAY_CONFLICT", "Automatic memory extraction was replayed with different content.");
        const memory = records.records.find(({ memoryId }) => memoryId === replay.confirmedMemoryId);
        if (!memory) throw new MemoryProposalError("MEMORY_CONFIRMATION_CORRUPT", "Automatic memory has no durable record.");
        return { memory, outcome: "replayed" as const };
      }

      const now = new Date(this.now()).toISOString();
      const projectId = input.scope === "project" ? context.projectId : null;
      const provenance: MemoryProposalProvenance = {
        sourceType: "background-conversation",
        threadId: input.threadId,
        turnId: input.turnId,
        callId: input.extractionId,
        toolNames: [...new Set(input.toolNames)].sort().slice(0, 32),
        sourceExcerpt: input.sourceExcerpt,
        capturedAt: now,
      };
      const scoped = records.records.filter((record) => record.kind === input.kind && record.scope === input.scope && record.projectId === projectId);
      const semantic = scoped.find((record) => automaticSemanticKey(record.provenance.callId) === input.semanticKey);
      if (semantic?.status === "deleted") {
        await this.appendAudit(roots, { actorUserId: context.userId, action: "memory.auto_suppressed", targetId: semantic.memoryId, scope: semantic.scope, projectId: semantic.projectId, summary: "La extracción automática respetó una eliminación previa y no recreó la memoria." });
        return { memory: semantic, outcome: "suppressed" as const };
      }
      const exact = scoped.find((record) => record.status === "active" && normalizedMemoryText(record.content) === normalizedMemoryText(input.content));
      const target = semantic ?? exact;
      const proposalId = randomUUID();
      let memory: GovernedMemoryRecord;
      let outcome: "created" | "deduplicated" | "versioned";
      if (target) {
        memory = target;
        if (normalizedMemoryText(target.content) === normalizedMemoryText(input.content)) {
          outcome = "deduplicated";
        } else {
          target.content = input.content;
          target.provenance = provenance;
          target.revision += 1;
          target.updatedAt = now;
          outcome = "versioned";
          await atomicWriteJson(roots.userRecordsPath, records, recordStateSchema, { mode: 0o600 });
        }
      } else {
        memory = parseGovernedRecord({ schemaVersion: 1, memoryId: randomUUID(), proposalId, installationId: context.installationId, ownerUserId: context.userId, projectId, scope: input.scope, kind: input.kind, content: input.content, provenance, status: "active", revision: 1, createdAt: now, updatedAt: now, deletedAt: null, deletedBy: null }, new ValidationContext("GovernedMemoryRecord", "rememberAutomatically"));
        records.records.unshift(memory);
        outcome = "created";
        await atomicWriteJson(roots.userRecordsPath, records, recordStateSchema, { mode: 0o600 });
      }
      const proposal = parseProposal({ schemaVersion: 1, proposalId, installationId: context.installationId, userId: context.userId, projectId: context.projectId, kind: input.kind, content: input.content, proposedScope: input.scope, provenance, status: "confirmed", createdAt: now, resolvedAt: now, confirmedMemoryId: memory.memoryId, rejectionReason: null, requestHash }, new ValidationContext("MemoryProposal", "rememberAutomatically"));
      proposals.proposals.unshift(proposal);
      await atomicWriteJson(roots.proposalPath, proposals, proposalStateSchema, { mode: 0o600 });
      const action = outcome === "created" ? "memory.auto_saved" : outcome === "versioned" ? "memory.versioned" : "memory.deduplicated";
      await this.appendAudit(roots, { actorUserId: context.userId, action, targetId: memory.memoryId, scope: memory.scope, projectId: memory.projectId, summary: outcome === "created" ? "Memoria útil extraída automáticamente de una conversación terminada." : outcome === "versioned" ? `Memoria automática actualizada a revisión ${memory.revision}.` : "Extracción automática deduplicada contra una memoria existente." });
      return { memory, outcome };
    });
  }
  async listProposals(context: MemoryProposalContext, status: MemoryProposal["status"] | "all" = "pending") { const roots = await this.roots(context); const state = await this.readProposals(roots.proposalPath, context); return state.proposals.filter((proposal) => status === "all" || proposal.status === status); }
  async confirm(context: MemoryProposalContext, input: { proposalId: string; explicit: true; content: string; scope: MemoryScope; allowCompanyScope: boolean }) {
    assertNoSecretMaterial(input.content);
    if (input.explicit !== true) throw new MemoryProposalError("MEMORY_CONFIRMATION_REQUIRED", "Memory confirmation must be explicit."); const roots = await this.roots(context);
    return this.locks.withLock(`memory-governance:${context.installationId}`, async () => { const proposals = await this.readProposals(roots.proposalPath, context); const proposal = proposals.proposals.find(({ proposalId }) => proposalId === input.proposalId); if (!proposal) throw new MemoryProposalError("MEMORY_PROPOSAL_NOT_FOUND", "Memory proposal was not found."); if (proposal.status === "rejected") throw new MemoryProposalError("MEMORY_PROPOSAL_REJECTED", "Rejected memory proposal cannot be confirmed."); if (input.scope === "company" && !input.allowCompanyScope) throw new MemoryProposalError("MEMORY_COMPANY_SCOPE_FORBIDDEN", "Company memory requires workspace administration permission.");
      const filePath = input.scope === "company" ? roots.companyRecordsPath : roots.userRecordsPath; const owner = input.scope === "company" ? "company" : context.userId; const records = await this.readRecords(filePath, owner);
      if (proposal.status === "confirmed") { const existing = records.records.find(({ memoryId }) => memoryId === proposal.confirmedMemoryId); if (!existing) throw new MemoryProposalError("MEMORY_CONFIRMATION_CORRUPT", "Confirmed proposal has no durable memory."); return { memory: existing, created: false }; }
      const recovered = records.records.find(({ proposalId }) => proposalId === proposal.proposalId);
      if (recovered) { proposal.status = "confirmed"; proposal.resolvedAt = recovered.createdAt; proposal.confirmedMemoryId = recovered.memoryId; await atomicWriteJson(roots.proposalPath, proposals, proposalStateSchema, { mode: 0o600 }); return { memory: recovered, created: false }; }
      const now = new Date(this.now()).toISOString(); const memory = parseGovernedRecord({ schemaVersion: 1, memoryId: randomUUID(), proposalId: proposal.proposalId, installationId: context.installationId, ownerUserId: context.userId, projectId: input.scope === "project" ? proposal.projectId : null, scope: input.scope, kind: proposal.kind, content: input.content, provenance: proposal.provenance, status: "active", revision: 1, createdAt: now, updatedAt: now, deletedAt: null, deletedBy: null }, new ValidationContext("GovernedMemoryRecord", "confirm"));
      records.records.unshift(memory); await atomicWriteJson(filePath, records, recordStateSchema, { mode: 0o600 }); proposal.status = "confirmed"; proposal.resolvedAt = now; proposal.confirmedMemoryId = memory.memoryId; await atomicWriteJson(roots.proposalPath, proposals, proposalStateSchema, { mode: 0o600 }); await this.appendAudit(roots, { actorUserId: context.userId, action: "memory.confirmed", targetId: memory.memoryId, scope: memory.scope, projectId: memory.projectId, summary: `Propuesta ${proposal.proposalId} confirmada explícitamente.` }); return { memory, created: true }; });
  }
  async reject(context: MemoryProposalContext, input: { proposalId: string; explicit: true; reason: string }) { if (input.explicit !== true) throw new MemoryProposalError("MEMORY_CONFIRMATION_REQUIRED", "Memory rejection must be explicit."); const roots = await this.roots(context); return this.locks.withLock(`memory-governance:${context.installationId}`, async () => { const state = await this.readProposals(roots.proposalPath, context); const proposal = state.proposals.find(({ proposalId }) => proposalId === input.proposalId); if (!proposal) throw new MemoryProposalError("MEMORY_PROPOSAL_NOT_FOUND", "Memory proposal was not found."); if (proposal.status === "confirmed") throw new MemoryProposalError("MEMORY_PROPOSAL_CONFIRMED", "Confirmed memory proposal cannot be rejected."); if (proposal.status === "rejected") return { proposal, changed: false }; proposal.status = "rejected"; proposal.resolvedAt = new Date(this.now()).toISOString(); proposal.rejectionReason = input.reason; await atomicWriteJson(roots.proposalPath, state, proposalStateSchema, { mode: 0o600 }); await this.appendAudit(roots, { actorUserId: context.userId, action: "memory.rejected", targetId: proposal.proposalId, scope: proposal.proposedScope, projectId: proposal.projectId, summary: "Propuesta rechazada; no se creó memoria." }); return { proposal, changed: true }; }); }
  async listRecords(context: MemoryProposalContext, includeDeleted = false, allowCompanyScope = false) { const roots = await this.roots(context); const [user, company] = await Promise.all([this.readRecords(roots.userRecordsPath, context.userId), this.readRecords(roots.companyRecordsPath, "company")]); return [...user.records.filter((record) => record.scope === "private" || record.projectId === context.projectId), ...company.records].filter((record) => record.status === "active" || (includeDeleted && (record.scope !== "company" || allowCompanyScope))).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)); }
  async update(context: MemoryProposalContext, input: { memoryId: string; explicit: true; expectedRevision: number; content: string; allowCompanyScope: boolean }) {
    assertNoSecretMaterial(input.content);
    if (input.explicit !== true) throw new MemoryProposalError("MEMORY_CONFIRMATION_REQUIRED", "Memory update must be explicit.");
    const roots = await this.roots(context);
    return this.mutateRecord(context, roots, input.memoryId, input.allowCompanyScope, async (record, state, filePath) => {
      const nextRevision = input.expectedRevision + 1;
      const operationHash = sha256({ action: "memory.updated", actorUserId: context.userId, memoryId: record.memoryId, expectedRevision: input.expectedRevision, nextRevision, content: input.content });
      const audit = { actorUserId: context.userId, action: "memory.updated" as const, targetId: record.memoryId, scope: record.scope, projectId: record.projectId, summary: `Memoria actualizada a revisión ${nextRevision}. Operación ${operationHash}.` };
      if (record.status === "active" && record.revision === nextRevision && record.content === input.content) {
        await this.requireTransitionAudit(roots, audit);
        return record;
      }
      if (record.revision !== input.expectedRevision || record.status !== "active") throw new MemoryProposalError("MEMORY_REVISION_CONFLICT", "Memory changed before this edit was confirmed.");
      const now = new Date(this.now()).toISOString();
      await this.appendTransitionAudit(roots, audit);
      record.content = input.content;
      record.revision = nextRevision;
      record.updatedAt = now;
      await atomicWriteJson(filePath, state, recordStateSchema, { mode: 0o600 });
      return record;
    });
  }
  async delete(context: MemoryProposalContext, input: { memoryId: string; explicit: true; expectedRevision: number; allowCompanyScope: boolean }) {
    if (input.explicit !== true) throw new MemoryProposalError("MEMORY_CONFIRMATION_REQUIRED", "Memory deletion must be explicit.");
    const roots = await this.roots(context);
    return this.mutateRecord(context, roots, input.memoryId, input.allowCompanyScope, async (record, state, filePath) => {
      const nextRevision = input.expectedRevision + 1;
      const operationHash = sha256({ action: "memory.deleted", actorUserId: context.userId, memoryId: record.memoryId, expectedRevision: input.expectedRevision, nextRevision });
      const audit = { actorUserId: context.userId, action: "memory.deleted" as const, targetId: record.memoryId, scope: record.scope, projectId: record.projectId, summary: `Memoria eliminada en revisión ${nextRevision} y excluida de futuras inyecciones. Operación ${operationHash}.` };
      if (record.status === "deleted" && record.revision === nextRevision && record.deletedBy === context.userId) {
        await this.requireTransitionAudit(roots, audit);
        return record;
      }
      if (record.revision !== input.expectedRevision || record.status !== "active") throw new MemoryProposalError("MEMORY_REVISION_CONFLICT", "Memory changed before deletion was confirmed.");
      const now = new Date(this.now()).toISOString();
      await this.appendTransitionAudit(roots, audit);
      record.status = "deleted";
      record.revision = nextRevision;
      record.updatedAt = now;
      record.deletedAt = now;
      record.deletedBy = context.userId;
      await atomicWriteJson(filePath, state, recordStateSchema, { mode: 0o600 });
      return record;
    });
  }
  async restore(context: MemoryProposalContext, input: { memoryId: string; explicit: true; expectedRevision: number; allowCompanyScope: boolean }) {
    if (input.explicit !== true) throw new MemoryProposalError("MEMORY_CONFIRMATION_REQUIRED", "Memory restoration must be explicit.");
    const roots = await this.roots(context);
    return this.mutateRecord(context, roots, input.memoryId, input.allowCompanyScope, async (record, state, filePath) => {
      const nextRevision = input.expectedRevision + 1;
      const operationHash = sha256({ action: "memory.restored", actorUserId: context.userId, memoryId: record.memoryId, expectedRevision: input.expectedRevision, nextRevision });
      const audit = { actorUserId: context.userId, action: "memory.restored" as const, targetId: record.memoryId, scope: record.scope, projectId: record.projectId, summary: `Memoria restaurada en revisión ${nextRevision} y disponible para futuras conversaciones. Operación ${operationHash}.` };
      if (record.status === "active" && record.revision === nextRevision) {
        await this.requireTransitionAudit(roots, audit);
        return record;
      }
      if (record.revision !== input.expectedRevision || record.status !== "deleted") throw new MemoryProposalError("MEMORY_REVISION_CONFLICT", "Memory changed before restoration was confirmed.");
      const now = new Date(this.now()).toISOString();
      await this.appendTransitionAudit(roots, audit);
      record.status = "active";
      record.revision = nextRevision;
      record.updatedAt = now;
      record.deletedAt = null;
      record.deletedBy = null;
      await atomicWriteJson(filePath, state, recordStateSchema, { mode: 0o600 });
      return record;
    });
  }
  private async mutateRecord<T>(context: MemoryProposalContext, roots: Awaited<ReturnType<FileMemoryProposalStore["roots"]>>, memoryId: string, allowCompanyScope: boolean, operation: (record: GovernedMemoryRecord, state: RecordState, filePath: string) => Promise<T>) { if (!UUID.test(memoryId)) throw new MemoryProposalError("MEMORY_ID_INVALID", "Memory id is invalid."); return this.locks.withLock(`memory-governance:${context.installationId}`, async () => { const user = await this.readRecords(roots.userRecordsPath, context.userId); let record = user.records.find(({ memoryId: candidate }) => candidate === memoryId); let state = user; let filePath = roots.userRecordsPath; if (!record) { const company = await this.readRecords(roots.companyRecordsPath, "company"); record = company.records.find(({ memoryId: candidate }) => candidate === memoryId); state = company; filePath = roots.companyRecordsPath; } if (!record || (record.scope === "project" && record.projectId !== context.projectId)) throw new MemoryProposalError("MEMORY_NOT_FOUND", "Memory is outside this user or project scope."); if (record.scope === "company" && !allowCompanyScope) throw new MemoryProposalError("MEMORY_COMPANY_SCOPE_FORBIDDEN", "Company memory requires workspace administration permission."); return operation(record, state, filePath); }); }
  async auditLog(context: MemoryProposalContext, limit = 100) { const roots = await this.roots(context); return (await this.audit(roots).read({ limit })).reverse().map(({ sequence, payload }) => ({ sequence, ...payload })); }
}
