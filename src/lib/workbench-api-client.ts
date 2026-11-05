import {
  isWorkbenchPage,
  isWorkbenchProject,
  isWorkbenchThread,
  isWorkbenchThreadSummary,
  type WorkbenchListQuery,
  type WorkbenchPage,
  type UpdateProjectInput,
  type UpdateThreadInput,
  type WorkbenchProject,
  type WorkbenchThread,
  type WorkbenchThreadSummary,
  type BranchThreadInput,
  type BranchThreadResult,
} from "@/workbench/types";

export type WorkbenchListRequest = Partial<WorkbenchListQuery>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function responseBody(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === "string"
      ? body.error
      : "El workbench no ha pogut completar l’acció.";
    throw new Error(message);
  }
  return body;
}

function listQuery(options: WorkbenchListRequest = {}) {
  const params = new URLSearchParams();
  if (options.status) params.set("status", options.status);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.query !== undefined) params.set("q", options.query);
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function projectPage(body: unknown): WorkbenchPage<WorkbenchProject> {
  if (!isRecord(body)) throw new Error("El servidor ha retornat una pàgina de projectes no vàlida.");
  const page = { items: body.projects, nextCursor: body.nextCursor };
  if (!isWorkbenchPage(page, isWorkbenchProject)) {
    throw new Error("El servidor ha retornat una pàgina de projectes no vàlida.");
  }
  return page;
}

function threadPage(body: unknown): WorkbenchPage<WorkbenchThreadSummary> {
  if (!isRecord(body)) throw new Error("El servidor ha retornat una pàgina de fils no vàlida.");
  const page = { items: body.threads, nextCursor: body.nextCursor };
  if (!isWorkbenchPage(page, isWorkbenchThreadSummary)) {
    throw new Error("El servidor ha retornat una pàgina de fils no vàlida.");
  }
  return page;
}

export async function listProjectsRequest(
  options: WorkbenchListRequest = {},
): Promise<WorkbenchPage<WorkbenchProject>> {
  return projectPage(await responseBody(await fetch(`/api/projects${listQuery(options)}`, {
    method: "GET",
    cache: "no-store",
  })));
}

export async function getProjectRequest(projectId: string): Promise<WorkbenchProject> {
  const body = await responseBody(await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "GET",
    cache: "no-store",
  }));
  if (!isRecord(body) || !isWorkbenchProject(body.project)) {
    throw new Error("El servidor ha retornat un projecte no vàlid.");
  }
  return body.project;
}

export async function createProjectRequest(name: string): Promise<WorkbenchProject> {
  const body = await responseBody(await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }));
  if (!isRecord(body) || !isWorkbenchProject(body.project)) {
    throw new Error("El servidor ha retornat un projecte no vàlid.");
  }
  return body.project;
}

export async function updateProjectRequest(
  projectId: string,
  patch: UpdateProjectInput,
): Promise<WorkbenchProject> {
  const body = await responseBody(await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
  if (!isRecord(body) || !isWorkbenchProject(body.project)) {
    throw new Error("El servidor ha retornat un projecte no vàlid.");
  }
  return body.project;
}

export function renameProjectRequest(projectId: string, name: string) {
  return updateProjectRequest(projectId, { name });
}

export function setProjectPinnedRequest(projectId: string, pinned: boolean) {
  return updateProjectRequest(projectId, { pinned });
}

export function archiveProjectRequest(projectId: string) {
  return updateProjectRequest(projectId, { status: "archived" });
}

export function restoreProjectRequest(projectId: string) {
  return updateProjectRequest(projectId, { status: "active" });
}

export async function listThreadsRequest(
  options: WorkbenchListRequest & { projectId?: string } = {},
): Promise<WorkbenchPage<WorkbenchThreadSummary>> {
  const { projectId, ...query } = options;
  const endpoint = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/threads`
    : "/api/threads";
  return threadPage(await responseBody(await fetch(`${endpoint}${listQuery(query)}`, {
    method: "GET",
    cache: "no-store",
  })));
}

export async function getThreadRequest(threadId: string): Promise<WorkbenchThread> {
  const body = await responseBody(await fetch(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: "GET",
    cache: "no-store",
  }));
  if (!isRecord(body) || !isWorkbenchThread(body.thread)) {
    throw new Error("El servidor ha retornat un fil no vàlid.");
  }
  return body.thread;
}

export async function createThreadRequest(
  projectId: string,
  title: string,
): Promise<WorkbenchThread> {
  const body = await responseBody(await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/threads`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    },
  ));
  if (!isRecord(body) || !isWorkbenchThread(body.thread)) {
    throw new Error("El servidor ha retornat un fil no vàlid.");
  }
  return body.thread;
}

export async function updateThreadRequest(
  threadId: string,
  patch: UpdateThreadInput,
): Promise<WorkbenchThread> {
  const body = await responseBody(await fetch(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
  if (!isRecord(body) || !isWorkbenchThread(body.thread)) {
    throw new Error("El servidor ha retornat un fil no vàlid.");
  }
  return body.thread;
}

export function renameThreadRequest(threadId: string, title: string) {
  return updateThreadRequest(threadId, { title });
}

export function setThreadPinnedRequest(threadId: string, pinned: boolean) {
  return updateThreadRequest(threadId, { pinned });
}

export function archiveThreadRequest(threadId: string) {
  return updateThreadRequest(threadId, { status: "archived" });
}

export function restoreThreadRequest(threadId: string) {
  return updateThreadRequest(threadId, { status: "active" });
}

export async function branchThreadRequest(
  threadId: string,
  input: BranchThreadInput,
): Promise<BranchThreadResult> {
  const body = await responseBody(await fetch(`/api/threads/${encodeURIComponent(threadId)}/branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
  if (!isRecord(body) || !isWorkbenchThread(body.thread) ||
    !(body.draftMessage === null || typeof body.draftMessage === "string")) {
    throw new Error("El servidor ha retornat una branca no vàlida.");
  }
  return { thread: body.thread, draftMessage: body.draftMessage };
}
