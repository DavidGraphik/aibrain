import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilePublicationCapacityGate } from "@/documents/publication-capacity";
import { ResourceLockManager } from "@/storage/resource-lock";
import { StorageError } from "@/storage/errors";
import { G03RemoteDocumentPublisher } from "./remote-document-publisher";
import type { RemoteWriteBinding, RemoteWriteReceipt } from "./publication-client";
import { g03PublicationTarget } from "./publication-target";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "g03-publication-"))); roots.push(root);
  const userId = randomUUID(), projectId = randomUUID(), threadId = randomUUID(), turnId = randomUUID(), uploadId = randomUUID();
  const staged = `threads/${threadId}/uploads/${uploadId}/Prova.txt`;
  await mkdir(path.join(root, "staging", path.dirname(staged)), { recursive: true, mode: 0o700 });
  const data = Buffer.from("New synthetic version");
  await writeFile(path.join(root, "staging", staged), data);
  let source: Buffer | null = Buffer.from("Original synthetic version");
  let receipt: RemoteWriteReceipt | null = null;
  let now = Date.now();
  const transport = {
    snapshot: vi.fn(async () => source ? { exists: true, size: source.length, sha256: sha(source), mtimeMs: now } :
      { exists: false, size: null, sha256: null, mtimeMs: null }),
    publish: vi.fn(async (binding: RemoteWriteBinding, candidate: Buffer): Promise<RemoteWriteReceipt> => {
      const conflict = (source ? sha(source) : null) !== binding.expectedSha256;
      receipt = { status: conflict ? "rejected" : "committed", operationId: binding.operationId,
        sha256: binding.sha256, previousSha256: binding.expectedSha256,
        backupId: !conflict && source ? binding.operationId : null, checkedAt: new Date(now).toISOString() };
      if (conflict) throw new StorageError("PUBLICATION_ORIGINAL_CONFLICT", "changed");
      source = candidate;
      return receipt;
    }),
    receipt: vi.fn(async (): Promise<RemoteWriteReceipt> => { if (!receipt) throw new Error("offline"); return receipt; }),
  };
  const options = { installationId: "g03-qa", userId, projectId, stagingRoot: path.join(root, "staging"),
    stateRoot: path.join(root, "private-state"), workerVisibleRoots: [path.join(root, "worker")],
    confirmationSecret: "synthetic-fixture-".repeat(4), locks: new ResourceLockManager({ rootDirectory: path.join(root, "locks") }),
    transport, now: () => now, confirmationTtlMs: 60_000,
    capacityGate: new FilePublicationCapacityGate({ rootDirectory: path.join(root, "capacity-locks"), capacityRoot: path.join(root, "private-state"),
      readCapacity: async () => ({ bsize: 4096n, bavail: 10_000_000n, blocks: 20_000_000n }) }) };
  const input = { operationId: randomUUID(), clientRequestId: randomUUID(), threadId, turnId,
    targetRelativePath: "server-g03/M/G03/PRODUCCIO/Prova.txt", candidateRelativePath: staged,
    preview: { schemaVersion: 1 as const, previewId: uploadId, threadId, turnId, candidateSha256: sha(data),
      status: "ready" as const, artifacts: ["preview.pdf"], createdAt: new Date(now).toISOString() } };
  const publisher = new G03RemoteDocumentPublisher(options);
  async function prepare() {
    const frozen = await publisher.freezeCandidate(input);
    return { operationId: input.operationId, clientRequestId: randomUUID(), threadId, turnId, confirmationToken: frozen.confirmationToken };
  }
  return { root, options, publisher, input, transport, prepare, data,
    source: () => source, receipt: () => receipt,
    changeSource: (data: Buffer | null) => { source = data; },
    advance: (ms: number) => { now += ms; } };
}

