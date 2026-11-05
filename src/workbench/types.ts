import type { ChatMessage } from "@/lib/chat-contract";
import { isChatMessage } from "@/lib/chat-contract";

export type ProjectStatus = "active" | "archived";
export type ThreadStatus = "active" | "archived";
export type ThreadBranchKind = "edit" | "retry" | "branch";
export type WorkspaceStatus = "ready" | "pending" | "unavailable";
export type WorkbenchPersistence = "filesystem" | "filesystem-demo" | "browser-preview";
export type ProjectVisibility = "private" | "shared";
export type ProjectMemberRole = "owner" | "editor" | "viewer";
export type ProjectMemberStatus = "active" | "invited-local";
export type ProjectSourceKind = "file" | "link" | "note";
export type ProjectSourceStatus = "ready" | "pending-index";

/** Internal per-user workspace backing chats that are not filed in a project. */
export const STANDALONE_PROJECT_SLUG = "aibrain-standalone-chats";

export type WorkbenchWorkspace = {
  id: string;
  label: string;
  hostType: "managed";
  status: WorkspaceStatus;
  isPrimary: boolean;
};

export type ProjectSource = {
  id: string;
  kind: ProjectSourceKind;
  name: string;
  url: string | null;
  mimeType: string | null;
  size: number | null;
  excerpt: string | null;
  status: ProjectSourceStatus;
  createdAt: string;
};

export type ProjectMember = {
  id: string;
  email: string;
  name: string | null;
  role: ProjectMemberRole;
  status: ProjectMemberStatus;
  addedAt: string;
};

export type ProjectMemory = {
  enabled: boolean;
  notes: string;
  updatedAt: string | null;
};

export type ProjectSharing = {
  visibility: ProjectVisibility;
  members: ProjectMember[];
};

/**
 * Server-issued capabilities for the principal viewing a project. Persisted
 * owner snapshots and demo fixtures may omit this projection; consumers must
 * treat an omitted value as the legacy owner-compatible state, never derive a
 * shared role from customer-controlled member metadata in the browser.
 */
export type WorkbenchProjectAccess = {
  role: ProjectMemberRole;
  canEdit: boolean;
  canManage: boolean;
};

export const OWNER_PROJECT_ACCESS: Readonly<WorkbenchProjectAccess> = {
  role: "owner",
  canEdit: true,
  canManage: true,
};

export function workbenchProjectAccess(
  project: Pick<WorkbenchProject, "access"> | null | undefined,
): Readonly<WorkbenchProjectAccess> {
  return project?.access ?? OWNER_PROJECT_ACCESS;
}

export type WorkbenchProject = {
  id: string;
  name: string;
  slug: string;
  status: ProjectStatus;
  pinned: boolean;
  instructions: string;
  sources: ProjectSource[];
  memory: ProjectMemory;
  sharing: ProjectSharing;
  /** Present on server-authorized shared-workbench projections. */
  access?: WorkbenchProjectAccess;
  workspace: WorkbenchWorkspace;
  createdAt: string;
  updatedAt: string;
};

export function isStandaloneProject(project: Pick<WorkbenchProject, "slug"> | null | undefined) {
  return project?.slug === STANDALONE_PROJECT_SLUG;
}

export type WorkbenchThread = {
  id: string;
  projectId: string;
  title: string;
  status: ThreadStatus;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  /** False only in metadata navigation snapshots; hydrate before selecting. */
  historyLoaded?: boolean;
  /** Server-issued capabilities for this conversation, independent of its project. */
  access?: WorkbenchProjectAccess;
  /** Present only for conversations created from a specific point in another conversation. */
  lineage?: {
    parentThreadId: string;
    branchedFromMessageId: string;
    kind: ThreadBranchKind;
  } | null;
};

export function workbenchThreadAccess(
  thread: Pick<WorkbenchThread, "access"> | null | undefined,
  project: Pick<WorkbenchProject, "access"> | null | undefined,
): Readonly<WorkbenchProjectAccess> {
  return thread?.access ?? (thread && !project
    ? { role: "viewer", canEdit: false, canManage: false }
    : workbenchProjectAccess(project));
}

