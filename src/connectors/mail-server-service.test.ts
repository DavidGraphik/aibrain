import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuthSession } from "@/auth/types";
import type { InstallationConfig } from "@/config/installation-schema";
import { createInteractiveChatAuthorization } from "@/runtime/interactive-chat-authorization";
import { FileMailStore } from "./mail-store";
import { connectMail, disconnectMail, executeMailOperation, mailAccessForIdentity, normalizeMailPayload, prepareMailSend, sendPreparedMail } from "./mail-server-service";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ config: vi.fn(), workspace: vi.fn(), catalog: vi.fn() }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: mocks.config }));
vi.mock("@/admin/policy-service", () => ({ workspacePolicyForIdentity: mocks.workspace }));
vi.mock("@/catalog/access-service", () => ({ catalogRuntimeEnforcer: mocks.catalog }));
const userId = "11111111-1111-4111-8111-111111111111", otherId = "22222222-2222-4222-8222-222222222222";
const key = Buffer.alloc(32, 9), password = "synthetic-private-mail-password";
let root: string, config: InstallationConfig, session: AuthSession;
const transport = vi.fn(async (operation: string) => operation === "send" ? { sent: true, messageId: "<stable@example.test>", sentCopySaved: true } : { verified: true });
beforeEach(async () => {
  vi.clearAllMocks(); root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mail-service-")));
  config = { installationId: "company-qa", publicUrl: "https://brain.example", connectors: { mail: { enabled: true, provider: "nominalia" } }, paths: { dataRoot: root, usersRoot: path.join(root, "users") } } as InstallationConfig;
  for (const [id, email] of [[userId, "test@example.test"], [otherId, "other@example.test"]]) {
    await mkdir(path.join(config.paths.usersRoot, id), { recursive: true, mode: 0o700 });
    await writeFile(path.join(config.paths.usersRoot, id, "user.json"), JSON.stringify({ schemaVersion: 1, userId: id, email, displayName: "Employee", enabled: true, workerId: "employee-one" }));
  }
  session = { provider: "local", user: { id: userId, email: "test@example.test", name: "Test" }, tenant: { id: config.installationId, name: "QA" }, expiresAt: new Date(Date.now() + 86400000).toISOString() };
  mocks.config.mockResolvedValue(config); mocks.workspace.mockResolvedValue({ roleId: "employee", policy: { capabilities: { consult: true, execute: true } } }); mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => true });
  vi.stubEnv("AIBRAIN_MAIL_ENCRYPTION_KEY", key.toString("base64"));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const payload = { to: ["client@example.test"], cc: ["copy@example.test"], bcc: ["private@example.test"], subject: "Subject", text: "Complete final body\nSecond line", attachments: [{ filename: "details.txt", contentType: "text/plain", dataBase64: Buffer.from("attachment contents").toString("base64") }] };
