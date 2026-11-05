import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseInstallationConfig } from "@/config/installation-schema";
import type { ResolvedPermissions } from "@/permissions";
import { EnterpriseDocumentNetwork } from "./enterprise-document-network";
import { ServerDocumentFiles } from "./server-files";

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const TOKEN = "00000000-0000-4000-8000-000000000003";
const ROOT = "server-g03/M/Company";
const FILE = ROOT + "/Drawings/00512-7134.A4.pdf";
const directories: string[] = [], servers: Server[] = [], sockets = new Set<Socket>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function response(nextCursor: string | null = null, file = FILE) {
  return { available: true, sourceChecked: true, checkedAt: new Date().toISOString(), lookupMode: "source-filename-search-v1",
    results: [{ scope: "company", path: file, name: "00512-7134.A4.pdf", kind: "file", size: 12, modifiedAt: new Date().toISOString() }],
    nextCursor, limited: nextCursor !== null,
    coverage: { complete: nextCursor === null, snapshot: false, scannedEntries: 6, scannedFolders: 2, pendingFolders: nextCursor ? 1 : 0 } };
}
async function fixture(reply: (request: Record<string, unknown>) => object | null | Promise<object | null>, options: { capability?: boolean; g03?: boolean } = {}) {
  const root = await realpath(await mkdtemp("/tmp/source-names-")); directories.push(root);
  const dataRoot = path.join(root, "data");
  const config = parseInstallationConfig({ schemaVersion: 1, installationId: options.g03 ? "g03-production" : "source-files-test", companyName: "Test", companySlug: "test",
    publicUrl: "https://example.test", branding: { productName: "Test", logoPath: "/logo.svg", faviconPath: "/favicon.svg", accentColor: "#123456" },
    paths: { dataRoot, companyContextRoot: path.join(dataRoot, "context"), usersRoot: path.join(dataRoot, "users"), sourceReadRoot: path.join(root, "source"),
      publishWriteRoot: path.join(root, "publish"), backupsRoot: path.join(dataRoot, "backups") } });
  const network = new EnterpriseDocumentNetwork(config);
  const permissions: ResolvedPermissions = { schemaVersion: 1, installationId: config.installationId, userId: USER, projectId: OTHER, roleId: null,
    turnId: TOKEN, resolvedAt: new Date().toISOString(), fingerprint: "a".repeat(64), sources: [], developerInstructions: "Test",
    rules: [{ ruleId: "documents.company.read", action: "consult", effect: "allow", instruction: "Test", sourceScope: "installation", sourcePolicyVersion: 1, precedence: 100 }] };
  const roots = await network.rootsForTurn({ userId: USER, projectId: OTHER, permissions });
  const directory = path.join(dataRoot, "locks/server-files"); await mkdir(directory, { recursive: true, mode: 0o750 });
  const policyPath = path.join(dataRoot, "locks/server-access.json");
  await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, installationId: config.installationId, users: { [USER]: [ROOT], [OTHER]: [ROOT] } }), { mode: 0o640 });
  await writeFile(path.join(directory, "g03.json"), JSON.stringify({ schemaVersion: 1, installationId: config.installationId, connectionId: "g03", scope: "company", mode: "read-only",
    entryPoints: [{ label: "Company", path: ROOT }], ...(options.capability === false ? {} : { capabilities: ["filename_search_v1"] }) }), { mode: 0o640 });
  const requests: Record<string, unknown>[] = [];
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); let data = "";
    socket.on("data", chunk => {
      data += chunk.toString(); if (!data.includes("\n")) return;
      const request = JSON.parse(data) as Record<string, unknown>; requests.push(request);
      void Promise.resolve(reply(request)).then(result => {
        if (result && !socket.destroyed) socket.end(JSON.stringify({ requestId: request.requestId, installationId: request.installationId, connectionId: request.connectionId, ...result }) + "\n");
      });
    });
  }); servers.push(server);
  await new Promise<void>(resolve => server.listen(path.join(directory, "g03.sock"), resolve)); await chmod(path.join(directory, "g03.sock"), 0o660);
  const clientOptions = { ownerUid: process.getuid?.() ?? 0, timeoutMs: 1000, userId: USER, cursorMinimumFreeBytes: 0 };
  return { config, network, roots, requests, policyPath, clientOptions, files: new ServerDocumentFiles(network, clientOptions) };
}

