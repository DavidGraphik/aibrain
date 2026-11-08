import "server-only";
import { privateHorariaRequest } from "./private-transport";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { AuthSession } from "@/auth/types";
import type { InstallationConfig } from "@/config/installation-schema";
import { readRegularFileWithin } from "@/security/safe-file";
import { resolveOperation, type OperationInput } from "./operations";
import { validateUploadedDocument } from "@/documents/upload-validation";

export type HorariaConfig = { installationId: string; baseUrl: string; secret: string; users: Record<string, { employeeId: number; backgroundOperations: string[] }>; eventsEnabled: boolean; eventActorId?: string };
export async function loadHorariaConfig(installation: Readonly<InstallationConfig>): Promise<HorariaConfig> {
  const file = await open(path.join(installation.paths.dataRoot, "horaria", "integration.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64_000 || (stat.mode & 0o077)) throw new Error("La configuración de horarios debe ser privada.");
    const c = JSON.parse(await file.readFile("utf8")) as HorariaConfig;
    const url = new URL(c.baseUrl);
    if (c.installationId !== installation.installationId || typeof c.secret !== "string" || c.secret.length < 32 ||
      !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || typeof c.eventsEnabled !== "boolean" || !c.users || typeof c.users !== "object" || Array.isArray(c.users)) throw new Error("Configuración de horarios no válida.");
    for (const user of Object.values(c.users)) {
      if (!Number.isSafeInteger(user.employeeId) || user.employeeId < 1 || !Array.isArray(user.backgroundOperations) || user.backgroundOperations.some(op => typeof op !== "string")) throw new Error("Asignación de horarios no válida.");
    }
    if (c.eventActorId !== undefined && (typeof c.eventActorId !== "string" || !Object.hasOwn(c.users, c.eventActorId))) throw new Error("Responsable de WhatsApp no válido.");
    return c;
  } finally { await file.close(); }
}

export function bridgeToken(config: HorariaConfig, request: { method: string; target: string; contentType: string; body: Uint8Array; kind: "user" | "event" | "scheduler"; actorId?: string; employeeId?: number; source?: "whatsapp" }) {
  const { body, ...claims } = request;
  const payload = Buffer.from(JSON.stringify({ ...claims, v: 1, installationId: config.installationId, timestamp: Date.now(), nonce: randomUUID(), bodyHash: createHash("sha256").update(body).digest("hex") })).toString("base64url");
  return `${payload}.${createHmac("sha256", config.secret).update(payload).digest("base64url")}`;
}

export async function callHoraria(config: HorariaConfig, session: AuthSession, input: OperationInput, projectWorkspace: string, renderPdf?: (data: Buffer, fileName: string) => Promise<Buffer>) {
  if (session.provider !== "local" || session.tenant.id !== config.installationId || !Object.hasOwn(config.users, session.user.id)) throw new Error("No tienes acceso a los horarios de esta instalación.");
  const op = resolveOperation(input);
  let body = Buffer.from(input.body ? JSON.stringify(input.body) : "");
  let contentType = body.length ? "application/json" : "";
  if (input.uploadPath) {
    if (path.isAbsolute(input.uploadPath) || input.uploadPath.split(/[\\/]/).includes("..")) throw new Error("El archivo debe pertenecer al proyecto actual.");
    const data = await readRegularFileWithin(projectWorkspace, input.uploadPath, 10 * 1024 * 1024);
    const workbook = input.operation === "schedules.review-upload";
    const mime = workbook ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : data.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? "image/jpeg" : data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" : null;
    if (!mime) throw new Error("Adjunta una imagen PNG o JPEG.");
    if (workbook && validateUploadedDocument({ fileName: path.basename(input.uploadPath), declaredMimeType: mime, data }).kind !== "xlsx") throw new Error("Adjunta un Excel .xlsx.");
    const form = new FormData();
    for (const [key, value] of Object.entries(input.body ?? {})) form.set(key, String(value));
    form.set(workbook ? "workbook" : "imagen", new Blob([new Uint8Array(data)], { type: mime }), path.basename(input.uploadPath));
    if (workbook) {
      const format = input.body?.deliveryFormat ?? "pdf";
      if (format !== "pdf" && format !== "xlsx") throw new Error("Formato de reparto no válido.");
      form.set("deliveryFormat", format);
      if (format === "pdf") {
        if (!renderPdf) throw new Error("No está disponible la conversión segura del Excel corregido.");
        const pdf = await renderPdf(data, path.basename(input.uploadPath));
        if (pdf.length > 4 * 1024 * 1024 || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("PDF revisado no válido.");
        form.set("pdfSourceSha256", createHash("sha256").update(data).digest("hex"));
        form.set("pdfSha256", createHash("sha256").update(pdf).digest("hex"));
        form.set("pdfPages", "1");
        form.set("reviewedPdf", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "reviewed.pdf");
      }
    }
    const serialized = new Request("http://localhost", { method: "POST", body: form });
    body = Buffer.from(await serialized.arrayBuffer());
    contentType = serialized.headers.get("content-type")!;
  }
  if (body.length > 15 * 1024 * 1024) throw new Error("Solicitud demasiado grande.");
  const token = bridgeToken(config, { method: op.method, target: op.target, contentType, body, kind: "user", actorId: session.user.id, employeeId: config.users[session.user.id].employeeId });
  const response = await privateHorariaRequest(config.baseUrl, op.target, { method: op.method, headers: { "x-aibrain-authorization": token, ...(contentType ? { "content-type": contentType } : {}) }, body: body.length ? body : undefined, signal: AbortSignal.timeout(op.effect === "ai" || op.effect === "draft" ? 20 * 60_000 : 90_000) });
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error("Respuesta demasiado grande; filtra por tienda y semana.");
  if (!response.ok) throw new Error(`horarIA (${response.status}): ${text.slice(0, 1500)}`);
  // No password hashes, access tokens or provider secrets may enter the conversation.
  return JSON.parse(text, (key, value) => /password|secret|token|apikey|api_key/i.test(key) ? undefined : value) as unknown;
}

/** Internal artifact registration, deliberately absent from the model's operation catalogue. */
export async function registerHorariaReviewSource(config: HorariaConfig, session: AuthSession, input: { establecimientoId: number; semana: string; fileName: string; sha256: string }, projectWorkspace: string) {
  if (session.provider !== "local" || session.tenant.id !== config.installationId || !Object.hasOwn(config.users, session.user.id)) throw new Error("No tienes acceso a los horarios de esta instalación.");
  if (input.fileName !== path.basename(input.fileName) || /[\\\u0000-\u001f]/u.test(input.fileName) || !input.fileName.endsWith(".xlsx")) throw new Error("Archivo de propuesta no válido.");
  const bytes = await readRegularFileWithin(projectWorkspace, path.join("documents", input.fileName), 10 * 1024 * 1024);
  if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) throw new Error("La propuesta original ha cambiado.");
  const form = new FormData();
  form.set("establecimientoId", String(input.establecimientoId)); form.set("semana", input.semana); form.set("sha256", input.sha256);
  form.set("workbook", new Blob([new Uint8Array(bytes)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), input.fileName);
  const serialized = new Request("http://localhost", { method: "POST", body: form });
  const body = Buffer.from(await serialized.arrayBuffer()), contentType = serialized.headers.get("content-type")!;
  const target = "/api/integration/review-source";
  const token = bridgeToken(config, { method: "POST", target, contentType, body, kind: "user", actorId: session.user.id, employeeId: config.users[session.user.id].employeeId });
  const result = await privateHorariaRequest(config.baseUrl, target, { method: "POST", headers: { "x-aibrain-authorization": token, "content-type": contentType }, body, signal: AbortSignal.timeout(90000) });
  if (!result.ok) throw new Error(`No se ha podido registrar el original para revisión (${result.status}).`);
  const value = await result.json() as { sourceId: string; sha256: string };
  if (!/^[a-f0-9]{64}$/.test(value.sourceId) || value.sha256 !== input.sha256) throw new Error("Recibo del original no válido.");
  return value;
}
