import { describe, expect, it, vi } from "vitest";
import { CatalogRuntimeEnforcer } from "@/catalog/runtime-enforcement";
import type { CatalogPrincipal, CatalogResource, CatalogState } from "@/catalog/contracts";
import { nativeMcpConfigForTurn } from "./native-mcp-config";
const resource: CatalogResource = { id: "crm", kind: "mcp", label: "CRM", credentialMode: "personal-oauth", managedBy: "company",
  sharedResource: false, appId: null, connectorId: null, mcp: { server: "crm", readTools: ["search", "edit"], sensitiveWriteTools: ["edit"] } };
const state: CatalogState = { schemaVersion: 1, installationId: "synthetic", revision: 1, resources: [resource],
  rules: [{ id: "read", scope: "installation", subjectId: null, resourceId: "crm", effect: "allow", operations: ["read"] }] };
const principal: CatalogPrincipal = { installationId: "synthetic", userId: "00000000-0000-4000-8000-000000000001", roleId: "workspace-member", groupIds: [], workspaceCanExecute: true };
const enforcer = (s = state, p = principal) => new CatalogRuntimeEnforcer(s, p);
describe("Codex native MCP turn configuration", () => {
  it("bounds the real model toolset, disables unknown servers and strips write overlap", async () => {
    const transport = { request: vi.fn().mockResolvedValue({ config: { mcp_servers: { crm: { url: "https://secret.test" }, foreign: { command: "private" } } } }) };
    expect(await nativeMcpConfigForTurn(transport, async () => enforcer(), new Set(["crm"]), "test"))
      .toEqual({ "mcp_servers.crm.enabled": true, "mcp_servers.crm.enabled_tools": ["search"], "mcp_servers.foreign.enabled": false, "mcp_servers.foreign.enabled_tools": [] });
  });
  it("permits native write tools only while both workspace and current catalog permit them", () => {
    const writable: CatalogState = { ...state, rules: [{ ...state.rules[0], operations: ["read", "write"] }] };
    expect(enforcer(writable).nativeMcpConfig(["crm"], new Set(["crm"]), true)["mcp_servers.crm.enabled_tools"]).toEqual(["edit", "search"]);
    expect(enforcer(writable).nativeMcpConfig(["crm"], new Set(["crm"]))["mcp_servers.crm.enabled_tools"]).toEqual(["search"]);
    expect(enforcer(writable, { ...principal, workspaceCanExecute: false }).nativeMcpConfig(["crm"], new Set(["crm"]), true)["mcp_servers.crm.enabled_tools"]).toEqual(["search"]);
    expect(enforcer({ ...writable, rules: [] }).nativeMcpConfig(["crm"], new Set(["crm"]))["mcp_servers.crm.enabled"]).toBe(false);
  });
  it("does not enable disconnected or ambiguous servers and rejects config path injection", () => {
    expect(enforcer().nativeMcpConfig(["crm"], new Set())["mcp_servers.crm.enabled"]).toBe(false);
    expect(enforcer({ ...state, resources: [resource, { ...resource, id: "alias" }], rules: [...state.rules, { ...state.rules[0], id: "alias-rule", resourceId: "alias" }] })
      .nativeMcpConfig(["crm"], new Set(["crm", "alias"]))["mcp_servers.crm.enabled"]).toBe(false);
    expect(() => enforcer().nativeMcpConfig(["crm.enabled"], new Set(["crm"]))).toThrow();
  });
  it("fails closed when native config is unavailable", async () => {
    const transport = { request: vi.fn().mockResolvedValue({}) };
    await expect(nativeMcpConfigForTurn(transport, async () => enforcer(), new Set(), "test")).rejects.toThrow("NATIVE_MCP_CONFIG_UNAVAILABLE");
  });
  it("cannot reenable an entire plugin from one declared server override", async () => {
    const transport = { request: vi.fn().mockResolvedValue({ config: { plugins: {
      "crm@company": { enabled: true, mcp_servers: { crm: { enabled: true } } },
      "unmapped@company": { enabled: true },
    } } }) };
    const config = await nativeMcpConfigForTurn(transport, async () => enforcer(), new Set(["crm"]), "test");
    expect(config['plugins."crm@company".enabled']).toBe(false);
    expect(config['plugins."unmapped@company".enabled']).toBe(false);
    expect(config['plugins."crm@company".mcp_servers.crm.enabled_tools']).toEqual(["search"]);
  });
});
