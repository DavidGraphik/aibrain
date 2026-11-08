import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { connectorApprovalRecordSchema, FileApprovalStore, type ConnectorReconciliationProof } from "./approval-store";
import { FileJournal } from "@/storage";

const userId = "11111111-1111-4111-8111-111111111111";
const fingerprint = "a".repeat(64), actionId = `web-${fingerprint}`;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
let legacy: { FileApprovalStore: typeof FileApprovalStore };
let legacyRoot: string;
beforeAll(async () => {
  legacyRoot = await mkdtemp(path.join(tmpdir(), "approval-4952-reader-"));
  const source = await readFile('tests/fixtures/legacy/approval-store.ts.txt','utf8');
  // One tiny isolated legacy-reader bundle, no image or application build.
  const outfile = path.join(legacyRoot, "legacy-reader.mjs");
  await build({ stdin: { contents: source, resolveDir: path.resolve("src/runtime"), loader: "ts" }, outfile,
    bundle: true, platform: "node", format: "esm", conditions: ["react-server"], alias: { "@": path.resolve("src") }, logLevel: "silent" });
  legacy = await import(pathToFileURL(outfile).href);
});
afterAll(async () => { await rm(legacyRoot, { recursive: true, force: true }); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(executed = false) {
  const root = await mkdtemp(path.join(tmpdir(), "approval-reconcile-")); roots.push(root);
  const usersRoot = path.join(root, "users"); await mkdir(path.join(usersRoot, userId), { recursive: true, mode: 0o700 }); await chmod(usersRoot, 0o700);
  let now = Date.now();
  const options = { installationId: "trinalum-production", userId, usersRoot, now: () => now };
  const store = new FileApprovalStore(options);
  const locator = { installationId: options.installationId, userId, threadId: "original-thread", turnId: "original-turn", itemId: actionId, approvalId: actionId };
  const prepared = await store.prepareConnectorApproval({ locator, authorizationFingerprint: fingerprint, ttlMs: 86_400_000 });
  const receipt = prepared.receipt!; await store.approveConnectorApproval(receipt);
  let providerCalls = 0;
  await store.executeConnectorApproval(receipt, { revalidate: () => true, execute: () => {
    if (executed) { providerCalls++; return {}; }
    throw Object.assign(Error("historical record unreadable before dispatch"), { code: "EACCES" });
  } });
  const key = sha(JSON.stringify(Object.values(locator)));
  const file = path.join(store.connectorRecordsRoot, `${key}.json`);
  const beforeJson = await readFile(file, "utf8"), before = JSON.parse(beforeJson);
  const proof = (category: "no-dispatch" | "definitive-rejection" = "no-dispatch"): ConnectorReconciliationProof => ({
    proofVersion: 1, proofCategory: category, installationId: options.installationId, userId, operation: "attio_action", actionId,
    requestedBy: "Trini", requestHash: "b".repeat(64), effectHash: "c".repeat(64), nativeRecordSha256: "d".repeat(64),
    ...(category === "no-dispatch" ? { nativeStatus: "prepared", approvedAt: null, approvedBy: null, dispatchedAt: null, error: null, preparedProvenance: "strict-unapproved-prepared" } as const :
      { nativeStatus: "rejected", approvedAt: new Date(now - 100).toISOString(), approvedBy: "Trini", dispatchedAt: new Date(now - 50).toISOString(),
        definitiveRejection: true, providerStatus: 400, providerCode: "validation_type", error: { status: 400, code: "validation_type" } } as const),
    executedAt: null, providerResultPresent: false, resultPresent: false, readbackPresent: false, otherClaimHeld: false,
    dispatchGuarantee: "attio-durable-before-mutation-v1", legacyHistoryCertified: false,
    checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30_000).toISOString(),
  } as ConnectorReconciliationProof);
  const input = { reconciliationVersion: 1 as const, proofCategory: "no-dispatch" as "no-dispatch" | "definitive-rejection", receipt, expectedRecordSha256: sha(beforeJson), operatorArtifactHash: "e".repeat(64),
    action: { actionId, requestedBy: "Trini", requestHash: "b".repeat(64) }, withProof: async (apply: (proof: ConnectorReconciliationProof, assertHeld: () => void | Promise<void>) => Promise<void>) => apply(proof(), () => {}) };
  const auditPath = path.join(store.approvalsRoot, "connector-reconciliations-v1.jsonl");
  const audit = async () => (await readFile(auditPath, "utf8")).trim().split("\n").map(line => JSON.parse(line).payload);
  return { root, options, store, locator, receipt, file, beforeJson, before, proof, input, auditPath, audit, advance: (ms: number) => { now += ms; }, providerCalls: () => providerCalls };
}

it("reconciles exact pre-dispatch EACCES with write-ahead history and unchanged4952 parser/executor", async () => {
  const f = await fixture(); const metadata = await stat(f.file); const originalEvents = await f.store.readConnectorApprovalEvents();
  const result = await f.store.reconcileConnectorDisposition(f.input);
  expect(result.outcome).toBe("reconciled"); expect(result.record.status).toBe("approval_requested"); expect(f.providerCalls()).toBe(0);
  const history = await f.audit(); expect(history.map(event => event.phase)).toEqual(["prepared", "committed"]);
  expect(history[0].beforeJson).toBe(f.beforeJson); expect(JSON.parse(history[0].beforeJson)).toEqual(f.before);
  expect(history[0].proof.proofCategory).toBe("no-dispatch");
  expect(await f.store.readConnectorApprovalEvents()).toEqual(originalEvents);
  const after = JSON.parse(await readFile(f.file, "utf8"));
  expect(after).toEqual({ ...f.before, status: "approval_requested", approvedAt: null, completedAt: null });
  expect(connectorApprovalRecordSchema.parse(after)).toEqual(after);
  const newMeta = await stat(f.file); expect([newMeta.uid, newMeta.gid, newMeta.mode & 0o777]).toEqual([metadata.uid, metadata.gid, metadata.mode & 0o777]);
  const auditMeta = await stat(f.auditPath); expect(auditMeta.uid).toBe(process.getuid!()); expect(auditMeta.mode & 0o777).toBe(0o600);
  const reader = new legacy.FileApprovalStore(f.options); // Actual baseline4952 implementation, not a copied schema.
  expect((await reader.readConnectorApproval(f.locator))?.status).toBe("approval_requested");
  expect((await reader.approveConnectorApproval(f.receipt)).outcome).toBe("approved");
  let dispatches = 0;
  const execute = () => reader.executeConnectorApproval(f.receipt, { revalidate: () => true, execute: () => { dispatches++; return { verified: true }; } });
  expect((await execute()).outcome).toBe("executed"); expect((await execute()).outcome).toBe("replayed"); expect(dispatches).toBe(1);
  expect((await reader.readConnectorApprovalEvents()).slice(0, originalEvents.length)).toEqual(originalEvents);
});

it("closes only authoritative rejected400validation_type as failed, preserving every original timestamp and preventing replay in4952", async () => {
  const f = await fixture();
  const p = f.proof("definitive-rejection");
  await f.store.reconcileConnectorDisposition({ ...f.input, proofCategory: "definitive-rejection", withProof: async apply => apply(p, () => {}) });
  const after = JSON.parse(await readFile(f.file, "utf8")); expect(after).toEqual({ ...f.before, status: "failed" });
  expect((await f.audit())[0].beforeJson).toBe(f.beforeJson);
  const reader = new legacy.FileApprovalStore(f.options); let dispatches = 0;
  expect((await reader.readConnectorApproval(f.locator))?.status).toBe("failed");
  expect((await reader.executeConnectorApproval(f.receipt, { revalidate: () => true, execute: () => { dispatches++; } })).outcome).toBe("not-pending");
  expect(dispatches).toBe(0);
});

it.each([
  ["completed", { nativeStatus: "completed" }], ["unknown", { nativeStatus: "unknown" }], ["dispatched", { dispatchedAt: "2026-10-16T00:00:00.000Z" }],
  ["result", { resultPresent: true }], ["readback", { readbackPresent: true }], ["other claim", { otherClaimHeld: true }],
  ["actor", { requestedBy: "Miguel" }], ["user", { userId: "22222222-2222-4222-8222-222222222222" }],
  ["action", { actionId: `web-${"f".repeat(64)}` }], ["payload", { requestHash: "f".repeat(64) }],
  ["stale", { checkedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:00:30.000Z" }],
  ["future", { checkedAt: "2099-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:30.000Z" }],
  ["missing explicit field", { approvedAt: undefined }], ["model assertion", { modelSaysNoDispatch: true }],
])("denies %s evidence without changing the original record", async (_name, patch) => {
  const f = await fixture();
  await expect(f.store.reconcileConnectorDisposition({ ...f.input, withProof: async apply => apply({ ...f.proof(), ...patch } as ConnectorReconciliationProof, () => {}) })).rejects.toThrow();
  expect(await readFile(f.file, "utf8")).toBe(f.beforeJson); expect(f.providerCalls()).toBe(0);
});

it.each([500, 401, 403, 429, 422])("does not reinterpret provider%d as the bounded validation rejection", async status => {
  const f = await fixture(); const p = { ...f.proof("definitive-rejection"), providerStatus: status, error: { status, code: "validation_type" } };
  await expect(f.store.reconcileConnectorDisposition({ ...f.input, proofCategory: "definitive-rejection", withProof: async apply => apply(p as never, () => {}) })).rejects.toThrow();
  expect(await readFile(f.file, "utf8")).toBe(f.beforeJson);
});

it("denies altered upper snapshots, cross-thread receipts, revoked grants, lost locks and expired original TTL", async () => {
  const f = await fixture();
  for (const patch of [{ expectedRecordSha256: "f".repeat(64) }, { receipt: { ...f.receipt, threadId: "other-thread" } },
    { withProof: async () => { throw Error("GRANT_REVOKED"); } }, { withProof: async (apply: typeof f.input.withProof extends (fn: infer F) => unknown ? F : never) => apply(f.proof(), () => { throw Error("NATIVE_LOCK_LOST"); }) }]) {
    await expect(f.store.reconcileConnectorDisposition({ ...f.input, ...patch })).rejects.toThrow();
    expect(await readFile(f.file, "utf8")).toBe(f.beforeJson);
  }
  f.advance(86_400_001); await expect(f.store.reconcileConnectorDisposition(f.input)).rejects.toThrow();
  expect(await readFile(f.file, "utf8")).toBe(f.beforeJson);
});

it("is idempotent under concurrent store instances and cannot reopen a completed upper action", async () => {
  const f = await fixture(); const proof = vi.fn(f.input.withProof); const other = new FileApprovalStore(f.options);
  const results = await Promise.all([f.store.reconcileConnectorDisposition({ ...f.input, withProof: proof }), other.reconcileConnectorDisposition({ ...f.input, withProof: proof })]);
  expect(results.map(result => result.outcome).sort()).toEqual(["already-reconciled", "reconciled"]); expect(proof).toHaveBeenCalledOnce();
  expect((await f.audit()).map(event => event.phase)).toEqual(["prepared", "committed"]);
  const completed = await fixture(true); await expect(completed.store.reconcileConnectorDisposition(completed.input)).rejects.toThrow(); expect(completed.providerCalls()).toBe(1);
});

it("retains write-ahead evidence on failure before projection and repairs a post-projection audit crash without native replay", async () => {
  const f = await fixture(); let checks = 0;
  await expect(f.store.reconcileConnectorDisposition({ ...f.input, withProof: async apply => apply(f.proof(), () => { if (++checks === 2) throw Error("LOCK_LOST_AFTER_AUDIT"); }) })).rejects.toThrow();
  expect(await readFile(f.file, "utf8")).toBe(f.beforeJson); expect((await f.audit()).map(event => event.phase)).toEqual(["prepared"]);
  const append = FileJournal.prototype.append;
  const crash = vi.spyOn(FileJournal.prototype, "append").mockImplementation(function (this: FileJournal<unknown>, payload: unknown) {
    if ((payload as {phase?: string}).phase === "committed") return Promise.reject(Error("AUDIT_WRITE_FAILED"));
    return append.call(this, payload);
  });
  await expect(f.store.reconcileConnectorDisposition(f.input)).rejects.toThrow("AUDIT_WRITE_FAILED"); crash.mockRestore();
  const held = vi.fn(f.input.withProof); expect((await f.store.reconcileConnectorDisposition({ ...f.input, withProof: held })).outcome).toBe("already-reconciled"); expect(held).not.toHaveBeenCalled();
  const events = await f.audit(); expect(events.at(-1).phase).toBe("committed"); expect(events.every(event => event.beforeJson === f.beforeJson)).toBe(true);
});

it("rejects root operator identity before creating audit or changing claims", async () => {
  const f = await fixture(); vi.spyOn(process, "getuid").mockReturnValue(0);
  await expect(f.store.reconcileConnectorDisposition(f.input)).rejects.toMatchObject({ code: "RECONCILIATION_SERVICE_IDENTITY_REQUIRED" });
  expect(await readFile(f.file, "utf8")).toBe(f.beforeJson);
});
