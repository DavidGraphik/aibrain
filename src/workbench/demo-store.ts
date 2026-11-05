import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthSession } from "@/auth/types";
import type { ChatMessage } from "@/lib/chat-contract";
import {
  branchHistory,
  publicProject,
  publicThread,
  uniqueSlug,
  type StoredProject,
  type StoredThread,
  type ThreadRuntimeContext,
} from "@/workbench/internal";
import {
  isUuid,
  isBranchThreadInput,
  isWorkbenchProject,
  isWorkbenchThread,
  STANDALONE_PROJECT_SLUG,
  type UpdateProjectInput,
  type UpdateThreadInput,
  type WorkbenchPersistence,
  type WorkbenchProject,
  type WorkbenchSnapshot,
  type WorkbenchThread,
  type BranchThreadInput,
  type BranchThreadResult,
} from "@/workbench/types";
import {
  WorkbenchConflictError,
  WorkbenchNotFoundError,
  WorkbenchPersistenceError,
} from "@/workbench/errors";

type DemoState = {
  version: 1;
  projects: StoredProject[];
  threads: StoredThread[];
};

const mutationQueues = new Map<string, Promise<unknown>>();

function dataDirectory() {
  const configured = process.env.AIBRAIN_DEMO_DATA_DIR?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new WorkbenchPersistenceError("AIBRAIN_DEMO_DATA_DIR ha de ser una ruta absoluta.");
  }
  if (configured) return path.join(configured, "workbench");
  if (process.env.NODE_ENV === "production") {
    throw new WorkbenchPersistenceError("La persistència demo no està configurada.");
  }
  return path.join(process.cwd(), "runtime", "demo", "workbench");
}

function statePath(tenantId: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(tenantId)) {
    throw new WorkbenchPersistenceError("Identificador de tenant no vàlid.");
  }
  return path.join(dataDirectory(), `${tenantId}.json`);
}

function seedNames(tenantId: string, tenantName: string) {
  if (tenantId === "studio") return ["Espacio principal", "Laboratori"] as const;
  if (tenantId === "operations") return ["Operacions", "Processos"] as const;
  return [tenantName, "Laboratori"] as const;
}

function seededProject(name: string, slug: string, workspaceKey: string): StoredProject {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name,
    slug,
    status: "active",
    pinned: workspaceKey === "workspace",
    instructions: "",
    sources: [],
    memory: { enabled: true, notes: "", updatedAt: null },
    sharing: { visibility: "private", members: [] },
    workspace: {
      id: randomUUID(),
      label: workspaceKey === "workspace" ? "Workspace principal" : name,
      hostType: "managed",
      status: "ready",
      isPrimary: true,
    },
    workspaceKey,
    createdAt: now,
    updatedAt: now,
  };
}

export function seedDemoState(tenantId: string, tenantName: string): DemoState {
  const [primaryName, secondaryName] = seedNames(tenantId, tenantName);
  const primarySlug = uniqueSlug(primaryName, new Set());
  const secondarySlug = uniqueSlug(secondaryName, new Set([primarySlug]));
  return {
    version: 1,
    projects: [
      seededProject("Conversaciones", STANDALONE_PROJECT_SLUG, STANDALONE_PROJECT_SLUG),
      seededProject(primaryName, primarySlug, "workspace"),
      seededProject(secondaryName, secondarySlug, secondarySlug),
    ],
    threads: [],
  };
}

function isStoredProject(value: unknown): value is StoredProject {
  if (!value || typeof value !== "object" || !("workspaceKey" in value)) return false;
  return typeof value.workspaceKey === "string" &&
    /^[a-z0-9][a-z0-9-]{0,127}$/.test(value.workspaceKey) &&
    isWorkbenchProject(value);
}

function isStoredThread(value: unknown): value is StoredThread {
  if (!value || typeof value !== "object" || !("runtimeThreadToken" in value)) return false;
  return (value.runtimeThreadToken === null || typeof value.runtimeThreadToken === "string") &&
    isWorkbenchThread(value);
}

function isDemoState(value: unknown): value is DemoState {
  if (!value || typeof value !== "object") return false;
  return "version" in value && value.version === 1 &&
    "projects" in value && Array.isArray(value.projects) && value.projects.every(isStoredProject) &&
    "threads" in value && Array.isArray(value.threads) && value.threads.every(isStoredThread);
}

