import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type { InstallationConfig } from "@/config/installation-schema";
import type { AuthSession } from "@/auth/types";
import { createInteractiveChatAuthorization } from "@/runtime/interactive-chat-authorization";
import { configureOutlookArchiveForIdentity, createOutlookDesktopEnrollment, enrollOutlookDesktopAgent, executeOutlookDesktopOperation as executeOperation, handleOutlookDesktopAgentRequest, pollOutlookDesktopAgent, readOutlookDesktopOperation as readOperation, readOutlookDesktopStatusForIdentity, revokeOutlookDesktopAgent, revokeOutlookDesktopIdentity, submitOutlookArchiveBatch, submitOutlookDesktopAgentResult } from "./outlook-desktop-service";
import { FileOutlookDesktopStore } from "./outlook-desktop-store";
import type { OutlookArchiveBatch } from "./outlook-archive-store";
import { normalizeOutlookDesktopOperationArgs } from "./outlook-desktop-contracts";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ config: vi.fn(), workspace: vi.fn(), catalog: vi.fn(), freeBytes: 30 * 1024 ** 3 }));
// Broker fixtures use a deterministic synthetic filesystem capacity. The real
// production 15GiB guard remains active and is exercised below and in store tests.
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  statfs: async () => ({ bavail: Math.floor(mocks.freeBytes / 4096), bsize: 4096 }),
}));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: mocks.config }));
vi.mock("@/admin/policy-service", () => ({ workspacePolicyForIdentity: mocks.workspace }));
vi.mock("@/catalog/access-service", () => ({ catalogRuntimeEnforcer: mocks.catalog }));
const executeOutlookDesktopOperation: typeof executeOperation = (identity, op, args, auth) => executeOperation(identity, op, args, auth, { waitMs: 0 });
const readOutlookDesktopOperation: typeof readOperation = (identity, id) => readOperation(identity, id, { waitMs: 0 });
const users = Array.from({ length: 6 }, (_, i) => `${i + 1}`.repeat(8) + "-1111-4111-8111-" + `${i + 1}`.repeat(12));
let root: string, config: InstallationConfig;
const machine = (n = 0) => ({ sid: `S-1-5-21-100-200-${n + 1000}`, computer: `PC-${n}`, email: `employee${n}@example.test`, storeIds: [`STORE-${n}`], version: "1.0.0" });
const identity = (n = 0) => ({ config, userId: users[n] });
const poll = (n = 0) => ({ sid: machine(n).sid, computer: machine(n).computer, version: "1.0.0", outlookOpen: true, availableStoreIds: machine(n).storeIds });
const args = (n = 0) => ({ storeId: machine(n).storeIds[0], entryId: "DRAFT-ENTRY", expectedFingerprint: "f".repeat(64) });
function authority(n = 0, messageId = "message-1") {
  const session = { provider: "local", user: { id: users[n], email: machine(n).email, name: "Employee" }, tenant: { id: config.installationId, name: "G03" }, expiresAt: new Date(Date.now() + 600000).toISOString() } as AuthSession;
  return createInteractiveChatAuthorization({ session, installationId: config.installationId, userId: users[n], threadId: "thread-1", turnId: "turn-1", userMessageId: messageId, message: "Send exact reviewed draft", signal: new AbortController().signal, backgroundExecution: false, mode: "agent", localTurnId: "local", permissions: { installationId: config.installationId, userId: users[n], turnId: "local", fingerprint: "a".repeat(64), rules: [{ ruleId: "tools.execute", action: "execute", effect: "allow", instruction: "execute", sourceScope: "installation", sourcePolicyVersion: 1, precedence: 0 }] } })!;
}
async function pair(n = 0) { const enrollment = await createOutlookDesktopEnrollment(identity(n), machine(n), "https://brain.example.test"); const device = await enrollOutlookDesktopAgent(config, enrollment.pairingCode, machine(n)); await pollOutlookDesktopAgent(config, device.token, poll(n)); return device; }
const archiveBody = "Historical confidential project correspondence from 2009";
const archiveBytes = Buffer.from("exact original attachment bytes, not a text extraction");
const archiveHash = createHash("sha256").update(archiveBytes).digest("hex");
function archiveBatch(n = 0): OutlookArchiveBatch {
  const storeId = machine(n).storeIds[0], version = "a".repeat(64);
  return { schema: 1, epoch: users[n], sequence: 1, checkpoint: { phase: "caught_up", errors: [], scannedItems: 1, expectedItems: 1 }, records: [
    { kind: "folder", storeId, id: "ROOT", parentId: null, name: "Historical archive", itemType: 0 },
    { kind: "item", storeId, id: "OLD-MAIL", folderId: "ROOT", version, lastModified: "2009-01-01T12:00:00Z", data: { itemClass: 43, subject: "Historical project", body: { total: archiveBody.length }, attachments: [{ index: 1, size: archiveBytes.length, filename: "drawing.png" }] } },
    { kind: "text", storeId, itemId: "OLD-MAIL", version, offset: 0, totalChars: archiveBody.length, text: archiveBody },
    { kind: "attachment", storeId, itemId: "OLD-MAIL", version, index: 1, offset: 0, totalBytes: archiveBytes.length, sha256: archiveHash, filename: "drawing.png", dataBase64: archiveBytes.toString("base64") },
  ] };
}
async function replicated(n = 0) { const device = await pair(n); await configureOutlookArchiveForIdentity(identity(n), 10 * 1024 ** 2); await submitOutlookArchiveBatch(config, device.token, archiveBatch(n)); return device; }
beforeEach(async () => {
  mocks.freeBytes = 30 * 1024 ** 3;
  vi.clearAllMocks(); root = await realpath(await mkdtemp(path.join(os.tmpdir(), "outlook-broker-")));
  config = { installationId: "g03-production", publicUrl: "https://brain.example.test", connectors: { mail: { enabled: true, provider: "nominalia" } }, paths: { dataRoot: root, usersRoot: path.join(root, "users") } } as InstallationConfig;
  for (let n = 0; n < users.length; n++) { await mkdir(path.join(config.paths.usersRoot, users[n]), { recursive: true, mode: 0o700 }); await writeFile(path.join(config.paths.usersRoot, users[n], "user.json"), JSON.stringify({ schemaVersion: 1, userId: users[n], email: machine(n).email, displayName: "Employee", enabled: true, workerId: `employee-${n}` })); }
  mocks.config.mockResolvedValue(config); mocks.workspace.mockResolvedValue({ roleId: "employee", policy: { capabilities: { consult: true, execute: true } } }); mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => true }); vi.stubEnv("AIBRAIN_MAIL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
describe("G03 desktop broker", () => {
  it("keeps the physical reserve enforced through the trusted quota operator", async () => {
    await pair(); mocks.freeBytes = 15 * 1024 ** 3;
    await expect(configureOutlookArchiveForIdentity(identity(), 1024 ** 2)).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_DISK_RESERVE", status: 507 });
    expect((await readOutlookDesktopStatusForIdentity(identity())).archive).toMatchObject({ configured: false, quotaBytes: 0 });
  });
  it.each(["outlook_closed", "offline"] as const)("reads copied historical mail and original attachments with %s, without queuing a desktop job", async status => {
    const device = await replicated();
    if (status === "outlook_closed") await pollOutlookDesktopAgent(config, device.token, { ...poll(), outlookOpen: false, availableStoreIds: [] });
    else await new FileOutlookDesktopStore(config).transaction(users[0], async state => { state.device!.lastSeenAt = Date.now() - 31_000; });
    expect(await readOutlookDesktopStatusForIdentity(identity())).toMatchObject({ connected: true, status, archive: { availableWithComputerOff: true, currentStateVerified: false, localChangesAfterLastSyncUnavailable: true, coverage: { phase: "caught_up" } } });
    const search = await executeOutlookDesktopOperation(identity(), "items.search", { storeId: "STORE-0", kind: "mail", query: "confidential" });
    expect(search).toMatchObject({ status: "succeeded", args: { storeId: "STORE-0", kind: "mail", query: "confidential" }, result: { items: [{ entryId: "OLD-MAIL" }], complete: true, archiveCoverage: { source: "encrypted-outlook-read-replica" } } });
    expect(await executeOutlookDesktopOperation(identity(), "items.read", { storeId: "STORE-0", entryId: "OLD-MAIL", bodyOffset: 11, bodyLimit: 12 })).toMatchObject({ status: "succeeded", result: { body: { text: archiveBody.slice(11, 23), offset: 11, nextOffset: 23 }, sourceChanged: false } });
    const attachmentArgs = { storeId: "STORE-0", entryId: "OLD-MAIL", index: 1, offset: 4, length: 12 };
    const attachment = await executeOutlookDesktopOperation(identity(), "attachments.read", attachmentArgs);
    expect(attachment).toMatchObject({ operation: "attachments.read", args: attachmentArgs, status: "succeeded", result: { filename: "drawing.png", dataBase64: archiveBytes.subarray(4, 16).toString("base64"), totalSize: archiveBytes.length, offset: 4, nextOffset: 16, sha256: archiveHash } });
    expect((await new FileOutlookDesktopStore(config).read(users[0])).jobs).toHaveLength(0);
  });
  it("binds archive upload and offline reads to the canonical user, currently paired device and approved stores", async () => {
    const first = await replicated(), second = await pair(1);
    await configureOutlookArchiveForIdentity(identity(1), 10 * 1024 ** 2);
    await expect(submitOutlookArchiveBatch(config, second.token, archiveBatch())).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_STORE_DENIED" });
    await expect(submitOutlookArchiveBatch(config, first.token.replace(users[0], users[1]), archiveBatch())).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_AUTH_INVALID" });
    await expect(submitOutlookArchiveBatch(config, first.token, { ...archiveBatch(), userId: users[1] })).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_ARGUMENTS_INVALID" });
    await pollOutlookDesktopAgent(config, first.token, { ...poll(), outlookOpen: false, availableStoreIds: [] });
    await expect(executeOutlookDesktopOperation(identity(), "items.read", { storeId: "STORE-1", entryId: "OLD-MAIL" })).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_STORE_DENIED" });
    await revokeOutlookDesktopAgent(config, first.token);
    await expect(submitOutlookArchiveBatch(config, first.token, archiveBatch())).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_NOT_PAIRED" });
    await expect(executeOutlookDesktopOperation(identity(), "items.read", { storeId: "STORE-0", entryId: "OLD-MAIL" })).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_NOT_PAIRED" });
    expect((await readOutlookDesktopStatusForIdentity(identity(1))).archive).toMatchObject({ replicatedItems: 0, availableWithComputerOff: false });
  });
  it("reads the approved PST copy when Outlook is online but that store is unloaded, while writes still wait for the live store", async () => {
    const device = await replicated();
    await pollOutlookDesktopAgent(config, device.token, { ...poll(), availableStoreIds: [] });
    expect(await readOutlookDesktopStatusForIdentity(identity())).toMatchObject({ status: "ready", availableStoreIds: [], archive: { availableWithComputerOff: true } });
    expect(await executeOutlookDesktopOperation(identity(), "items.read", { storeId: "STORE-0", entryId: "OLD-MAIL" })).toMatchObject({ status: "succeeded", result: { body: { text: archiveBody }, archiveCoverage: { source: "encrypted-outlook-read-replica", currentStateVerified: false } } });
    const attachmentArgs = { storeId: "STORE-0", entryId: "OLD-MAIL", index: 1, offset: 0, length: 8 };
    expect(await executeOutlookDesktopOperation(identity(), "attachments.read", attachmentArgs)).toMatchObject({ status: "succeeded", args: attachmentArgs, result: { dataBase64: archiveBytes.subarray(0, 8).toString("base64"), sha256: archiveHash } });
    expect((await new FileOutlookDesktopStore(config).read(users[0])).jobs).toHaveLength(0);
    await expect(executeOutlookDesktopOperation(identity(), "items.read", { storeId: "STORE-1", entryId: "OLD-MAIL" })).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_STORE_DENIED" });
    const queued = await executeOutlookDesktopOperation(identity(), "mail.send", args(), authority());
    expect(queued).toMatchObject({ operation: "mail.send", status: "pending" }); expect(queued).not.toHaveProperty("result");
    expect((await pollOutlookDesktopAgent(config, device.token, { ...poll(), availableStoreIds: [] })).job).toBeNull();
    expect((await pollOutlookDesktopAgent(config, device.token, poll())).job).toMatchObject({ operationId: queued.operationId, operation: "mail.send" });
  });
  it("returns copy-not-ready immediately for an unloaded approved store before it has been replicated", async () => {
    const device = await pair();
    await pollOutlookDesktopAgent(config, device.token, { ...poll(), availableStoreIds: [] });
    await expect(executeOutlookDesktopOperation(identity(), "items.search", { storeId: "STORE-0", query: "historical" })).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_NOT_READY" });
    expect((await new FileOutlookDesktopStore(config).read(users[0])).jobs).toHaveLength(0);
  });
  it("rechecks current mail/consult policy for authenticated archive uploads and copied offline reads", async () => {
    const device = await replicated();
    await pollOutlookDesktopAgent(config, device.token, { ...poll(), outlookOpen: false, availableStoreIds: [] });
    for (const deny of ["catalog", "consult"] as const) {
      mocks.catalog.mockResolvedValue({ allowsConnector: () => deny !== "catalog", allowsConnectorWrite: () => false });
      mocks.workspace.mockResolvedValue({ roleId: "employee", policy: { capabilities: { consult: deny !== "consult", execute: true } } });
      await expect(submitOutlookArchiveBatch(config, device.token, archiveBatch())).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_ACCESS_DENIED" });
      await expect(executeOutlookDesktopOperation(identity(), "items.read", { storeId: "STORE-0", entryId: "OLD-MAIL" })).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_ACCESS_DENIED" });
      await expect(readOutlookDesktopStatusForIdentity(identity())).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_ACCESS_DENIED" });
    }
    mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => false });
    mocks.workspace.mockResolvedValue({ roleId: "employee", policy: { capabilities: { consult: true, execute: false } } });
    expect(await executeOutlookDesktopOperation(identity(), "items.read", { storeId: "STORE-0", entryId: "OLD-MAIL" })).toMatchObject({ status: "succeeded", result: { body: { text: archiveBody } } });
    await expect(executeOutlookDesktopOperation(identity(), "mail.send", args(), authority())).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_ACCESS_DENIED" });
  });
  it("authenticates the archive HTTP route, accepts the exact upload and replay, and denies the old device after replacement", async () => {
    const device = await pair(); await configureOutlookArchiveForIdentity(identity(), 10 * 1024 ** 2);
    const request = (token: string, value: unknown = archiveBatch()) => handleOutlookDesktopAgentRequest("archive", new Request("https://brain.example.test/api", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(value) }));
    const invalid = await request(device.token.replace(users[0], users[1])); expect(invalid.status).toBe(401);
    const first = await request(device.token); expect(first.status).toBe(200); expect(await first.json()).toMatchObject({ accepted: true, duplicate: false, archiveCoverage: { replicatedItems: 1 } });
    const retry = await request(device.token); expect(retry.status).toBe(200); expect(await retry.json()).toMatchObject({ accepted: true, duplicate: true });
    await pair();
    const replaced = await request(device.token); expect(replaced.status).toBe(401); expect(await replaced.json()).toEqual({ code: "OUTLOOK_DESKTOP_AUTH_INVALID" });
  });
  it("cannot enable an unreviewed copy or choose capacity through an authenticated agent request", async () => {
    const device = await pair();
    await expect(submitOutlookArchiveBatch(config, device.token, archiveBatch())).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_CAPACITY_REVIEW_REQUIRED" });
    const response = await handleOutlookDesktopAgentRequest("archive", new Request("https://brain.example.test/api", { method: "POST", headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...archiveBatch(), quotaBytes: 10 * 1024 ** 2 }) }));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ code: "OUTLOOK_ARCHIVE_ARGUMENTS_INVALID" });
    expect((await pollOutlookDesktopAgent(config, device.token, poll())).archive).toMatchObject({ configured: false, availableWithComputerOff: false, replicatedItems: 0 });
  });
  it("keeps writes in the live durable queue while the copied mailbox is available and never reports a snapshot as a send", async () => {
    const device = await replicated();
    await pollOutlookDesktopAgent(config, device.token, { ...poll(), outlookOpen: false, availableStoreIds: [] });
    await expect(executeOutlookDesktopOperation(identity(), "mail.send", args())).rejects.toThrow("INTERACTIVE_CHAT_REQUIRED");
    const queued = await executeOutlookDesktopOperation(identity(), "mail.send", args(), authority());
    expect(queued).toMatchObject({ operation: "mail.send", status: "pending" }); expect(queued).not.toHaveProperty("result");
    expect((await pollOutlookDesktopAgent(config, device.token, { ...poll(), outlookOpen: false, availableStoreIds: [] })).job).toBeNull();
    expect((await new FileOutlookDesktopStore(config).read(users[0])).jobs).toEqual([expect.objectContaining({ operation: "mail.send", status: "pending" })]);
    const leased = (await pollOutlookDesktopAgent(config, device.token, poll())).job;
    expect(leased).toMatchObject({ operationId: queued.operationId, operation: "mail.send", args: args() });
  });
  it("returns explicit not-ready coverage with an offline PC before the initial copy, instead of an empty mailbox", async () => {
    const device = await pair();
    await pollOutlookDesktopAgent(config, device.token, { ...poll(), outlookOpen: false, availableStoreIds: [] });
    await expect(executeOutlookDesktopOperation(identity(), "items.search", { storeId: "STORE-0", query: "historical" })).rejects.toMatchObject({ code: "OUTLOOK_ARCHIVE_NOT_READY" });
    expect((await new FileOutlookDesktopStore(config).read(users[0])).jobs).toHaveLength(0);
  });
  it("pairs six canonical users, isolates queues, stores, credentials and returned results", async () => {
    const devices = await Promise.all(users.map((_, n) => pair(n)));
    const jobs = await Promise.all(users.map((_, n) => executeOutlookDesktopOperation(identity(n), "items.read", { storeId: machine(n).storeIds[0], entryId: `entry-${n}` })));
    for (let n = 0; n < users.length; n++) {
      const next = await pollOutlookDesktopAgent(config, devices[n].token, poll(n)); expect(next.job?.operationId).toBe(jobs[n].operationId);
      await expect(readOutlookDesktopOperation(identity((n + 1) % 6), jobs[n].operationId)).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_OPERATION_NOT_FOUND" });
      await expect(executeOutlookDesktopOperation(identity(n), "items.read", { storeId: machine((n + 1) % 6).storeIds[0], entryId: "foreign" })).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_STORE_DENIED" });
      const file = path.join(config.paths.usersRoot, users[n], "connectors/outlook-desktop/broker.json"); const raw = await readFile(file, "utf8"); expect(raw).not.toContain(devices[n].token); expect(raw).not.toContain(machine(n).email); expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    const substituted = devices[0].token.replace(users[0], users[1]); await expect(pollOutlookDesktopAgent(config, substituted, poll(1))).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_AUTH_INVALID" });
  });
  it("consumes one-time enrollment atomically and only replaces an old device after successful matching enrollment", async () => {
    const old = await pair(); const code = await createOutlookDesktopEnrollment(identity(), machine(), "https://brain.example.test");
    await expect(enrollOutlookDesktopAgent(config, code.pairingCode, { ...machine(), sid: machine(1).sid })).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_PAIRING_INVALID" });
    await expect(pollOutlookDesktopAgent(config, old.token, poll())).resolves.toMatchObject({ job: null });
    const results = await Promise.allSettled([enrollOutlookDesktopAgent(config, code.pairingCode, machine()), enrollOutlookDesktopAgent(config, code.pairingCode, machine())]); expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await expect(pollOutlookDesktopAgent(config, old.token, poll())).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_AUTH_INVALID" });
    const expired = await createOutlookDesktopEnrollment(identity(), machine(), "https://brain.example.test"); const store = new FileOutlookDesktopStore(config); await store.transaction(users[0], async state => { state.pairing!.expiresAt = Date.now() - 1; });
    await expect(enrollOutlookDesktopAgent(config, expired.pairingCode, machine())).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_PAIRING_INVALID" });
  });
  it("requires actual interactive authority, current consult/write policy, canonical identity, and G03 installation", async () => {
    await pair(); await expect(executeOutlookDesktopOperation(identity(), "mail.send", args())).rejects.toThrow("INTERACTIVE_CHAT_REQUIRED");
    const auth = authority(); await expect(executeOutlookDesktopOperation(identity(), "mail.send", args(), { ...auth })).rejects.toThrow("INTERACTIVE_CHAT_REQUIRED");
    mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => false }); await expect(executeOutlookDesktopOperation(identity(), "mail.send", args(), auth)).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_ACCESS_DENIED" });
    await expect(readOutlookDesktopStatusForIdentity({ ...identity(), config: { ...config, installationId: "company-qa" } })).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_NOT_ENABLED" });
    mocks.catalog.mockResolvedValue({ allowsConnector: () => false, allowsConnectorWrite: () => false }); await expect(readOutlookDesktopStatusForIdentity(identity())).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_ACCESS_DENIED" });
  });
  it("serializes competing polls/results and durably prevents repeats of leased or uncertain writes", async () => {
    const device = await pair(), auth = authority();
    const calls = await Promise.all([executeOutlookDesktopOperation(identity(), "mail.send", args(), auth), executeOutlookDesktopOperation(identity(), "mail.send", { expectedFingerprint: args().expectedFingerprint, entryId: args().entryId, storeId: args().storeId }, auth)]); expect(calls[0].operationId).toBe(calls[1].operationId);
    const polls = await Promise.all([pollOutlookDesktopAgent(config, device.token, poll()), pollOutlookDesktopAgent(config, device.token, poll())]); const leased = polls.find(r => r.job)!.job!; expect(polls.filter(r => r.job)).toHaveLength(1);
    await expect(submitOutlookDesktopAgentResult(config, device.token, { ...leased, outcome: "succeeded", result: { queued: true } })).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_ARGUMENTS_INVALID" });
    const result = { operationId: leased.operationId, leaseId: leased.leaseId, fingerprint: leased.fingerprint, outcome: "unknown", error: "ambiguous" };
    await submitOutlookDesktopAgentResult(config, device.token, result); await expect(submitOutlookDesktopAgentResult(config, device.token, result)).resolves.toMatchObject({ duplicate: true });
    await expect(submitOutlookDesktopAgentResult(config, device.token, { ...result, outcome: "succeeded", result: { queued: true } })).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_RESULT_REPLAY" });
    expect(await executeOutlookDesktopOperation(identity(), "mail.send", args(), auth)).toMatchObject({ operationId: leased.operationId, status: "unknown" }); expect((await pollOutlookDesktopAgent(config, device.token, poll())).job).toBeNull();
  });
  it("marks expired leases unknown, never reissues status reads, revokes devices and fails queued operations", async () => {
    const device = await pair(); const job = await executeOutlookDesktopOperation(identity(), "mail.send", args(), authority()); await pollOutlookDesktopAgent(config, device.token, poll());
    const store = new FileOutlookDesktopStore(config); await store.transaction(users[0], async state => { state.jobs[0].deadline = Date.now() - 1; });
    expect(await readOutlookDesktopOperation(identity(), job.operationId)).toMatchObject({ status: "unknown" }); expect((await pollOutlookDesktopAgent(config, device.token, poll())).job).toBeNull();
    await revokeOutlookDesktopAgent(config, device.token); await expect(pollOutlookDesktopAgent(config, device.token, poll())).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_NOT_PAIRED" });
    await pair(); const queued = await executeOutlookDesktopOperation(identity(), "items.read", { storeId: "STORE-0", entryId: "one" }); await revokeOutlookDesktopIdentity(identity()); expect(await readOutlookDesktopOperation(identity(), queued.operationId)).toMatchObject({ status: "failed" });
  });
  it("checks policy again before leasing and checks SID/computer plus actually loaded stores", async () => {
    const d = await pair(); await executeOutlookDesktopOperation(identity(), "mail.send", args(), authority());
    await expect(pollOutlookDesktopAgent(config, d.token, { ...poll(), sid: machine(1).sid })).rejects.toMatchObject({ code: "OUTLOOK_DESKTOP_MACHINE_MISMATCH" });
    expect((await pollOutlookDesktopAgent(config, d.token, { ...poll(), availableStoreIds: [] })).job).toBeNull();
    mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => false }); expect((await pollOutlookDesktopAgent(config, d.token, poll())).job).toBeNull();
    expect(await readOutlookDesktopStatusForIdentity(identity())).toMatchObject({ pendingOperations: 0 });
  });
  it("rejects hostile arguments, unsafe attachments/paths, substituted private files and oversized HTTP bodies", async () => {
    for (const [op, input] of [["items.read", { storeId: "STORE-0", entryId: "id", command: "execute" }], ["mail.draft", { storeId: "STORE-0", to: [], subject: "x", body: "y", attachments: [{ filename: "../evil", contentType: "text/plain", dataBase64: "" }] }], ["calendar.mutate", { action: "create", storeId: "STORE-0", fields: { subject: "x" }, recurrence: { type: "daily", interval: 1, startDate: "2026-01-01" } }]] as const) expect(() => normalizeOutlookDesktopOperationArgs(op, input)).toThrow();
    await pair(); const file = path.join(config.paths.usersRoot, users[0], "connectors/outlook-desktop/broker.json"), foreign = path.join(root, "foreign"); await writeFile(foreign, "{}"); await rm(file); await symlink(foreign, file); await expect(readOutlookDesktopStatusForIdentity(identity())).rejects.toThrow();
    const response = await handleOutlookDesktopAgentRequest("enroll", new Request("https://brain.example.test/api", { method: "POST", headers: { authorization: `Pairing ${users[0]}.${"a".repeat(43)}`, "content-type": "application/json", "content-length": "999999999" }, body: "{}" })); expect(response.status).toBe(413);
  });
  it("acknowledges a late exact report and preserves duplicate hashes after payload compaction", async () => {
    const d = await pair(); const queued = await executeOutlookDesktopOperation(identity(), "mail.send", args(), authority()); const leased = (await pollOutlookDesktopAgent(config, d.token, poll())).job!;
    const store = new FileOutlookDesktopStore(config); await store.transaction(users[0], async state => { state.jobs[0].deadline = Date.now() - 1; });
    const report = { operationId: leased.operationId, leaseId: leased.leaseId, fingerprint: leased.fingerprint, outcome: "succeeded", result: { queued: true } };
    await expect(submitOutlookDesktopAgentResult(config, d.token, report)).resolves.toMatchObject({ accepted: true, late: true });
    expect(await readOutlookDesktopOperation(identity(), queued.operationId)).toMatchObject({ status: "unknown", lateObserved: { outcome: "succeeded", result: { queued: true } } });
    await store.transaction(users[0], async state => { state.jobs[0].terminalAt = Date.now() - 60 * 60_000; });
    expect(await readOutlookDesktopOperation(identity(), queued.operationId)).toMatchObject({ status: "unknown", resultExpired: true });
    await expect(submitOutlookDesktopAgentResult(config, d.token, report)).resolves.toMatchObject({ accepted: true, duplicate: true });
    expect(await executeOutlookDesktopOperation(identity(), "mail.send", args(), authority())).toMatchObject({ operationId: queued.operationId, status: "unknown" });
  });
  it("returns a typical agent result during bounded execution wait without holding the queue lock", async () => {
    const d = await pair();
    const pending = executeOperation(identity(), "items.read", { storeId: "STORE-0", entryId: "waiting" }, undefined, { waitMs: 2000 });
    await new Promise(resolve => setTimeout(resolve, 100));
    const leased = (await pollOutlookDesktopAgent(config, d.token, poll())).job!; expect(leased).toBeTruthy();
    await submitOutlookDesktopAgentResult(config, d.token, { operationId: leased.operationId, leaseId: leased.leaseId, fingerprint: leased.fingerprint, outcome: "succeeded", result: { body: "bounded read" } });
    expect(await pending).toMatchObject({ status: "succeeded", result: { body: "bounded read" } });
  });
  it("serializes durable user state across separate Node processes", async () => {
    await createOutlookDesktopEnrollment(identity(), machine(), "https://brain.example.test");
    const store = new FileOutlookDesktopStore(config), before = (await store.read(users[0])).pairing!.expiresAt;
    const worker = path.join(root, "worker.mts");
    await writeFile(worker, `import storeModule from ${JSON.stringify(pathToFileURL(path.resolve("src/connectors/outlook-desktop-store.ts")).href)};
const { FileOutlookDesktopStore } = storeModule; const config = JSON.parse(process.argv[2]); const store = new FileOutlookDesktopStore(config);
for (let i = 0; i < 4; i++) await store.transaction(process.argv[3], async state => { const current = state.pairing.expiresAt; await new Promise(resolve => setTimeout(resolve, 15)); state.pairing.expiresAt = current + 1; });`);
    await Promise.all([0, 1].map(() => promisify(execFile)(process.execPath, ["--import", "tsx", worker, JSON.stringify(config), users[0]], { cwd: process.cwd(), env: process.env, timeout: 15000 })));
    expect((await store.read(users[0])).pairing!.expiresAt).toBe(before + 8);
  });
  it("runs fake-agent enrollment, poll, result and revoke through actual local HTTP requests", async () => {
    const enrollment = await createOutlookDesktopEnrollment(identity(), machine(), "https://brain.example.test");
    const server = createServer(async (req, res) => { const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part)); const route = req.url!.split("/").pop()! as "enroll" | "poll" | "result" | "revoke"; const response = await handleOutlookDesktopAgentRequest(route, new Request("http://127.0.0.1/agent/" + route, { method: "POST", headers: req.headers as Record<string, string>, body: Buffer.concat(parts) })); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address() as { port: number }; const call = async (kind: string, token: string, body: unknown) => { const response = await fetch(`http://127.0.0.1:${address.port}/${kind}`, { method: "POST", headers: { authorization: `${kind === "enroll" ? "Pairing" : "Bearer"} ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }); expect(response.status).toBe(200); return response.json(); };
    try { const device = await call("enroll", enrollment.pairingCode, machine()); await call("poll", device.token, poll()); const queued = await executeOutlookDesktopOperation(identity(), "items.read", { storeId: "STORE-0", entryId: "real-http-synthetic" }); const leased = (await call("poll", device.token, poll())).job; expect(leased.operationId).toBe(queued.operationId); await call("result", device.token, { operationId: leased.operationId, leaseId: leased.leaseId, fingerprint: leased.fingerprint, outcome: "succeeded", result: { subject: "synthetic readback" } }); expect(await readOutlookDesktopOperation(identity(), queued.operationId)).toMatchObject({ status: "succeeded", result: { subject: "synthetic readback" } }); await call("revoke", device.token, {}); } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
