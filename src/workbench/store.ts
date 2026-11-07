import "server-only";

import { createHash } from "node:crypto";
import type { AuthSession } from "@/auth/types";
import { isVercelPreviewDemoEnabled } from "@/auth/session";
import type { ChatMessage } from "@/lib/chat-contract";
import {
  assertWorkbenchId,
  beginDemoThreadTurn,
  branchDemoThread,
  createDemoProject,
  createDemoThread,
  finishDemoThreadTurn,
  getDemoThread,
  getDemoProjectRuntimeContext,
  getDemoThreadRuntimeContext,
  loadDemoWorkbench,
  updateDemoProject,
  updateDemoThread,
  updateDemoMessageActivity,
} from "@/workbench/demo-store";
import { WorkbenchConflictError, WorkbenchNotFoundError, WorkbenchPersistenceError, WorkbenchValidationError } from "@/workbench/errors";
import {
  assertFilesystemWorkbenchId,
  FileWorkbenchStore,
} from "@/workbench/filesystem-store";
import { FilePinnedThreadStore } from "@/workbench/pinned-thread-store";
import { loadInstallationConfig } from "@/config/installation";
import type {
  BranchThreadInput,
  UpdateProjectInput,
  UpdateThreadInput,
  WorkbenchProject,
  WorkbenchListQuery,
  WorkbenchSnapshot,
} from "@/workbench/types";
import { STANDALONE_PROJECT_SLUG } from "@/workbench/types";
import type { AgentThreadRuntimeContext, ThreadRuntimeContext } from "@/workbench/internal";
import {
  loadSharedWorkbench,
  createReadableThreadReader,
  loadVisibleProjectsForResolvedThread,
  normalizeProjectMembers,
  resolveProjectAccess,
  resolveThreadAccess,
  syncOwnSharedAccess,
  syncSharedThreadAccess,
  threadSummary,
  threadWithAccess,
} from "@/workbench/shared-access";

function mode(session: AuthSession): "filesystem" | "demo" {
  if (session?.provider === "local") return "filesystem";
  if (session?.provider === "demo") return "demo";
  throw new WorkbenchPersistenceError("La sessió no té un adapter de producte autoritzat.");
}

function sharedPageFingerprint(scope: string, query: WorkbenchListQuery) {
  return createHash("sha256").update(JSON.stringify({ scope, status: query.status, query: query.query ?? null }))
    .digest("base64url").slice(0, 16);
}

function sharedPage<Item>(items: Item[], query: WorkbenchListQuery, scope: string) {
  const fingerprint = sharedPageFingerprint(scope, query);
  let offset = 0;
  if (query.cursor) {
    try {
      const raw = Buffer.from(query.cursor, "base64url");
      if (raw.toString("base64url") !== query.cursor || raw.byteLength > 128) throw new Error("cursor");
      const value: unknown = JSON.parse(raw.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).length !== 3 || !("v" in value) || value.v !== 1 ||
          !("offset" in value) || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 ||
          !("fingerprint" in value) || value.fingerprint !== fingerprint) throw new Error("cursor");
      offset = value.offset as number;
    } catch (error) {
      throw new WorkbenchValidationError("El cursor de paginació no és vàlid.", { cause: error });
    }
  }
  const page = items.slice(offset, offset + query.limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    nextCursor: nextOffset < items.length
      ? Buffer.from(JSON.stringify({ v: 1, offset: nextOffset, fingerprint }), "utf8").toString("base64url")
      : null,
  };
}

function compareVisibleProjects(left: WorkbenchProject, right: WorkbenchProject) {
  return Number(right.pinned) - Number(left.pinned)
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id);
}

/** Mirrors the active project section of the UI sidebar, using only the
 * server-authorized workbench snapshot for this session. */
export function visibleProjectReferences(snapshot: Pick<WorkbenchSnapshot, "projects">) {
  return snapshot.projects
    .filter((project) => project.status === "active" && project.slug !== STANDALONE_PROJECT_SLUG)
    .toSorted(compareVisibleProjects)
    .map(({ id, name }) => ({ id, name }));
}

