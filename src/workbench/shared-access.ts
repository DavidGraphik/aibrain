import "server-only";

import { readdir } from "node:fs/promises";
import type { AuthSession } from "@/auth/types";
import { FileLocalUserStore, type LocalUser } from "@/auth/local-user-store";
import { loadInstallationConfig } from "@/config/installation";
import { WorkbenchNotFoundError, WorkbenchPersistenceError } from "@/workbench/errors";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import { FilePinnedThreadStore, projectPinnedThreads } from "@/workbench/pinned-thread-store";
import {
  FileSharedAccessIndex,
  type SharedAccessProvenance,
  type SharedAccessRole as IndexedSharedAccessRole,
} from "@/workbench/shared-access-index";
import type {
  WorkbenchProject,
  WorkbenchProjectAccess,
  WorkbenchSnapshot,
  WorkbenchThread,
} from "@/workbench/types";
import { listAutomationThreadAccess, resolveAutomationThreadAccess, resolveAutomationDeliveryAccess } from "@/automations/thread-access";
import { FileAutomationAudienceStore } from "@/automations/audience-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type SharedAccessRole = "owner" | IndexedSharedAccessRole;

function projectAccess(role: SharedAccessRole): WorkbenchProjectAccess {
  return {
    role,
    canEdit: role !== "viewer",
    canManage: role === "owner",
  };
}

function projectWithAccess(project: WorkbenchProject, role: SharedAccessRole): WorkbenchProject {
  return { ...project, access: projectAccess(role) };
}

export function threadWithAccess(thread: WorkbenchThread, role: SharedAccessRole): WorkbenchThread {
  return { ...thread, access: projectAccess(role) };
}

/** An index grant is necessary, but cannot undo a canonical revocation or
 * role reduction while its owner's index synchronization is still pending. */
function currentSharedRole(project: WorkbenchProject, principal: LocalUser, indexedRole: IndexedSharedAccessRole): IndexedSharedAccessRole | null {
  const member = project.sharing.visibility === "shared"
    ? project.sharing.members.find(candidate => candidate.email === principal.email && candidate.status === "active") : null;
  if (!member) return null;
  return indexedRole === "viewer" || member.role === "viewer" ? "viewer" : "editor";
}

function currentSharedRoles(projects: readonly WorkbenchProject[], principal: LocalUser, indexedRoles: ReadonlyMap<string, IndexedSharedAccessRole>) {
  const roles = new Map<string, IndexedSharedAccessRole>();
  for (const project of projects) {
    const indexedRole = indexedRoles.get(project.id);
    if (!indexedRole) continue;
    const role = currentSharedRole(project, principal, indexedRole);
    if (role) roles.set(project.id, role);
  }
  return roles;
}

async function installationForSession(session: AuthSession) {
  if (session.provider !== "local") throw new WorkbenchPersistenceError("La compartición requiere una cuenta local.");
  const installation = await loadInstallationConfig();
  if (installation.installationId !== session.tenant.id) throw new WorkbenchPersistenceError("La sesión no pertenece a esta instalación.");
  return installation;
}

async function users(session: AuthSession) {
  const installation = await installationForSession(session);
  const store = new FileLocalUserStore(installation.paths.usersRoot);
  const entries = await readdir(installation.paths.usersRoot, { withFileTypes: true });
  const values = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && UUID.test(entry.name))
    .map((entry) => store.read(entry.name)));
  const provisioned = values.filter((user): user is LocalUser => user !== null);
  const principal = provisioned.find((user) => user.userId === session.user.id);
  if (!principal || !principal.enabled || principal.email !== session.user.email.toLocaleLowerCase()) {
    throw new WorkbenchNotFoundError("Projecte no trobat.");
  }
  return { installation, users: provisioned, principal };
}

function accessIndex(installation: Awaited<ReturnType<typeof loadInstallationConfig>>) {
  return new FileSharedAccessIndex({
    dataRoot: installation.paths.dataRoot,
    installationId: installation.installationId,
  });
}

function automationAudienceStore(installation: Awaited<ReturnType<typeof loadInstallationConfig>>) {
  return new FileAutomationAudienceStore({
    dataRoot: installation.paths.dataRoot,
    installationId: installation.installationId,
  });
}

async function ownAccessContext(session: AuthSession, options: { fullSnapshot?: boolean; threadId?: string; includeTurnContext?: boolean } = {}) {
  const context = await users(session);
  const store = FileWorkbenchStore.fromInstallation(context.installation);
  const selected = options.fullSnapshot ? null : await store.loadAccessSnapshot(context.principal.userId, options.threadId, options);
  const own = selected ?? await store.load(context.principal.userId);
  const index = accessIndex(context.installation);
  await index.syncOwnerSnapshot({ owner: context.principal, snapshot: own, users: context.users });
  return { ...context, session, store, own, index, turnContext: selected?.turnContext ?? null };
}

