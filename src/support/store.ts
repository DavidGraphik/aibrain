import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "@/storage/atomic-file";
import { ResourceLockManager } from "@/storage/resource-lock";
import { parseSupportRequestInput, parseSupportReplyInput, SUPPORT_KINDS, SUPPORT_STATUSES, SUPPORT_UUID, SUPPORT_SCREENSHOT_MAX_BYTES, validSupportText, type SupportReplyInput, type SupportRequest, type SupportRequestInput, type SupportResolutionEvidence, type SupportScreenshotInput, type SupportStatus } from "@/support/contracts";

type StoredRequest = SupportRequest & { fingerprint?: string; lease?: { owner: string; token: string; expiresAt: string } };
type Snapshot = { schemaVersion: 1; requests: StoredRequest[] };
export type SupportUpdate = { status: SupportStatus; body: string; evidence?: SupportResolutionEvidence; clientRequestId: string };
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
function missing(error: unknown) { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"); }
function publicRequest(request: StoredRequest): SupportRequest {
  const { lease: _lease, fingerprint: _fingerprint, ...result } = request;
  return result;
}
function decodeScreenshot(shot: SupportScreenshotInput) {
  const data = Buffer.from(shot.dataUrl.slice(shot.dataUrl.indexOf(",") + 1), "base64");
  const valid = shot.mimeType === "image/png" ? data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.toString("ascii", 12, 16) === "IHDR" : shot.mimeType === "image/jpeg" ? data.length >= 4 && data[0] === 255 && data[1] === 216 && data[data.length - 2] === 255 && data[data.length - 1] === 217 : data.length >= 16 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
  if (!valid || data.length > SUPPORT_SCREENSHOT_MAX_BYTES) fail("SUPPORT_SCREENSHOT_INVALID", "La captura debe ser una imagen PNG, JPG o WebP válida de hasta 2 MB.");
  return data;
}
export class FileSupportRequestStore {
  private readonly locks: ResourceLockManager;
  private readonly directory: string;
  private readonly filePath: string;
  constructor(private readonly installationId: string, private readonly userId: string, usersRoot: string, private readonly now: () => number = Date.now) {
    if (![installationId, userId].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))) fail("SUPPORT_IDENTITY_REQUIRED", "Identidad de soporte no válida.");
    this.directory = path.join(path.resolve(usersRoot), userId, "support");
    this.filePath = path.join(this.directory, "requests.json");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(this.directory, "locks") });
  }
  private async safeDirectory() {
    for (const directory of [path.dirname(this.directory), this.directory, path.join(this.directory, "screenshots")]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(directory)).isDirectory()) fail("SUPPORT_STORE_UNSAFE", "Ubicación de soporte no válida.");
    }
  }
  private async read(): Promise<Snapshot> {
    await this.safeDirectory();
    try {
      if (!(await lstat(this.filePath)).isFile()) fail("SUPPORT_STORE_UNSAFE", "Archivo de soporte no válido.");
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as Snapshot;
      if (!value || value.schemaVersion !== 1 || !Array.isArray(value.requests)) fail("SUPPORT_STORE_CORRUPT", "Support request store is corrupt.");
      for (const record of value.requests) {
        if (!record || record.installationId !== this.installationId || record.userId !== this.userId || !SUPPORT_UUID.test(record.id) || !SUPPORT_KINDS.includes(record.kind) || typeof record.description !== "string" || !Number.isFinite(Date.parse(record.createdAt))) fail("SUPPORT_STORE_CORRUPT", "Support request identity is corrupt.");
        // Existing schema1 records are upgraded in memory and only persisted on mutation.
        record.status ??= "queued"; record.updatedAt ??= record.createdAt; record.screenshots ??= [];
        record.messages ??= [{ id: record.id, author: "user", body: record.description, createdAt: record.createdAt }];
        if (!SUPPORT_STATUSES.includes(record.status) || !Array.isArray(record.messages) || !Array.isArray(record.screenshots)) fail("SUPPORT_STORE_CORRUPT", "Support lifecycle is corrupt.");
      }
      return value;
    } catch (error) { if (missing(error)) return { schemaVersion: 1, requests: [] }; throw error; }
  }
  private async write(snapshot: Snapshot) { await atomicWriteFile(this.filePath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 }); }
  private async mutate<T>(operation: (snapshot: Snapshot) => Promise<T>) {
    await this.safeDirectory();
    return this.locks.withLock(`support:${this.installationId}:${this.userId}`, async () => operation(await this.read()));
  }
  async list() { return (await this.read()).requests.map(publicRequest).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async create(input: SupportRequestInput) {
    const parsed = parseSupportRequestInput(input);
    if (!parsed) fail("SUPPORT_INPUT_INVALID", "Solicitud de soporte no válida.");
    const images = (parsed.screenshots ?? []).map((shot) => ({ shot, data: decodeScreenshot(shot) }));
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...parsed, clientRequestId: undefined })).digest("hex");
    return this.mutate(async (snapshot) => {
      if (parsed.clientRequestId) {
        const previous = snapshot.requests.find((item) => item.clientRequestId === parsed.clientRequestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail("SUPPORT_IDEMPOTENCY_CONFLICT", "La referencia ya corresponde a otra solicitud.");
          return publicRequest(previous);
        }
      }
      const recent = snapshot.requests.filter((item) => this.now() - Date.parse(item.createdAt) < 60 * 60_000);
      if (recent.length >= 10) fail("SUPPORT_RATE_LIMITED", "Has enviado demasiadas solicitudes. Inténtalo de nuevo más tarde.");
      const { screenshots: _screenshots, ...fields } = parsed;
      const createdAt = new Date(this.now()).toISOString();
      const request: StoredRequest = { ...fields, schemaVersion: 1, id: randomUUID(), installationId: this.installationId, userId: this.userId, createdAt, updatedAt: createdAt, notification: "not_configured", status: "queued", messages: [], screenshots: [], fingerprint };
      request.messages.push({ id: randomUUID(), author: "user", body: parsed.description, createdAt });
      for (const { shot, data } of images) {
        const id = randomUUID();
        await atomicWriteFile(path.join(this.directory, "screenshots", id), data, { mode: 0o600 });
        request.screenshots.push({ id, name: shot.name, mimeType: shot.mimeType, size: data.length });
      }
      snapshot.requests.push(request); await this.write(snapshot); return publicRequest(request);
    });
  }
  async reply(id: string, input: SupportReplyInput) {
    const parsed = parseSupportReplyInput(input);
    if (!SUPPORT_UUID.test(id) || !parsed) fail("SUPPORT_INPUT_INVALID", "Respuesta de soporte no válida.");
    return this.mutate(async (snapshot) => {
      const request = snapshot.requests.find((item) => item.id === id);
      if (!request) fail("SUPPORT_NOT_FOUND", "Solicitud no encontrada.");
      const previous = request.messages.find((item) => item.clientRequestId === parsed.clientRequestId);
      if (previous) { if (previous.author !== "user" || previous.body !== parsed.body) fail("SUPPORT_IDEMPOTENCY_CONFLICT", "Referencia de respuesta ya utilizada."); return publicRequest(request); }
      const recent = request.messages.filter((item) => item.author === "user" && this.now() - Date.parse(item.createdAt) < 60 * 60_000);
      if (recent.length >= 20) fail("SUPPORT_RATE_LIMITED", "Has enviado demasiadas respuestas. Inténtalo más tarde.");
      request.updatedAt = new Date(this.now()).toISOString();
      request.messages.push({ id: randomUUID(), author: "user", body: parsed.body, createdAt: request.updatedAt, clientRequestId: parsed.clientRequestId });
      // User follow-up invalidates outstanding work and stale acceptance evidence.
      request.status = "queued"; delete request.lease; delete request.evidence;
      await this.write(snapshot); return publicRequest(request);
    });
  }
  async readScreenshot(id: string, screenshotId: string) {
    if (!SUPPORT_UUID.test(id) || !SUPPORT_UUID.test(screenshotId)) return null;
    const request = (await this.read()).requests.find((item) => item.id === id);
    const screenshot = request?.screenshots.find((item) => item.id === screenshotId);
    if (!screenshot) return null;
    const filePath = path.join(this.directory, "screenshots", screenshotId);
    if (!(await lstat(filePath)).isFile()) fail("SUPPORT_STORE_UNSAFE", "Captura no válida.");
    return { ...screenshot, data: await readFile(filePath) };
  }
  async claim(owner: string, leaseMs = 120_000, requestId?: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner) || !Number.isFinite(leaseMs) || leaseMs < 10_000 || leaseMs > 30 * 60_000 || (requestId !== undefined && !SUPPORT_UUID.test(requestId))) fail("SUPPORT_LEASE_INVALID", "Lease no válido.");
    return this.mutate(async (snapshot) => {
      const request = snapshot.requests.find((item) => (requestId === undefined || item.id === requestId) && ["queued", "investigating", "working", "verifying"].includes(item.status) && (!item.lease || Date.parse(item.lease.expiresAt) <= this.now()));
      if (!request) return null;
      const token = randomUUID();
      request.lease = { owner, token, expiresAt: new Date(this.now() + leaseMs).toISOString() };
      request.status = "investigating"; request.updatedAt = new Date(this.now()).toISOString();
      await this.write(snapshot); return { request: publicRequest(request), token };
    });
  }
  async renew(id: string, token: string, leaseMs = 120_000) {
    if (!SUPPORT_UUID.test(id) || !SUPPORT_UUID.test(token) || !Number.isFinite(leaseMs) || leaseMs < 10_000 || leaseMs > 30 * 60_000) fail("SUPPORT_LEASE_INVALID", "Lease no válido.");
    return this.mutate(async (snapshot) => {
      const request = snapshot.requests.find((item) => item.id === id);
      if (!request?.lease || request.lease.token !== token || Date.parse(request.lease.expiresAt) <= this.now()) fail("SUPPORT_LEASE_LOST", "La incidencia ha cambiado o la sesión ha caducado.");
      request.lease.expiresAt = new Date(this.now() + leaseMs).toISOString();
      await this.write(snapshot); return { expiresAt: request.lease.expiresAt };
    });
  }
  async update(id: string, token: string, update: SupportUpdate) {
    if (!SUPPORT_UUID.test(id) || !SUPPORT_UUID.test(token) || !SUPPORT_UUID.test(update.clientRequestId) || !SUPPORT_STATUSES.includes(update.status) || !validSupportText(update.body)) fail("SUPPORT_INPUT_INVALID", "Actualización no válida.");
    return this.mutate(async (snapshot) => {
      const request = snapshot.requests.find((item) => item.id === id);
      if (!request) fail("SUPPORT_NOT_FOUND", "Solicitud no encontrada.");
      const previous = request.messages.find((item) => item.clientRequestId === update.clientRequestId);
      if (previous) { if (previous.author !== "support" || previous.body !== update.body || request.status !== update.status) fail("SUPPORT_IDEMPOTENCY_CONFLICT", "Referencia de actualización ya utilizada."); return publicRequest(request); }
      if (!request.lease || request.lease.token !== token || Date.parse(request.lease.expiresAt) <= this.now()) fail("SUPPORT_LEASE_LOST", "La incidencia ha cambiado o la sesión ha caducado.");
      if (update.status === "resolved") {
        const evidence = update.evidence;
        if (!evidence || !/^[a-f0-9]{40}$/i.test(evidence.revision) || evidence.installationId !== this.installationId || !Number.isFinite(Date.parse(evidence.checkedAt)) || Date.parse(evidence.checkedAt) > this.now() + 30_000 || this.now() - Date.parse(evidence.checkedAt) > 60 * 60_000) fail("SUPPORT_ACCEPTANCE_REQUIRED", "Falta verificación real de la versión desplegada.");
        let url: URL; try { url = new URL(evidence.url); } catch { fail("SUPPORT_ACCEPTANCE_REQUIRED", "URL de comprobación no válida."); }
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail("SUPPORT_ACCEPTANCE_REQUIRED", "URL de comprobación no válida.");
        request.evidence = evidence;
      }
      request.status = update.status; request.updatedAt = new Date(this.now()).toISOString();
      request.messages.push({ id: randomUUID(), author: "support", body: update.body.trim(), createdAt: request.updatedAt, clientRequestId: update.clientRequestId });
      if (["resolved", "escalated", "declined", "needs_information"].includes(update.status)) delete request.lease;
      await this.write(snapshot); return publicRequest(request);
    });
  }
  async setNotification(id: string, notification: SupportRequest["notification"]) {
    return this.mutate(async (snapshot) => { const request = snapshot.requests.find((item) => item.id === id); if (!request) return; request.notification = notification; await this.write(snapshot); });
  }
}