function withVisibleProjects(
  context: ThreadRuntimeContext,
  snapshot: Pick<WorkbenchSnapshot, "projects">,
): AgentThreadRuntimeContext {
  return { ...context, visibleProjects: visibleProjectReferences(snapshot) };
}

async function filesystemStore(session: AuthSession) {
  if (session.provider !== "local") {
    throw new WorkbenchPersistenceError("La sessió no pertany al workbench local.");
  }
  const installation = await loadInstallationConfig();
  if (session.tenant.id !== installation.installationId) {
    throw new WorkbenchPersistenceError("La sessió no pertany a aquesta instal·lació.");
  }
  return FileWorkbenchStore.fromInstallation(installation);
}

async function pinnedThreadStore(session: AuthSession) {
  if (session.provider !== "local") {
    throw new WorkbenchPersistenceError("La sessió no pertany al workbench local.");
  }
  const installation = await loadInstallationConfig();
  if (session.tenant.id !== installation.installationId) {
    throw new WorkbenchPersistenceError("La sessió no pertany a aquesta instal·lació.");
  }
  return new FilePinnedThreadStore(
    installation.paths.dataRoot,
    installation.paths.usersRoot,
    installation.installationId,
  );
}

function legacyPinnedIds(threads: WorkbenchSnapshot["threads"]) {
  return threads
    .filter((thread) => thread.pinned)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    .map((thread) => thread.id);
}

export function isBrowserPreviewWorkbench() {
  return isVercelPreviewDemoEnabled();
}

export async function loadWorkbench(session: AuthSession, metadataOnly = false) {
  if (mode(session) === "filesystem") {
    return loadSharedWorkbench(session, metadataOnly);
  }
  return loadDemoWorkbench(
    session,
    isBrowserPreviewWorkbench() ? "browser-preview" : "filesystem-demo",
  );
}

