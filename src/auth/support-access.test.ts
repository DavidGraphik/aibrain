import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { FileLocalSessionStore, localSessionSchema, SUPPORT_SESSION_MAX_MS } from "@/auth/local-session-store";
import { FileJournal } from "@/storage/journal";
import { FileSupportAccessStore, SUPPORT_CODE_MS } from "./support-access";
const actor = "10000000-0000-4000-8000-000000000001";
const target = "10000000-0000-4000-8000-000000000002";
const input = { actorUserId: actor, actorEmail: "operator@example.invalid", targetUserId: target, targetEmail: "production-fixture@example.invalid", reason: "Verify user folder isolation from deployed UI" };
let root: string, now: number, sessions: FileLocalSessionStore, store: FileSupportAccessStore;
async function profile(id: string, email: string, enabled = true) {
  const dir = path.join(root, "users", id); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "user.json"), JSON.stringify({ schemaVersion: 1, userId: id, email, displayName: id === actor ? "Operator" : "Employee", enabled, workerId: id === actor ? "operator" : "employee" }));
}
function makeStore(installationId = "example-qa") { return new FileSupportAccessStore({ root: path.join(root, "support"), installationId, operatorUserId: actor, users: new FileLocalUserStore(path.join(root, "users")), sessions, now: () => now }); }
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "support-auth-")); now = Date.now();
  sessions = new FileLocalSessionStore({ rootDirectory: path.join(root, "sessions"), now: () => now });
  store = makeStore(); await profile(actor, input.actorEmail); await profile(target, input.targetEmail);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