type OwnAccessContext = Awaited<ReturnType<typeof ownAccessContext>>;

async function loadSharedWorkbenchFromContext(
  context: OwnAccessContext,
  metadataOnly = false,
): Promise<WorkbenchSnapshot> {
  const { principal, store, own, index } = context;
  const deliveries = await automationAudienceStore(context.installation).list();
  const deliveredThreadIds = new Set(deliveries.map(({ threadId }) => threadId));
  const automationAccess = deliveries.length ? await listAutomationThreadAccess(context.session) : [];
  const authorizedAutomationThreadIds = new Set(automationAccess.map(({ delivery }) => delivery.threadId));
  const visibleAutomationThread = (threadId: string) =>
    !deliveredThreadIds.has(threadId) || authorizedAutomationThreadIds.has(threadId);
  const grants = await index.listProjectsForPrincipal(principal);
  const projects = own.projects.map((project) => projectWithAccess(project, "owner"));
  const threads = own.threads.filter(({ id }) => visibleAutomationThread(id))
    .map((thread) => threadWithAccess(thread, "owner"));
  const byOwner = Map.groupBy(grants, (grant) => grant.ownerUserId);
  const sharedSnapshots = await Promise.all([...byOwner].map(async ([ownerUserId, ownerGrants]) => {
    // The index lookup above precedes foreign metadata; current membership is
    // then checked before opening any foreign conversation history.
    const metadata = await store.loadAccessSnapshot(ownerUserId);
    const permitted = currentSharedRoles(metadata.projects, principal, new Map(ownerGrants.map(grant => [grant.projectId, grant.role])));
    if (permitted.size === 0) return { projects: [], threads: [] };
    const snapshot = metadataOnly ? metadata : await store.load(ownerUserId);
    const roles = currentSharedRoles(snapshot.projects, principal, permitted);
    return {
      projects: snapshot.projects
        .filter((project) => roles.has(project.id))
        .map((project) => projectWithAccess(project, roles.get(project.id) ?? "viewer")),
      threads: snapshot.threads.filter((thread) => roles.has(thread.projectId) && visibleAutomationThread(thread.id))
        .map((thread) => threadWithAccess(thread, roles.get(thread.projectId) ?? "viewer")),
    };
  }));
  for (const snapshot of sharedSnapshots) {
    projects.push(...snapshot.projects);
    threads.push(...snapshot.threads);
  }
  // Automation audiences grant only their result threads, never the owner's
  // whole project. The task center can therefore notify recipients without
  // widening ordinary project visibility.
  const automationByOwner = Map.groupBy(automationAccess, ({ delivery }) => delivery.ownerUserId);
  const automationThreads = await Promise.all([...automationByOwner].map(async ([ownerUserId, grants]) => {
    const snapshot = metadataOnly ? await store.loadAccessSnapshot(ownerUserId) : await store.load(ownerUserId);
    const allowed = new Set(grants.map(({ delivery }) => delivery.threadId));
    return snapshot.threads.filter(({ id }) => allowed.has(id))
      .map((thread) => threadWithAccess(thread, ownerUserId === principal.userId ? "owner" : "viewer"));
  }));
  const knownThreadIds = new Set(threads.map(({ id }) => id));
  for (const thread of automationThreads.flat()) {
    if (knownThreadIds.has(thread.id)) {
      // A result recipient remains a viewer even when they can edit its project.
      const existing = threads.findIndex((item) => item.id === thread.id);
      threads[existing] = thread;
    } else {
      knownThreadIds.add(thread.id);
      threads.push(thread);
    }
  }
  const legacyPinnedThreadIds = own.threads
    .filter((thread) => thread.pinned)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    .map((thread) => thread.id);
  const pinnedThreadIds = await new FilePinnedThreadStore(
    context.installation.paths.dataRoot,
    context.installation.paths.usersRoot,
    context.installation.installationId,
  ).read(principal.userId, legacyPinnedThreadIds);
  return {
    persistence: "filesystem",
    projects,
    threads: projectPinnedThreads(threads, pinnedThreadIds).map(thread => metadataOnly ? { ...thread, historyLoaded: false } : thread),
  };
}

export async function syncOwnSharedAccess(session: AuthSession) {
  await ownAccessContext(session);
}

/** The caller must already have resolved access to the project. */
export async function syncSharedThreadAccess(
  session: AuthSession,
  ownerUserId: string,
  projectId: string,
  threadId: string,
) {
  const context = await users(session);
  await accessIndex(context.installation).syncThreadFromProject({
    actorUserId: context.principal.userId,
    ownerUserId,
    projectId,
    threadId,
  });
}