export type WorkbenchThreadSummary = Omit<WorkbenchThread, "messages"> & {
  messageCount: number;
  lastMessageAt: string | null;
};

export type WorkbenchPage<Item> = {
  items: Item[];
  nextCursor: string | null;
};

export type WorkbenchStatusFilter = ProjectStatus | "all";
export type WorkbenchListQuery = {
  status: WorkbenchStatusFilter;
  limit: number;
  query?: string;
  cursor?: string;
};

export const WORKBENCH_DEFAULT_PAGE_SIZE = 20;
export const WORKBENCH_MAX_PAGE_SIZE = 50;
export const WORKBENCH_MAX_QUERY_LENGTH = 100;
export const WORKBENCH_MAX_CURSOR_LENGTH = 256;

export type WorkbenchSnapshot = {
  persistence: WorkbenchPersistence;
  projects: WorkbenchProject[];
  threads: WorkbenchThread[];
};

export type CreateProjectInput = { name: string };
export type UpdateProjectInput = {
  name?: string;
  pinned?: boolean;
  status?: ProjectStatus;
  instructions?: string;
  sources?: ProjectSource[];
  memory?: ProjectMemory;
  sharing?: ProjectSharing;
};
export type CreateThreadInput = { title: string };
export type UpdateThreadInput = {
  title?: string;
  pinned?: boolean;
  status?: ThreadStatus;
};

export type BranchThreadInput = {
  kind: ThreadBranchKind;
  messageId: string;
  editedContent?: string;
};

export type BranchThreadResult = {
  thread: WorkbenchThread;
  draftMessage: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isIsoDate(value: unknown) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isSafeText(value: unknown, maximum: number) {
  return typeof value === "string" && value.length <= maximum && !/\p{C}/u.test(value);
}

function isSafeMultilineText(value: unknown, maximum: number) {
  return typeof value === "string" && value.length <= maximum && !/\p{C}/u.test(value.replace(/[\t\r\n]/g, ""));
}

function isProjectSource(value: unknown): value is ProjectSource {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 9 &&
    isUuid(value.id) &&
    (value.kind === "file" || value.kind === "link" || value.kind === "note") &&
    typeof value.name === "string" && isSafeText(value.name, 160) && value.name.trim().length > 0 &&
    (value.url === null || (typeof value.url === "string" && value.url.length <= 2_048 && /^https?:\/\//.test(value.url))) &&
    (value.mimeType === null || isSafeText(value.mimeType, 120)) &&
    (value.size === null || (Number.isSafeInteger(value.size) && (value.size as number) >= 0 && (value.size as number) <= 20_000_000)) &&
    (value.excerpt === null || isSafeText(value.excerpt, 32_000)) &&
    (value.status === "ready" || value.status === "pending-index") &&
    isIsoDate(value.createdAt);
}

function isProjectMember(value: unknown): value is ProjectMember {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 6 &&
    isUuid(value.id) &&
    typeof value.email === "string" && value.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) &&
    (value.name === null || (typeof value.name === "string" && isSafeText(value.name, 100) && value.name.trim().length > 0)) &&
    (value.role === "owner" || value.role === "editor" || value.role === "viewer") &&
    (value.status === "active" || value.status === "invited-local") &&
    isIsoDate(value.addedAt);
}

function isProjectMemory(value: unknown): value is ProjectMemory {
  return isRecord(value) && Object.keys(value).length === 3 &&
    typeof value.enabled === "boolean" && isSafeMultilineText(value.notes, 16_000) &&
    (value.updatedAt === null || isIsoDate(value.updatedAt));
}

function isProjectSharing(value: unknown): value is ProjectSharing {
  return isRecord(value) && Object.keys(value).length === 2 &&
    (value.visibility === "private" || value.visibility === "shared") &&
    Array.isArray(value.members) && value.members.length <= 100 && value.members.every(isProjectMember) &&
    new Set(value.members.map((member) => member.email.toLocaleLowerCase())).size === value.members.length;
}

function isWorkbenchProjectAccess(value: unknown): value is WorkbenchProjectAccess {
  if (!isRecord(value) || Object.keys(value).length !== 3) return false;
  return (value.role === "owner" && value.canEdit === true && value.canManage === true) ||
    (value.role === "editor" && value.canEdit === true && value.canManage === false) ||
    (value.role === "viewer" && value.canEdit === false && value.canManage === false);
}

export function isProjectName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && value.trim().length > 0;
}

export function isThreadTitle(value: unknown): value is string {
  return typeof value === "string" && value.length <= 120 && value.trim().length > 0;
}

export function isWorkbenchWorkspace(value: unknown): value is WorkbenchWorkspace {
  if (!isRecord(value)) return false;
  return isUuid(value.id) &&
    typeof value.label === "string" && value.label.trim().length > 0 && value.label.length <= 100 &&
    value.hostType === "managed" &&
    (value.status === "ready" || value.status === "pending" || value.status === "unavailable") &&
    typeof value.isPrimary === "boolean";
}

export function isWorkbenchProject(value: unknown): value is WorkbenchProject {
  if (!isRecord(value)) return false;
  return isUuid(value.id) &&
    isProjectName(value.name) &&
    typeof value.slug === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value.slug) &&
    (value.status === "active" || value.status === "archived") &&
    typeof value.pinned === "boolean" &&
    isSafeMultilineText(value.instructions, 16_000) &&
    Array.isArray(value.sources) && value.sources.length <= 100 && value.sources.every(isProjectSource) &&
    isProjectMemory(value.memory) &&
    isProjectSharing(value.sharing) &&
    (value.access === undefined || isWorkbenchProjectAccess(value.access)) &&
    isWorkbenchWorkspace(value.workspace) &&
    isIsoDate(value.createdAt) &&
    isIsoDate(value.updatedAt);
}