function authority(message: string, turnId = "turn-prepare", threadId = "thread", actor = userId) {
  return createInteractiveChatAuthorization({ session: { ...session, user: { ...session.user, id: actor } }, installationId: config.installationId, userId: actor, threadId, turnId, userMessageId: `message-${turnId}`, message, signal: new AbortController().signal, backgroundExecution: false, mode: "agent", localTurnId: "local-turn", permissions: { installationId: config.installationId, userId: actor, turnId: "local-turn", fingerprint: "a".repeat(64), rules: [{ ruleId: "tools.execute", action: "execute", effect: "allow", instruction: "Authorized execution", sourceScope: "installation", sourcePolicyVersion: 1, precedence: 0 }] } })!;
}
const sendRequest = "Envía este correo al cliente con el archivo adjunto.";
async function prepare() { await connectMail(session, password, transport); return prepareMailSend(authority(sendRequest), payload, transport); }
describe("Nominalia personal mailbox, conversational execution and exact message binding", () => {
  it("checks the provider before persisting, binds the session email, encrypts credentials with private permissions", async () => {
    await expect(connectMail({ ...session, user: { ...session.user, email: "foreign@example.test" } }, password, transport)).rejects.toMatchObject({ code: "MAIL_IDENTITY_INVALID" });
    expect(transport).not.toHaveBeenCalled();
    await connectMail(session, password, transport);
    expect(transport).toHaveBeenCalledWith("verify", { email: session.user.email, password }, {});
    const file = path.join(config.paths.usersRoot, userId, "connectors/mail/credentials.json"), raw = await readFile(file, "utf8");
    expect(raw).not.toContain(password); expect(raw).not.toContain(session.user.email); expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(mailAccessForIdentity(config, otherId)).rejects.toMatchObject({ code: "CONNECTOR_BINDING_NOT_FOUND" });
    await expect(connectMail({ ...session, tenant: { id: "foreign", name: "Foreign" } }, password, transport)).rejects.toMatchObject({ code: "MAIL_IDENTITY_INVALID" });
  });
  it("does not persist credentials after failed authentication", async () => {
    const failed = vi.fn(async () => { throw new Error(password); });
    await expect(connectMail(session, password, failed)).rejects.toThrow();
    expect(await new FileMailStore(config, key).read(userId, "credentials")).toBeNull();
  });
  it("denies foreign encrypted data and substituted symlinks", async () => {
    const store = new FileMailStore(config, key); await store.put(userId, "credentials", { email: session.user.email, password });
    const source = path.join(config.paths.usersRoot, userId, "connectors/mail/credentials.json"), target = path.join(config.paths.usersRoot, otherId, "connectors/mail/credentials.json");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, await readFile(source), { mode: 0o600 });
    await expect(store.read(otherId, "credentials")).rejects.toMatchObject({ code: "MAIL_STORAGE_INVALID" });
    await rm(target); await symlink(source, target);
    await expect(store.read(otherId, "credentials")).rejects.toMatchObject({ code: "MAIL_STORAGE_UNSAFE" });
  });
  it("requires current identity/catalog read and write rights and issued interactive authority before provider mutations", async () => {
    await connectMail(session, password, transport); transport.mockClear();
    await expect(executeMailOperation({ config, userId }, "draft", payload, transport)).rejects.toMatchObject({ code: "MAIL_CHAT_AUTHORIZATION_REQUIRED" });
    mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => false });
    await expect(executeMailOperation({ config, userId }, "draft", payload, transport, authority("Save a draft"))).rejects.toMatchObject({ code: "MAIL_ACCESS_DENIED" });
    mocks.catalog.mockResolvedValue({ allowsConnector: () => false, allowsConnectorWrite: () => false });
    await expect(executeMailOperation({ config, userId }, "list", {}, transport)).rejects.toMatchObject({ code: "MAIL_ACCESS_DENIED" }); expect(transport).not.toHaveBeenCalled();
  });
  it("rejects unbounded malformed references and headers before the provider is touched", async () => {
    await connectMail(session, password, transport); transport.mockClear();
    for (const args of [{ message: { folder: "INBOX", uid: "1" } }, { message: { folder: "INBOX", uid: "1", uidValidity: "2", foreign: true } }]) await expect(executeMailOperation({ config, userId }, "read", args, transport)).rejects.toThrow();
    for (const input of [{ ...payload, subject: "Injected\r\nBcc: foreign@example.test" }, { ...payload, to: ["Display <recipient@example.test>"] }, { ...payload, from: "foreign@example.test" }]) expect(() => normalizeMailPayload(input, session.user.email)).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("sends the frozen version in the same ordinary human task without a code and reuses preparation and dispatch results", async () => {
    const preview = await prepare();
    expect(preview).toMatchObject({ from: session.user.email, to: payload.to, cc: payload.cc, bcc: payload.bcc, subject: payload.subject, text: payload.text, attachments: [{ filename: "details.txt", contentType: "text/plain", size: 19 }] });
    expect(preview).not.toHaveProperty("confirmationCode");
    const authorized = authority(sendRequest);
    expect(await prepareMailSend(authorized, payload, transport)).toEqual(preview);
    await sendPreparedMail(authorized, preview.previewId, preview.fingerprint, transport);
    const repeated = await prepareMailSend(authorized, payload, transport);
    expect(repeated.previewId).toBe(preview.previewId); expect(repeated.fingerprint).toBe(preview.fingerprint);
    await sendPreparedMail(authorized, repeated.previewId, repeated.fingerprint, transport);
    expect(transport.mock.calls.filter(([op]) => op === "send")).toHaveLength(1);
    expect(transport).toHaveBeenCalledWith("send", { email: session.user.email, password }, expect.objectContaining({ ...payload, from: session.user.email, messageId: expect.stringMatching(/^<.+@example.test>$/) }));
  });
  it("can send a previously reviewed version after an ordinary conversational reply", async () => {
    const preview = await prepare();
    await expect(sendPreparedMail(authority("Sí, esta versión está bien; envíala.", "reply"), preview.previewId, preview.fingerprint, transport)).resolves.toMatchObject({ sent: true });
  });
  it("keeps issued identity, foreign user/thread and exact fingerprint boundaries without interpreting authorization phrases", async () => {
    const preview = await prepare(); transport.mockClear();
    const authorized = authority(sendRequest);
    await expect(sendPreparedMail({ ...authorized }, preview.previewId, preview.fingerprint, transport)).rejects.toThrow("INTERACTIVE_CHAT_REQUIRED");
    await expect(sendPreparedMail(undefined as never, preview.previewId, preview.fingerprint, transport)).rejects.toThrow("INTERACTIVE_CHAT_REQUIRED");
    await expect(sendPreparedMail(authority(sendRequest, "foreign-turn", "foreign-thread"), preview.previewId, preview.fingerprint, transport)).rejects.toMatchObject({ code: "MAIL_PREVIEW_STALE" });
    await connectMail({ ...session, user: { ...session.user, id: otherId, email: "other@example.test" } }, password, transport);
    await expect(sendPreparedMail(authority(sendRequest, "foreign-user", "thread", otherId), preview.previewId, preview.fingerprint, transport)).rejects.toMatchObject({ code: "MAIL_PREVIEW_STALE" });
    await expect(sendPreparedMail(authorized, preview.previewId, "0".repeat(64), transport)).rejects.toMatchObject({ code: "MAIL_PREVIEW_STALE" });
    expect(transport.mock.calls.filter(([op]) => op === "send")).toHaveLength(0);
  });
  it("preserves policy and connection version checks before sending a prepared message", async () => {
    const preview = await prepare(); transport.mockClear();
    mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => false });
    await expect(sendPreparedMail(authority(sendRequest), preview.previewId, preview.fingerprint, transport)).rejects.toMatchObject({ code: "MAIL_ACCESS_DENIED" });
    mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => true });
    await connectMail(session, password, transport);
    await expect(sendPreparedMail(authority(sendRequest), preview.previewId, preview.fingerprint, transport)).rejects.toMatchObject({ code: "MAIL_PREVIEW_STALE" });
    expect(transport.mock.calls.filter(([op]) => op === "send")).toHaveLength(0);
  });
  it("freezes a changed message separately and rejects expiry or stored content tampering", async () => {
    const preview = await prepare(), authorized = authority(sendRequest), store = new FileMailStore(config, key);
    const changed = await prepareMailSend(authorized, { ...payload, text: "A changed version" }, transport);
    expect(changed.previewId).not.toBe(preview.previewId); expect(changed.fingerprint).not.toBe(preview.fingerprint);
    const saved = await store.read<Record<string, unknown>>(userId, `preview-${preview.previewId}`);
    await store.put(userId, `preview-${preview.previewId}`, { ...saved, expiresAt: 0 });
    await expect(sendPreparedMail(authorized, preview.previewId, preview.fingerprint, transport)).rejects.toMatchObject({ code: "MAIL_PREVIEW_STALE" });
    await expect(prepareMailSend(authorized, payload, transport)).rejects.toMatchObject({ code: "MAIL_PREVIEW_STALE" });
    await store.put(userId, `preview-${preview.previewId}`, { ...saved, payload: { ...(saved!.payload as object), text: "Modified after preparation" } });
    await expect(sendPreparedMail(authorized, preview.previewId, preview.fingerprint, transport)).rejects.toMatchObject({ code: "MAIL_PREVIEW_STALE" });
    expect(transport.mock.calls.filter(([op]) => op === "send")).toHaveLength(0);
  });
  it("persists dispatch uncertainty before SMTP and never retries an ambiguous send", async () => {
    const preview = await prepare(), authorized = authority(sendRequest);
    const failed = vi.fn(async () => { throw new Error("SMTP connection lost after DATA"); });
    await expect(sendPreparedMail(authorized, preview.previewId, preview.fingerprint, failed)).rejects.toMatchObject({ code: "MAIL_SEND_INDETERMINATE" });
    const repeated = await prepareMailSend(authorized, payload, transport);
    expect(repeated.previewId).toBe(preview.previewId);
    await expect(sendPreparedMail(authorized, repeated.previewId, repeated.fingerprint, failed)).rejects.toMatchObject({ code: "MAIL_SEND_INDETERMINATE" });
    expect(failed).toHaveBeenCalledTimes(1);
    expect(await new FileMailStore(config, key).read(userId, `preview-${preview.previewId}`)).toMatchObject({ status: "indeterminate" });
  });
  it("revocation removes the personal secret and makes earlier previews unusable", async () => {
    const preview = await prepare(); await disconnectMail(session);
    expect(await new FileMailStore(config, key).read(userId, "credentials")).toBeNull();
    await expect(sendPreparedMail(authority(sendRequest), preview.previewId, preview.fingerprint, transport)).rejects.toMatchObject({ code: "MAIL_LOGIN_REQUIRED" });
  });
});

