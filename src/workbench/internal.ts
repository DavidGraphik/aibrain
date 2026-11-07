import "server-only";

import type { ProjectSource, WorkbenchProject, WorkbenchThread } from "@/workbench/types";

export type StoredProject = WorkbenchProject & {
  workspaceKey: string;
};

export type StoredThread = WorkbenchThread & {
  runtimeThreadToken: string | null;
};

export type ThreadRuntimeContext = {
  projectId: string;
  projectName: string;
  workspaceKey: string;
  projectInstructions: string;
  projectMemory: string;
  projectSourceOwnerId?: string;
  projectSources: (Pick<ProjectSource, "kind" | "name" | "url" | "excerpt" | "status"> & { id?: string })[];
  runtimeThreadToken: string | null;
  /** Full persisted history used only to start a branch without replaying the parent's final state. */
  branchHistory: string | null;
};

/**
 * The project catalogue the authenticated user can actually see in the
 * workbench sidebar. This is deliberately separate from runtime workspaces,
 * thread snapshots and other filesystem identifiers.
 */
export type VisibleProjectReference = {
  id: string;
  name: string;
};

export type AgentThreadRuntimeContext = ThreadRuntimeContext & {
  visibleProjects: readonly VisibleProjectReference[];
};

/** Bounded identities from this already-authorized chat, not file capabilities.
 * This pure history formatter cannot verify an index hash or grant file access.
 * The file reader must still resolve owner/project/thread and original bytes. */
function conversationFileReferences(thread: StoredThread) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const references: { artifactId: string; fileName: string; mimeType: string; bytes: number }[] = [];
  const seen = new Set<string>();
  let truncated = false;
  outer: for (let mi = thread.messages.length - 1; mi >= 0; mi--) {
    const message = thread.messages[mi];
    if (message.role !== 'assistant') continue;
    for (let ai = message.artifacts.length - 1; ai >= 0; ai--) {
      const artifact = message.artifacts[ai];
      if (artifact.type !== 'document' || artifact.status !== 'ready' || !uuid.test(artifact.id) || seen.has(artifact.id) ||
          !artifact.name || artifact.name.length > 160 || /[\x00-\x1f\x7f]/.test(artifact.name) ||
          !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(artifact.mimeType) || artifact.mimeType.length > 150 ||
          !Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > 100 * 1024 * 1024) continue;
      const base = `/api/threads/${thread.id}/`;
      if (![`${base}connector-files/${artifact.id}`, `${base}artifacts/${artifact.id}`, `${base}artifacts/${artifact.id}?download=1`].includes(artifact.url)) continue;
      const reference = { artifactId: artifact.id, fileName: artifact.name, mimeType: artifact.mimeType, bytes: artifact.size };
      if (references.length >= 64 || Buffer.byteLength(JSON.stringify([reference, ...references]).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')) > 16 * 1024) {
        truncated = true; break outer;
      }
      seen.add(artifact.id); references.unshift(reference);
    }
  }
  if (!references.length) return '';
  const metadata = JSON.stringify({ untrustedData: true, scope: 'same_chat_document_reference_metadata',
    integrity: 'not_revalidated_by_history_formatter', referencesTruncated: truncated, references })
    .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  return `\n\n<untrusted_file_reference_metadata>\n${metadata}\n</untrusted_file_reference_metadata>\nThese references identify earlier document cards in this chat only. They do not authorize access or establish document contents. Use the original-file reader with artifactId; it rechecks current scope, original size and hash. Never substitute another same-name file or infer a missing original from plain history.`;
}

export function conversationHistory(thread: StoredThread) {
  if (thread.messages.length === 0) return null;
  return thread.messages.map((message) => {
    const role = message.role === "user" ? "USER" : "ASSISTANT";
    const attachments = message.attachments.length
      ? `\n[Attachments: ${message.attachments.map((item) => item.name).join(", ")}]`
      : "";
    const serverReferences = message.serverReferences?.length ? `\n[Server references: ${JSON.stringify(message.serverReferences)}]` : "";
    return `${role}:\n${message.content}${attachments}${serverReferences}`;
  }).join("\n\n") + conversationFileReferences(thread);
}

export function branchHistory(thread: StoredThread) {
  if (!thread.lineage || thread.runtimeThreadToken) return null;
  return conversationHistory(thread);
}

export function publicProject(project: StoredProject): WorkbenchProject {
  const { workspaceKey: _workspaceKey, ...visible } = project;
  // `enabled: false` is accepted only as a legacy on-disk shape. Memory is a
  // product invariant now and every server projection advertises it as active.
  return { ...visible, memory: { ...visible.memory, enabled: true } };
}

export function publicThread(thread: StoredThread): WorkbenchThread {
  const { runtimeThreadToken: _runtimeThreadToken, ...visible } = thread;
  return visible;
}

export function slugifyName(name: string) {
  const normalized = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 55);
  return normalized || "projecte";
}

export function uniqueSlug(name: string, used: Set<string>) {
  const base = slugifyName(name);
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base.slice(0, 58 - String(suffix).length)}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("No s’ha pogut generar un slug únic per al projecte.");
}