export async function resolveProjectAccess(session: AuthSession, projectId: string) {
  const { principal, store, own, index } = await ownAccessContext(session);
  const ownProject = own.projects.find((item) => item.id === projectId);
  if (ownProject) {
    return { store, ownerUserId: principal.userId, role: "owner" as const, project: ownProject, provenance: null };
  }

  // This is deliberately the last operation before touching a foreign store.
  const grant = await index.resolve({ principal, resourceType: "project", resourceId: projectId });
  if (!grant) throw new WorkbenchNotFoundError("Projecte no trobat.");
  const project = (await store.loadAccessSnapshot(grant.ownerUserId)).projects.find(item => item.id === projectId);
  if (!project) throw new WorkbenchNotFoundError("Projecte no trobat.");
  // The index remains the gate before any foreign read. Current canonical
  // sharing may further restrict that grant while its index sync is pending;
  // neither a metadata hit nor an old editor grant can undo a revocation.
  const role = currentSharedRole(project, principal, grant.role);
  if (!role) throw new WorkbenchNotFoundError("Projecte no trobat.");
  return {
    store,
    ownerUserId: grant.ownerUserId,
    role,
    project,
    provenance: {
      source: "shared-access-index",
      grantFingerprint: grant.grantFingerprint,
      projectUpdatedAt: grant.projectUpdatedAt,
      indexedAt: grant.indexedAt,
    } satisfies SharedAccessProvenance,
  };
}

export async function resolveThreadAccess(session: AuthSession, threadId: string, options: { includeTurnContext?: boolean } = {}) {
  const context = await ownAccessContext(session, { threadId, ...options });
  const { principal, store, own, index } = context;
  const delivery = await automationAudienceStore(context.installation).findByThread(threadId);
  if (delivery) {
    const automation = await resolveAutomationThreadAccess(session, threadId);
    if (!automation) throw new WorkbenchNotFoundError("Fil no trobat.");
    const selected = delivery.ownerUserId === principal.userId ? null : await store.loadAccessSnapshot(delivery.ownerUserId, threadId, options);
    const snapshot = selected ?? own;
    const thread = snapshot.threads.find(({ id }) => id === threadId);
    const project = snapshot.projects.find(({ id }) => id === delivery.projectId);
    if (!thread || !project || thread.projectId !== project.id) throw new WorkbenchNotFoundError("Fil no trobat.");
    return {
      store,
      ownerUserId: delivery.ownerUserId,
      role: delivery.ownerUserId === principal.userId ? "owner" as const : "viewer" as const,
      project,
      thread,
      turnContext: selected ? selected.turnContext : context.turnContext,
      provenance: {
        source: "automation-audience" as const,
        taskId: delivery.taskId,
        runKey: delivery.runKey,
        membershipPolicy: "current" as const,
      },
      context,
    };
  }
  const ownThread = own.threads.find((item) => item.id === threadId);
  if (ownThread) {
    const ownProject = own.projects.find((item) => item.id === ownThread.projectId);
    if (ownProject) {
      return {
        store,
        ownerUserId: principal.userId,
        role: "owner" as const,
        project: ownProject,
        thread: ownThread,
        turnContext: context.turnContext,
        provenance: null,
        context,
      };
    }
  }

  // The durable thread grant is resolved before either foreign thread or project is read.
  const grant = await index.resolve({ principal, resourceType: "thread", resourceId: threadId });
  if (!grant) throw new WorkbenchNotFoundError("Fil no trobat.");
  const metadata = await store.loadAccessSnapshot(grant.ownerUserId);
  const indexedThread = metadata.threads.find(({ id }) => id === threadId);
  const indexedProject = metadata.projects.find(({ id }) => id === grant.projectId);
  const permittedRole = indexedProject ? currentSharedRole(indexedProject, principal, grant.role) : null;
  if (!indexedThread || !indexedProject || indexedThread.projectId !== indexedProject.id || !permittedRole) throw new WorkbenchNotFoundError("Fil no trobat.");
  const snapshot = await store.loadAccessSnapshot(grant.ownerUserId, threadId, options);
  const thread = snapshot.threads.find(({ id }) => id === threadId);
  const project = snapshot.projects.find(({ id }) => id === grant.projectId);
  if (!thread || !project || thread.projectId !== project.id) throw new WorkbenchNotFoundError("Fil no trobat.");
  const role = currentSharedRole(project, principal, permittedRole);
  if (!role) throw new WorkbenchNotFoundError("Fil no trobat.");
  return {
    store,
    ownerUserId: grant.ownerUserId,
    role,
    project,
    thread,
    turnContext: snapshot.turnContext,
    provenance: {
      source: "shared-access-index",
      grantFingerprint: grant.grantFingerprint,
      projectUpdatedAt: grant.projectUpdatedAt,
      indexedAt: grant.indexedAt,
    } satisfies SharedAccessProvenance,
    context,
  };
}

/** A request-bound reader for scans. Reuses only immutable metadata, never an
 * authorization decision. Current users, task audiences, index grants and
 * canonical project membership are checked for every selected history. */