export function isWorkbenchThread(value: unknown): value is WorkbenchThread {
  if (!isRecord(value)) return false;
  const lineage = value.lineage;
  return isUuid(value.id) &&
    isUuid(value.projectId) &&
    isThreadTitle(value.title) &&
    (value.status === "active" || value.status === "archived") &&
    typeof value.pinned === "boolean" &&
    isIsoDate(value.createdAt) &&
    isIsoDate(value.updatedAt) &&
    Array.isArray(value.messages) &&
    value.messages.every(isChatMessage) &&
    (value.historyLoaded === undefined || typeof value.historyLoaded === "boolean") &&
    (value.access === undefined || isWorkbenchProjectAccess(value.access)) &&
    (lineage === undefined || lineage === null || (
      isRecord(lineage) && Object.keys(lineage).length === 3 &&
      isUuid(lineage.parentThreadId) && isUuid(lineage.branchedFromMessageId) &&
      (lineage.kind === "edit" || lineage.kind === "retry" || lineage.kind === "branch")
    ));
}

export function isWorkbenchThreadSummary(value: unknown): value is WorkbenchThreadSummary {
  if (!isRecord(value)) return false;
  const keys = [
    "id", "projectId", "title", "status", "pinned", "createdAt", "updatedAt",
    "messageCount", "lastMessageAt",
  ];
  if (Object.keys(value).some((key) => ![...keys, "lineage", "access", "historyLoaded"].includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))) {
    return false;
  }
  const { messageCount, lastMessageAt, ...thread } = value;
  return isWorkbenchThread({ ...thread, messages: [] }) &&
    Number.isSafeInteger(messageCount) && (messageCount as number) >= 0 &&
    (lastMessageAt === null || isIsoDate(lastMessageAt));
}