async function writeState(tenantId: string, state: DemoState) {
  const directory = dataDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = statePath(tenantId);
  const temporary = path.join(directory, `.${tenantId}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}

async function readState(session: AuthSession) {
  try {
    const decoded: unknown = JSON.parse(await readFile(statePath(session.tenant.id), "utf8"));
    let upgraded = false;
    if (decoded && typeof decoded === "object" && "threads" in decoded && Array.isArray(decoded.threads)) {
      for (const thread of decoded.threads) {
        if (!thread || typeof thread !== "object" || !("messages" in thread) || !Array.isArray(thread.messages)) continue;
        for (const message of thread.messages) {
          if (message && typeof message === "object" && !("attachments" in message)) {
            Object.assign(message, { attachments: [] });
            upgraded = true;
          }
          if (message && typeof message === "object" && !("artifacts" in message)) {
            Object.assign(message, { artifacts: [] });
            upgraded = true;
          }
          if (message && typeof message === "object" && !("sources" in message)) {
            Object.assign(message, { sources: [] });
            upgraded = true;
          }
          if (message && typeof message === "object" && !("toolResults" in message)) {
            Object.assign(message, { toolResults: [] });
            upgraded = true;
          }
        }
      }
    }
    if (decoded && typeof decoded === "object" && "projects" in decoded && Array.isArray(decoded.projects)) {
      for (const project of decoded.projects) {
        if (!project || typeof project !== "object") continue;
        if (!("instructions" in project)) { Object.assign(project, { instructions: "" }); upgraded = true; }
        if (!("sources" in project)) { Object.assign(project, { sources: [] }); upgraded = true; }
        if (!("memory" in project)) { Object.assign(project, { memory: { enabled: true, notes: "", updatedAt: null } }); upgraded = true; }
        if (!("sharing" in project)) { Object.assign(project, { sharing: { visibility: "private", members: [] } }); upgraded = true; }
      }
    }
    if (!isDemoState(decoded)) {
      throw new WorkbenchPersistenceError("L’estat persistent del workbench no és vàlid.");
    }
    if (!decoded.projects.some((project) => project.slug === STANDALONE_PROJECT_SLUG)) {
      decoded.projects.unshift(seededProject(
        "Conversaciones",
        STANDALONE_PROJECT_SLUG,
        STANDALONE_PROJECT_SLUG,
      ));
      upgraded = true;
    }
    if (upgraded) await writeState(session.tenant.id, decoded);
    return decoded;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      const seeded = seedDemoState(session.tenant.id, session.tenant.name);
      await writeState(session.tenant.id, seeded);
      return seeded;
    }
    throw error;
  }
}

async function mutateState<Result>(
  session: AuthSession,
  mutation: (state: DemoState) => Result | Promise<Result>,
) {
  const tenantId = session.tenant.id;
  const previous = mutationQueues.get(tenantId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const state = await readState(session);
    const result = await mutation(state);
    await writeState(tenantId, state);
    return result;
  });
  mutationQueues.set(tenantId, current);
  try {
    return await current;
  } finally {
    if (mutationQueues.get(tenantId) === current) mutationQueues.delete(tenantId);
  }
}

function snapshot(state: DemoState, persistence: WorkbenchPersistence): WorkbenchSnapshot {
  return {
    persistence,
    projects: state.projects.map(publicProject),
    threads: state.threads.map(publicThread),
  };
}

export async function loadDemoWorkbench(
  session: AuthSession,
  persistence: WorkbenchPersistence = "filesystem-demo",
) {
  if (persistence === "browser-preview") {
    return snapshot(seedDemoState(session.tenant.id, session.tenant.name), persistence);
  }
  return snapshot(await readState(session), persistence);
}

export async function getDemoThread(session: AuthSession, threadId: string): Promise<WorkbenchThread> {
  assertWorkbenchId(threadId);
  const thread = (await readState(session)).threads.find((candidate) => candidate.id === threadId);
  if (!thread) throw new WorkbenchNotFoundError("Fil no trobat.");
  return publicThread(thread);
}

export async function createDemoProject(session: AuthSession, name: string): Promise<WorkbenchProject> {
  return mutateState(session, (state) => {
    const slug = uniqueSlug(name, new Set(state.projects.map((project) => project.slug)));
    const project = seededProject(name.trim(), slug, `project-${randomUUID()}`);
    project.pinned = false;
    state.projects.push(project);
    return publicProject(project);
  });
}

export async function updateDemoProject(
  session: AuthSession,
  projectId: string,
  patch: UpdateProjectInput,
): Promise<WorkbenchProject> {
  return mutateState(session, (state) => {
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new WorkbenchNotFoundError("Projecte no trobat.");
    if (patch.name !== undefined) project.name = patch.name.trim();
    if (patch.pinned !== undefined) project.pinned = patch.pinned;
    if (patch.status !== undefined) project.status = patch.status;
    if (patch.instructions !== undefined) project.instructions = patch.instructions;
    if (patch.sources !== undefined) project.sources = patch.sources;
    if (patch.memory !== undefined) project.memory = { ...patch.memory, enabled: true };
    if (patch.sharing !== undefined) project.sharing = patch.sharing;
    project.updatedAt = new Date().toISOString();
    return publicProject(project);
  });
}

export async function createDemoThread(
  session: AuthSession,
  projectId: string,
  title: string,
): Promise<WorkbenchThread> {
  return mutateState(session, (state) => {
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project || project.status !== "active") {
      throw new WorkbenchNotFoundError("Projecte actiu no trobat.");
    }
    const now = new Date().toISOString();
    const thread: StoredThread = {
      id: randomUUID(),
      projectId,
      title: title.trim(),
      status: "active",
      pinned: false,
      createdAt: now,
      updatedAt: now,
      messages: [],
      runtimeThreadToken: null,
    };
    state.threads.push(thread);
    project.updatedAt = now;
    return publicThread(thread);
  });
}

export async function updateDemoThread(
  session: AuthSession,
  threadId: string,
  patch: UpdateThreadInput,
): Promise<WorkbenchThread> {
  return mutateState(session, (state) => {
    const thread = state.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new WorkbenchNotFoundError("Fil no trobat.");
    if (patch.title !== undefined) thread.title = patch.title.trim();
    if (patch.pinned !== undefined) thread.pinned = patch.pinned;
    if (patch.status !== undefined) thread.status = patch.status;
    thread.updatedAt = new Date().toISOString();
    return publicThread(thread);
  });
}

function runtimeContext(state: DemoState, projectId: string): ThreadRuntimeContext {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project || project.status !== "active") {
    throw new WorkbenchNotFoundError("Projecte actiu no trobat.");
  }
  return {
    projectId: project.id,
    projectName: project.name,
    workspaceKey: project.workspaceKey,
    projectInstructions: project.instructions,
    projectMemory: project.memory.notes,
    projectSources: project.sources.map(({ kind, name, url, excerpt, status }) => ({
      kind, name, url, excerpt, status,
    })),
    runtimeThreadToken: null,
    branchHistory: null,
  };
}

export async function getDemoProjectRuntimeContext(session: AuthSession, projectId: string) {
  return runtimeContext(await readState(session), projectId);
}

export async function getDemoThreadRuntimeContext(
  session: AuthSession,
  threadId: string,
): Promise<ThreadRuntimeContext> {
  const state = await readState(session);
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread || thread.status !== "active") {
    throw new WorkbenchNotFoundError("Fil actiu no trobat.");
  }
  return {
    ...runtimeContext(state, thread.projectId),
    runtimeThreadToken: thread.runtimeThreadToken,
    branchHistory: branchHistory(thread),
  };
}

export async function branchDemoThread(
  session: AuthSession,
  threadId: string,
  input: BranchThreadInput,
): Promise<BranchThreadResult> {
  if (!isBranchThreadInput(input)) throw new WorkbenchPersistenceError("La branca no és vàlida.");
  return mutateState(session, (state) => {
    const parent = state.threads.find((candidate) => candidate.id === threadId);
    if (!parent || parent.status !== "active") throw new WorkbenchNotFoundError("Fil actiu no trobat.");
    const targetIndex = parent.messages.findIndex((message) => message.id === input.messageId);
    const target = parent.messages[targetIndex];
    if (!target) throw new WorkbenchNotFoundError("Missatge no trobat.");
    let prefixEnd = targetIndex;
    let draftMessage: string | null = null;
    if (input.kind === "edit") {
      if (target.role !== "user" || !input.editedContent?.trim()) {
        throw new WorkbenchConflictError("Només es poden editar missatges de l’usuari.");
      }
      prefixEnd = targetIndex - 1;
      draftMessage = input.editedContent.trim();
    } else if (input.kind === "retry") {
      if (target.role !== "assistant") throw new WorkbenchConflictError("Resposta no vàlida.");
      const userIndex = parent.messages.findLastIndex(
        (message, index) => index < targetIndex && message.role === "user",
      );
      if (userIndex < 0) throw new WorkbenchConflictError("La resposta no té cap petició per regenerar.");
      prefixEnd = userIndex - 1;
      draftMessage = parent.messages[userIndex].content;
    } else if (target.role !== "assistant") {
      throw new WorkbenchConflictError("La branca ha de començar des d’una resposta.");
    }
    const now = new Date().toISOString();
    const suffix = input.kind === "edit" ? "editada" : input.kind === "retry" ? "regenerada" : "rama";
    const thread: StoredThread = {
      id: randomUUID(), projectId: parent.projectId,
      title: `${parent.title.replace(/ · (?:editada|regenerada|rama)$/u, "")} · ${suffix}`.slice(0, 120),
      status: "active", pinned: false, createdAt: now, updatedAt: now,
      messages: structuredClone(parent.messages.slice(0, prefixEnd + 1)),
      runtimeThreadToken: null,
      lineage: { parentThreadId: parent.id, branchedFromMessageId: target.id, kind: input.kind },
    };
    state.threads.push(thread);
    return { thread: publicThread(thread), draftMessage };
  });
}

export async function beginDemoThreadTurn(
  session: AuthSession,
  threadId: string,
  userMessage: ChatMessage,
  assistantMessage: ChatMessage,
) {
  return mutateState(session, (state) => {
    const thread = state.threads.find((candidate) => candidate.id === threadId);
    if (!thread || thread.status !== "active") {
      throw new WorkbenchNotFoundError("Fil actiu no trobat.");
    }
    const existingUserIndex = thread.messages.findIndex((message) => message.id === userMessage.id);
    const existingAssistantIndex = thread.messages.findIndex((message) => message.id === assistantMessage.id);
    if (existingUserIndex !== -1 || existingAssistantIndex !== -1) {
      const existingUser = thread.messages[existingUserIndex];
      const existingAssistant = thread.messages[existingAssistantIndex];
      if (
        existingUserIndex >= 0 && existingAssistantIndex === existingUserIndex + 1 &&
        existingUser?.role === "user" && existingAssistant?.role === "assistant" &&
        existingUser.content === userMessage.content &&
        JSON.stringify(existingUser.attachments) === JSON.stringify(userMessage.attachments) &&
        JSON.stringify(existingUser.serverReferences ?? []) === JSON.stringify(userMessage.serverReferences ?? []) &&
          JSON.stringify(existingUser.connectorMentions ?? []) === JSON.stringify(userMessage.connectorMentions ?? [])
      ) {
        return { outcome: "existing" as const, assistantMessage: existingAssistant };
      }
      throw new WorkbenchConflictError("Els identificadors del torn ja existeixen amb un altre contingut.");
    }
    if (thread.messages.some((message) => message.role === "assistant" && message.status === "streaming")) {
      throw new WorkbenchConflictError("Aquest fil ja té un torn actiu.");
    }
    thread.messages.push(userMessage, assistantMessage);
    thread.updatedAt = new Date().toISOString();
    return { outcome: "created" as const, assistantMessage };
  });
}

export async function finishDemoThreadTurn(
  session: AuthSession,
  threadId: string,
  assistantMessage: ChatMessage,
  runtimeThreadToken: string | null,
) {
  await mutateState(session, (state) => {
    const thread = state.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new WorkbenchNotFoundError("Fil no trobat.");
    const messageIndex = thread.messages.findIndex((message) => message.id === assistantMessage.id);
    if (messageIndex === -1) throw new WorkbenchNotFoundError("Missatge del torn no trobat.");
    thread.messages[messageIndex] = assistantMessage;
    if (runtimeThreadToken) thread.runtimeThreadToken = runtimeThreadToken;
    thread.updatedAt = new Date().toISOString();
  });
}

export async function updateDemoMessageActivity(
  session: AuthSession,
  threadId: string,
  messageId: string,
  item: ChatMessage["activity"][number],
) {
  return mutateState(session, (state) => {
    const thread = state.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new WorkbenchNotFoundError("Fil no trobat.");
    const message = thread.messages.find((candidate) => candidate.id === messageId && candidate.role === "assistant");
    if (!message) throw new WorkbenchNotFoundError("Resultat no trobat.");
    const index = message.activity.findIndex((candidate) => candidate.id === item.id);
    if (index === -1) message.activity.push(item);
    else message.activity[index] = item;
    thread.updatedAt = new Date().toISOString();
    return message;
  });
}

export function assertWorkbenchId(value: string) {
  if (!isUuid(value)) throw new WorkbenchNotFoundError("Identificador no vàlid.");
}
