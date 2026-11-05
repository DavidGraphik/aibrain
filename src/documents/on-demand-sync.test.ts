import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseInstallationConfig } from "@/config/installation-schema";
import type { ResolvedPermissions } from "@/permissions";
import { EnterpriseDocumentNetwork } from "./enterprise-document-network";
import { OnDemandDocumentSync } from "./on-demand-sync";
import { handleCompanyFilesDynamicToolCall } from "@/runtime/enterprise-documents/dynamic-tools";

const USER = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const temporary: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(allow = true, reply?: (request: Record<string, unknown>) => Promise<object | null>) {
  // Keep Unix socket paths below the platform limit, including on macOS.
  const root = await realpath(await mkdtemp("/tmp/ab-sync-"));
  temporary.push(root);
  const dataRoot = path.join(root, "data");
  const config = parseInstallationConfig({ schemaVersion: 1, installationId: "sync-test", companyName: "Test", companySlug: "test",
    publicUrl: "https://example.test", branding: { productName: "Test", logoPath: "/logo.svg", faviconPath: "/favicon.svg", accentColor: "#123456" },
    paths: { dataRoot, companyContextRoot: path.join(dataRoot, "context"), usersRoot: path.join(dataRoot, "users"),
      sourceReadRoot: path.join(root, "source"), publishWriteRoot: path.join(root, "publish"), backupsRoot: path.join(dataRoot, "backups") } });
  const network = new EnterpriseDocumentNetwork(config);
  const permissions: ResolvedPermissions = { schemaVersion: 1, installationId: config.installationId,
    userId: USER, roleId: null, projectId: PROJECT, turnId: "00000000-0000-4000-8000-000000000003",
    resolvedAt: new Date().toISOString(), fingerprint: "a".repeat(64), sources: [], developerInstructions: "Test",
    rules: [{ ruleId: "documents.company.read", action: "consult", effect: allow ? "allow" : "deny",
      instruction: "Test", sourceScope: "installation", sourcePolicyVersion: 1, precedence: 100 }] };
  const roots = await network.rootsForTurn({ userId: USER, projectId: PROJECT, permissions });
  const directory = path.join(dataRoot, "locks", "document-sync");
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const descriptor = path.join(directory, "arnall.json");
  await writeFile(descriptor, JSON.stringify({ schemaVersion: 1, installationId: config.installationId, connectionId: "arnall",
    publications: [{ scope: "company", scopeId: null }] }), { mode: 0o440 });
  let requests = 0;
  const server = createServer((socket) => {
    let data = "";
    socket.on("data", async (chunk) => {
      data += chunk.toString();
      if (!data.includes("\n")) return;
      const request = JSON.parse(data) as Record<string, unknown>;
      requests += 1;
      const result = reply ? await reply(request) : { state: "current", checkedAt: new Date().toISOString(), documents: 6 };
      if (result) socket.end(JSON.stringify({ ...request, ...result }) + "\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path.join(directory, "arnall.sock"), resolve));
  await chmod(path.join(directory, "arnall.sock"), 0o660);
  const sync = new OnDemandDocumentSync(network, { ownerUid: process.getuid?.() ?? 0, timeoutMs: 100 });
  const context = { network, roots, sync, runtimeThreadId: "thread", runtimeTurnId: "turn" };
  const tool = (name: string, args: object) => handleCompanyFilesDynamicToolCall({ namespace: "aibrain_company_files", tool: name,
    threadId: "thread", turnId: "turn", callId: "call", arguments: args } as never, context);
  return { root, network, roots, sync, tool, descriptor, requests: () => requests };
}

describe("on-demand company document synchronization", () => {
  it.each(["current", "failed"])("explains limited search coverage when an absent copy has sync state %s", async (state) => {
    const f = await fixture(true, async () => ({ state, checkedAt: new Date().toISOString(), documents: 6 }));
    const response = await f.tool("search", { query: "pressupostos" });
    expect(response.success).toBe(true);
    const item = response.contentItems[0];
    if (item.type !== "inputText") throw new Error("Expected text tool result");
    const payload = JSON.parse(item.text);
    expect(payload.results).toEqual([]);
    expect(payload.synchronization[0].state).toBe(state);
    expect(payload.warning).toContain("no es un inventario completo");
    expect(payload.warning).toContain("fuera de las carpetas configuradas");
    expect(f.requests()).toBe(1);
  });

  it("waits for a missing source copy before returning search results, then shares the check with read", async () => {
    let destination = "";
    const f = await fixture(true, async () => {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, "New verified source text");
      return { state: "current", checkedAt: new Date().toISOString(), documents: 1 };
    });
    destination = path.join(f.network.companyRoot(), "windows-arnall/new.txt");
    const found = await f.tool("search", { query: "new.txt" });
    expect(found.success).toBe(true);
    expect(JSON.stringify(found)).toContain("windows-arnall/new.txt");
    const read = await f.tool("read", { scope: "company", path: "windows-arnall/new.txt" });
    expect(JSON.stringify(read)).toContain("New verified source text");
    expect(f.requests()).toBe(1);
  });

  it("refreshes an existing imported copy before a direct read", async () => {
    let destination = "";
    const f = await fixture(true, async () => {
      await writeFile(destination, "Updated value");
      return { state: "current", checkedAt: new Date().toISOString() };
    });
    destination = path.join(f.network.companyRoot(), "windows-arnall/existing.txt");
    await mkdir(path.dirname(destination));
    await writeFile(destination, "Old value");
    const response = await f.tool("read", { scope: "company", path: "windows-arnall/existing.txt" });
    expect(JSON.stringify(response)).toContain("Updated value");
  });

  it("does not contact the broker for denied scopes, forged roots, traversal or malformed queries", async () => {
    const f = await fixture(false);
    await f.tool("search", { query: "document" });
    expect((await f.tool("read", { scope: "company", path: "windows-arnall/a.txt" })).success).toBe(false);
    await expect(f.sync.refresh([{ scope: "company", scopeId: null, path: f.network.companyRoot(), readOnly: true }]))
      .rejects.toMatchObject({ code: "DOCUMENT_NETWORK_ROOT_NOT_AUTHORIZED" });
    expect(f.requests()).toBe(0);
    const allowed = await fixture();
    expect((await allowed.tool("read", { scope: "company", path: "../secret" })).success).toBe(false);
    expect((await allowed.tool("search", { query: "../secret" })).success).toBe(false);
    expect(allowed.requests()).toBe(0);
  });

  it("preserves a usable copy and marks it stale when refresh fails", async () => {
    const f = await fixture(true, async () => ({ state: "failed", checkedAt: "2000-01-01T00:00:00Z" }));
    const file = path.join(f.network.companyRoot(), "windows-arnall/old.txt");
    await mkdir(path.dirname(file)); await writeFile(file, "Last verified copy");
    const response = await f.tool("read", { scope: "company", path: "windows-arnall/old.txt" });
    expect(response.success).toBe(true);
    expect(JSON.stringify(response)).toContain("Last verified copy");
    expect(JSON.stringify(response)).toContain("desactualizada");
  });

  it("rejects cross-installation replies and unsafe descriptors without accepting freshness", async () => {
    const f = await fixture(true, async () => ({ state: "current", checkedAt: new Date().toISOString(), installationId: "other" }));
    expect(await f.sync.refresh(f.roots)).toMatchObject([{ state: "unavailable" }]);
    const unsafe = await fixture();
    await rm(unsafe.descriptor);
    await symlink(f.descriptor, unsafe.descriptor);
    expect(await unsafe.sync.refresh(unsafe.roots)).toMatchObject([{ state: "unavailable" }]);
    expect(unsafe.requests()).toBe(0);
  });

  it("bounds waiting and never labels an unfinished update current", async () => {
    const f = await fixture(true, async () => null);
    expect(await f.sync.refresh(f.roots)).toMatchObject([{ state: "pending" }]);
  });
});