describe("server mailbox continuation, replies and existing draft dispatch", () => {
  const draft = { folder: "Drafts", uid: "19", uidValidity: "42", fingerprint: "f".repeat(64) };
  it("keeps global search global and passes continuation unchanged; explicit list remains INBOX", async () => {
    await connectMail(session, password, transport); transport.mockClear();
    await executeMailOperation({ config, userId }, "search", { query: { text: "colleague" }, cursor: "opaque-page" }, transport);
    expect(transport).toHaveBeenLastCalledWith("search", expect.anything(), { query: { text: "colleague" }, cursor: "opaque-page", limit: 20 });
    await executeMailOperation({ config, userId }, "list", {}, transport);
    expect(transport).toHaveBeenLastCalledWith("list", expect.anything(), { folder: "INBOX", limit: 20 });
  });
  it("routes reply source through the authenticated account and validates replyAll", async () => {
    await connectMail(session, password, transport); transport.mockClear();
    const message = { folder: "Sent", uid: "2", uidValidity: "3" };
    await executeMailOperation({ config, userId }, "reply", { message, replyAll: true, text: "Answer" }, transport);
    expect(transport).toHaveBeenCalledWith("reply", { email: session.user.email, password }, { message, replyAll: true, text: "Answer" });
    await expect(executeMailOperation({ config, userId }, "reply", { message, replyAll: "true" }, transport)).rejects.toThrow();
  });
  it("updates a referenced draft once per task and retains its fingerprint", async () => {
    await connectMail(session, password, transport); transport.mockClear();
    const authorized = authority("Update this draft");
    await executeMailOperation({ config, userId }, "draft", { ...payload, draft }, transport, authorized);
    await executeMailOperation({ config, userId }, "draft", { ...payload, draft }, transport, authorized);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith("draft", expect.anything(), expect.objectContaining({ draft, ...payload, from: session.user.email }));
    await expect(executeMailOperation({ config, userId }, "draft", { ...payload, draft: { ...draft, fingerprint: "wrong" } }, transport, authorized)).rejects.toThrow();
  });
  it("freezes the actual stored draft, including Bcc, attachments and thread, without sending on prepare", async () => {
    await connectMail(session, password, transport);
    const frozen = { ...payload, inReplyTo: "<parent@example.test>", references: "<root@example.test> <parent@example.test>" };
    const provider = vi.fn(async (op: string) => op === "draft_payload" ? frozen : { sent: true, sentCopySaved: true });
    const auth = authority("Prepare this exact saved draft");
    const preview = await prepareMailSend(auth, { draft }, provider);
    expect(preview).toMatchObject({ draft, bcc: payload.bcc, inReplyTo: frozen.inReplyTo, references: frozen.references });
    expect(provider.mock.calls.map(([op]) => op)).toEqual(["draft_payload"]);
    await sendPreparedMail(auth, preview.previewId, preview.fingerprint, provider);
    expect(provider).toHaveBeenLastCalledWith("send", expect.anything(), expect.objectContaining({ ...frozen, draft }));
    await expect(prepareMailSend(auth, { ...payload, draft }, provider)).rejects.toMatchObject({ code: "MAIL_ARGUMENTS_INVALID" });
  });
  it("does not resend one existing draft from another task or thread after accepted or ambiguous SMTP", async () => {
    await connectMail(session, password, transport);
    let draftExists = true;
    const provider = vi.fn(async (op: string) => {
      if (op === "draft_payload") { if (!draftExists) throw new Error("MESSAGE_NOT_FOUND"); return payload; }
      draftExists = false; return { sent: true };
    });
    const first = authority("Send saved draft", "one", "thread-one");
    const preview = await prepareMailSend(first, { draft }, provider);
    await sendPreparedMail(first, preview.previewId, preview.fingerprint, provider);
    const second = authority("Send saved draft", "two", "thread-two");
    const repeated = await prepareMailSend(second, { draft }, provider);
    expect(repeated).toMatchObject({ alreadySent: true, status: "sent" });
    expect(provider.mock.calls.filter(([op]) => op === "send")).toHaveLength(1);
    const otherDraft = { ...draft, uid: "20" };
    const uncertain = vi.fn(async (op: string) => { if (op === "draft_payload") return payload; throw new Error("SMTP ambiguous"); });
    const a = await prepareMailSend(first, { draft: otherDraft }, uncertain);
    await expect(sendPreparedMail(first, a.previewId, a.fingerprint, uncertain)).rejects.toMatchObject({ code: "MAIL_SEND_INDETERMINATE" });
    await expect(prepareMailSend(second, { draft: otherDraft }, uncertain)).rejects.toMatchObject({ code: "MAIL_SEND_INDETERMINATE" });
    await connectMail(session, password, transport);
    await expect(prepareMailSend(second, { draft: otherDraft }, uncertain)).rejects.toMatchObject({ code: "MAIL_SEND_INDETERMINATE" });
    await expect(executeMailOperation({ config, userId }, "draft", { ...payload, draft: otherDraft }, uncertain, second)).rejects.toMatchObject({ code: "MAIL_DRAFT_ALREADY_DISPATCHED" });
    expect(uncertain.mock.calls.filter(([op]) => op === "send")).toHaveLength(1);
  });
});