describe("audited operator support sessions", () => {
  it("binds a preview grant to the target, exact thread and app and preserves it across session read", async () => {
    const threadId="30000000-0000-4000-8000-000000000001",appId="30000000-0000-4000-8000-000000000002";
    store=makeStore("g03-qa");
    const grant=await store.issue({...input,previewThreadId:threadId,previewAppId:appId});
    const support=await store.redeem(grant.code);
    expect(support.sessionId).toMatch(/^QA_PREVIEW_[A-Za-z0-9_-]{32}$/);
    expect((await sessions.read(support.sessionId,"g03-qa"))?.record.support?.preview).toEqual({threadId,appId});
    await store.revoke(grant.grantId);
    expect(await sessions.read(support.sessionId,"g03-qa")).toBeNull();
  });
  it("rejects partial, malformed and foreign-installation preview scopes", async () => {
    const threadId="30000000-0000-4000-8000-000000000001",appId="30000000-0000-4000-8000-000000000002";
    await expect(store.issue({...input,previewThreadId:threadId,previewAppId:appId})).rejects.toThrow();
    store=makeStore("g03-qa");
    await expect(store.issue({...input,previewThreadId:threadId})).rejects.toThrow();
    await expect(store.issue({...input,previewThreadId:threadId,previewAppId:"../escape"})).rejects.toThrow();
  });
  it("redeems exactly once through real session storage, preserves canonical target and logs no bearer", async () => {
    const grant = await store.issue(input);
    const results = await Promise.allSettled([store.redeem(grant.code), store.redeem(grant.code)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const result = results.find(r => r.status === "fulfilled"); if (result?.status !== "fulfilled") throw new Error("No session");
    const session = result.value;
    expect((await sessions.read(session.sessionId, "example-qa"))?.record).toMatchObject({ userId: target, support: { actorUserId: actor, actorEmail: input.actorEmail, reason: input.reason } });
    expect(session.record.absoluteExpiresAt - now).toBe(SUPPORT_SESSION_MAX_MS);
    const audit = await readFile(path.join(root, "support", "audit.jsonl"), "utf8");
    expect((await stat(path.join(root, "support", "audit.jsonl"))).mode & 0o777).toBe(0o600);
    expect(audit).toContain('"status":"consumed"'); expect(audit).not.toContain(grant.code); expect(audit).not.toContain(session.sessionId);
  });
  it("expires pending codes and rejects a wrong tenant without consuming valid grants", async () => {
    const grant = await store.issue(input);
    await expect(makeStore("other-qa").redeem(grant.code)).rejects.toThrow();
    now += SUPPORT_CODE_MS;
    await expect(store.redeem(grant.code)).rejects.toThrow();
  });
  it("rejects disabled/mismatched canonical identities at issuance and again at redemption", async () => {
    await expect(store.issue({ ...input, targetEmail: "someone@example.com" })).rejects.toThrow();
    const grant = await store.issue(input); await profile(target, input.targetEmail, false);
    await expect(store.redeem(grant.code)).rejects.toThrow();
    await profile(target, input.targetEmail); await profile(actor, input.actorEmail, false);
    await expect(store.issue(input)).rejects.toThrow();
  });
  it("fails closed if audit cannot persist and removes a session if redemption audit fails", async () => {
    const audit = vi.spyOn(FileJournal.prototype, "append").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(store.issue(input)).rejects.toThrow("disk unavailable");
    audit.mockRestore(); const grant = await store.issue(input);
    vi.spyOn(FileJournal.prototype, "append").mockRejectedValueOnce(new Error("disk unavailable"));
    const create = vi.spyOn(sessions, "create");
    await expect(store.redeem(grant.code)).rejects.toThrow("disk unavailable");
    const issued = await create.mock.results[0].value;
    expect(await sessions.read(issued.sessionId, "example-qa")).toBeNull();
    await expect(store.redeem(grant.code)).rejects.toThrow();
  });
  it("revokes only identified support sessions and retains ordinary user sessions", async () => {
    const ordinary = await sessions.create("example-qa", target);
    const grant = await store.issue(input); const support = await store.redeem(grant.code);
    expect(await sessions.revokeSupportHash("example-qa", ordinary.record.sessionIdHash)).toBe(false);
    await store.revoke(grant.grantId);
    expect(await sessions.read(support.sessionId, "example-qa")).toBeNull();
    expect(await sessions.read(ordinary.sessionId, "example-qa")).not.toBeNull();
    await expect(store.redeem(grant.code)).rejects.toThrow();
  });
  it("rechecks live support authorization on an already admitted server binding", async () => {
    const grant = await store.issue(input); const support = await store.redeem(grant.code);
    let authorized = true;
    const boundStore = new FileLocalSessionStore({ rootDirectory: path.join(root, "sessions"), now: () => now, validateSupport: async () => authorized });
    expect(await boundStore.isActiveBinding("example-qa", target, support.record.sessionIdHash)).toBe(true);
    authorized = false;
    expect(await boundStore.isActiveBinding("example-qa", target, support.record.sessionIdHash)).toBe(false);
    // A consumer that forgot to configure the live validator must fail closed.
    expect(await sessions.isActiveBinding("example-qa", target, support.record.sessionIdHash)).toBe(false);
    const ordinary = await sessions.create("example-qa", target);
    expect(await sessions.isActiveBinding("example-qa", target, ordinary.record.sessionIdHash)).toBe(true);
  });
  it("reads only the exact live support binding by root-pinned hash, without renewal", async () => {
    const grant = await store.issue(input); const support = await store.redeem(grant.code);
    let authorized = true;
    const bound = new FileLocalSessionStore({ rootDirectory: path.join(root, "sessions"), now: () => now, validateSupport: async () => authorized });
    expect(await bound.activeSupportBindingByHash("example-qa", target, support.record.sessionIdHash)).toEqual(support.record);
    expect(await bound.activeSupportBindingByHash("other-qa", target, support.record.sessionIdHash)).toBeNull();
    expect(await bound.activeSupportBindingByHash("example-qa", actor, support.record.sessionIdHash)).toBeNull();
    expect(await bound.activeSupportBindingByHash("example-qa", target, "b".repeat(64))).toBeNull();
    const ordinary = await sessions.create("example-qa", target);
    expect(await bound.activeSupportBindingByHash("example-qa", target, ordinary.record.sessionIdHash)).toBeNull();
    authorized = false; expect(await bound.activeSupportBindingByHash("example-qa", target, support.record.sessionIdHash)).toBeNull();
    authorized = true; await store.revoke(grant.grantId);
    expect(await bound.activeSupportBindingByHash("example-qa", target, support.record.sessionIdHash)).toBeNull();
    const second = await store.redeem((await store.issue(input)).code);
    now += SUPPORT_SESSION_MAX_MS;
    expect(await bound.activeSupportBindingByHash("example-qa", target, second.record.sessionIdHash)).toBeNull();
  });
  it("enforces the absolute short lifetime in the server store and rejects forged long-lived support records", async () => {
    const grant = await store.issue(input); const support = await store.redeem(grant.code);
    expect(() => localSessionSchema.parse({ ...support.record, absoluteExpiresAt: now + SUPPORT_SESSION_MAX_MS + 1 })).toThrow();
    now += SUPPORT_SESSION_MAX_MS - 1;
    expect((await sessions.read(support.sessionId, "example-qa"))?.record.absoluteExpiresAt).toBe(support.record.absoluteExpiresAt);
    now += 1; expect(await sessions.read(support.sessionId, "example-qa")).toBeNull();
  });
});