it("negotiates source-side filename search for a generic installation in one request, with a literal needle and exact scope", async () => {
  const f = await fixture(() => response());
  expect(await f.files.search(f.roots, "name:005127134 in:server:/M/Company/Drawings")).toMatchObject({ available: true, sourceChecked: true, lookupMode: "source-filename-search-v1", nextQuery: null });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({ operation: "filename_search", input: { needle: "005127134", roots: [ROOT + "/Drawings"], cursor: null, limit: 50, budgetMs: 4000 } });
});
it("resumes after a new client, replays the source cursor, and derives a different binding for another employee", async () => {
  let binding: unknown;
  const f = await fixture(request => {
    const args = request.input as Record<string, unknown>;
    binding ??= args.binding;
    return args.binding !== binding ? { available: false, error: "SEARCH_CURSOR_EXPIRED_OR_DENIED" } : response(args.cursor ? null : TOKEN);
  });
  const first = await f.files.search(f.roots, "005127134"); const next = String(first?.nextQuery);
  expect(next).toBe(`filename-cursor:g03:${TOKEN}`);
  const resumed = new ServerDocumentFiles(f.network, f.clientOptions);
  expect(await resumed.search(f.roots, next)).toMatchObject({ available: true, nextQuery: null });
  expect(await resumed.search(f.roots, next)).toMatchObject({ available: true, nextQuery: null });
  expect(await new ServerDocumentFiles(f.network, { ...f.clientOptions, userId: OTHER }).search(f.roots, next)).toMatchObject({ available: false, error: "SEARCH_CURSOR_EXPIRED_OR_DENIED", nextQuery: null, restartRequired: true });
  expect(f.requests.slice(1).every(r => (r.input as Record<string, unknown>).cursor === TOKEN && (r.input as Record<string, unknown>).needle === null)).toBe(true);
});
it.each([false, true])("falls back to the old bounded browser only for an unsupported capability (advertised=%s)", async capability => {
  const f = await fixture(request => request.operation === "filename_search" ? { available: false, error: "FILENAME_SEARCH_UNSUPPORTED" } :
    { available: true, sourceChecked: true, checkedAt: new Date().toISOString(), results: [], limited: false }, { capability, g03: true });
  expect(await f.files.search(f.roots, "name:005127134 in:server:/M/Company")).toMatchObject({ available: true, coverage: { complete: true, pages: 1 } });
  expect(f.requests.map(r => r.operation)).toEqual(capability ? ["filename_search", "browse"] : ["browse"]);
});
it.each(["SEARCH_SOURCE_BUSY", "SEARCH_SOURCE_OFFLINE", "SEARCH_SOURCE_INACCESSIBLE", "SEARCH_POLICY_CHANGED"])("preserves %s without silently switching to a tree walk", async error => {
  const f = await fixture(() => ({ available: false, error }));
  expect(await f.files.search(f.roots, "005127134")).toMatchObject({ available: false, error }); expect(f.requests).toHaveLength(1);
});
it("rejects source rows outside the requested folder and malformed partial continuations", async () => {
  const f = await fixture(() => response(null, ROOT + "/Private/005127134.pdf"));
  expect(await f.files.search(f.roots, "005127134 in:server:/M/Company/Drawings")).toMatchObject({ available: false });
  const malformed = await fixture(() => ({ ...response(TOKEN), limited: false }));
  expect(await malformed.files.search(malformed.roots, "005127134")).toMatchObject({ available: false });
});
it("rechecks revocable employee roots after the source responds", async () => {
  const f = await fixture(async () => {
    await writeFile(f.policyPath, JSON.stringify({ schemaVersion: 1, installationId: "g03-production", users: { [USER]: [] } })); return response();
  }, { g03: true });
  expect(await f.files.search(f.roots, "005127134")).toMatchObject({ available: false, error: "SEARCH_CURSOR_EXPIRED_OR_DENIED" });
});
it("closes the source request promptly on cancellation", async () => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(() => { entered(); return null; }); const controller = new AbortController();
  const pending = new ServerDocumentFiles(f.network, { ...f.clientOptions, signal: controller.signal }).search(f.roots, "005127134");
  await ready; controller.abort(); expect(await pending).toMatchObject({ available: false, error: "SEARCH_CANCELLED" });
});
it("does not count an inaccessible legacy page as successful coverage and preserves its typed failure", async () => {
  const f = await fixture(() => ({ available: false, error: "SERVER_FILES_BUSY" }), { capability: false, g03: true });
  expect(await f.files.search(f.roots, "005127134")).toMatchObject({ available: false, sourceChecked: false, error: "SERVER_FILES_BUSY", coverage: { pages: 0, complete: false, pendingCount: 1 } });
});