it("caps a 100-message task to bounded pages without losing continuation or claiming full coverage", async () => {
  await connectMail(session, password, transport); transport.mockClear();
  for (const operation of ["list", "search"] as const) {
    const paged = vi.fn(async () => ({ messages: Array.from({ length: 50 }, (_, index) => ({ uid: String(index + 1) })), nextCursor: "next-synthetic-page", complete: false }));
    const query = operation === "search" ? { query: { since: "2026-11-02" } } : {};
    const response = await executeMailOperation({ config, userId }, operation, { folder: "INBOX", limit: 100, ...query }, paged);
    expect(paged).toHaveBeenCalledWith(operation, expect.anything(), { folder: "INBOX", limit: 50, ...query });
    expect(response).toMatchObject({ nextCursor: "next-synthetic-page", complete: false, pageSize: { requested: 100, effective: 50, limited: true } });
    await executeMailOperation({ config, userId }, operation, { folder: "INBOX", limit: 100, cursor: "next-synthetic-page", ...query }, paged);
    expect(paged).toHaveBeenLastCalledWith(operation, expect.anything(), { folder: "INBOX", limit: 50, cursor: "next-synthetic-page", ...query });
    for (const invalid of [0, -1, 1.5, 101, "100"]) {
      await expect(executeMailOperation({ config, userId }, operation, { limit: invalid, ...query }, paged)).rejects.toMatchObject({ code: "MAIL_ARGUMENTS_INVALID" });
    }
    expect(paged).toHaveBeenCalledTimes(2);
  }
});

it("preserves the provider timeout instruction when a large requested page is capped", async () => {
  await connectMail(session, password, transport);
  const interrupted = vi.fn(async () => ({ messages: [], nextCursor: "signed-next-page", coverage: {
    complete: false, interrupted: { reason: "provider_search_timeout", folder: "INBOX", retryable: true },
  }, coverageInstruction: "Do not automatically retry in a loop." }));
  const result = await executeMailOperation({ config, userId }, "search", { folder: "INBOX", limit: 100, query: { text: "ref" } }, interrupted);
  expect(result).toMatchObject({ nextCursor: "signed-next-page", pageSize: { effective: 50, limited: true },
    coverage: { complete: false, interrupted: { reason: "provider_search_timeout" } },
    coverageInstruction: "Do not automatically retry in a loop." });
  expect(interrupted).toHaveBeenCalledTimes(1);
});
