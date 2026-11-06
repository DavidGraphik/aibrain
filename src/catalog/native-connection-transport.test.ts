import { describe, expect, it, vi } from "vitest";
import type { CatalogResource } from "./contracts";
import { NativeConnectionTransport, assertPersonalNativeConnectionIdentity } from "./native-connection-transport";

vi.mock("server-only", () => ({}));
const resource: CatalogResource = { id: "company-crm", kind: "mcp", label: "CRM", credentialMode: "personal-oauth",
  managedBy: "company", sharedResource: false, appId: null, connectorId: null,
  mcp: { server: "crm", readTools: ["search"], sensitiveWriteTools: ["update"] } };
const USER = "00000000-0000-4000-8000-000000000001";
const make = (result: unknown = {}) => {
  const inner = { request: vi.fn().mockResolvedValue(result) };
  const current = vi.fn().mockResolvedValue(resource);
  return { inner, current, transport: new NativeConnectionTransport(inner, resource, current) };
};

describe("native connection management boundary", () => {
  it("binds connector/asdk app inventories and local flags to the exact provider ID", async () => {
    for (const appId of ["connector_00000000000000000000000000000001", "asdk_app_synthetic_123"]) {
      const app: CatalogResource = { ...resource, kind: "app", appId, mcp: null };
      const inner = { request: vi.fn().mockResolvedValue({ apps: [{ id: appId, enabled: true, callable: true }, { id: "foreign", enabled: true, callable: true }] }) };
      const transport = new NativeConnectionTransport(inner, app, async () => app);
      expect(await transport.request("app/installed", { forceRefresh: true }, "status"))
        .toEqual({ apps: [{ id: appId, enabled: true, callable: true }] });
      await transport.request("config/value/write", { keyPath: `apps.${appId}.enabled`, value: false, mergeStrategy: "upsert" }, "local-flag");
      for (const keyPath of ["apps._default.enabled", "apps.foreign.enabled", `apps.${appId}.tools.send.enabled`, `apps.${appId}.enabled.other`]) {
        await expect(transport.request("config/value/write", { keyPath, value: true, mergeStrategy: "upsert" }, "foreign-flag")).rejects.toThrow();
      }
      await expect(transport.request("app/read", { appIds: ["foreign"], includeTools: true }, "foreign-read")).rejects.toThrow();
      expect(inner.request).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects an invalid provider app ID before dispatch even if a caller bypassed the store", async () => {
    for (const appId of ["_default", "apps.foreign.enabled", "connector_x/foreign"]) {
      const app: CatalogResource = { ...resource, kind: "app", appId, mcp: null };
      const inner = { request: vi.fn() };
      const transport = new NativeConnectionTransport(inner, app, async () => app);
      await expect(transport.request("app/installed", { forceRefresh: true }, "status")).rejects.toThrow();
      expect(inner.request).not.toHaveBeenCalled();
    }
  });

  it("starts OAuth only for the assigned server with configured scopes", async () => {
    const { inner, transport } = make({ authorizationUrl: "https://identity.example.test/authorize" });
    await transport.request("mcpServer/oauth/login", { name: "crm" }, "login");
    expect(inner.request).toHaveBeenCalledOnce();
    for (const params of [{ name: "foreign" }, { name: "crm", scopes: ["admin"] }, { name: "crm", threadId: "foreign-thread" }]) {
      await expect(transport.request("mcpServer/oauth/login", params, "login")).rejects.toThrow();
    }
    expect(inner.request).toHaveBeenCalledOnce();
  });
  it("permits only one local enabled flag, never provider configuration or paths", async () => {
    const { inner, transport } = make();
    await transport.request("config/value/write", { keyPath: "mcp_servers.crm.enabled", value: false, mergeStrategy: "upsert" }, "disconnect");
    for (const params of [
      { keyPath: "mcp_servers.other.enabled", value: true, mergeStrategy: "upsert" },
      { keyPath: "mcp_servers.crm.url", value: "https://foreign.test", mergeStrategy: "upsert" },
      { keyPath: "mcp_servers.crm.enabled", value: true, mergeStrategy: "upsert", filePath: "/foreign/config.toml" },
    ]) await expect(transport.request("config/value/write", params, "write")).rejects.toThrow();
    expect(inner.request).toHaveBeenCalledOnce();
    await expect(transport.request("mcpServer/tool/call", { server: "crm", tool: "update", arguments: {} }, "invoke")).rejects.toThrow();
    await expect(transport.request("plugin/install", {}, "install")).rejects.toThrow();
  });
  it("projects config without secrets or foreign resources and never invents missing config", async () => {
    const { transport, inner } = make({ config: { mcp_servers: { crm: { enabled: false, http_headers: { Authorization: "secret" } }, foreign: { enabled: true } } }, layers: ["secret"] });
    expect(await transport.request("config/read", { includeLayers: false }, "readback"))
      .toEqual({ config: { mcp_servers: { crm: { enabled: false } } } });
    inner.request.mockResolvedValue({ config: { mcp_servers: {} } });
    expect(await transport.request("config/read", { includeLayers: false }, "readback")).toEqual({ config: { mcp_servers: {} } });
    await expect(transport.request("config/read", { includeLayers: true }, "readback")).rejects.toThrow();
  });
  it("rechecks revocation and target replacement before every dispatch", async () => {
    const { transport, inner, current } = make();
    await transport.request("config/mcpServer/reload", undefined, "reload");
    current.mockResolvedValue({ ...resource, mcp: { ...resource.mcp!, server: "foreign" } });
    await expect(transport.request("config/mcpServer/reload", undefined, "reload")).rejects.toThrow();
    current.mockRejectedValue(new Error("revoked"));
    await expect(transport.request("config/mcpServer/reload", undefined, "reload")).rejects.toThrow("revoked");
    expect(inner.request).toHaveBeenCalledOnce();
  });
  it("filters native inventories and disallows a foreign thread", async () => {
    const { transport } = make({ data: [{ name: "crm", tools: {} }, { name: "foreign", tools: {} }], nextCursor: null });
    expect(await transport.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly" }, "status"))
      .toEqual({ data: [{ name: "crm", tools: {} }], nextCursor: null });
    await expect(transport.request("mcpServerStatus/list", { threadId: "foreign" }, "status")).rejects.toThrow();
  });
  it("does not release a result after access or its tool set changed during the RPC", async () => {
    const { transport, current, inner } = make({ data: [{ name: "crm", tools: {} }], nextCursor: null });
    current.mockResolvedValueOnce(resource).mockResolvedValueOnce({ ...resource, mcp: { ...resource.mcp!, readTools: [] } });
    await expect(transport.request("mcpServerStatus/list", {}, "status")).rejects.toThrow();
    expect(inner.request).toHaveBeenCalledOnce();
  });
  it("rejects shared model identities for personal native connections", () => {
    expect(() => assertPersonalNativeConnectionIdentity(USER, {})).not.toThrow();
    for (const env of [{ AIBRAIN_CODEX_AUTH_SCOPE: "shared-qa" }, { AIBRAIN_CODEX_AUTH_SCOPE: "installation-owner" },
      { AIBRAIN_CODEX_OWNER_AUTH_SOCKET: "/operator/socket" }, { AIBRAIN_SHARED_CODEX_AUTH_SOURCE: "/operator/auth" }]) {
      expect(() => assertPersonalNativeConnectionIdentity(USER, env)).toThrow();
    }
  });
});

describe("server-only callback provisioning bound to a persisted lease", () => {
  const url = "https://brain.example/api/connectors/native/callback";
  it("writes only this server's leased callback scalars, reloads and verifies effective config", async () => {
    const oauth: Record<string, unknown> = {};
    const inner = { request: vi.fn(async (method: string, params: unknown) => {
      if (method === "config/value/write") { const p = params as { keyPath: string; value: unknown }; oauth[p.keyPath.split(".").at(-1)!] = p.value; return {}; }
      return method === "config/read" ? { config: { mcp_servers: { crm: { enabled: true, oauth } } } } : {};
    }) };
    const lease = vi.fn().mockResolvedValue(undefined), transport = new NativeConnectionTransport(inner, resource, async () => resource, lease);
    await transport.configureCallback(url, 43100, "https://brain.example");
    expect(lease).toHaveBeenCalledTimes(2);
    expect(inner.request.mock.calls.map(call => call[0])).toEqual(["config/value/write", "config/value/write", "config/mcpServer/reload", "config/read"]);
    expect(inner.request.mock.calls[0][1]).toEqual({ keyPath: "mcp_servers.crm.oauth.callback_url", value: url, mergeStrategy: "upsert" });
    expect(inner.request.mock.calls[1][1]).toEqual({ keyPath: "mcp_servers.crm.oauth.callback_port", value: 43100, mergeStrategy: "upsert" });
    await expect(transport.request("config/value/write", { keyPath: "mcp_servers.crm.oauth.callback_port", value: 43100, mergeStrategy: "upsert" }, "untrusted")).rejects.toThrow();
  });
  it("rejects unleased, foreign-origin/path, zero-port and revoked settings before writes", async () => {
    const { inner, current } = make();
    const lease = vi.fn().mockRejectedValue(new Error("lease revoked"));
    const transport = new NativeConnectionTransport(inner, resource, current, lease);
    for (const [target, port] of [["https://foreign.example/api/connectors/native/callback", 43100], ["https://brain.example/foreign", 43100], [url, 0]] as const) {
      await expect(transport.configureCallback(target, port, "https://brain.example")).rejects.toThrow();
    }
    await expect(transport.configureCallback(url, 43100, "https://brain.example")).rejects.toThrow("lease revoked");
    await expect(new NativeConnectionTransport(inner, resource, current).configureCallback(url, 43100, "https://brain.example")).rejects.toThrow();
    expect(inner.request).not.toHaveBeenCalled();
  });
  it("does not accept CIMD, scopes, or arbitrary timeout overrides", async () => {
    const { inner, transport } = make();
    for (const params of [{ name: "crm", clientRegistration: "cimd" }, { name: "crm", clientRegistration: "auto" }, { name: "crm", clientRegistration: "dcr", timeoutSecs: 900 }]) {
      await expect(transport.request("mcpServer/oauth/login", params, "login")).rejects.toThrow();
    }
    expect(inner.request).not.toHaveBeenCalled();
  });
});

 it("projects only static-client presence without exposing its ID or secret", async () => {
  const {transport}=make({config:{mcp_servers:{crm:{enabled:true,oauth:{callback_url:"https://brain.example/api/connectors/native/callback",callback_port:43100,client_id:"private-client-id",client_secret:"private-client-secret"}}}}});
  const response=await transport.request("config/read",{includeLayers:false},"static-shape");
  expect(response).toMatchObject({config:{mcp_servers:{crm:{oauth:{client_id_configured:true}}}}});
  expect(JSON.stringify(response)).not.toContain("private-client-id");expect(JSON.stringify(response)).not.toContain("private-client-secret");
 });
