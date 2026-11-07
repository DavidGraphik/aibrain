import type { MemoryKind, MemoryRecord } from "@/memory/types";
import type { GovernedMemoryRecord, MemoryProposal, MemoryScope } from "@/memory/proposal-store";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!isRecord(value) || !isRecord(value.provenance)) return false;
  return value.schemaVersion === 1
    && typeof value.memoryId === "string"
    && typeof value.content === "string"
    && (value.kind === "recollection" || value.kind === "decision")
    && value.explicit === true
    && (value.status === "active" || value.status === "revoked")
    && typeof value.createdAt === "string";
}

async function responseError(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  return isRecord(body) && typeof body.error === "string"
    ? body.error
    : "No se ha podido actualizar la memoria.";
}

export async function listExplicitMemories(signal?: AbortSignal) {
  const response = await fetch("/api/memory?status=all&limit=100", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(await responseError(response));
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.memories) || !body.memories.every(isMemoryRecord)) {
    throw new Error("La respuesta de memoria no es válida.");
  }
  return body.memories;
}

export async function createExplicitMemory(input: { kind: MemoryKind; content: string }) {
  const content = input.content.trim();
  const response = await fetch("/api/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      explicit: true,
      kind: input.kind,
      content,
      sourceExcerpt: content.slice(0, 4_000),
      clientRequestId: crypto.randomUUID(),
    }),
  });
  if (!response.ok) throw new Error(await responseError(response));
  const body: unknown = await response.json();
  if (!isRecord(body) || !isMemoryRecord(body.memory)) {
    throw new Error("La memoria guardada no es válida.");
  }
  return body.memory;
}

export async function revokeExplicitMemory(memoryId: string, reason: string) {
  const response = await fetch(`/api/memory/${encodeURIComponent(memoryId)}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      explicit: true,
      reason: reason.trim(),
      clientRequestId: crypto.randomUUID(),
    }),
  });
  if (!response.ok) throw new Error(await responseError(response));
  const body: unknown = await response.json();
  if (!isRecord(body) || !isMemoryRecord(body.memory)) {
    throw new Error("La memoria revocada no es válida.");
  }
  return body.memory;
}

function isProposal(value: unknown): value is MemoryProposal {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.proposalId === "string" &&
    typeof value.content === "string" && (value.status === "pending" || value.status === "confirmed" || value.status === "rejected") &&
    (value.proposedScope === "private" || value.proposedScope === "project" || value.proposedScope === "company") && isRecord(value.provenance);
}

function isGovernedMemory(value: unknown): value is GovernedMemoryRecord {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.memoryId === "string" && typeof value.content === "string" &&
    Number.isSafeInteger(value.revision) && (value.status === "active" || value.status === "deleted") &&
    (value.scope === "private" || value.scope === "project" || value.scope === "company") && isRecord(value.provenance);
}

export async function listMemoryGovernance(projectId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/memory/proposals?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(await responseError(response));
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.proposals) || !body.proposals.every(isProposal) ||
      !Array.isArray(body.memories) || !body.memories.every(isGovernedMemory) || typeof body.allowCompanyScope !== "boolean") {
    throw new Error("La respuesta de propuestas de memoria no es válida.");
  }
  return { proposals: body.proposals, memories: body.memories, allowCompanyScope: body.allowCompanyScope };
}

async function governanceMutation(url: string, method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>) {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<unknown>;
}

async function governedMemoryMutation(url: string, method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>) {
  const result = await governanceMutation(url, method, body);
  if (!isRecord(result) || !isGovernedMemory(result.memory)) {
    throw new Error("La memoria actualizada no es válida.");
  }
  return result.memory;
}

export async function confirmMemoryProposal(input: { proposalId: string; projectId: string; content: string; scope: MemoryScope }) {
  return governanceMutation(`/api/memory/proposals/${encodeURIComponent(input.proposalId)}/confirm`, "POST", { explicit: true, projectId: input.projectId, content: input.content.trim(), scope: input.scope });
}
export async function rejectMemoryProposal(proposalId: string, projectId: string) {
  return governanceMutation(`/api/memory/proposals/${encodeURIComponent(proposalId)}/reject`, "POST", { explicit: true, projectId, reason: "El usuario rechazó explícitamente la propuesta." });
}
export async function updateGovernedMemory(memory: GovernedMemoryRecord, projectId: string, content: string) {
  return governedMemoryMutation(`/api/memory/governed/${encodeURIComponent(memory.memoryId)}`, "PATCH", { explicit: true, projectId, expectedRevision: memory.revision, content: content.trim() });
}
export async function deleteGovernedMemory(memory: GovernedMemoryRecord, projectId: string) {
  return governedMemoryMutation(`/api/memory/governed/${encodeURIComponent(memory.memoryId)}`, "DELETE", { explicit: true, projectId, expectedRevision: memory.revision });
}
export async function restoreGovernedMemory(memory: GovernedMemoryRecord, projectId: string) {
  return governedMemoryMutation(`/api/memory/governed/${encodeURIComponent(memory.memoryId)}/restore`, "POST", { explicit: true, projectId, expectedRevision: memory.revision });
}