export function isBranchThreadInput(value: unknown): value is BranchThreadInput {
  if (!isRecord(value)) return false;
  const allowed = value.kind === "edit"
    ? ["kind", "messageId", "editedContent"]
    : ["kind", "messageId"];
  if (Object.keys(value).length !== allowed.length ||
    Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (!(value.kind === "edit" || value.kind === "retry" || value.kind === "branch") ||
    !isUuid(value.messageId)) return false;
  return value.kind !== "edit" || (
    typeof value.editedContent === "string" && value.editedContent.trim().length > 0 &&
    value.editedContent.length <= 32_000 && !/\p{C}/u.test(value.editedContent)
  );
}

export function isWorkbenchPage<Item>(
  value: unknown,
  isItem: (item: unknown) => item is Item,
): value is WorkbenchPage<Item> {
  return isRecord(value) &&
    Object.keys(value).length === 2 &&
    Array.isArray(value.items) && value.items.every(isItem) &&
    (value.nextCursor === null || (
      typeof value.nextCursor === "string" &&
      value.nextCursor.length > 0 &&
      value.nextCursor.length <= WORKBENCH_MAX_CURSOR_LENGTH &&
      /^[A-Za-z0-9_-]+$/.test(value.nextCursor)
    ));
}

export function parseWorkbenchListQuery(searchParams: URLSearchParams): WorkbenchListQuery | null {
  const allowed = new Set(["status", "limit", "q", "cursor"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) return null;
  }

  const rawStatus = searchParams.get("status");
  const status: WorkbenchStatusFilter = rawStatus === null
    ? "active"
    : rawStatus === "active" || rawStatus === "archived" || rawStatus === "all"
      ? rawStatus
      : "all";
  if (rawStatus !== null && status !== rawStatus) return null;

  const rawLimit = searchParams.get("limit");
  const limit = rawLimit === null ? WORKBENCH_DEFAULT_PAGE_SIZE : Number(rawLimit);
  if (
    !Number.isSafeInteger(limit) || limit < 1 || limit > WORKBENCH_MAX_PAGE_SIZE ||
    (rawLimit !== null && !/^[1-9][0-9]*$/.test(rawLimit))
  ) return null;

  const rawQuery = searchParams.get("q");
  const query = rawQuery?.trim();
  if (rawQuery !== null && (
    rawQuery.length > WORKBENCH_MAX_QUERY_LENGTH || !query || /\p{C}/u.test(query)
  )) return null;

  const cursor = searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && (
    cursor.length < 1 || cursor.length > WORKBENCH_MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  )) return null;

  return {
    status,
    limit,
    ...(query ? { query } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export function isWorkbenchSnapshot(value: unknown): value is WorkbenchSnapshot {
  if (!isRecord(value)) return false;
  return (value.persistence === "filesystem" ||
      value.persistence === "filesystem-demo" ||
      value.persistence === "browser-preview") &&
    Array.isArray(value.projects) && value.projects.every(isWorkbenchProject) &&
    Array.isArray(value.threads) && value.threads.every(isWorkbenchThread);
}

export function isCreateProjectInput(value: unknown): value is CreateProjectInput {
  return isRecord(value) && Object.keys(value).length === 1 && isProjectName(value.name);
}

export function isUpdateProjectInput(value: unknown): value is UpdateProjectInput {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !["name", "pinned", "status", "instructions", "sources", "memory", "sharing"].includes(key))) {
    return false;
  }
  return (!("name" in value) || isProjectName(value.name)) &&
    (!("pinned" in value) || typeof value.pinned === "boolean") &&
    (!("status" in value) || value.status === "active" || value.status === "archived") &&
    (!("instructions" in value) || isSafeMultilineText(value.instructions, 16_000)) &&
    (!("sources" in value) || (Array.isArray(value.sources) && value.sources.length <= 100 && value.sources.every(isProjectSource))) &&
    (!("memory" in value) || isProjectMemory(value.memory)) &&
    (!("sharing" in value) || isProjectSharing(value.sharing));
}

export function isCreateThreadInput(value: unknown): value is CreateThreadInput {
  return isRecord(value) && Object.keys(value).length === 1 && isThreadTitle(value.title);
}

export function isUpdateThreadInput(value: unknown): value is UpdateThreadInput {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !["title", "pinned", "status"].includes(key))) {
    return false;
  }
  return (!("title" in value) || isThreadTitle(value.title)) &&
    (!("pinned" in value) || typeof value.pinned === "boolean") &&
    (!("status" in value) || value.status === "active" || value.status === "archived");
}
