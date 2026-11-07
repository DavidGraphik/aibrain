import type { GeneratedArtifact } from "@/lib/chat-contract";
import type { AdvancedArtifactSummary } from "@/artifacts/contracts";
import type { MemoryRecord } from "@/memory/types";
import type { WorkbenchSnapshot } from "@/workbench/types";

export type LibraryItemType = "upload" | "image" | "document" | "result" | "browser" | "visualization" | "internal-site";

export type LibraryItem = {
  id: string;
  type: LibraryItemType;
  name: string;
  mimeType: string | null;
  size: number | null;
  createdAt: string;
  projectId: string;
  projectName: string;
  threadId: string;
  threadTitle: string;
  messageId: string;
  previewUrl: string | null;
  downloadUrl: string | null;
  status: "ready" | "processing" | "error";
  artifactId?: string | null;
  downloadZipUrl?: string | null;
  internalSiteUrl?: string | null;
  latestVersion?: number | null;
  capabilities?: {
    preview: boolean;
    download: boolean;
    history: boolean;
    mutate: boolean;
  };
};

export type SearchResultType =
  | "project"
  | "thread"
  | "message"
  | "file"
  | "artifact"
  | "memory"
  | "activity"
  | "source"
  | "tool";

export type GlobalSearchResult = {
  id: string;
  type: SearchResultType;
  title: string;
  snippet: string;
  createdAt: string;
  projectId: string | null;
  threadId: string | null;
  messageId: string | null;
  libraryItemId: string | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isoDate(value: unknown) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function isLibraryItem(value: unknown): value is LibraryItem {
  if (!record(value)) return false;
  return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 240 &&
    (value.type === "upload" || value.type === "image" || value.type === "document" ||
      value.type === "result" || value.type === "browser" || value.type === "visualization" || value.type === "internal-site") &&
    typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 160 &&
    (value.mimeType === null || typeof value.mimeType === "string") &&
    (value.size === null || (Number.isSafeInteger(value.size) && (value.size as number) > 0)) &&
    isoDate(value.createdAt) &&
    typeof value.projectId === "string" && typeof value.projectName === "string" &&
    typeof value.threadId === "string" && typeof value.threadTitle === "string" &&
    typeof value.messageId === "string" &&
    (value.previewUrl === null || (typeof value.previewUrl === "string" && value.previewUrl.startsWith("/api/"))) &&
    (value.downloadUrl === null || (typeof value.downloadUrl === "string" && value.downloadUrl.startsWith("/api/"))) &&
    (value.status === "ready" || value.status === "processing" || value.status === "error") &&
    (!("artifactId" in value) || value.artifactId === null || (typeof value.artifactId === "string" && /^[0-9a-f-]{36}$/i.test(value.artifactId))) &&
    (!("downloadZipUrl" in value) || value.downloadZipUrl === null || (typeof value.downloadZipUrl === "string" && value.downloadZipUrl.startsWith("/api/artifacts/"))) &&
    (!("internalSiteUrl" in value) || value.internalSiteUrl === null || (typeof value.internalSiteUrl === "string" && value.internalSiteUrl.startsWith("/api/artifacts/"))) &&
    (!("latestVersion" in value) || value.latestVersion === null || (Number.isSafeInteger(value.latestVersion) && (value.latestVersion as number) >= 1)) &&
    (!("capabilities" in value) || (record(value.capabilities) &&
      Object.keys(value.capabilities).length === 4 && typeof value.capabilities.preview === "boolean" &&
      typeof value.capabilities.download === "boolean" && typeof value.capabilities.history === "boolean" &&
      typeof value.capabilities.mutate === "boolean"));
}

export function advancedArtifactLibraryItem(
  artifact: AdvancedArtifactSummary,
  context: { projectName: string; threadTitle: string },
): LibraryItem {
  return {
    id: `advanced:${artifact.id}`,
    type: artifact.kind,
    name: artifact.title,
    mimeType: "text/html",
    size: null,
    createdAt: artifact.createdAt,
    projectId: artifact.projectId,
    projectName: context.projectName,
    threadId: artifact.threadId,
    threadTitle: context.threadTitle,
    messageId: artifact.messageId,
    previewUrl: artifact.previewUrl,
    downloadUrl: artifact.downloadHtmlUrl,
    status: "ready",
    artifactId: artifact.id,
    downloadZipUrl: artifact.downloadZipUrl,
    internalSiteUrl: artifact.internalSiteUrl,
    latestVersion: artifact.latestVersion,
  };
}

export function isGlobalSearchResult(value: unknown): value is GlobalSearchResult {
  if (!record(value)) return false;
  return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 300 &&
    (value.type === "project" || value.type === "thread" || value.type === "message" ||
      value.type === "file" || value.type === "artifact" || value.type === "memory" ||
      value.type === "activity" || value.type === "source" || value.type === "tool") &&
    typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 200 &&
    typeof value.snippet === "string" && value.snippet.length <= 280 && isoDate(value.createdAt) &&
    (value.projectId === null || typeof value.projectId === "string") &&
    (value.threadId === null || typeof value.threadId === "string") &&
    (value.messageId === null || typeof value.messageId === "string") &&
    (value.libraryItemId === null || typeof value.libraryItemId === "string");
}

function withDownload(url: string) {
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

function uploadPreviewUrl(threadId: string, attachment: { id: string; name: string; mimeType: string }) {
  const supported = attachment.mimeType.startsWith("image/") || attachment.mimeType.startsWith("text/") ||
    attachment.mimeType === "application/json" || attachment.mimeType === "application/pdf" || attachment.mimeType === "audio/ogg" ||
    attachment.mimeType.startsWith("application/vnd.openxmlformats-officedocument.");
  if (!supported) return null;
  const previewName = attachment.mimeType.startsWith("image/")
    ? `preview${attachment.name.slice(attachment.name.lastIndexOf(".")).toLocaleLowerCase()}`
    : attachment.mimeType.startsWith("text/") || attachment.mimeType === "application/json" || attachment.mimeType === "audio/ogg"
      ? "preview.txt"
      : "document.pdf";
  return `/api/threads/${encodeURIComponent(threadId)}/documents/${encodeURIComponent(attachment.id)}/preview/${encodeURIComponent(previewName)}`;
}

function artifactItem(input: {
  artifact: GeneratedArtifact;
  projectId: string;
  projectName: string;
  threadId: string;
  threadTitle: string;
  messageId: string;
  createdAt: string;
}): LibraryItem | null {
  const common = {
    id: `artifact:${input.artifact.id}`,
    name: input.artifact.name,
    createdAt: input.createdAt,
    projectId: input.projectId,
    projectName: input.projectName,
    threadId: input.threadId,
    threadTitle: input.threadTitle,
    messageId: input.messageId,
  };
  if (input.artifact.type === "image") {
    return {
      ...common,
      type: "image",
      mimeType: "image/png",
      size: null,
      previewUrl: input.artifact.url,
      downloadUrl: withDownload(input.artifact.url),
      status: "ready",
    };
  }
  if (input.artifact.type === "document") {
    return {
      ...common,
      type: "document",
      mimeType: input.artifact.mimeType,
      size: input.artifact.size,
      previewUrl: input.artifact.previewUrl,
      downloadUrl: input.artifact.status === "ready" ? withDownload(input.artifact.url) : null,
      status: input.artifact.status,
    };
  }
  if (!input.artifact.downloadUrl) return null;
  return {
    ...common,
    type: "browser",
    mimeType: null,
    size: null,
    previewUrl: input.artifact.captureUrl,
    downloadUrl: input.artifact.downloadUrl,
    status: input.artifact.status === "error" ? "error" :
      input.artifact.status === "starting" || input.artifact.status === "reconnecting" ? "processing" : "ready",
  };
}

export function buildLibraryItems(snapshot: Pick<WorkbenchSnapshot, "projects" | "threads">) {
  const projectNames = new Map(snapshot.projects.map((project) => [project.id, project.name]));
  const items = new Map<string, LibraryItem>();
  for (const thread of snapshot.threads) {
    const projectName = projectNames.get(thread.projectId);
    if (!projectName) continue;
    for (const message of thread.messages) {
      for (const attachment of message.attachments) {
        const id = `upload:${thread.id}:${attachment.id}`;
        if (items.has(id)) continue;
        const url = `/api/library/uploads/${encodeURIComponent(thread.id)}/${encodeURIComponent(attachment.id)}`;
        const previewUrl = uploadPreviewUrl(thread.id, attachment);
        items.set(id, {
          id,
          type: "upload",
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          createdAt: message.createdAt,
          projectId: thread.projectId,
          projectName,
          threadId: thread.id,
          threadTitle: thread.title,
          messageId: message.id,
          previewUrl,
          downloadUrl: url,
          status: "ready",
        });
      }
      for (const artifact of message.artifacts) {
        const item = artifactItem({
          artifact,
          projectId: thread.projectId,
          projectName,
          threadId: thread.id,
          threadTitle: thread.title,
          messageId: message.id,
          createdAt: message.createdAt,
        });
        if (item) items.set(item.id, item);
      }
      if (message.role === "assistant" && message.content.trim() && message.status !== "streaming") {
        const id = `result:${thread.id}:${message.id}`;
        items.set(id, {
          id,
          type: "result",
          name: `${thread.title}.md`,
          mimeType: "text/markdown",
          size: new TextEncoder().encode(message.content).byteLength,
          createdAt: message.createdAt,
          projectId: thread.projectId,
          projectName,
          threadId: thread.id,
          threadTitle: thread.title,
          messageId: message.id,
          previewUrl: null,
          downloadUrl: `/api/library/results/${encodeURIComponent(thread.id)}/${encodeURIComponent(message.id)}`,
          status: message.status === "error" ? "error" : "ready",
        });
      }
    }
  }
  return [...items.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function normalized(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es");
}

function snippet(value: string, needle: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const index = normalized(compact).indexOf(needle);
  const start = Math.max(0, index < 0 ? 0 : index - 72);
  const excerpt = compact.slice(start, start + 220);
  return `${start ? "…" : ""}${excerpt}${start + excerpt.length < compact.length ? "…" : ""}`;
}

function match(value: string, needle: string) {
  const haystack = normalized(value);
  return haystack.includes(needle) || needle.split(/[^a-z0-9]+/u)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

export function buildGlobalSearchResults(
  snapshot: Pick<WorkbenchSnapshot, "projects" | "threads">,
  query: string,
  memories: readonly MemoryRecord[] = [],
) {
  const needle = normalized(query.trim());
  if (!needle) return [];
  const results: Array<GlobalSearchResult & { score: number }> = [];
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  for (const project of snapshot.projects) {
    if (!match(`${project.name} ${project.slug}`, needle)) continue;
    results.push({
      id: `project:${project.id}`, type: "project", title: project.name,
      snippet: "Proyecto", createdAt: project.updatedAt, projectId: project.id,
      threadId: null, messageId: null, libraryItemId: null,
      score: match(project.name, needle) ? 100 : 70,
    });
  }
  for (const thread of snapshot.threads) {
    const project = projects.get(thread.projectId);
    if (!project) continue;
    if (match(thread.title, needle)) {
      results.push({
        id: `thread:${thread.id}`, type: "thread", title: thread.title,
        snippet: project.name, createdAt: thread.updatedAt, projectId: project.id,
        threadId: thread.id, messageId: null, libraryItemId: null, score: 95,
      });
    }
    for (const message of thread.messages) {
      if (match(message.content, needle)) {
        results.push({
          id: `message:${message.id}`, type: "message",
          title: message.role === "user" ? "Tu mensaje" : `Respuesta en ${thread.title}`,
          snippet: snippet(message.content, needle), createdAt: message.createdAt,
          projectId: project.id, threadId: thread.id, messageId: message.id,
          libraryItemId: null, score: message.role === "assistant" ? 82 : 84,
        });
      }
      for (const attachment of message.attachments) {
        if (!match(`${attachment.name} ${attachment.mimeType}`, needle)) continue;
        results.push({
          id: `file:${thread.id}:${attachment.id}`, type: "file", title: attachment.name,
          snippet: `${project.name} · ${thread.title}`, createdAt: message.createdAt,
          projectId: project.id, threadId: thread.id, messageId: message.id,
          libraryItemId: `upload:${thread.id}:${attachment.id}`, score: 88,
        });
      }
      for (const artifact of message.artifacts) {
        const detail = artifact.type === "image" ? artifact.prompt ?? "" : artifact.type === "document"
          ? `${artifact.kind} ${artifact.targetLabel ?? ""}` : `${artifact.status} ${artifact.error ?? ""}`;
        if (!match(`${artifact.name} ${detail}`, needle)) continue;
        results.push({
          id: `artifact:${artifact.id}`, type: "artifact", title: artifact.name,
          snippet: snippet(detail || `${project.name} · ${thread.title}`, needle),
          createdAt: message.createdAt, projectId: project.id, threadId: thread.id,
          messageId: message.id, libraryItemId: `artifact:${artifact.id}`, score: 86,
        });
      }
      for (const activity of message.activity) {
        const searchable = `${activity.label} ${activity.detail ?? ""} ${activity.output ?? ""}`;
        if (!match(searchable, needle)) continue;
        results.push({
          id: `activity:${message.id}:${activity.id}`, type: "activity", title: activity.label,
          snippet: snippet(`${activity.detail ?? ""} ${activity.output ?? ""}`, needle),
          createdAt: message.createdAt, projectId: project.id, threadId: thread.id,
          messageId: message.id, libraryItemId: null, score: 76,
        });
      }
      for (const source of message.sources ?? []) {
        const searchable = `${source.title} ${source.domain ?? ""} ${source.snippet ?? ""} ${source.url ?? ""}`;
        if (!match(searchable, needle)) continue;
        results.push({
          id: `source:${message.id}:${source.id}`, type: "source", title: source.title,
          snippet: snippet(`${source.domain ?? ""} ${source.snippet ?? ""}`, needle),
          createdAt: message.createdAt, projectId: project.id, threadId: thread.id,
          messageId: message.id, libraryItemId: null, score: 90,
        });
      }
      for (const result of message.toolResults ?? []) {
        const searchable = `${result.title} ${result.summary ?? ""} ${result.output ?? ""}`;
        if (!match(searchable, needle)) continue;
        results.push({
          id: `tool:${message.id}:${result.id}`, type: "tool", title: result.title,
          snippet: snippet(`${result.summary ?? ""} ${result.output ?? ""}`, needle),
          createdAt: result.createdAt, projectId: project.id, threadId: thread.id,
          messageId: message.id, libraryItemId: null, score: 78,
        });
      }
    }
  }
  for (const memory of memories) {
    if (memory.status !== "active" || !match(`${memory.content} ${memory.provenance.sourceExcerpt}`, needle)) continue;
    results.push({
      id: `memory:${memory.memoryId}`, type: "memory",
      title: memory.kind === "decision" ? "Decisión guardada" : "Recuerdo guardado",
      snippet: snippet(memory.content, needle), createdAt: memory.createdAt,
      projectId: memory.provenance.sourceType === "project" ? memory.provenance.sourceId : null,
      threadId: memory.provenance.sourceType === "thread" ? memory.provenance.sourceId : null,
      messageId: null, libraryItemId: null, score: 80,
    });
  }
  return results
    .sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt))
    .slice(0, 60)
    .map(({ score: _score, ...result }) => result);
}