describe("G03 remote document publication", () => {
  it("freezes an immutable candidate, requires confirmation and records the Windows receipt", async () => {
    const f = await fixture(); const decision = await f.prepare();
    expect(f.transport.publish).not.toHaveBeenCalled();
    await writeFile(path.join(f.options.stagingRoot, f.input.candidateRelativePath), "Later staging change");
    const published = await f.publisher.confirm(decision);
    expect(published.status).toBe("published");
    expect(published.version?.sha256).toBe(sha(Buffer.from("Original synthetic version")));
    expect(f.source()).toEqual(f.data);
    const repeated = await new G03RemoteDocumentPublisher(f.options).confirm({ ...decision, clientRequestId: randomUUID() });
    expect(repeated).toEqual(published);
    expect(f.transport.publish).toHaveBeenCalledTimes(1);
  });
  it("creates a new file without claiming a previous backup", async () => {
    const f = await fixture(); f.changeSource(null);
    const result = await f.publisher.confirm(await f.prepare());
    expect(result.version).toBeNull(); expect(result.status).toBe("published");
    expect(f.transport.publish.mock.calls[0][0].writeOperation).toBe("create");
  });
  it("recovers a lost successful response by querying, never writing twice", async () => {
    const f = await fixture(); const decision = await f.prepare();
    const write = f.transport.publish.getMockImplementation()!;
    f.transport.publish.mockImplementationOnce(async (...args) => { await write(...args); throw new Error("lost response"); });
    await expect(f.publisher.confirm(decision)).rejects.toThrow("lost response");
    f.advance(120_000); // Expired confirmation cannot dispatch, but may reconcile the prior effect.
    const recovered = await new G03RemoteDocumentPublisher(f.options).confirm(decision);
    expect(recovered.status).toBe("published"); expect(recovered.result?.recoveredAfterInterruption).toBe(true);
    expect(f.transport.publish).toHaveBeenCalledTimes(1); expect(f.transport.receipt).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite a document changed since preview", async () => {
    const f = await fixture(); const decision = await f.prepare(); const changed = Buffer.from("Employee edit");
    f.changeSource(changed);
    expect((await f.publisher.confirm(decision)).status).toBe("conflict");
    expect(f.source()).toEqual(changed);
  });
  it("decline, expiry and forged confirmation cause no remote writes", async () => {
    const f = await fixture(); const decision = await f.prepare();
    await expect(f.publisher.confirm({ ...decision, confirmationToken: "0".repeat(64) })).rejects.toMatchObject({ code: "PUBLICATION_TOKEN_INVALID" });
    await expect(f.publisher.confirm({ ...decision, confirmationToken: "é".repeat(64) })).rejects.toMatchObject({ code: "PUBLICATION_TOKEN_INVALID" });
    expect((await f.publisher.decline(decision)).status).toBe("declined");
    expect(f.transport.publish).not.toHaveBeenCalled();
    const g = await fixture(); const expired = await g.prepare(); g.advance(60_000);
    await expect(g.publisher.confirm(expired)).rejects.toMatchObject({ code: "PUBLICATION_TOKEN_EXPIRED" });
    expect(g.transport.publish).not.toHaveBeenCalled();
  });
  it("rejects other projects, users, threads and turns before any remote write", async () => {
    const f = await fixture(); const decision = await f.prepare();
    await expect(new G03RemoteDocumentPublisher({ ...f.options, projectId: randomUUID() }).confirm(decision))
      .rejects.toMatchObject({ code: "PUBLICATION_SCOPE_MISMATCH" });
    await expect(new G03RemoteDocumentPublisher({ ...f.options, userId: randomUUID() }).confirm(decision)).rejects.toThrow();
    await expect(f.publisher.confirm({ ...decision, threadId: randomUUID() })).rejects.toMatchObject({ code: "PUBLICATION_SCOPE_MISMATCH" });
    await expect(f.publisher.confirm({ ...decision, turnId: randomUUID() })).rejects.toMatchObject({ code: "PUBLICATION_SCOPE_MISMATCH" });
    expect(f.transport.publish).not.toHaveBeenCalled(); expect(f.transport.receipt).not.toHaveBeenCalled();
  });
  it("refuses state tampering rather than trusting an edited target", async () => {
    const f = await fixture(); const decision = await f.prepare();
    const file = path.join(f.options.stateRoot, "operations", f.options.userId, f.input.operationId + ".json");
    const state = JSON.parse(await readFile(file, "utf8")); state.payload.operation.targetRelativePath = "server-g03/M/G03/RAFAEL/Prova.txt";
    await writeFile(file, JSON.stringify(state));
    await expect(f.publisher.confirm(decision)).rejects.toMatchObject({ code: "PUBLICATION_STATE_CORRUPT" });
    expect(f.transport.publish).not.toHaveBeenCalled();
  });
  it("keeps an uncertain target reserved across another operation and restart", async () => {
    const f = await fixture(); const decision = await f.prepare();
    f.transport.publish.mockRejectedValueOnce(new Error("offline"));
    await expect(f.publisher.confirm(decision)).rejects.toThrow("offline");
    f.transport.receipt.mockResolvedValueOnce({ status: "not_found", operationId: f.input.operationId,
      sha256: sha(f.data), previousSha256: sha(f.source()!), backupId: null, checkedAt: new Date().toISOString() });
    await expect(new G03RemoteDocumentPublisher(f.options).confirm(decision)).rejects.toMatchObject({ code: "PUBLICATION_REMOTE_UNCERTAIN" });
    const another = { ...f.input, operationId: randomUUID(), clientRequestId: randomUUID() };
    const frozen = await f.publisher.freezeCandidate(another);
    await expect(f.publisher.confirm({ ...decision, operationId: another.operationId, confirmationToken: frozen.confirmationToken }))
      .rejects.toMatchObject({ code: "PUBLICATION_REMOTE_UNCERTAIN" });
    expect(f.transport.publish).toHaveBeenCalledTimes(1);
  });
  it("restores the same pending confirmation after a browser/process restart", async () => {
    const f = await fixture(); const decision = await f.prepare();
    const recovered = await new G03RemoteDocumentPublisher(f.options).recoverThread(f.input.threadId);
    expect(recovered).toHaveLength(1); expect(recovered[0].confirmationToken).toBe(decision.confirmationToken);
    expect(await f.publisher.recoverThread(randomUUID())).toEqual([]);
    expect(await new G03RemoteDocumentPublisher({ ...f.options, projectId: randomUUID() }).recoverThread(f.input.threadId)).toEqual([]);
    expect(f.transport.publish).not.toHaveBeenCalled();
  });
  it("rejects new candidates on storage backpressure before querying Windows", async () => {
    const f = await fixture();
    const publisher = new G03RemoteDocumentPublisher({ ...f.options, capacityGate: {
      run: async () => { throw new StorageError("PUBLICATION_STORAGE_BACKPRESSURE", "synthetic full disk"); },
    } });
    await expect(publisher.freezeCandidate(f.input)).rejects.toMatchObject({ code: "PUBLICATION_STORAGE_BACKPRESSURE" });
    expect(f.transport.snapshot).not.toHaveBeenCalled(); expect(f.transport.publish).not.toHaveBeenCalled();
  });

  it("keeps an unresolved destination reserved against another user's operation", async () => {
    const f = await fixture(); const decision = await f.prepare();
    f.transport.publish.mockRejectedValueOnce(new Error("offline"));
    await expect(f.publisher.confirm(decision)).rejects.toThrow();
    const publisher = new G03RemoteDocumentPublisher({ ...f.options, userId: randomUUID() });
    const input = { ...f.input, operationId: randomUUID(), clientRequestId: randomUUID(),
      targetRelativePath: f.input.targetRelativePath.toLowerCase().replace("/m/", "/M/") };
    const frozen = await publisher.freezeCandidate(input);
    await expect(publisher.confirm({ ...decision, operationId: input.operationId, confirmationToken: frozen.confirmationToken }))
      .rejects.toMatchObject({ code: "PUBLICATION_REMOTE_UNCERTAIN" });
    expect(f.transport.publish).toHaveBeenCalledTimes(1);
  });
  it("rejects changed previews and unsupported/traversing destinations before remote access", async () => {
    const f = await fixture();
    await expect(f.publisher.freezeCandidate({ ...f.input, preview: { ...f.input.preview, candidateSha256: "0".repeat(64) } })).rejects.toThrow();
    for (const target of ["local/Prova.txt", "server-g03/C/Windows/Prova.txt", "server-g03/M/G03/PRODUCCIO/../Prova.txt",
      "server-g03/M/G03/PRODUCCIO/%252e%252e/Prova.txt", "server-g03/M/G03/PRODUCCIO/CON.txt", "server-g03/M/G03/PRODUCCIO/run.ps1"]) {
      await expect(f.publisher.freezeCandidate({ ...f.input, targetRelativePath: target })).rejects.toThrow();
    }
    expect(f.transport.snapshot).not.toHaveBeenCalled();
    expect(g03PublicationTarget("server-g03/M/G03/PRODUCCIO/Àngels prova.txt")).toContain("%C3%80ngels%20prova.txt");
  });
});
