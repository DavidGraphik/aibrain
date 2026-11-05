import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeReviewTransport } from "./review-transport";

const temp: string[] = [], servers: Server[] = [], sockets: Socket[] = [];
const actor = "10000000-0000-4000-8000-000000000001", company = { scope: "company", scopeId: null } as const;
const partition = createHash("sha256").update("company").digest("hex").slice(0, 32);
const reference = `knowledge-arnall/${partition}/Y/example.txt?sha256=${"a".repeat(64)}&part=1`;
const record = { id: actor, kind: "fact", label: "Fictional", topic: "Review", content: "Review weekly.", status: "proposed", revision: 1,
  citations: [{ source: "Y:\\example.txt", sha256: "a".repeat(64), locator: "line:1", quote: "Review weekly.", path: reference }], conflicts: [], events: [] };
afterEach(async () => { for (const s of sockets.splice(0)) s.destroy(); await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))); await Promise.all(temp.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture(reply?: (request: Record<string, unknown>) => object) {
  const root = await realpath(await mkdtemp("/tmp/ab-review-")); temp.push(root);
  const roots = [{ ...company, path: "/fixture", readOnly: false }];
  const network = { config: { installationId: "test", paths: { dataRoot: root } }, validateSyncRoots: vi.fn(async (items: typeof roots) => { if (items.some((r) => r !== roots[0])) throw new Error("FORGED_ROOT"); }) };
  const directory = path.join(root, "locks/knowledge-review"); await mkdir(directory, { recursive: true, mode: 0o750 });
  await writeFile(path.join(directory, "arnall.json"), JSON.stringify({ schemaVersion: 1, mode: "human-review", installationId: "test", connectionId: "arnall", publications: [company] }), { mode: 0o440 });
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    sockets.push(socket); let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString(); if (!text.includes("\n")) return;
      const request = JSON.parse(text); requests.push(request);
      socket.end(JSON.stringify({ requestId: request.requestId, installationId: "test", connectionId: "arnall", audience: company, checkedAt: new Date().toISOString(),
        ...(reply?.(request) ?? { available: true, records: [record], nextCursor: null }) }) + "\n");
    });
  }); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path.join(directory, "arnall.sock"), resolve); });
  await chmod(path.join(directory, "arnall.sock"), 0o660);
  return { roots, requests, directory, transport: new KnowledgeReviewTransport(network as never, { ownerUid: process.getuid!(), timeoutMs: 500 }) };
}
describe("trusted review socket", () => {
  it("sends server actor, authorized audience and exact expected revision", async () => {
    const f = await fixture((request) => request.operation === "review" ? { available: true, record: { ...record, status: "confirmed", revision: 2 } } : { available: true, records: [record], nextCursor: null });
    expect(await f.transport.call(f.roots, actor, company, "list", { status: "proposed", cursor: 0 })).toMatchObject({ available: true, records: [{ id: actor }] });
    expect(await f.transport.call(f.roots, actor, company, "review", { recordId: actor, revision: 1, decision: "confirm" }, "arnall")).toMatchObject({ record: { revision: 2 } });
    expect(f.requests[1]).toMatchObject({ actorId: actor, audience: company, input: { recordId: actor, revision: 1, decision: "confirm" } });
  });
  it("requires correction replies to bind the prior record and exact revision", async () => {
    const corrected = { ...record, id: "20000000-0000-4000-8000-000000000001", status: "confirmed", content: "Qualified statement",
      correction: { previousRecordId: actor, previousRevision: 1, previousContent: record.content, reason: "Clarify scope" } };
    const f = await fixture(() => ({ available: true, record: corrected }));
    const input = { recordId: actor, revision: 1, content: corrected.content, reason: corrected.correction.reason };
    expect(await f.transport.call(f.roots, actor, company, "correct", input)).toMatchObject({ available: true, record: { id: corrected.id } });
    expect(await f.transport.call(f.roots, actor, company, "correct", { ...input, revision: 2 })).toMatchObject({ available: false });
    expect(await f.transport.call(f.roots, actor, company, "correct", { ...input, content: "Unexpected replacement" })).toMatchObject({ available: false });
    const g = await fixture(() => ({ available: true, record: { ...corrected, correction: { ...corrected.correction, previousRecordId: corrected.id } } }));
    expect(await g.transport.call(g.roots, actor, company, "correct", input)).toMatchObject({ available: false });
  });
  it("does not contact any socket for forged roots or foreign scopes", async () => {
    const f = await fixture();
    await expect(f.transport.call([{ ...f.roots[0] }], actor, company, "list", {})).rejects.toThrow("FORGED_ROOT");
    await expect(f.transport.call(f.roots, actor, { scope: "private", scopeId: actor }, "list", {})).rejects.toThrow("REVIEW_SCOPE_DENIED");
    expect(f.requests).toHaveLength(0);
  });
  it("rejects mismatched source partitions and installation envelopes", async () => {
    const f = await fixture(() => ({ available: true, records: [{ ...record, citations: [{ ...record.citations[0], path: reference.replace(partition, "b".repeat(32)) }] }], nextCursor: null }));
    expect(await f.transport.call(f.roots, actor, company, "list", { status: "proposed", cursor: 0 })).toMatchObject({ available: false });
    const g = await fixture(() => ({ available: true, installationId: "foreign", records: [], nextCursor: null }));
    expect(await g.transport.call(g.roots, actor, company, "list", { status: "proposed", cursor: 0 })).toMatchObject({ available: false });
  });
});