export async function createReadableThreadReader(session: AuthSession) {
  const installation = await installationForSession(session);
  const store = FileWorkbenchStore.fromInstallation(installation);
  const findDelivery = automationAudienceStore(installation).createThreadReader();
  const readers = new Map<string, ReturnType<FileWorkbenchStore["createThreadReader"]>>();
  const selected = (owner: string, id: string) => {
    let read = readers.get(owner);
    if (!read) { read = store.createThreadReader(owner); readers.set(owner, read); }
    return read(id);
  };
  return async (threadId: string): Promise<WorkbenchThread> => {
    const principal = await new FileLocalUserStore(installation.paths.usersRoot).read(session.user.id);
    if (!principal || !principal.enabled || principal.email !== session.user.email.toLocaleLowerCase()) throw new WorkbenchNotFoundError("Fil no trobat.");
    const delivery = await findDelivery(threadId);
    if (delivery) {
      const access = await resolveAutomationDeliveryAccess(session, delivery, true);
      if (!access) throw new WorkbenchNotFoundError("Fil no trobat.");
      const snapshot = await selected(delivery.ownerUserId, threadId);
      const thread = snapshot.threads[0];
      if (!thread || thread.projectId !== delivery.projectId || !snapshot.projects.some(project => project.id === delivery.projectId)) throw new WorkbenchNotFoundError("Fil no trobat.");
      return threadWithAccess(thread, delivery.ownerUserId === principal.userId ? "owner" : "viewer");
    }
    const own = await selected(principal.userId, threadId);
    if (own.threads[0]) return threadWithAccess(own.threads[0], "owner");
    const grant = await accessIndex(installation).resolve({ principal, resourceType: "thread", resourceId: threadId });
    if (!grant) throw new WorkbenchNotFoundError("Fil no trobat.");
    // No foreign history before BOTH indexed grant and current canonical ACL.
    const metadata = await store.loadAccessSnapshot(grant.ownerUserId);
    const project = metadata.projects.find(project => project.id === grant.projectId);
    const threadMetadata = metadata.threads.find(thread => thread.id === threadId);
    const role = project ? currentSharedRole(project, principal, grant.role) : null;
    if (!project || !role || !threadMetadata || threadMetadata.projectId !== project.id) throw new WorkbenchNotFoundError("Fil no trobat.");
    const snapshot = await selected(grant.ownerUserId, threadId);
    const currentProject = snapshot.projects.find(project => project.id === grant.projectId);
    const currentRole = currentProject ? currentSharedRole(currentProject, principal, role) : null;
    const thread = snapshot.threads[0];
    if (!currentRole || !thread || thread.projectId !== grant.projectId) throw new WorkbenchNotFoundError("Fil no trobat.");
    return threadWithAccess(thread, currentRole);
  };
}

export async function loadVisibleProjectsForResolvedThread(
  access: Awaited<ReturnType<typeof resolveThreadAccess>>,
) {
  const { principal, store, own, index } = access.context;
  const projects = own.projects.map((project) => projectWithAccess(project, "owner"));
  const grants = await index.listProjectsForPrincipal(principal);
  // Automation audiences add result threads only; they do not add projects to
  // the runtime catalogue. Foreign snapshots are read only after their grants.
  for (const [ownerUserId, ownerGrants] of Map.groupBy(grants, (grant) => grant.ownerUserId)) {
    const snapshot = await store.loadAccessSnapshot(ownerUserId);
    const roles = currentSharedRoles(snapshot.projects, principal, new Map(ownerGrants.map(grant => [grant.projectId, grant.role])));
    projects.push(...snapshot.projects.filter(({ id }) => roles.has(id))
      .map((project) => projectWithAccess(project, roles.get(project.id) ?? "viewer")));
  }
  return { projects };
}

export async function loadSharedWorkbench(session: AuthSession, metadataOnly = false): Promise<WorkbenchSnapshot> {
  return loadSharedWorkbenchFromContext(await ownAccessContext(session, { fullSnapshot: !metadataOnly }), metadataOnly);
}

export async function normalizeProjectMembers(session: AuthSession, project: WorkbenchProject) {
  const { users: provisioned } = await users(session);
  const byEmail = new Map(provisioned.filter(({ enabled }) => enabled).map((user) => [user.email, user]));
  return {
    ...project.sharing,
    members: project.sharing.members.map((member) => {
      const user = byEmail.get(member.email);
      return user ? { ...member, name: user.displayName, status: "active" as const } : { ...member, status: "invited-local" as const };
    }),
  };
}

export function threadSummary(thread: WorkbenchThread) {
  const { messages, ...summary } = thread;
  return { ...summary, messageCount: messages.length, lastMessageAt: messages.at(-1)?.createdAt ?? null };
}
