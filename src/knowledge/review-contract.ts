export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type KnowledgeAudience = { scope: "company" | "department" | "project" | "private"; scopeId: string | null };
export type KnowledgeReviewCommand = KnowledgeAudience & { projectId: string; connectionId: string; recordId: string; revision: number; } & ({ decision: "confirm" | "reject" | "delete" } | { decision: "correct"; content: string; reason: string });
export type KnowledgeReviewRecord = {
  id: string; kind: "fact" | "summary" | "insight" | "decision"; label: string; topic: string; content: string;
  status: "proposed" | "confirmed" | "rejected" | "deleted"; revision: number;
  citations: Array<{ source: string; sha256: string; locator: string; quote: string; path: string }>;
  correction?: { previousRecordId: string; previousRevision: number; previousContent: string; reason: string };
  conflicts: string[]; events: Array<{ action: string; actor: string; recorded: string; revision: number }>;
};
export function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
export function audience(value: unknown): value is KnowledgeAudience & Record<string, unknown> {
  return object(value) && ["company", "department", "project", "private"].includes(String(value.scope)) &&
    (value.scope === "company" ? value.scopeId === null : typeof value.scopeId === "string" && UUID.test(value.scopeId));
}
export function command(value: unknown): value is KnowledgeReviewCommand {
  return audience(value) && object(value) && Object.keys(value).sort().join(",") === (value.decision === "correct" ? "connectionId,content,decision,projectId,reason,recordId,revision,scope,scopeId" : "connectionId,decision,projectId,recordId,revision,scope,scopeId") &&
    typeof value.projectId === "string" && UUID.test(value.projectId) && typeof value.recordId === "string" && UUID.test(value.recordId) &&
    typeof value.connectionId === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value.connectionId) && Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 && Number(value.revision) <= 2 ** 31 - 1 && (value.decision === "correct" ? typeof value.content === "string" && value.content.trim().length > 0 && value.content.length <= 8000 &&
      typeof value.reason === "string" && value.reason.trim().length > 0 && value.reason.length <= 1000 : ["confirm", "reject", "delete"].includes(String(value.decision)));
}
export function reviewRecord(value: unknown): value is KnowledgeReviewRecord {
  if (!object(value) || typeof value.id !== "string" || !UUID.test(value.id) || !["fact", "summary", "insight", "decision"].includes(String(value.kind)) ||
    !["proposed", "confirmed", "rejected", "deleted"].includes(String(value.status)) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return false;
  if (!["label", "topic", "content"].every((key) => typeof value[key] === "string" && (value[key] as string).length > 0 && (value[key] as string).length <= 8000)) return false;
  if (value.correction !== undefined && (!object(value.correction) || typeof value.correction.previousRecordId !== "string" || !UUID.test(value.correction.previousRecordId) ||
    !Number.isSafeInteger(value.correction.previousRevision) || Number(value.correction.previousRevision) < 1 ||
    typeof value.correction.previousContent !== "string" || value.correction.previousContent.length > 8000 ||
    typeof value.correction.reason !== "string" || !value.correction.reason.trim() || value.correction.reason.length > 1000)) return false;
  return Array.isArray(value.citations) && value.citations.length > 0 && value.citations.length <= 20 && value.citations.every((c) => object(c) &&
    typeof c.source === "string" && c.source.length <= 1024 && typeof c.sha256 === "string" && /^[a-f0-9]{64}$/.test(c.sha256) &&
    typeof c.path === "string" && c.path.length <= 1024 && typeof c.locator === "string" && c.locator.length <= 500 && typeof c.quote === "string" && c.quote.length <= 4000) &&
    Array.isArray(value.conflicts) && value.conflicts.length <= 1000 && value.conflicts.every((v) => typeof v === "string" && UUID.test(v)) &&
    Array.isArray(value.events) && value.events.length <= 10 && value.events.every((e) => object(e) && typeof e.action === "string" && typeof e.actor === "string" &&
      typeof e.recorded === "string" && Number.isFinite(Date.parse(e.recorded)) && Number.isSafeInteger(e.revision));
}
