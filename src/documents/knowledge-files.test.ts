import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeDocumentFiles } from "./knowledge-files";
import { handleCompanyFilesDynamicToolCall } from "@/runtime/enterprise-documents/dynamic-tools";

const temporary: string[] = [], servers: Server[] = [], sockets: Socket[] = [];
const company = { scope: "company", scopeId: null };
const partition = createHash("sha256").update("company").digest("hex").slice(0, 32);
const reference = `knowledge-arnall/${partition}/Y/Report.pdf?sha256=${"a".repeat(64)}&part=1`;
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(reply?: (request: Record<string, unknown>) => object) {
  const root = await realpath(await mkdtemp("/tmp/ab-knowledge-"));
  temporary.push(root);
  const roots = [{ ...company, path: path.join(root, "company"), readOnly: true }];
  const network = { config: { paths: { dataRoot: root }, installationId: "test" },
    validateSyncRoots: vi.fn(async (items: typeof roots) => {
      if (items.some((item) => item !== roots[0])) throw new Error("Forged root");
    }), search: vi.fn(async () => []) };
  const directory = path.join(root, "locks/knowledge");
  await mkdir(directory, { recursive: true, mode: 0o750 });
  await writeFile(path.join(directory, "arnall.json"), JSON.stringify({ schemaVersion: 1, installationId: "test", connectionId: "arnall", mode: "read-only", publications: [company] }), { mode: 0o440 });
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    let data = "";
    socket.on("data", (part) => {
      data += part.toString();
      if (!data.includes("\n")) return;
      const request = JSON.parse(data);
      requests.push(request);
      const result = reply?.(request) ?? { available: true, checkedAt: new Date().toISOString(), results: [{ ...company, path: reference }] };
      socket.end(JSON.stringify({ requestId: request.requestId, connectionId: request.connectionId, installationId: request.installationId, ...result }) + "\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path.join(directory, "arnall.sock"), resolve); });
  await chmod(path.join(directory, "arnall.sock"), 0o660);
  const files = new KnowledgeDocumentFiles(network as never, { ownerUid: process.getuid?.() ?? 0, timeoutMs: 100 });
  return { roots: roots as never, network, files, requests, directory };
}

describe("indexed knowledge transport", () => {
  it("binds search to issued scopes and reads a matching cited copy", async () => {
    const f = await fixture((request) => request.operation === "read"
      ? { available: true, ...company, path: reference, content: "[page:1] Contract", checkedAt: new Date().toISOString() }
      : { available: true, results: [{ ...company, path: reference }], checkedAt: new Date().toISOString() });
    expect(await f.files.search(f.roots, "contract")).toMatchObject({ available: true });
    expect(f.requests[0]).toMatchObject({ audiences: [company], input: { query: "contract", limit: 20 } });
    expect(await f.files.read(f.roots, { ...company, path: reference })).toMatchObject({ content: "[page:1] Contract" });
  });

  it("does not contact the broker for empty, forged or foreign scopes", async () => {
    const f = await fixture();
    expect(await f.files.search([], "contract")).toBeNull();
    await expect(f.files.search([{ ...company }] as never, "contract")).rejects.toThrow("Forged root");
    await expect(f.files.read(f.roots, { scope: "private", path: reference })).rejects.toThrow("scope denied");
    expect(f.requests).toHaveLength(0);
  });

  it("rejects cross-partition responses and mismatched envelopes", async () => {
    const f = await fixture(() => ({ available: true, installationId: "foreign", checkedAt: new Date().toISOString(), results: [] }));
    expect(await f.files.search(f.roots, "contract")).toMatchObject({ available: false });
    const g = await fixture(() => ({ available: true, checkedAt: new Date().toISOString(), results: [{ ...company, path: reference.replace(partition, "b".repeat(32)) }] }));
    expect(await g.files.search(g.roots, "contract")).toMatchObject({ available: false });
  });

  it("keeps metadata map matches when the content index is also available", async () => {
    const f = await fixture();
    const serverSearch = vi.fn().mockResolvedValue({ available: true, lookupMode: "metadata-map", sourceChecked: false,
      results: [{ scope: "company", path: "server-arnall/Y/contract-unparsed.pdf" }], warning: "Partial metadata map." });
    const result = await handleCompanyFilesDynamicToolCall({ namespace: "aibrain_company_files", tool: "search", threadId: "thread", turnId: "turn", callId: "call", arguments: { query: "contract" } } as never,
      { network: f.network, roots: f.roots, knowledgeFiles: f.files, serverFiles: { search: serverSearch }, runtimeThreadId: "thread", runtimeTurnId: "turn" } as never);
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).toContain("knowledge-arnall");
    expect(JSON.stringify(result)).toContain("server-arnall/Y/contract-unparsed.pdf");
    expect(JSON.stringify(result)).toContain("Partial metadata map.");
    expect(serverSearch).toHaveBeenCalledOnce();
  });

  it("reads table references and binds calculations to the authorized turn and source", async () => {
    const tablePath = `${reference}&table=0&offset=100`;
    const f = await fixture((request) => ({ available: true, ...company,
      path: (request.input as { path: string }).path, checkedAt: new Date().toISOString(),
      ...(request.operation === "calculate" ? { result: "2.50", operation: "sum" } : { content: "table page" }) }));
    expect(await f.files.read(f.roots, { ...company, path: tablePath })).toMatchObject({ content: "table page" });
    const args = { ...company, path: reference, tableIndex: 0, selection: { rows: [2, 3], column: 1 }, operation: "sum", locale: "es" };
    const params = { namespace: "aibrain_company_files", tool: "calculate", threadId: "thread", turnId: "turn", callId: "call", arguments: args };
    const context = { network: f.network, roots: f.roots, knowledgeFiles: f.files, runtimeThreadId: "thread", runtimeTurnId: "turn" };
    const result = await handleCompanyFilesDynamicToolCall(params as never, context as never);
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).toContain("2.50");
    expect(f.requests[1]).toMatchObject({ operation: "calculate", audiences: [company], input: { selection: args.selection } });
    expect((await handleCompanyFilesDynamicToolCall({ ...params, turnId: "other" } as never, context as never)).success).toBe(false);
    expect((await handleCompanyFilesDynamicToolCall({ ...params, arguments: { ...args, selection: { rows: [0], column: 1 } } } as never, context as never)).success).toBe(false);
    expect(f.requests).toHaveLength(2);
  });
});