export async function listProjects(session: AuthSession, query: WorkbenchListQuery) {
  await filesystemStore(session);
  const snapshot = await loadSharedWorkbench(session, true);
  const needle = query.query?.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  const items = snapshot.projects.filter((project) => project.slug !== "aibrain-standalone-chats")
    .filter((project) => query.status === "all" || project.status === query.status)
    .filter((project) => !needle || `${project.name} ${project.slug}`.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().includes(needle))
    .toSorted((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  return sharedPage(items, query, `projects:${session.user.id}`);
}

export async function getProject(session: AuthSession, projectId: string) {
  if (mode(session) === "filesystem") {
    assertFilesystemWorkbenchId(projectId);
    const access = await resolveProjectAccess(session, projectId);
    return access.store.getProject(access.ownerUserId, projectId);
  }
  assertWorkbenchId(projectId);
  const snapshot = await loadDemoWorkbench(
    session,
    isBrowserPreviewWorkbench() ? "browser-preview" : "filesystem-demo",
  );
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new WorkbenchNotFoundError("Proyecto no encontrado.");
  return project;
}

export async function getWritableProject(session: AuthSession, projectId: string) {
  if (mode(session) !== "filesystem") return getProject(session, projectId);
  assertFilesystemWorkbenchId(projectId);
  const access = await resolveProjectAccess(session, projectId);
  if (access.role === "viewer") {
    throw new WorkbenchConflictError("No tienes permisos para crear trabajo en este proyecto compartido.");
  }
  return access.project;
}

export async function listThreads(
  session: AuthSession,
  projectId: string | null,
  query: WorkbenchListQuery,
) {
  if (projectId !== null) assertFilesystemWorkbenchId(projectId);
  await filesystemStore(session);
  if (projectId !== null) await resolveProjectAccess(session, projectId);
  const snapshot = await loadSharedWorkbench(session, true);
  const needle = query.query?.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  const snapshotOrder = new Map(snapshot.threads.map((thread, index) => [thread.id, index]));
  const items = snapshot.threads.filter((thread) => projectId === null || thread.projectId === projectId)
    .filter((thread) => query.status === "all" || thread.status === query.status)
    .filter((thread) => !needle || thread.title.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().includes(needle))
    .map(threadSummary)
    .toSorted((left, right) => Number(right.pinned) - Number(left.pinned) || (
      left.pinned && right.pinned
        ? (snapshotOrder.get(left.id) ?? 0) - (snapshotOrder.get(right.id) ?? 0)
        : right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
    ));
  const page = sharedPage(items, query, `threads:${session.user.id}:${projectId ?? "all"}`);
  const read = await createReadableThreadReader(session);
  const summaries = [];
  // Metadata decides visibility, filtering, personal pin order and pagination.
  // Hydrate only the returned page, one authorized history at a time. Never
  // retain a page of message bodies or turn metadata placeholders into counts.
  for (const { historyLoaded: _historyLoaded, ...listed } of page.items) {
    const thread = await read(listed.id);
    if (thread.projectId !== listed.projectId) throw new WorkbenchNotFoundError("Fil no trobat.");
    summaries.push({ ...listed, access: thread.access,
      messageCount: thread.messages.length, lastMessageAt: thread.messages.at(-1)?.createdAt ?? null });
  }
  return { ...page, items: summaries };
}

export async function getThread(session: AuthSession, threadId: string) {
  if (mode(session) === "filesystem") {
    assertFilesystemWorkbenchId(threadId);
    const access = await resolveThreadAccess(session, threadId);
    const pinnedThreadIds = await (await pinnedThreadStore(session)).read(
      session.user.id,
      legacyPinnedIds(access.context.own.threads),
    );
    return { ...threadWithAccess(access.thread, access.role), pinned: pinnedThreadIds.includes(threadId) };
  }
  assertWorkbenchId(threadId);
  return getDemoThread(session, threadId);
}

export async function createProject(session: AuthSession, name: string) {
  if (mode(session) === "filesystem") {
    const project = await (await filesystemStore(session)).createProject(session.user.id, name);
    await syncOwnSharedAccess(session);
    return project;
  }
  return createDemoProject(session, name);
}

export async function updateProject(
  session: AuthSession,
  projectId: string,
  patch: UpdateProjectInput,
) {
  if (mode(session) === "filesystem") {
    assertFilesystemWorkbenchId(projectId);
    const access = await resolveProjectAccess(session, projectId);
    if (access.role === "viewer" || (access.role !== "owner" && (patch.sharing !== undefined || patch.status !== undefined))) {
      throw new WorkbenchConflictError("No tens permís per gestionar aquest projecte compartit.");
    }
    const normalized = patch.sharing
      ? { ...patch, sharing: await normalizeProjectMembers(session, { ...access.project, sharing: patch.sharing }) }
      : patch;
    const project = await access.store.updateProject(access.ownerUserId, projectId, normalized);
    if (access.ownerUserId === session.user.id) await syncOwnSharedAccess(session);
    return project;
  }
  assertWorkbenchId(projectId);
  return updateDemoProject(session, projectId, patch);
}

export async function createThread(
  session: AuthSession,
  projectId: string,
  title: string,
  options: { id?: string } = {},
) {
  if (mode(session) === "filesystem") {
    assertFilesystemWorkbenchId(projectId);
    const access = await resolveProjectAccess(session, projectId);
    if (access.role === "viewer") throw new WorkbenchConflictError("Aquest projecte compartit és de només lectura.");
    const thread = await access.store.createThread(access.ownerUserId, projectId, title, options.id);
    await syncSharedThreadAccess(session, access.ownerUserId, projectId, thread.id);
    return thread;
  }
  if (options.id) throw new WorkbenchPersistenceError("Los ids deterministas requieren el workbench local persistente.");
  assertWorkbenchId(projectId);
  return createDemoThread(session, projectId, title);
}

export async function updateThread(
  session: AuthSession,
  threadId: string,
  patch: UpdateThreadInput,
) {
  if (mode(session) === "filesystem") {
    assertFilesystemWorkbenchId(threadId);
    const access = await resolveThreadAccess(session, threadId);
    const resourcePatch: UpdateThreadInput = {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    };
    if (Object.keys(resourcePatch).length > 0 && access.role === "viewer") {
      throw new WorkbenchConflictError("Aquest projecte compartit és de només lectura.");
    }
    const thread = Object.keys(resourcePatch).length > 0
      ? await access.store.updateThread(access.ownerUserId, threadId, resourcePatch)
      : access.thread;
    const pins = await pinnedThreadStore(session);
    const existingLegacyPins = legacyPinnedIds(access.context.own.threads);
    const orderedIds = patch.pinned === undefined
      ? await pins.read(session.user.id, existingLegacyPins)
      : await pins.update(session.user.id, threadId, patch.pinned, existingLegacyPins);
    return { ...thread, pinned: orderedIds.includes(threadId) };
  }
  assertWorkbenchId(threadId);
  return updateDemoThread(session, threadId, patch);
}

/** Not a public lifecycle endpoint: only an exact generated automation result
 * with no human follow-up can be archived by this compare-and-set closeout. */
export async function archiveGeneratedAutomationResult(session:AuthSession,runKey:string,expected:{projectId:string;prompt:string;resultHash:string}) {
  if(mode(session)!=="filesystem")throw new WorkbenchPersistenceError("La finalización silenciosa requiere el workbench persistente.");
  const {automationRunIdentities}=await import("@/automations/run-identities");
  const access=await resolveThreadAccess(session,automationRunIdentities(runKey).threadId);
  if(access.role==="viewer")throw new WorkbenchConflictError("El resultado es de solo lectura.");
  return access.store.archiveGeneratedAutomationResult(access.ownerUserId,runKey,expected);
}

export async function branchThread(
  session: AuthSession,
  threadId: string,
  input: BranchThreadInput,
) {
  if (mode(session) === "filesystem") {
    assertFilesystemWorkbenchId(threadId);
    const access = await resolveThreadAccess(session, threadId);
    if (access.role === "viewer") throw new WorkbenchConflictError("Aquest projecte compartit és de només lectura.");
    const result = await access.store.branchThread(access.ownerUserId, threadId, input);
    await syncSharedThreadAccess(session, access.ownerUserId, access.project.id, result.thread.id);
    return result;
  }
  assertWorkbenchId(threadId);
  return branchDemoThread(session, threadId, input);
}

export async function getProjectRuntimeContext(session: AuthSession, projectId: string) {
  if (mode(session) === "filesystem") {
    assertFilesystemWorkbenchId(projectId);
    const access = await resolveProjectAccess(session, projectId);
    return access.store.getProjectRuntimeContext(access.ownerUserId, projectId);
  }
  assertWorkbenchId(projectId);
  return getDemoProjectRuntimeContext(session, projectId);
}

export async function getThreadRuntimeContext(
  session: AuthSession,
  threadId: string,
): Promise<AgentThreadRuntimeContext> {
  if (mode(session) === "filesystem") {
    assertFilesystemWorkbenchId(threadId);
    const access = await resolveThreadAccess(session, threadId, { includeTurnContext: true });
    if (access.role === "viewer") throw new WorkbenchConflictError("Aquest projecte compartit és de només lectura.");
    if (!access.turnContext) throw new WorkbenchNotFoundError("Fil o projecte actiu no trobat.");
    return withVisibleProjects(
      access.turnContext.context,
      await loadVisibleProjectsForResolvedThread(access),
    );
  }
  assertWorkbenchId(threadId);
  return withVisibleProjects(
    await getDemoThreadRuntimeContext(session, threadId),
    await loadDemoWorkbench(
      session,
      isBrowserPreviewWorkbench() ? "browser-preview" : "filesystem-demo",
    ),
  );
}

/**
 * Resolves filesystem authorization once for the pre-stream portion of a chat
 * turn. The returned closure can persist the idempotent turn without scanning
 * users and rebuilding the same access context a second time.
 */
export async function prepareThreadTurn(session: AuthSession, threadId: string) {
  if (mode(session) !== "filesystem") {
    throw new WorkbenchPersistenceError("La preparació persistent requereix un workbench local.");
  }
  assertFilesystemWorkbenchId(threadId);
  const access = await resolveThreadAccess(session, threadId, { includeTurnContext: true });
  if (access.role === "viewer") {
    throw new WorkbenchConflictError("Aquest projecte compartit és de només lectura.");
  }
  if (!access.turnContext) throw new WorkbenchNotFoundError("Fil o projecte actiu no trobat.");
  const { context: runtimeContext, rebootstrapHistory } = access.turnContext;
  const visibleSnapshot = await loadVisibleProjectsForResolvedThread(access);
  const { store, ownerUserId } = access;
  return {
    context: withVisibleProjects(runtimeContext, visibleSnapshot),
    rebootstrapHistory,
    begin(userMessage: ChatMessage, assistantMessage: ChatMessage) {
      return store.beginThreadTurn(
        ownerUserId,
        threadId,
        userMessage,
        assistantMessage,
      );
    },
  };
}

export async function beginThreadTurn(
  session: AuthSession,
  threadId: string,
  userMessage: ChatMessage,
  assistantMessage: ChatMessage,
  options: { retryExistingFailure?: boolean } = {},
) {
  if (mode(session) === "filesystem") {
    assertFilesystemWorkbenchId(threadId);
    const access = await resolveThreadAccess(session, threadId);
    if (access.role === "viewer") throw new WorkbenchConflictError("Aquest projecte compartit és de només lectura.");
    return access.store.beginThreadTurn(
      access.ownerUserId,
      threadId,
      userMessage,
      assistantMessage,
      options,
    );
  }
  assertWorkbenchId(threadId);
  return beginDemoThreadTurn(session, threadId, userMessage, assistantMessage);
}

export async function finishThreadTurn(
  session: AuthSession,
  threadId: string,
  assistantMessage: ChatMessage,
  runtimeThreadToken: string | null,
) {
  if (mode(session) === "filesystem") {
    assertFilesystemWorkbenchId(threadId);
    const access = await resolveThreadAccess(session, threadId);
    if (access.role === "viewer") throw new WorkbenchConflictError("Aquest projecte compartit és de només lectura.");
    return access.store.finishThreadTurn(
      access.ownerUserId,
      threadId,
      assistantMessage,
      runtimeThreadToken,
    );
  }
  assertWorkbenchId(threadId);
  return finishDemoThreadTurn(
    session,
    threadId,
    assistantMessage,
    runtimeThreadToken,
  );
}

export async function updateMessageActivity(
  session: AuthSession,
  threadId: string,
  messageId: string,
  item: ChatMessage["activity"][number],
) {
  if (mode(session) === "filesystem") {
    assertFilesystemWorkbenchId(threadId);
    assertFilesystemWorkbenchId(messageId);
    const access = await resolveThreadAccess(session, threadId);
    if (access.role === "viewer") throw new WorkbenchConflictError("Aquest projecte compartit és de només lectura.");
    return access.store.updateMessageActivity(
      access.ownerUserId,
      threadId,
      messageId,
      item,
    );
  }
  assertWorkbenchId(threadId);
  assertWorkbenchId(messageId);
  return updateDemoMessageActivity(session, threadId, messageId, item);
}

/** Bind a bounded scan to this exact authenticated session. */
export async function createWorkbenchThreadReader(session: AuthSession) {
  if (mode(session) === "filesystem") {
    const { createReadableThreadReader } = await import("./shared-access");
    return createReadableThreadReader(session);
  }
  return (threadId: string) => getThread(session, threadId);
}
