import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogPrincipal, CatalogResource, CatalogRule, CatalogState } from "@/catalog/contracts";
import { isCatalogCommand, isCatalogResource } from "@/catalog/contracts";
import { allowsCatalogOperation } from "@/catalog/resolver";
import { CatalogEnforcedTransport, CatalogRuntimeDeniedError, CatalogRuntimeEnforcer } from "@/catalog/runtime-enforcement";
import { FileCatalogStore } from "@/catalog/store";
import type { ListMcpServerStatusResponse } from "../../contracts/codex/0.162.1/types/v2/ListMcpServerStatusResponse";

const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const GROUP = "00000000-0000-4000-8000-000000000003";
const roots: string[] = [];
const principal = (overrides: Partial<CatalogPrincipal> = {}): CatalogPrincipal => ({
  installationId: "arnall-qa", userId: USER_A, roleId: "workspace-member", groupIds: [GROUP], workspaceCanExecute: true, ...overrides,
});
const skill: CatalogResource = { id: "graphikai-company-context", kind: "skill", label: "GraphikAI context", credentialMode: "none", managedBy: "graphikai", sharedResource: false, appId: null, connectorId: null, mcp: null };
const app: CatalogResource = { id: "mail-app", kind: "app", label: "Mail", credentialMode: "personal-oauth", managedBy: "company", sharedResource: false, appId: "mail", connectorId: null, mcp: null };
const outlook: CatalogResource = { id: "outlook", kind: "connector", label: "Outlook", credentialMode: "personal-oauth", managedBy: "graphikai", sharedResource: false, appId: null, connectorId: "outlook", mcp: null };
const mcp: CatalogResource = { id: "mail-mcp", kind: "mcp", label: "Mail MCP", credentialMode: "personal-oauth", managedBy: "company", sharedResource: false, appId: null, connectorId: null, mcp: { server: "mail", readTools: ["search"], sensitiveWriteTools: ["send"] } };
const rule = (id: string, scope: CatalogRule["scope"], subjectId: string | null, resourceId: string, effect: CatalogRule["effect"], operations: CatalogRule["operations"]): CatalogRule => ({ id, scope, subjectId, resourceId, effect, operations });

