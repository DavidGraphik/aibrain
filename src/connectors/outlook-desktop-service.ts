import "server-only";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { InstallationConfig } from "@/config/installation-schema";
import { loadInstallationConfig } from "@/config/installation";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { workspacePolicyForIdentity } from "@/admin/policy-service";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";
import { MAIL_CONNECTOR_ID } from "./mail-contracts";
import { USER_ID_PATTERN } from "./contracts";
import { assertInteractiveChatAuthorization, type InteractiveChatAuthorization } from "@/runtime/interactive-chat-authorization";
import { FileOutlookDesktopStore, type DesktopJob, type DesktopState, type DesktopMachine } from "./outlook-desktop-store";
import { FileOutlookArchiveStore, OUTLOOK_ARCHIVE_MAX_BATCH_BYTES } from "./outlook-archive-store";
import { desktopRecord, desktopString, exactDesktopRecord, normalizeOutlookDesktopOperationArgs, outlookDesktopIsMutation, OutlookDesktopError, OUTLOOK_DESKTOP_MAX_RESULT_BYTES, validateDesktopMachine, validateDesktopStores, type OutlookDesktopOperation } from "./outlook-desktop-contracts";
export type OutlookDesktopIdentity = { config: Readonly<InstallationConfig>; userId: string };
function stable(value: unknown): unknown { if (Array.isArray(value)) return value.map(stable); if (desktopRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])); return value; }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value)) ?? "null").digest("hex");
const sameHash = (a: string, b: string) => /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
async function context(identity: OutlookDesktopIdentity, mutating = false) {
  const { config, userId } = identity;
  if (config.installationId !== "g03-production" || !config.connectors?.mail?.enabled || config.connectors.mail.provider !== "nominalia") throw new OutlookDesktopError("OUTLOOK_DESKTOP_NOT_ENABLED", 404);
  if (!USER_ID_PATTERN.test(userId)) throw new OutlookDesktopError("OUTLOOK_DESKTOP_IDENTITY_INVALID", 403);
  const user = await new FileLocalUserStore(config.paths.usersRoot).read(userId); if (!user?.enabled) throw new OutlookDesktopError("OUTLOOK_DESKTOP_IDENTITY_INVALID", 403);
  const workspace = await workspacePolicyForIdentity(config.installationId, userId, config); const catalog = await catalogRuntimeEnforcer(config.installationId, userId);
  if (!workspace.policy.capabilities.consult || mutating && !workspace.policy.capabilities.execute || !catalog.allowsConnector(MAIL_CONNECTOR_ID) || mutating && !catalog.allowsConnectorWrite(MAIL_CONNECTOR_ID)) throw new OutlookDesktopError("OUTLOOK_DESKTOP_ACCESS_DENIED", 403);
  return { ...identity, user, policyHash: digest(workspace.policy), store: new FileOutlookDesktopStore(config) };
}
function requireDevice(state: DesktopState, email: string) { const device = state.device; if (!device || device.revoked || device.email !== email) throw new OutlookDesktopError("OUTLOOK_DESKTOP_NOT_PAIRED", 401); return device; }
function expireJobs(state: DesktopState, now = Date.now()) { for (const job of state.jobs) if (["pending", "leased"].includes(job.status) && job.deadline <= now) { job.status = job.status === "leased" ? "unknown" : "failed"; job.terminalAt = now; job.error = job.status === "unknown" ? "OUTLOOK_DESKTOP_OUTCOME_UNKNOWN_DO_NOT_RETRY" : "OUTLOOK_DESKTOP_DEADLINE_EXCEEDED"; } }
function stopJobs(state: DesktopState, code: string) { for (const job of state.jobs) if (["pending", "leased"].includes(job.status)) { job.status = job.status === "leased" ? "unknown" : "failed"; job.terminalAt = Date.now(); job.error = code; } }
function visible(job: DesktopJob) { return { operationId: job.operationId, operation: job.operation, args: job.args, status: job.status === "leased" ? "pending" as const : job.status, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}), ...(job.resultExpired ? { resultExpired: true } : {}), ...(job.lateObserved ? { lateObserved: job.lateObserved } : {}) }; }
/** Keep bounded recent readbacks; terminal mutation identities survive forever. */
function compactJobs(state: DesktopState, preserveId?: string) {
  const now = Date.now(); let retainedBytes = 0, retainedReads = 0;
  for (const job of [...state.jobs].reverse()) {
    if (["pending", "leased"].includes(job.status)) continue;
    job.terminalAt ??= now;
    const bytes = Buffer.byteLength(JSON.stringify({ args: job.args, result: job.result, lateObserved: job.lateObserved }));
    const mutation = outlookDesktopIsMutation(job.operation);
    const age = now - job.terminalAt;
    const retain = job.operationId === preserveId || (age < (mutation ? 30 * 60_000 : 5 * 60_000) && retainedBytes + bytes <= 24 * 1024 * 1024 && (mutation || retainedReads < 20));
    if (retain) { retainedBytes += bytes; if (!mutation) retainedReads++; }
    else { delete job.result; if (job.lateObserved) delete job.lateObserved.result; job.args = {}; job.resultExpired = true; }
  }
  state.jobs = state.jobs.filter(job => outlookDesktopIsMutation(job.operation) || !job.terminalAt || now - job.terminalAt < 86400000);
}
const cancellationRegistrations = new Map<string, AbortSignal>();
function registerCancellation(identity: OutlookDesktopIdentity, operationId: string, authorization: InteractiveChatAuthorization) {
  if (cancellationRegistrations.has(operationId)) return; cancellationRegistrations.set(operationId, authorization.signal);
  const cancel = () => { void new FileOutlookDesktopStore(identity.config).transaction(identity.userId, async state => { const job = state.jobs.find(job => job.operationId === operationId); if (job && ["pending", "leased"].includes(job.status)) { job.status = job.status === "leased" ? "unknown" : "failed"; job.error = "OUTLOOK_DESKTOP_CHAT_CANCELLED"; job.terminalAt = Date.now(); } }).catch(() => undefined); };
  if (authorization.signal.aborted) cancel(); else authorization.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { authorization.signal.removeEventListener("abort", cancel); cancellationRegistrations.delete(operationId); }, Math.max(0, Math.min(120_000, authorization.expiresAt - Date.now()))); timer.unref?.();
}
function waitBudget(requested: number | undefined, maximum: number) { return Number.isFinite(requested) ? Math.max(0, Math.min(maximum, requested!)) : maximum; }
async function waitForOperation(identity: OutlookDesktopIdentity, operationId: string, milliseconds: number, signal?: AbortSignal) {
  const end = Date.now() + milliseconds; let job: DesktopJob | undefined;
  while (true) {
    const ctx = await context(identity);
    job = await ctx.store.transaction(identity.userId, async state => { expireJobs(state); compactJobs(state); const found = state.jobs.find(job => job.operationId === operationId); if (!found) throw new OutlookDesktopError("OUTLOOK_DESKTOP_OPERATION_NOT_FOUND", 404); await context(identity, outlookDesktopIsMutation(found.operation)); return found; });
    if (!["pending", "leased"].includes(job.status) || signal?.aborted || Date.now() >= end) return visible(job);
    await new Promise<void>(resolve => { const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); }; const timer = setTimeout(finish, Math.min(300, end - Date.now())); signal?.addEventListener("abort", finish, { once: true }); });
  }
}
function storesAllowed(args: Record<string, unknown>, stores: string[]) { for (const key of ["storeId", "targetStoreId"]) if (args[key] !== undefined && !stores.includes(String(args[key]))) throw new OutlookDesktopError("OUTLOOK_DESKTOP_STORE_DENIED", 403); }
export async function createOutlookDesktopEnrollment(identity: OutlookDesktopIdentity, machine: DesktopMachine, serverUrl: string) {
  const validated = validateDesktopMachine({ ...machine, version: "operator" }); const ctx = await context(identity);
  if (validated.email !== ctx.user.email) throw new OutlookDesktopError("OUTLOOK_DESKTOP_IDENTITY_INVALID", 403);
  let url: URL; try { url = new URL(serverUrl); } catch { throw new OutlookDesktopError("OUTLOOK_DESKTOP_SERVER_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.origin !== new URL(identity.config.publicUrl).origin) throw new OutlookDesktopError("OUTLOOK_DESKTOP_SERVER_URL_INVALID");
  const pairingCode = `${identity.userId}.${randomBytes(32).toString("base64url")}`, expiresAt = Date.now() + 10 * 60_000;
  await ctx.store.transaction(identity.userId, async state => { state.pairing = { sid: validated.sid, computer: validated.computer, email: validated.email, storeIds: validated.storeIds, hash: digest(pairingCode), expiresAt }; });
  return { schema: 1, serverUrl: url.origin, userId: identity.userId, email: validated.email, sid: validated.sid, computer: validated.computer, storeIds: validated.storeIds, pairingCode, expiresAt: new Date(expiresAt).toISOString() };
}
export async function revokeOutlookDesktopIdentity(identity: OutlookDesktopIdentity) { const ctx = await context(identity); return ctx.store.transaction(identity.userId, async state => { if (state.device) state.device.revoked = true; delete state.pairing; stopJobs(state, "OUTLOOK_DESKTOP_DEVICE_REVOKED"); return { revoked: true }; }); }
function authUser(secret: string, kind: "Pairing" | "Bearer") { const pattern = kind === "Pairing" ? /^([a-f0-9-]{36})\.[A-Za-z0-9_-]{43}$/ : /^([a-f0-9-]{36})\.([a-f0-9-]{36})\.[A-Za-z0-9_-]{43}$/; const match = pattern.exec(secret); if (!match || !USER_ID_PATTERN.test(match[1])) throw new OutlookDesktopError("OUTLOOK_DESKTOP_AUTH_INVALID", 401); return match[1]; }
export async function enrollOutlookDesktopAgent(config: Readonly<InstallationConfig>, code: string, input: unknown) {
  const userId = authUser(code, "Pairing"), machine = validateDesktopMachine(input), ctx = await context({ config, userId });
  return ctx.store.transaction(userId, async state => {
    const current = await context({ config, userId }); const pair = state.pairing;
    if (!pair || pair.expiresAt <= Date.now() || !sameHash(pair.hash, digest(code)) || pair.email !== current.user.email || machine.email !== pair.email || machine.sid !== pair.sid || machine.computer !== pair.computer || digest([...machine.storeIds].sort()) !== digest([...pair.storeIds].sort())) throw new OutlookDesktopError("OUTLOOK_DESKTOP_PAIRING_INVALID", 401);
    const deviceId = randomUUID(), token = `${userId}.${deviceId}.${randomBytes(32).toString("base64url")}`;
    stopJobs(state, "OUTLOOK_DESKTOP_DEVICE_REPLACED");
    state.device = { id: deviceId, tokenHash: digest(token), sid: pair.sid, computer: pair.computer, email: pair.email, storeIds: pair.storeIds, enrolledAt: Date.now(), version: machine.version };
    delete state.pairing; return { deviceId, token, pollSeconds: 2 };
  });
}
async function agentContext(config: Readonly<InstallationConfig>, token: string) {
  const userId = authUser(token, "Bearer"), ctx = await context({ config, userId });
  return { ...ctx, token };
}
function authenticateDevice(state: DesktopState, email: string, token: string) { const device = requireDevice(state, email); if (!sameHash(device.tokenHash, digest(token)) || token.split(".")[1] !== device.id) throw new OutlookDesktopError("OUTLOOK_DESKTOP_AUTH_INVALID", 401); return device; }
function archiveAuthority(userId: string, device: NonNullable<DesktopState["device"]>) { return { userId, deviceId: device.id, storeIds: device.storeIds }; }
/** Operator-only capacity setting. Never exposed as a model tool or agent input. */
export async function configureOutlookArchiveForIdentity(identity: OutlookDesktopIdentity, quotaBytes: number) {
  const ctx = await context(identity);
  return ctx.store.transaction(identity.userId, async state => {
    const fresh = await context(identity); const device = requireDevice(state, fresh.user.email);
    return new FileOutlookArchiveStore(identity.config).configure(archiveAuthority(identity.userId, device), quotaBytes);
  });
}
export async function submitOutlookArchiveBatch(config: Readonly<InstallationConfig>, token: string, input: unknown) {
  const ctx = await agentContext(config, token);
  return ctx.store.transaction(ctx.userId, async state => {
    const fresh = await context({ config, userId: ctx.userId });
    const device = authenticateDevice(state, fresh.user.email, token);
    return new FileOutlookArchiveStore(config).ingest(archiveAuthority(ctx.userId, device), input);
  });
}
export async function pollOutlookDesktopAgent(config: Readonly<InstallationConfig>, token: string, input: unknown) {
  exactDesktopRecord(input, ["sid", "computer", "version", "outlookOpen", "availableStoreIds"]);
  const sid = desktopString(input.sid, 184), computer = desktopString(input.computer, 63).toUpperCase(), version = desktopString(input.version, 40);
  if (typeof input.outlookOpen !== "boolean") throw new OutlookDesktopError("OUTLOOK_DESKTOP_ARGUMENTS_INVALID");
  const stores = Array.isArray(input.availableStoreIds) && input.availableStoreIds.length === 0 ? [] : validateDesktopStores(input.availableStoreIds);
  const ctx = await agentContext(config, token);
  const polled = await ctx.store.transaction(ctx.userId, async state => {
    const device = authenticateDevice(state, ctx.user.email, token); if (device.sid !== sid || device.computer !== computer) throw new OutlookDesktopError("OUTLOOK_DESKTOP_MACHINE_MISMATCH", 403);
    device.lastSeenAt = Date.now(); device.outlookOpen = input.outlookOpen as boolean; device.availableStoreIds = stores.filter(id => device.storeIds.includes(id)); device.version = version; expireJobs(state); compactJobs(state);
    // A running lease is never redispatched, including after server restart.
    if (!device.outlookOpen || state.jobs.some(job => job.status === "leased")) return { job: null, pollSeconds: 2 };
    for (const job of state.jobs.filter(job => job.status === "pending")) {
      let allowed = false;
      try { const fresh = await context({ config, userId: ctx.userId }, outlookDesktopIsMutation(job.operation)); allowed = fresh.policyHash === job.policyHash && fresh.user.email === job.email && job.deviceId === device.id; storesAllowed(job.args, device.storeIds); } catch { allowed = false; }
      if (!allowed) { job.status = "failed"; job.terminalAt = Date.now(); job.error = "OUTLOOK_DESKTOP_AUTHORITY_CHANGED"; continue; }
      if (["storeId", "targetStoreId"].some(key => job.args[key] !== undefined && !device.availableStoreIds!.includes(String(job.args[key])))) continue;
      job.leaseId = randomUUID(); job.status = "leased";
      return { job: { operationId: job.operationId, leaseId: job.leaseId, fingerprint: job.fingerprint, operation: job.operation, args: job.args, deadline: new Date(job.deadline).toISOString() }, pollSeconds: 2 };
    }
    return { job: null, pollSeconds: 2 };
  });
  const snapshot = await ctx.store.read(ctx.userId); const device = authenticateDevice(snapshot, ctx.user.email, token);
  const archive = await new FileOutlookArchiveStore(config).status(archiveAuthority(ctx.userId, device));
  return { ...polled, archive };
}
function safeResult(value: unknown) {
  if (!desktopRecord(value) || Buffer.byteLength(JSON.stringify(value)) > OUTLOOK_DESKTOP_MAX_RESULT_BYTES) throw new OutlookDesktopError("OUTLOOK_DESKTOP_RESULT_INVALID", 413);
  let nodes = 0; const visit = (v: unknown, depth: number) => { if (++nodes > 100000 || depth > 24) throw new OutlookDesktopError("OUTLOOK_DESKTOP_RESULT_INVALID"); if (v && typeof v === "object") { if (!Array.isArray(v) && !desktopRecord(v)) throw new OutlookDesktopError("OUTLOOK_DESKTOP_RESULT_INVALID"); for (const [key, item] of Object.entries(v)) { if (["__proto__", "constructor", "prototype"].includes(key)) throw new OutlookDesktopError("OUTLOOK_DESKTOP_RESULT_INVALID"); visit(item, depth + 1); } } else if (!["string", "number", "boolean", "undefined"].includes(typeof v) && v !== null || typeof v === "number" && !Number.isFinite(v)) throw new OutlookDesktopError("OUTLOOK_DESKTOP_RESULT_INVALID"); }; visit(value, 0); return value;
}
export async function submitOutlookDesktopAgentResult(config: Readonly<InstallationConfig>, token: string, input: unknown) {
  exactDesktopRecord(input, ["operationId", "leaseId", "fingerprint", "outcome", "result", "error"]);
  const operationId = desktopString(input.operationId, 64), leaseId = desktopString(input.leaseId, 36), fingerprint = desktopString(input.fingerprint, 64);
  if (!["succeeded", "failed", "unknown"].includes(String(input.outcome)) || !/^[a-f0-9]{64}$/.test(operationId) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new OutlookDesktopError("OUTLOOK_DESKTOP_RESULT_INVALID");
  const result = input.result === undefined ? undefined : safeResult(input.result); if (input.outcome === "succeeded" && !result) throw new OutlookDesktopError("OUTLOOK_DESKTOP_RESULT_INVALID");
  const error = input.error === undefined ? undefined : desktopString(input.error, 500);
  const ctx = await agentContext(config, token);
  return ctx.store.transaction(ctx.userId, async state => {
    const device = authenticateDevice(state, ctx.user.email, token); expireJobs(state);
    const job = state.jobs.find(job => job.operationId === operationId);
    if (!job || job.deviceId !== device.id || job.leaseId !== leaseId || !sameHash(job.fingerprint, fingerprint)) throw new OutlookDesktopError("OUTLOOK_DESKTOP_LEASE_INVALID", 409);
    const reportHash = digest({ outcome: input.outcome, result, error });
    if (job.reportHash) {
      if (sameHash(job.reportHash, reportHash)) return { accepted: true, duplicate: true };
      throw new OutlookDesktopError("OUTLOOK_DESKTOP_RESULT_REPLAY", 409);
    }
    if (job.status === "unknown") {
      job.reportHash = reportHash; job.lateObserved = { outcome: String(input.outcome), result, error, receivedAt: Date.now() }; compactJobs(state, job.operationId); return { accepted: true, late: true };
    }
    if (job.status !== "leased") throw new OutlookDesktopError("OUTLOOK_DESKTOP_RESULT_REPLAY", 409);
    let authorityCurrent = false; try { const fresh = await context({ config, userId: ctx.userId }, outlookDesktopIsMutation(job.operation)); authorityCurrent = fresh.policyHash === job.policyHash && fresh.user.email === job.email; } catch { /* Record an authenticated agent report without authorizing any further effect. */ }
    if (!authorityCurrent) { job.status = "unknown"; job.terminalAt = Date.now(); job.error = "OUTLOOK_DESKTOP_AUTHORITY_CHANGED"; job.reportHash = reportHash; job.lateObserved = { outcome: String(input.outcome), result, error, receivedAt: Date.now() }; compactJobs(state, job.operationId); return { accepted: true }; }
    job.status = input.outcome as "succeeded" | "failed" | "unknown"; job.result = result; job.reportHash = reportHash; job.error = error; job.terminalAt = Date.now(); compactJobs(state, job.operationId); return { accepted: true };
  });
}
export async function revokeOutlookDesktopAgent(config: Readonly<InstallationConfig>, token: string) { const ctx = await agentContext(config, token); return ctx.store.transaction(ctx.userId, async state => { authenticateDevice(state, ctx.user.email, token).revoked = true; delete state.pairing; stopJobs(state, "OUTLOOK_DESKTOP_DEVICE_REVOKED"); return { revoked: true }; }); }
export async function readOutlookDesktopStatusForIdentity(identity: OutlookDesktopIdentity) {
  const ctx = await context(identity); return ctx.store.transaction(identity.userId, async state => { expireJobs(state); const d = state.device; if (!d || d.revoked || d.email !== ctx.user.email) return { connected: false, status: "not_paired" as const };
    const online = !!d.lastSeenAt && Date.now() - d.lastSeenAt < 30_000;
    const archive = await new FileOutlookArchiveStore(identity.config).status(archiveAuthority(identity.userId, d));
    return { connected: true, status: !online ? "offline" as const : d.outlookOpen ? "ready" as const : "outlook_closed" as const, accountEmail: d.email, computer: d.computer, storeIds: d.storeIds, availableStoreIds: d.availableStoreIds ?? [], lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : null, pendingOperations: state.jobs.filter(j => j.status === "pending" || j.status === "leased").length, archive };
  });
}
export async function executeOutlookDesktopOperation(identity: OutlookDesktopIdentity, operation: OutlookDesktopOperation, args: unknown, authorization?: InteractiveChatAuthorization, options: { waitMs?: number } = {}) {
  const validated = normalizeOutlookDesktopOperationArgs(operation, args), mutating = outlookDesktopIsMutation(operation);
  if (mutating) assertInteractiveChatAuthorization(authorization, { ...authorization!, installationId: identity.config.installationId, userId: identity.userId });
  const ctx = await context(identity, mutating);
  if (!mutating) {
    const snapshot = await ctx.store.read(identity.userId); const device = requireDevice(snapshot, ctx.user.email);
    storesAllowed(validated, device.storeIds);
    const requestedStoreUnavailable = validated.storeId !== undefined && !device.availableStoreIds?.includes(String(validated.storeId));
    if (!device.outlookOpen || !device.lastSeenAt || Date.now() - device.lastSeenAt >= 30_000 || requestedStoreUnavailable) {
      const replica = new FileOutlookArchiveStore(identity.config);
      const scope = archiveAuthority(identity.userId, device), status = await replica.status(scope);
      if (status.availableWithComputerOff) return { ...await replica.execute(scope, operation, validated), args: validated };
      throw new OutlookDesktopError("OUTLOOK_ARCHIVE_NOT_READY", 409);
    }
  }
  const queued = await ctx.store.transaction(identity.userId, async state => {
    const fresh = await context(identity, mutating); if (mutating) assertInteractiveChatAuthorization(authorization, { ...authorization!, installationId: identity.config.installationId, userId: identity.userId });
    const device = requireDevice(state, fresh.user.email); storesAllowed(validated, device.storeIds); expireJobs(state); compactJobs(state);
    const operationId = mutating ? digest({ userId: identity.userId, installationId: identity.config.installationId, threadId: authorization!.threadId, userMessageId: authorization!.userMessageId, requestHash: authorization!.requestHash, operation, args: validated }) : digest(randomUUID());
    const previous = state.jobs.find(job => job.operationId === operationId); if (previous) return visible(previous);
    if (state.jobs.length >= 100000 || state.jobs.filter(job => ["pending", "leased"].includes(job.status)).length >= 20) throw new OutlookDesktopError("OUTLOOK_DESKTOP_QUEUE_FULL", 429);
    if (Buffer.byteLength(JSON.stringify(state.jobs.filter(job => ["pending", "leased"].includes(job.status)))) + Buffer.byteLength(JSON.stringify(validated)) > 16 * 1024 * 1024) throw new OutlookDesktopError("OUTLOOK_DESKTOP_QUEUE_FULL", 429);
    const job: DesktopJob = { operationId, operation, args: validated, fingerprint: digest({ operationId, operation, args: validated, deviceId: device.id, email: device.email }), deviceId: device.id, email: device.email, policyHash: fresh.policyHash, status: "pending", createdAt: Date.now(), deadline: Math.min(Date.now() + 120_000, authorization?.expiresAt ?? Infinity) };
    state.jobs.push(job); return visible(job);
  });
  if (queued.status !== "pending") return queued;
  if (mutating && authorization) registerCancellation(identity, queued.operationId, authorization);
  return waitForOperation(identity, queued.operationId, waitBudget(options.waitMs, 12000), authorization?.signal);
}
export async function readOutlookDesktopOperation(identity: OutlookDesktopIdentity, operationId: string, options: { waitMs?: number } = {}) {
  if (!/^[a-f0-9]{64}$/.test(operationId)) throw new OutlookDesktopError("OUTLOOK_DESKTOP_ARGUMENTS_INVALID");
  return waitForOperation(identity, operationId, waitBudget(options.waitMs, 5000));
}
export async function handleOutlookDesktopAgentRequest(kind: "enroll" | "poll" | "result" | "revoke" | "archive", request: Request) {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  try {
    const expected = kind === "enroll" ? "Pairing" : "Bearer"; const auth = request.headers.get("authorization") ?? "";
    if (auth.length > 512 || !auth.startsWith(`${expected} `)) throw new OutlookDesktopError("OUTLOOK_DESKTOP_AUTH_INVALID", 401);
    const token = auth.slice(expected.length + 1); authUser(token, expected);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new OutlookDesktopError("OUTLOOK_DESKTOP_ARGUMENTS_INVALID", 415);
    const max = kind === "result" ? OUTLOOK_DESKTOP_MAX_RESULT_BYTES + 4096 : kind === "archive" ? OUTLOOK_ARCHIVE_MAX_BATCH_BYTES : 128 * 1024;
    if (Number(request.headers.get("content-length")) > max) throw new OutlookDesktopError("OUTLOOK_DESKTOP_BODY_TOO_LARGE", 413);
    // Authenticate the opaque credential before accepting a potentially large
    // attachment report. Final handlers recheck it under the mutation lock.
    const config = await loadInstallationConfig();
    const preflight = await context({ config, userId: authUser(token, expected) });
    const snapshot = await preflight.store.read(preflight.userId);
    if (kind === "enroll") {
      if (!snapshot.pairing || snapshot.pairing.expiresAt <= Date.now() || !sameHash(snapshot.pairing.hash, digest(token))) throw new OutlookDesktopError("OUTLOOK_DESKTOP_PAIRING_INVALID", 401);
    } else authenticateDevice(snapshot, preflight.user.email, token);
    const reader = request.body?.getReader(); if (!reader) throw new OutlookDesktopError("OUTLOOK_DESKTOP_ARGUMENTS_INVALID"); const chunks: Uint8Array[] = []; let count = 0;
    while (true) { const chunk = await reader.read(); if (chunk.done) break; count += chunk.value.byteLength; if (count > max) { await reader.cancel(); throw new OutlookDesktopError("OUTLOOK_DESKTOP_BODY_TOO_LARGE", 413); } chunks.push(chunk.value); }
    let input: unknown; try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new OutlookDesktopError("OUTLOOK_DESKTOP_ARGUMENTS_INVALID"); }
    if (kind === "revoke") exactDesktopRecord(input, []);
    const result = kind === "enroll" ? await enrollOutlookDesktopAgent(config, token, input) : kind === "poll" ? await pollOutlookDesktopAgent(config, token, input) : kind === "result" ? await submitOutlookDesktopAgentResult(config, token, input) : kind === "archive" ? await submitOutlookArchiveBatch(config, token, input) : await revokeOutlookDesktopAgent(config, token);
    return Response.json(result, { headers });
  } catch (error) { return Response.json({ code: error instanceof OutlookDesktopError ? error.code : "OUTLOOK_DESKTOP_UNAVAILABLE" }, { status: error instanceof OutlookDesktopError ? error.status : 503, headers }); }
}
