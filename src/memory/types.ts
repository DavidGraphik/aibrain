export const MEMORY_SCHEMA_VERSION = 1 as const;

export type MemoryKind = "recollection" | "decision";
export type MemoryStatus = "active" | "revoked";
export type MemorySourceType =
  | "manual"
  | "thread"
  | "project"
  | "document"
  | "decision";

export type MemoryContext = {
  installationId: string;
  userId: string;
  projectId?: string;
};

export type MemoryProvenance = {
  sourceType: MemorySourceType;
  sourceId: string;
  sourceExcerpt: string;
  capturedAt: string;
};

export type MemoryRecord = {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  memoryId: string;
  installationId: string;
  subjectUserId: string;
  kind: MemoryKind;
  content: string;
  provenance: MemoryProvenance;
  explicit: true;
  createdBy: string;
  createdAt: string;
  status: MemoryStatus;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  idempotencyKey: string;
};

export type RememberInput = {
  explicit: true;
  kind: MemoryKind;
  content: string;
  provenance: MemoryProvenance;
  idempotencyKey: string;
};

export type RevokeMemoryInput = {
  explicit: true;
  memoryId: string;
  reason: string;
  idempotencyKey: string;
};

export type MemoryListOptions = {
  status?: MemoryStatus | "all";
  kind?: MemoryKind;
  limit?: number;
};

export type CompanyContextDocument = {
  fileName: string;
  content: string;
};

export type EmployeeContext = {
  profile: string;
  preferences: string;
};

export type KnowledgeEntry = {
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
};

export type MemoryPromptSnapshot = {
  text: string;
  memoryIds: string[];
  truncated: boolean;
};

export interface MemoryService {
  remember(
    context: MemoryContext,
    input: RememberInput,
  ): Promise<{ memory: MemoryRecord; created: boolean }>;
  read(context: MemoryContext, memoryId: string): Promise<MemoryRecord | null>;
  list(context: MemoryContext, options?: MemoryListOptions): Promise<MemoryRecord[]>;
  revoke(
    context: MemoryContext,
    input: RevokeMemoryInput,
  ): Promise<{ memory: MemoryRecord; changed: boolean }>;
  readCompanyContext(context: MemoryContext): Promise<CompanyContextDocument[]>;
  readKnowledgeIndex(context: MemoryContext): Promise<string>;
  listKnowledge(context: MemoryContext): Promise<KnowledgeEntry[]>;
  readKnowledge(context: MemoryContext, relativePath: string): Promise<string>;
  readEmployeeContext(context: MemoryContext): Promise<EmployeeContext>;
  buildPromptSnapshot(
    context: MemoryContext,
    options?: { maxItems?: number; maxCharacters?: number; query?: string },
  ): Promise<MemoryPromptSnapshot>;
}
