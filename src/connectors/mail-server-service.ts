import "server-only";
import { privateReadBridge, privateMailCapability, PrivateReadBridgeError } from "./private-read-bridge";
import { createHash, randomBytes } from "node:crypto";
import type { AuthSession } from "@/auth/types";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { workspacePolicyForIdentity } from "@/admin/policy-service";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";
import { loadInstallationConfig } from "@/config/installation";
import type { InstallationConfig } from "@/config/installation-schema";
import { FileConnectorBindingStore } from "@/connectors/binding-store";
import type { ConnectorPrincipal } from "@/connectors/contracts";
import { assertInteractiveChatAuthorization, type InteractiveChatAuthorization } from "@/runtime/interactive-chat-authorization";
import { FileMailStore, mailEncryptionKey } from "./mail-store";
import { nominaliaMailTransport } from "./mail-transport";
import { MAIL_CONNECTOR_ID, MailConnectorError, isMailRecord, mailErrorCode, type MailDraftRef, type MailCredentials, type MailPayload, type MailOperation, type MailTransport } from "./mail-contracts";

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type CredentialsRecord = { email: string; password: string; bindingVersion: number };
type PreviewRecord = { id: string; threadId: string; userMessageId: string; requestHash: string; payload: MailPayload; fingerprint: string; expiresAt: number; bindingVersion: number; policyHash: string; status: "prepared" | "dispatching" | "sent" | "indeterminate"; result?: unknown };
type Identity = { config: Readonly<InstallationConfig>; userId: string };
// Stable mailbox identity, deliberately independent of connection versions or
// draft content. Reconnecting/editing cannot bypass an uncertain dispatch.
function draftDispatchName(draft: MailDraftRef, email: string) {
  return `preview-${hash({ kind: "draft-dispatch", email: email.toLowerCase(), folder: draft.folder, uid: draft.uid, uidValidity: draft.uidValidity }).slice(0, 32)}`;
}