function state(rules: CatalogRule[]): CatalogState { return { schemaVersion: 1, installationId: "arnall-qa", revision: 1, resources: [skill, app, outlook, mcp], rules }; }

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("enterprise catalog resolution", () => {
  it("accepts only bounded administrative skill packages", () => {
    const command = { action: "upsert-skill-package", package: { id: "company-handoff", label: "Company handoff", version: "1.0.0", category: "company", provenance: "Confirmed by workspace administration.", files: [{ path: "SKILL.md", content: "---\nname: company-handoff\ndescription: Use the confirmed handoff.\n---\n\n# Handoff" }] } };
    expect(isCatalogCommand(command)).toBe(true);
    expect(isCatalogCommand({ ...command, package: { ...command.package, files: [{ path: "../SKILL.md", content: "unsafe" }] } })).toBe(false);
    expect(isCatalogCommand({ action: "revoke-skill-package", skillId: "company-handoff" })).toBe(true);
  });

  it("uses user, group, role, then installation precedence and fails closed", () => {
    const catalog = state([
      rule("base-mail", "installation", null, "mail-app", "allow", ["read"]),
      rule("role-mail", "role", "workspace-member", "mail-app", "deny", ["read"]),
      rule("group-mail", "group", GROUP, "mail-app", "allow", ["read"]),
      rule("user-mail", "user", USER_A, "mail-app", "deny", ["read"]),
    ]);
    expect(allowsCatalogOperation(catalog, principal(), "mail-app", "read")).toBe(false);
    expect(allowsCatalogOperation(catalog, principal({ userId: USER_B }), "mail-app", "read")).toBe(true);
    expect(allowsCatalogOperation(catalog, principal({ groupIds: [] }), "mail-app", "read")).toBe(false);
    expect(allowsCatalogOperation(catalog, principal({ installationId: "other-tenant" }), "mail-app", "read")).toBe(false);
    expect(allowsCatalogOperation(catalog, principal(), "unknown", "read")).toBe(false);
  });

  it("exposes a company connector only to an allowed group and lets a group deny dominate", () => {
    const allowed = state([rule("outlook-group", "group", GROUP, outlook.id, "allow", ["read"])]);
    expect(allowsCatalogOperation(allowed, principal(), outlook.id, "read")).toBe(true);
    expect(allowsCatalogOperation(allowed, principal({ userId: USER_B, groupIds: [] }), outlook.id, "read")).toBe(false);
    const denied = state([
      rule("outlook-group", "group", GROUP, outlook.id, "allow", ["read"]),
      rule("outlook-group-deny", "group", GROUP, outlook.id, "deny", ["read"]),
    ]);
    expect(allowsCatalogOperation(denied, principal(), outlook.id, "read")).toBe(false);
  });

  it("rejects non-resource shared credentials and preserves versioned state across restart", async () => {
    expect(isCatalogResource({ ...app, credentialMode: "shared-resource", sharedResource: false })).toBe(false);
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-catalog-")); roots.push(root);
    const first = new FileCatalogStore("arnall-qa", root, () => Date.parse("2026-08-29T00:00:00.000Z"));
    await first.ensureManagedSkills([{ id: skill.id, label: skill.label }]);
    await first.mutate(USER_A, (current) => {
      current.resources.push(app);
      current.rules.push(rule("install-mail", "installation", null, app.id, "allow", ["read"]));
      return { action: "catalog.resource-upserted", targetId: app.id, summary: "Mail catalogued." };
    });
    const restarted = new FileCatalogStore("arnall-qa", root);
    await expect(restarted.read()).resolves.toMatchObject({ schemaVersion: 1, revision: 2, resources: expect.arrayContaining([expect.objectContaining({ id: skill.id }), expect.objectContaining({ id: app.id })]) });
    await expect(restarted.auditLog()).resolves.toHaveLength(1);
  });

  it("removes disabled GraphikAI connectors and their grants from the effective catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aibrain-catalog-connectors-")); roots.push(root);
    const store = new FileCatalogStore("arnall-qa", root);
    await store.ensureManagedResources([outlook]);
    await expect(store.read()).resolves.toMatchObject({ resources: expect.arrayContaining([expect.objectContaining({ id: "outlook" })]) });
    const disabled = await store.ensureManagedResources([], [outlook.id]);
    expect(disabled.resources.some(({ id }) => id === "outlook")).toBe(false);
    expect(disabled.rules.some(({ resourceId }) => resourceId === "outlook")).toBe(false);
  });
});

