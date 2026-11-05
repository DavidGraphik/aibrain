import { createHash } from "node:crypto";
export const HOST_ANALYSIS_JOBS = ["provider-response-watchdog", "client-response-watchdog", "email-event-router", "sibema-event-router", "missing-invoice-watchdog", "weekly-trini-summary", "monday-delivery-summary", "automation-acceptance"] as const;
export type HostAnalysisJob = typeof HOST_ANALYSIS_JOBS[number];
export const JOB_LABELS: Record<HostAnalysisJob, string> = {
  "provider-response-watchdog": "Respuestas de proveedores", "client-response-watchdog": "Respuestas de clientes",
  "email-event-router": "Clasificación de correo", "sibema-event-router": "Eventos Sibema", "missing-invoice-watchdog": "Facturas pendientes",
  "weekly-trini-summary": "Resumen semanal", "monday-delivery-summary": "Entregas del lunes", "automation-acceptance": "Prueba manual de automatización",
};
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isHostJob = (value: unknown): value is HostAnalysisJob => typeof value === "string" && HOST_ANALYSIS_JOBS.includes(value as HostAnalysisJob);
export function stableId(value: string) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split(""); hex[12] = "4"; hex[16] = "8";
  const s = hex.join(""); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type HostAnalysisEnvelope = { job: HostAnalysisJob; occurrence: string; deadlineAt?: number; input: string; documents: Array<{ uploadName: string; base64: string }> };
export function parseHostEnvelope(value: unknown): HostAnalysisEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("HOST_INPUT_INVALID");
  const v = value as Record<string, unknown>;
  if (!(["documents,input,job,occurrence", "deadlineAt,documents,input,job,occurrence"].includes(Object.keys(v).sort().join())) || (v.deadlineAt !== undefined && (!Number.isSafeInteger(v.deadlineAt) || Number(v.deadlineAt) <= 0)) || !isHostJob(v.job) || typeof v.occurrence !== "string" ||
    !v.occurrence.length || v.occurrence.length > 512 || /[\r\n\0]/.test(v.occurrence) || typeof v.input !== "string" || !v.input.trim() ||
    Buffer.byteLength(v.input) > 2 * 1024 * 1024 || !Array.isArray(v.documents) || v.documents.length > 19) throw Error("HOST_INPUT_INVALID");
  let bytes = 0; const names = new Set<string>();
  const documents = v.documents.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw Error("HOST_DOCUMENT_INVALID");
    const d = item as Record<string, unknown>;
    if (Object.keys(d).sort().join() !== "base64,uploadName" || typeof d.uploadName !== "string" ||
      !/^SNAPSHOT_\d{4}_document_\d{2}_original\.pdf$/.test(d.uploadName) || names.has(d.uploadName) || typeof d.base64 !== "string" ||
      d.base64.length > 28 * 1024 * 1024) throw Error("HOST_DOCUMENT_INVALID");
    const data = Buffer.from(d.base64, "base64"); bytes += data.length; names.add(d.uploadName);
    if (bytes > 20 * 1024 * 1024 || data.toString("base64") !== d.base64 || data.subarray(0, 5).toString() !== "%PDF-") throw Error("HOST_DOCUMENT_INVALID");
    return { uploadName: d.uploadName, base64: d.base64 };
  });
  return { job: v.job, occurrence: v.occurrence, input: v.input, documents, ...(v.deadlineAt === undefined ? {} : { deadlineAt: Number(v.deadlineAt) }) };
}