async function mailReadBridge(installationId: string, userId: string) {
  try { return await privateReadBridge(installationId, userId); }
  catch (error) { if (error instanceof PrivateReadBridgeError) throw new MailConnectorError(error.code, error.status); throw error; }
}
async function policyContext(identity: Identity, mutating = false) {
  const { config, userId } = identity;
  if (!config.connectors?.mail?.enabled || config.connectors.mail.provider !== "nominalia") throw new MailConnectorError("MAIL_NOT_ENABLED", 404);
  const user = await new FileLocalUserStore(config.paths.usersRoot).read(userId);
  if (!user?.enabled || user.userId !== userId) throw new MailConnectorError("MAIL_IDENTITY_INVALID", 403);
  const workspace = await workspacePolicyForIdentity(config.installationId, userId, config);
  const catalog = await catalogRuntimeEnforcer(config.installationId, userId);
  if (!workspace.policy.capabilities.consult || mutating && !workspace.policy.capabilities.execute || !catalog.allowsConnector(MAIL_CONNECTOR_ID) || mutating && !catalog.allowsConnectorWrite(MAIL_CONNECTOR_ID)) throw new MailConnectorError("MAIL_ACCESS_DENIED", 403);
  const principal: ConnectorPrincipal = { installationId: config.installationId, userId, roleId: workspace.roleId };
  return { config, user, principal, policyHash: hash(workspace.policy) };
}
async function context(identity: Identity, mutating = false) {
  const ctx = await policyContext(identity, mutating);
  return { ...ctx, store: new FileMailStore(ctx.config, mailEncryptionKey()), bindings: new FileConnectorBindingStore(ctx.config.installationId, ctx.config.paths.dataRoot) };
}
async function sessionContext(session: AuthSession, mutating = false) {
  const config = await loadInstallationConfig();
  if (session.provider !== "local" || session.tenant.id !== config.installationId || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) throw new MailConnectorError("MAIL_IDENTITY_INVALID", 403);
  const ctx = await context({ config, userId: session.user.id }, mutating);
  if (ctx.user.email !== session.user.email.trim().toLowerCase()) throw new MailConnectorError("MAIL_IDENTITY_INVALID", 403);
  return ctx;
}
async function access(identity: Identity, mutating = false) {
  const ctx = await context(identity, mutating);
  const binding = await ctx.bindings.resolve(ctx.principal, MAIL_CONNECTOR_ID, { allowShared: false });
  if (binding.userId !== identity.userId || binding.status !== "active") throw new MailConnectorError("MAIL_LOGIN_REQUIRED", 401);
  const stored = await ctx.store.read<CredentialsRecord>(identity.userId, "credentials");
  if (!stored || stored.email !== ctx.user.email || stored.bindingVersion !== binding.version || typeof stored.password !== "string") throw new MailConnectorError("MAIL_LOGIN_REQUIRED", 401);
  return { ...ctx, binding, credentials: { email: stored.email, password: stored.password } satisfies MailCredentials };
}
export async function connectMail(session: AuthSession, password: unknown, transport: MailTransport = nominaliaMailTransport) {
  if (typeof password !== "string" || password.length < 1 || password.length > 1024 || /[\0\r\n]/.test(password)) throw new MailConnectorError("MAIL_CREDENTIALS_INVALID");
  const ctx = await sessionContext(session);
  return ctx.store.locks.withLock(`mail-account:${session.user.id}`, async () => {
    await transport("verify", { email: ctx.user.email, password }, {});
    let old;
    try { old = await ctx.bindings.readPersonalForManagement(ctx.principal, MAIL_CONNECTOR_ID); } catch (error) { if (!isMailRecord(error) || error.code !== "ENOENT") throw error; }
    const version = (old?.version ?? 0) + 1;
    await ctx.store.put(session.user.id, "credentials", { email: ctx.user.email, password, bindingVersion: version });
    await ctx.bindings.put({ schemaVersion: 1, connectorId: MAIL_CONNECTOR_ID, credentialRef: `mail:${randomBytes(16).toString("hex")}`, installationId: ctx.config.installationId, userId: session.user.id, scopes: ["mail.read", "mail.draft", "mail.send", "mail.organize"], status: "active", version });
    return { connected: true, accountEmail: ctx.user.email, connectionVersion: version };
  });
}
export async function disconnectMail(session: AuthSession) {
  const ctx = await sessionContext(session);
  return ctx.store.locks.withLock(`mail-account:${session.user.id}`, async () => {
    const binding = await ctx.bindings.resolve(ctx.principal, MAIL_CONNECTOR_ID, { allowShared: false });
    await ctx.bindings.revoke(ctx.principal, MAIL_CONNECTOR_ID, { allowShared: false, manageShared: false, expectedVersion: binding.version });
    await ctx.store.clear(session.user.id);
    return { status: "revoked" };
  });
}
export async function mailAccessForIdentity(config: Readonly<InstallationConfig>, userId: string) {
  const bridge = await mailReadBridge(config.installationId, userId);
  if (bridge) {
    await policyContext({ config, userId });
    const capability = privateMailCapability(await bridge.request("capabilities", {}));
    return { binding: { transport: "source-native" as const, version: capability.connectionVersion }, capability };
  }
  const ctx = await access({ config, userId }); return { binding: ctx.binding };
}
export async function mailCapabilityForSession(session: AuthSession, transport: MailTransport = nominaliaMailTransport) {
  const config = await loadInstallationConfig();
  if (!config.connectors?.mail?.enabled) return null;
  const base = { connectorId: MAIL_CONNECTOR_ID, label: "Correo", effectiveOperations: [] as string[], approvalRequiredOperations: [] as string[], connectUrl: "/api/connectors/mail/connect", disconnectUrl: null as string | null, accountEmail: session.user.email, connectionVersion: null as number | null, checkedAt: null as string | null };
  try {
    const bridge = await mailReadBridge(config.installationId, session.user.id);
    if (bridge) {
      if (session.provider !== "local" || session.tenant.id !== config.installationId || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) throw new MailConnectorError("MAIL_IDENTITY_INVALID", 403);
      const ctx = await policyContext({ config, userId: session.user.id });
      if (ctx.user.email !== session.user.email.trim().toLowerCase()) throw new MailConnectorError("MAIL_IDENTITY_INVALID", 403);
      const remote = privateMailCapability(await bridge.request("capabilities", {}));
      return { ...base, status: "connected" as const, statusCode: "SOURCE_PERMISSION_VERIFIED_REACHABILITY_UNTESTED", connectUrl: null, effectiveOperations: remote.operations, connectionVersion: remote.connectionVersion };
    }
    await sessionContext(session);
    const ctx = await access({ config, userId: session.user.id });
    // Provider reachability is checked on connect and operations. Settings does
    // not reauthenticate every employee mailbox on every page refresh.
    void transport;
    return { ...base, status: "connected" as const, statusCode: null, effectiveOperations: ["folders", "list", "search", "read", "attachment", "reply", "draft", "prepare_send", "send", "flags", "move"], disconnectUrl: "/api/connectors/mail/disconnect", connectionVersion: ctx.binding.version };
  } catch (error) {
    if (error instanceof MailConnectorError && error.code === "MAIL_ACCESS_DENIED") return null;
    const code = error instanceof PrivateReadBridgeError ? error.code : mailErrorCode(error);
    const missing = isMailRecord(error) && (error.code === "CONNECTOR_BINDING_NOT_FOUND" || error.code === "CONNECTOR_BINDING_REVOKED") || code === "MAIL_LOGIN_REQUIRED";
    return { ...base, status: missing ? "reauth_required" as const : "not_configured" as const, statusCode: code };
  }
}
function string(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || !allowEmpty && !value.trim() || value.includes("\0")) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID");
  return value;
}
function header(value: unknown, max: number, allowEmpty = false) { const result = string(value, max, allowEmpty); if (/[\r\n]/.test(result)) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID"); return result; }
function addresses(value: unknown) {
  if (!Array.isArray(value) || value.length > 50 || !value.every(email => typeof email === "string" && email.length <= 320 && EMAIL.test(email))) throw new MailConnectorError("MAIL_RECIPIENT_INVALID");
  return [...new Set((value as string[]).map(email => email.toLowerCase()))];
}
export function normalizeMailPayload(input: unknown, from: string): MailPayload {
  if (!isMailRecord(input) || Object.keys(input).some(key => !["to", "cc", "bcc", "subject", "text", "attachments", "inReplyTo", "references", "draft"].includes(key))) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID");
  const to = addresses(input.to), cc = addresses(input.cc ?? []), bcc = addresses(input.bcc ?? []);
  if (to.length + cc.length + bcc.length < 1 || to.length + cc.length + bcc.length > 50) throw new MailConnectorError("MAIL_RECIPIENT_INVALID");
  let size = 0;
  const rawAttachments = input.attachments ?? [];
  if (!Array.isArray(rawAttachments) || rawAttachments.length > 10) throw new MailConnectorError("MAIL_ATTACHMENT_INVALID");
  const attachments = rawAttachments.map(raw => {
    if (!isMailRecord(raw) || Object.keys(raw).sort().join() !== "contentType,dataBase64,filename") throw new MailConnectorError("MAIL_ATTACHMENT_INVALID");
    const filename = header(raw.filename, 240), contentType = header(raw.contentType, 100), dataBase64 = string(raw.dataBase64, 7 * 1024 * 1024, true);
    if (!/^[A-Za-z0-9+\/]*={0,2}$/.test(dataBase64) || !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(contentType) || /[\/\\]/.test(filename)) throw new MailConnectorError("MAIL_ATTACHMENT_INVALID");
    const data = Buffer.from(dataBase64, "base64");
    if (data.toString("base64") !== dataBase64) throw new MailConnectorError("MAIL_ATTACHMENT_INVALID");
    size += data.length; return { filename, contentType, dataBase64 };
  });
  if (size > 5 * 1024 * 1024) throw new MailConnectorError("MAIL_ATTACHMENT_TOO_LARGE");
  return { ...(input.draft === undefined ? {} : { draft: normalizeDraftReference(input.draft) }), from, to, cc, bcc, subject: header(input.subject, 998, true), text: string(input.text, 150_000, true), attachments, messageId: `<${randomBytes(20).toString("hex")}@${from.split("@")[1]}>`, ...(input.inReplyTo === undefined ? {} : { inReplyTo: header(input.inReplyTo, 998) }), ...(input.references === undefined ? {} : { references: header(input.references, 2000) }) };
}
function normalizeMessageReference(input: unknown) {
  if (!isMailRecord(input) || Object.keys(input).sort().join() !== "folder,uid,uidValidity" || typeof input.uid !== "string" || !/^[1-9]\d{0,19}$/.test(input.uid) || typeof input.uidValidity !== "string" || !/^[1-9]\d{0,19}$/.test(input.uidValidity)) throw new MailConnectorError("MAIL_MESSAGE_INVALID");
  return { folder: header(input.folder, 500), uid: input.uid, uidValidity: input.uidValidity };
}
function normalizeDraftReference(input: unknown): MailDraftRef {
  if (!isMailRecord(input) || Object.keys(input).sort().join() !== "fingerprint,folder,uid,uidValidity" || typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new MailConnectorError("MAIL_DRAFT_INVALID");
  const { fingerprint, ...reference } = input;
  return { ...normalizeMessageReference(reference), fingerprint };
}
export function normalizeMailOperationArgs(operation: Exclude<MailOperation, "send" | "verify">, args: unknown): Record<string, unknown> {
  if (!isMailRecord(args)) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID");
  const allowed: Record<string, string[]> = { folders: [], list: ["folder", "limit", "cursor"], search: ["folder", "limit", "query", "cursor"], read: ["message"], attachment: ["message", "partId"], reply: ["message", "replyAll", "text"], draft_payload: ["draft"], flags: ["message", "seen", "flagged"], move: ["message", "destination"], draft: ["to", "cc", "bcc", "subject", "text", "attachments", "inReplyTo", "references", "draft"] };
  if (Object.keys(args).some(key => !allowed[operation].includes(key))) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID");
  if (operation === "folders") return {};
  if (operation === "list" || operation === "search") {
    const folder = args.folder === undefined && operation === "search" ? undefined : header(args.folder ?? "INBOX", 500), limit = args.limit ?? 20;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID");
    const base = { ...(folder === undefined ? {} : { folder }), limit: Math.min(Number(limit), 50), ...(args.cursor === undefined ? {} : { cursor: string(args.cursor, 100_000) }) };
    if (operation === "list") return base;
    if (!isMailRecord(args.query) || Object.keys(args.query).length === 0 || Object.keys(args.query).some(key => !["text", "from", "to", "subject", "participant", "since", "before", "unread"].includes(key))) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID");
    for (const [key, value] of Object.entries(args.query)) {
      if (key === "unread") { if (typeof value !== "boolean") throw new MailConnectorError("MAIL_ARGUMENTS_INVALID"); }
      else if (["since", "before"].includes(key)) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID"); }
      else header(value, 500);
    }
    return { ...base, query: args.query };
  }
  if (operation === "draft") return args;
  if (operation === "draft_payload") return { draft: normalizeDraftReference(args.draft) };
  normalizeMessageReference(args.message);
  if (operation === "reply") {
    if (args.replyAll !== undefined && typeof args.replyAll !== "boolean") throw new MailConnectorError("MAIL_ARGUMENTS_INVALID");
    if (args.text !== undefined) string(args.text, 150_000, true);
  }
  if (operation === "attachment" && !/^[1-9]\d*(?:\.\d+)*$/.test(string(args.partId, 80))) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID");
  if (operation === "move") header(args.destination, 500);
  if (operation === "flags" && (typeof args.seen !== "boolean" && typeof args.flagged !== "boolean" || args.seen !== undefined && typeof args.seen !== "boolean" || args.flagged !== undefined && typeof args.flagged !== "boolean")) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID");
  return args;
}
export async function executeMailOperation(identity: Identity, operation: Exclude<MailOperation, "verify" | "send">, args: unknown, transport: MailTransport = nominaliaMailTransport, authorization?: InteractiveChatAuthorization) {
  const bridge = await mailReadBridge(identity.config.installationId, identity.userId);
  if (bridge) {
    if (!["folders", "list", "search", "read"].includes(operation)) throw new MailConnectorError("MAIL_ACCESS_DENIED", 403);
    const initial = await policyContext(identity);
    normalizeMailOperationArgs(operation, args);
    // Preserve the native requested limit/cursor. Native source normalization owns paging metadata.
    try {
      const value = await bridge.request("mail", { operation, input: args });
      const fresh = await policyContext(identity);
      if (fresh.policyHash !== initial.policyHash || JSON.stringify(fresh.user) !== JSON.stringify(initial.user)) throw new MailConnectorError("MAIL_CONNECTION_CHANGED", 403);
      return value;
    } catch (error) { if (error instanceof PrivateReadBridgeError) throw new MailConnectorError(error.code, error.status); throw error; }
  }
  const mutating = ["draft", "flags", "move"].includes(operation);
  if (mutating) {
    if (!authorization) throw new MailConnectorError("MAIL_CHAT_AUTHORIZATION_REQUIRED", 403);
    assertInteractiveChatAuthorization(authorization, { ...authorization, installationId: identity.config.installationId, userId: identity.userId });
  }
  const ctx = await access(identity, mutating);
  const validated = normalizeMailOperationArgs(operation, args);
  const payload = operation === "draft" ? normalizeMailPayload(validated, ctx.user.email) : validated;
  if (!mutating) {
    const response = await transport(operation, ctx.credentials, payload);
    // A task may request 100 messages, but each provider page remains bounded.
    // Keep continuation intact and make the reduced page size explicit.
    if ((operation === "list" || operation === "search") && isMailRecord(args) && Number(args.limit) > 50 && isMailRecord(response)) {
      const priorInstruction = typeof response.coverageInstruction === "string" ? response.coverageInstruction : "";
      return { ...response, pageSize: { requested: args.limit, effective: 50, limited: true }, coverageInstruction: priorInstruction || "This page contains at most 50 messages. Continue nextCursor until null or the task budget is reached; this page alone does not establish coverage of a 100-message task." };
    }
    return response;
  }
  const id = hash({ operation, args: validated, userMessageId: authorization!.userMessageId, threadId: authorization!.threadId }).slice(0, 32);
  const name = `preview-${id}`;
  return ctx.store.locks.withLock(`mail-account:${identity.userId}`, async () => {
    assertInteractiveChatAuthorization(authorization, { ...authorization!, installationId: identity.config.installationId, userId: identity.userId });
    const fresh = await access(identity, true);
    const previous = await ctx.store.read<{ status: string; result?: unknown }>(identity.userId, name);
    if (previous?.status === "complete") return previous.result;
    if (previous) throw new MailConnectorError("MAIL_MUTATION_INDETERMINATE", 409);
    if (fresh.binding.version !== ctx.binding.version || fresh.policyHash !== ctx.policyHash) throw new MailConnectorError("MAIL_CONNECTION_CHANGED", 409);
    if (operation === "draft" && isMailRecord(payload) && payload.draft) {
      const dispatch = await ctx.store.read(identity.userId, draftDispatchName(payload.draft as MailDraftRef, fresh.user.email));
      if (dispatch) throw new MailConnectorError("MAIL_DRAFT_ALREADY_DISPATCHED", 409);
    }
    await ctx.store.put(identity.userId, name, { status: "dispatching", operation });
    try { const result = await transport(operation, fresh.credentials, payload); await ctx.store.put(identity.userId, name, { status: "complete", operation, result }); return result; }
    catch { await ctx.store.put(identity.userId, name, { status: "indeterminate", operation }); throw new MailConnectorError("MAIL_MUTATION_INDETERMINATE", 409); }
  });
}
function mailPreviewResult(preview: PreviewRecord) {
  const { payload } = preview;
  return { status: preview.status, ...(preview.status === "sent" ? { alreadySent: true, result: preview.result } : {}), previewId: preview.id, fingerprint: preview.fingerprint, from: payload.from, to: payload.to, cc: payload.cc, bcc: payload.bcc, subject: payload.subject, text: payload.text, attachments: payload.attachments.map(file => ({ filename: file.filename, contentType: file.contentType, size: Buffer.from(file.dataBase64, "base64").length })), expiresAt: new Date(preview.expiresAt).toISOString(), ...(payload.draft ? { draft: payload.draft } : {}), inReplyTo: payload.inReplyTo, references: payload.references, instruction: (preview.status === "sent" ? "Este correo ya fue aceptado por SMTP. No vuelvas a enviarlo ni crees otra copia para reintentarlo. La aceptación SMTP no acredita entrega al destinatario. " : "") + "Versión íntegra e inmutable del correo. Envía mediante la herramienta normal si el encargo humano lo autoriza; si sólo pide un borrador, consérvalo sin enviar. Respeta las instrucciones expresas del titular: antes de enviar en nombre de David, muéstrale remitente, To/Cc/Bcc, asunto, cuerpo completo y adjuntos, y obtén su aprobación exacta en la conversación. No solicites códigos ni botones de autorización. Si cambia algún dato, prepara una nueva versión." };
}
export async function prepareMailSend(authorization: InteractiveChatAuthorization, input: unknown, transport: MailTransport = nominaliaMailTransport) {
  assertInteractiveChatAuthorization(authorization, authorization);
  const config = await loadInstallationConfig();
  if (authorization.installationId !== config.installationId) throw new MailConnectorError("MAIL_IDENTITY_INVALID", 403);
  const ctx = await access({ config, userId: authorization.userId }, true);
  const requestedDraft = isMailRecord(input) && Object.keys(input).join() === "draft" ? normalizeDraftReference(input.draft) : null;
  return ctx.store.locks.withLock(`mail-account:${authorization.userId}`, async () => {
    assertInteractiveChatAuthorization(authorization, authorization);
    const fresh = await access({ config, userId: authorization.userId }, true);
    if (fresh.binding.version !== ctx.binding.version || fresh.policyHash !== ctx.policyHash) throw new MailConnectorError("MAIL_CONNECTION_CHANGED", 409);
    if (requestedDraft) {
      const dispatched = await ctx.store.read<{ status: string; preview?: PreviewRecord }>(authorization.userId, draftDispatchName(requestedDraft, fresh.user.email));
      if (dispatched) {
        if (dispatched.status === "sent" && dispatched.preview) return mailPreviewResult(dispatched.preview);
        throw new MailConnectorError("MAIL_SEND_INDETERMINATE", 409);
      }
    }
    let payload: MailPayload;
    if (requestedDraft) {
      const existing = await transport("draft_payload", fresh.credentials, { draft: requestedDraft });
      if (!isMailRecord(existing)) throw new MailConnectorError("MAIL_DRAFT_INVALID");
      payload = normalizeMailPayload({ ...existing, draft: requestedDraft }, ctx.user.email);
    } else {
      if (isMailRecord(input) && input.draft !== undefined) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID");
      payload = normalizeMailPayload(input, ctx.user.email);
    }
    // Identical task/content keeps its immutable SMTP Message-ID.
    const { messageId: _messageId, ...content } = payload;
    const id = hash({ content, threadId: authorization.threadId, userMessageId: authorization.userMessageId, requestHash: authorization.requestHash, bindingVersion: ctx.binding.version, policyHash: ctx.policyHash }).slice(0, 32);
    const previous = await ctx.store.read<PreviewRecord>(authorization.userId, `preview-${id}`);
    if (previous) {
      if (previous.id !== id || previous.threadId !== authorization.threadId || previous.fingerprint !== hash(previous.payload) || previous.expiresAt <= Date.now()) throw new MailConnectorError("MAIL_PREVIEW_STALE", 409);
      return mailPreviewResult(previous);
    }
    const preview: PreviewRecord = { id, threadId: authorization.threadId, userMessageId: authorization.userMessageId, requestHash: authorization.requestHash, payload, fingerprint: hash(payload), expiresAt: Date.now() + 30 * 60_000, bindingVersion: ctx.binding.version, policyHash: ctx.policyHash, status: "prepared" };
    await ctx.store.put(authorization.userId, `preview-${id}`, preview);
    return mailPreviewResult(preview);
  });
}
export async function sendPreparedMail(authorization: InteractiveChatAuthorization, previewId: string, fingerprint: string, transport: MailTransport = nominaliaMailTransport) {
  assertInteractiveChatAuthorization(authorization, authorization);
  if (!/^[a-f0-9]{32}$/.test(previewId) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new MailConnectorError("MAIL_ARGUMENTS_INVALID");
  const config = await loadInstallationConfig();
  if (authorization.installationId !== config.installationId) throw new MailConnectorError("MAIL_IDENTITY_INVALID", 403);
  const ctx = await access({ config, userId: authorization.userId }, true);
  return ctx.store.locks.withLock(`mail-account:${authorization.userId}`, () => ctx.store.locks.withLock(`mail-send:${authorization.userId}:${previewId}`, async () => {
    const preview = await ctx.store.read<PreviewRecord>(authorization.userId, `preview-${previewId}`);
    if (!preview || preview.threadId !== authorization.threadId || preview.fingerprint !== fingerprint || preview.fingerprint !== hash(preview.payload) || preview.expiresAt <= Date.now() || preview.bindingVersion !== ctx.binding.version || preview.policyHash !== ctx.policyHash || preview.payload.from !== ctx.user.email) throw new MailConnectorError("MAIL_PREVIEW_STALE", 409);
    if (preview.status === "sent") return preview.result;
    if (preview.status !== "prepared") throw new MailConnectorError("MAIL_SEND_INDETERMINATE", 409);
    assertInteractiveChatAuthorization(authorization, authorization);
    const fresh = await access({ config, userId: authorization.userId }, true);
    if (fresh.binding.version !== preview.bindingVersion || fresh.policyHash !== preview.policyHash) throw new MailConnectorError("MAIL_PREVIEW_STALE", 409);
    // A draft can be prepared in another conversation, but must never be
    // dispatched twice, including after a crash or ambiguous SMTP outcome.
    const draftDispatch = preview.payload.draft ? draftDispatchName(preview.payload.draft, ctx.user.email) : null;
    if (draftDispatch) {
      const prior = await ctx.store.read<{ status: string; result?: unknown }>(authorization.userId, draftDispatch);
      if (prior?.status === "sent") return prior.result;
      if (prior) throw new MailConnectorError("MAIL_SEND_INDETERMINATE", 409);
      await ctx.store.put(authorization.userId, draftDispatch, { status: "dispatching", preview });
    }
    preview.status = "dispatching";
    await ctx.store.put(authorization.userId, `preview-${previewId}`, preview);
    try {
      preview.result = await transport("send", fresh.credentials, preview.payload);
      if (!isMailRecord(preview.result) || preview.result.sent !== true) throw new MailConnectorError("MAIL_SEND_INDETERMINATE", 409);
      preview.status = "sent";
      if (draftDispatch) await ctx.store.put(authorization.userId, draftDispatch, { status: "sent", result: preview.result, preview });
      await ctx.store.put(authorization.userId, `preview-${previewId}`, preview); return preview.result;
    } catch { preview.status = "indeterminate"; await ctx.store.put(authorization.userId, `preview-${previewId}`, preview); throw new MailConnectorError("MAIL_SEND_INDETERMINATE", 409); }
  }));
}