describe("runtime catalog enforcement", () => {
  const catalog = state([
    rule("skill-read", "installation", null, skill.id, "allow", ["read"]),
    rule("app-read", "installation", null, app.id, "allow", ["read"]),
    rule("mcp-read", "installation", null, mcp.id, "allow", ["read"]),
    rule("mcp-write", "user", USER_A, mcp.id, "allow", ["write"]),
  ]);

  it("filters skills/apps and permits only declared reads", () => {
    const enforcer = new CatalogRuntimeEnforcer(catalog, principal());
    expect(enforcer.filterSkills({ data: [{ cwd: "/x", skills: [{ name: skill.id }, { name: "hidden" }] }] })).toMatchObject({ data: [{ skills: [{ name: skill.id }] }] });
    expect(enforcer.filterApps({ data: [{ id: "mail" }, { id: "shadow" }] })).toMatchObject({ data: [{ id: "mail" }] });
    expect(() => enforcer.assertMcpTool({ server: "mail", tool: "search" })).not.toThrow();
    expect(() => enforcer.assertMcpTool({ server: "mail", tool: "send" })).toThrowError(expect.objectContaining({ code: "CATALOG_MCP_APPROVAL_REQUIRED" }));
    expect(() => enforcer.assertMcpTool({ server: "mail", tool: "send" }, true)).not.toThrow();
    expect(() => new CatalogRuntimeEnforcer(catalog, principal({ workspaceCanExecute: false }))
      .assertMcpTool({ server: "mail", tool: "send" }, true)).toThrowError(expect.objectContaining({ code: "CATALOG_MCP_WRITE_DENIED" }));
  });

  it("never forwards install/configuration calls or unknown MCP tools", async () => {
    const inner = { request: vi.fn(async (method: string) => method === "app/list"
      ? { data: [{ id: "mail" }, { id: "hidden" }] }
      : method === "mcpServerStatus/list" ? { data: [{ server: "mail" }, { server: "hidden" }] }
        : { apps: [{ id: "mail" }, { id: "hidden" }] }) };
    const transport = new CatalogEnforcedTransport(inner, new CatalogRuntimeEnforcer(catalog, principal()));
    await expect(transport.request("app/installed", { forceRefresh: false }, "apps", 100)).resolves.toMatchObject({ apps: [{ id: "mail" }] });
    await expect(transport.request("app/list", {}, "apps-list", 100)).resolves.toMatchObject({ data: [{ id: "mail" }] });
    await expect(transport.request("mcpServerStatus/list", {}, "mcp-list", 100)).resolves.toMatchObject({ data: [{ server: "mail" }] });
    await expect(transport.request("plugin/install", {}, "install", 100)).rejects.toBeInstanceOf(CatalogRuntimeDeniedError);
    await expect(transport.request("mcpServer/tool/call", { server: "mail", tool: "erase" }, "tool", 100)).rejects.toMatchObject({ code: "CATALOG_MCP_DENIED" });
    expect(inner.request).toHaveBeenCalledTimes(3);
  });

  it("filters the pinned MCP inventory by name while preserving tool, connection and cursor metadata", () => {
    const connected = {
      name: "mail", runtimeStatus: "connected", pluginId: "mail-plugin", httpOrigin: "https://mail.example.test",
      serverInfo: null, serverCapabilities: { tools: { listChanged: true } },
      tools: { search: { name: "search", description: "Search connected mail", inputSchema: { type: "object" } } },
      toolsError: null, resources: [], resourceTemplates: [], authStatus: "oAuth",
    } satisfies ListMcpServerStatusResponse["data"][number];
    const response = { data: [connected, { ...connected, name: "foreign-server" }], nextCursor: "next-page" } satisfies ListMcpServerStatusResponse;
    const filtered = new CatalogRuntimeEnforcer(catalog, principal()).filterMcpStatus(response);
    expect(filtered).toEqual({ ...response, data: [connected] });
    expect((filtered as unknown as ListMcpServerStatusResponse).data[0]).toBe(connected);
    expect(new CatalogRuntimeEnforcer(catalog, principal({ installationId: "foreign-company" })).filterMcpStatus(response))
      .toEqual({ ...response, data: [] });
    const denied = { ...catalog, rules: [...catalog.rules, rule("deny-mail", "user", USER_B, mcp.id, "deny", ["read"])] };
    expect(new CatalogRuntimeEnforcer(denied, principal({ userId: USER_B })).filterMcpStatus(response))
      .toEqual({ ...response, data: [] });
  });

  it("supports legacy MCP server names without allowing an alias to override the pinned name", () => {
    const legacy = { server: "mail", tools: { search: { description: "Legacy tool metadata" } }, authStatus: "oAuth" };
    const response = { servers: [legacy, { server: "foreign-server" },
      { name: "foreign-server", server: "mail" }, { name: null, server: "mail" }], nextCursor: "legacy-next" };
    expect(new CatalogRuntimeEnforcer(catalog, principal()).filterMcpStatus(response))
      .toEqual({ ...response, servers: [legacy] });
  });
});
