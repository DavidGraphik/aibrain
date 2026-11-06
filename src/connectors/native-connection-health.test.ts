import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogResource, CatalogState, CatalogPrincipal } from "@/catalog/contracts";
import { CatalogEnforcedTransport, CatalogRuntimeEnforcer } from "@/catalog/runtime-enforcement";
import { nativeAppToolsForTurn } from "@/runtime/native-app-tools";
import { connectedAppConfig } from "@/runtime/connected-app-config";
import { nativeConnectionHealthForIdentity } from "./native-connection-health";

const mocks = vi.hoisted(() => ({
  transportForUser: vi.fn(),
  request: vi.fn<(method: string, params: Record<string, unknown>, purpose: string, timeout: number) => Promise<unknown>>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/catalog/server-service", () => ({ catalogTransportForUser: mocks.transportForUser }));

function app(id: string): CatalogResource {
  return { id: `resource-${id}`, label: id, kind: "app", appId: id, connectorId: null, mcp: null,
    credentialMode: "personal-oauth", managedBy: "company", sharedResource: false };
}
function mcp(id: string): CatalogResource {
  return { ...app(id), kind: "mcp", appId: null, mcp: { server: id, readTools: ["read"], sensitiveWriteTools: [] } };
}
const check = (resources: readonly CatalogResource[], userId = "user-a") => nativeConnectionHealthForIdentity("tenant-a", userId, resources);
const callableTools = { read: { name: "read", inputSchema: { type: "object" } } };
const connected = { status: "connected", statusCode: null };

describe("native connection health for an authenticated catalog identity", () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.transportForUser.mockReset().mockResolvedValue({ request: mocks.request });
  });

  it("does not load runtime inventories for ordinary connectors or skills", async () => {
    const connector = { ...app("mail"), kind: "connector" as const, appId: null, connectorId: "mail" };
    expect(await check([connector])).toEqual(new Map());
    expect(mocks.transportForUser).not.toHaveBeenCalled();
  });

  it("binds each lookup to its exact tenant/user and queries only the requested resource kinds", async () => {
    mocks.request.mockResolvedValue({ apps: [{ id: "files", enabled: true, callable: true }] });
    expect((await check([app("files")])).get("resource-files")).toEqual(connected);
    expect(mocks.transportForUser).toHaveBeenCalledExactlyOnceWith("tenant-a", "user-a");
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith("app/installed", { forceRefresh: false, threadId: null }, expect.stringMatching(/^connector-native-connection-health:[a-f0-9-]{36}:apps:0:committed$/), 10_000);
    mocks.request.mockClear().mockResolvedValue({ data: [{ name: "files", runtimeStatus: "connected", authStatus: "oAuth", toolsError: null, tools: callableTools }], nextCursor: null });
    expect((await check([mcp("files")], "user-b")).get("resource-files")).toEqual(connected);
    expect(mocks.transportForUser).toHaveBeenLastCalledWith("tenant-a", "user-b");
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith("mcpServerStatus/list", { detail: "toolsAndAuthOnly", threadId: null }, expect.stringMatching(/^connector-native-connection-health:[a-f0-9-]{36}:mcp:0$/), 10_000);
  });

  it("requires enabled, callable installed apps and keeps an incomplete snapshot closed", async () => {
    mocks.request.mockResolvedValue({ apps: [
      { id: "ready", enabled: true, callable: true, providerRef: "private-reference" },
      { id: "login", enabled: true, callable: false },
      { id: "disabled", enabled: false, callable: true },
    ], nextCursor: null });
    const result = await check(["ready", "login", "disabled", "absent"].map(app));
    expect(result.get("resource-ready")).toEqual(connected);
    expect(result.get("resource-login")).toMatchObject({ status: "degraded", statusCode: "NATIVE_APP_NOT_CALLABLE" });
    expect(result.get("resource-disabled")).toMatchObject({ status: "not_configured" });
    expect(result.get("resource-absent")).toMatchObject({ status: "not_configured" });
    expect(JSON.stringify([...result])).not.toContain("private-reference");
    mocks.request.mockResolvedValue({ apps: [{ id: "ready", enabled: true, callable: true }, { id: "malformed", enabled: true }] });
    const incomplete = await check(["ready", "malformed"].map(app));
    expect([...incomplete.values()]).toEqual([
      { status: "degraded", statusCode: "NATIVE_APP_READINESS_UNAVAILABLE" },
      { status: "degraded", statusCode: "NATIVE_APP_READINESS_UNAVAILABLE" },
    ]);
  });

  it("requires a connected MCP runtime and handles login and unavailable states independently", async () => {
    const rows = [
      { name: "ready", runtimeStatus: "connected", authStatus: "oAuth", toolsError: null, tools: callableTools },
      { name: "noauth", runtimeStatus: "connected", authStatus: "unsupported", toolsError: null, tools: callableTools },
      { name: "unknown-auth", runtimeStatus: "connected", authStatus: "unknown", toolsError: null, tools: callableTools },
      { name: "login", runtimeStatus: "connected", authStatus: "notLoggedIn", toolsError: null, tools: callableTools },
      { name: "authenticate", runtimeStatus: "authenticationRequired", authStatus: "unknown", toolsError: null, tools: callableTools },
      { name: "starting", runtimeStatus: "starting", authStatus: "oAuth", toolsError: null, tools: callableTools },
      { name: "failed", runtimeStatus: "failed", authStatus: "oAuth", toolsError: null, tools: callableTools },
      { name: "malformed", runtimeStatus: "connected" },
    ];
    mocks.request.mockResolvedValue({ data: rows, nextCursor: null });
    const result = await check([...rows.map(({ name }) => mcp(name)), mcp("absent")]);
    for (const name of ["ready", "noauth", "unknown-auth"]) expect(result.get(`resource-${name}`)).toEqual(connected);
    for (const name of ["login", "authenticate"]) expect(result.get(`resource-${name}`)).toMatchObject({ status: "reauth_required" });
    for (const name of ["starting", "failed", "malformed", "absent"]) expect(result.get(`resource-${name}`)).toMatchObject({ status: "degraded" });
  });

  it("does not call a MCP connected when tool discovery failed or only disallowed tools exist", async () => {
    for (const entry of [
      { toolsError: "provider unavailable", tools: callableTools },
      { toolsError: null, tools: {} },
      { toolsError: null, tools: { foreign: { name: "foreign", inputSchema: { type: "object" } } } },
    ]) {
      mocks.request.mockResolvedValue({ data: [{ name: "files", runtimeStatus: "connected", authStatus: "oAuth", ...entry }], nextCursor: null });
      expect((await check([mcp("files")])).get("resource-files")).toMatchObject({ status: "degraded" });
    }
  });

  it("counts a write-only MCP tool only with a current effective write grant", async () => {
    const resource = mcp("files");
    resource.mcp = { server: "files", readTools: [], sensitiveWriteTools: ["write"] };
    mocks.request.mockResolvedValue({ data: [{ name: "files", runtimeStatus: "connected", authStatus: "oAuth", toolsError: null,
      tools: { write: { name: "write", inputSchema: { type: "object" } } } }], nextCursor: null });
    expect((await check([resource])).get("resource-files")).toMatchObject({ status: "degraded" });
    expect((await nativeConnectionHealthForIdentity("tenant-a", "user-a", [resource], new Set([resource.id]))).get(resource.id)).toEqual(connected);
  });

  it("uses one installed-app snapshot and follows MCP cursors including empty filtered pages", async () => {
    mocks.request.mockImplementation(async (method, params) => {
      if (method === "app/installed") return { apps: [{ id: "files", enabled: true, callable: true }] };
      const page = params.cursor === undefined ? 0 : Number(String(params.cursor).slice(5));
      if (page < 25) return { data: [], nextCursor: `page-${page + 1}` };
      return { data: [{ name: "search", runtimeStatus: "connected", authStatus: "bearerToken", toolsError: null, tools: callableTools }], nextCursor: null };
    });
    expect(await check([app("files"), mcp("search")])).toEqual(new Map([
      ["resource-files", connected], ["resource-search", connected],
    ]));
    expect(mocks.request).toHaveBeenCalledTimes(27);
    expect(mocks.request.mock.calls.filter(([method]) => method === "app/installed")).toHaveLength(1);
  });

  it("never matches a foreign server through a legacy alias or exports unrequested provider entries", async () => {
    mocks.request.mockResolvedValue({ data: [
      { name: "foreign", server: "allowed", runtimeStatus: "connected", authStatus: "oAuth", providerRef: "foreign-private" },
      { server: "allowed", runtimeStatus: "connected", authStatus: "oAuth", toolsError: null, tools: callableTools },
    ], nextCursor: null });
    const result = await check([mcp("allowed")]);
    expect([...result.keys()]).toEqual(["resource-allowed"]);
    expect(result.get("resource-allowed")).toMatchObject({ status: "degraded" });
    expect(JSON.stringify([...result])).not.toMatch(/foreign|providerRef/);
  });

  it.each(["app/installed", "mcpServerStatus/list"])("isolates a %s provider failure from the other inventory", async failingMethod => {
    mocks.request.mockImplementation(async method => {
      if (method === failingMethod) throw new Error("private provider failure");
      return method === "app/installed" ? { apps: [{ id: "files", enabled: true, callable: true }] }
        : { data: [{ name: "search", runtimeStatus: "connected", authStatus: "oAuth", toolsError: null, tools: callableTools }], nextCursor: null };
    });
    const result = await check([app("files"), mcp("search")]);
    expect(result.get(failingMethod === "app/installed" ? "resource-files" : "resource-search")).toMatchObject({ status: "degraded" });
    expect(result.get(failingMethod === "app/installed" ? "resource-search" : "resource-files")).toEqual(connected);
    expect(JSON.stringify([...result])).not.toContain("private provider failure");
  });


  it("uses fresh observation IDs after a successful read and across providers/pages", async () => {
    const observed = new Set<string>();
    let enabled = true;
    mocks.request.mockImplementation(async (method, params, purpose) => {
      // Mirrors the durable boundary: a completed ID cannot request a fresh
      // provider observation. A reused ID must not accidentally prove health.
      if (observed.has(purpose)) throw new Error("Observation ID was reused");
      observed.add(purpose);
      if (method === "app/installed") return { apps: [{ id: "files", enabled, callable: enabled }] };
      return { data: params.cursor ? [{ name: "search", runtimeStatus: "connected", authStatus: "oAuth", toolsError: null, tools: callableTools }] : [],
        nextCursor: params.cursor ? null : "page-2" };
    });
    const resources = [app("files"), mcp("search")];
    expect([...await check(resources)]).toEqual([["resource-files", connected], ["resource-search", connected]]);
    expect([...await check(resources)]).toEqual([["resource-files", connected], ["resource-search", connected]]);
    enabled = false;
    expect((await check(resources)).get("resource-files")).toMatchObject({ status: "not_configured", statusCode: "NATIVE_APP_DISABLED" });
    expect(observed.size).toBe(9);
    expect(mocks.request.mock.calls.map(call => call[2])).toEqual(expect.arrayContaining([
      expect.stringMatching(/:apps:0:committed$/), expect.stringMatching(/:mcp:0$/), expect.stringMatching(/:mcp:1$/),
    ]));
  });

  it("admits an assigned provider connector ID distinct from its resource ID through health and read-only tool configuration", async () => {
    const appId = "connector_0123456789abcdef0123456789abcdef";
    const userId = "00000000-0000-4000-8000-000000000001";
    const resource: CatalogResource = { ...app("fixture"), id: "native-gmail", appId };
    const state: CatalogState = { schemaVersion: 1, installationId: "tenant-a", revision: 1, resources: [resource], rules: [
      { id: "own-read", resourceId: resource.id, scope: "user", subjectId: userId, effect: "allow", operations: ["read"] },
      { id: "own-deny-write", resourceId: resource.id, scope: "user", subjectId: userId, effect: "deny", operations: ["write"] },
    ] };
    const principal: CatalogPrincipal = { installationId: "tenant-a", userId, roleId: "workspace-member", groupIds: [], workspaceCanExecute: true };
    const catalog = new CatalogRuntimeEnforcer(state, principal);
    const inner = { request: vi.fn(async (method: string) => {
      if (method === "config/read") return { config: { apps: null } };
      if (method === "app/installed") return { apps: [{ id: appId, enabled: true, callable: true }, { id: "connector_foreign", enabled: true, callable: true }] };
      return { apps: [{ id: appId, toolSummaries: [
        { name: "get_profile", title: "Profile", description: "Read own profile", isEnabled: true, disabledReason: null, isReadOnly: true },
        { name: "send_email", title: "Send", description: "Send mail", isEnabled: true, disabledReason: null, isReadOnly: false },
      ] }], missingAppIds: [] };
    }) };
    const transport = new CatalogEnforcedTransport(inner, catalog);
    mocks.transportForUser.mockResolvedValue(transport);
    expect((await check([resource], userId)).get(resource.id)).toEqual(connected);
    const policies = await nativeAppToolsForTurn(inner, async () => catalog, [appId], "fixture-turn", true);
    const config = connectedAppConfig([appId], policies);
    expect(config["features.apps"]).toBe(true);
    expect(config.apps).toMatchObject({
      [appId]: { enabled: true, default_tools_enabled: false,
        tools: { get_profile: { enabled: true }, send_email: { enabled: false } } },
      connector_foreign: { enabled: false },
    });
    const foreign = new CatalogRuntimeEnforcer(state, { ...principal, userId: "00000000-0000-4000-8000-000000000002" });
    expect(foreign.filterApps({ apps: [{ id: appId, enabled: true, callable: true }] }, true)).toEqual({ apps: [] });
  });

  it("fails closed for a transport failure, malformed installed snapshot or duplicate entry", async () => {
    mocks.transportForUser.mockRejectedValueOnce(new Error("private auth failure"));
    const failed = await check([app("files"), mcp("search")]);
    expect([...failed.values()]).toEqual([
      { status: "degraded", statusCode: "NATIVE_APP_READINESS_UNAVAILABLE" },
      { status: "degraded", statusCode: "NATIVE_CONNECTION_UNAVAILABLE" },
    ]);
    expect(mocks.request).not.toHaveBeenCalled();
    for (const response of [
      { apps: null },
      { apps: [{ id: "files", enabled: true }] },
      { apps: [{ id: "files", enabled: true, callable: true }, { id: "files", enabled: true, callable: true }] },
    ]) {
      mocks.request.mockResolvedValue(response);
      expect((await check([app("files")])).get("resource-files")).toMatchObject({ status: "degraded" });
    }
  });
});

describe("pinned SDK global inventory has no thread runtime status", () => {
  beforeEach(() => { mocks.request.mockReset(); mocks.transportForUser.mockReset().mockResolvedValue({ request: mocks.request }); });
  it.each([
    [null, "oAuth", null, callableTools, "connected"],
    [undefined, "oAuth", null, callableTools, "degraded"],
    ["disabled", "oAuth", null, callableTools, "degraded"],
    ["authenticationRequired", "oAuth", null, callableTools, "reauth_required"],
    [null, "notLoggedIn", null, callableTools, "reauth_required"],
    [null, "oAuth", "failed", callableTools, "degraded"],
    [null, "oAuth", null, {}, "degraded"],
  ])("keeps auth/catalog/error checks for global status %s/%s", async (runtimeStatus, authStatus, toolsError, tools, status) => {
    mocks.request.mockResolvedValue({ data: [{ name: "fixture", runtimeStatus, authStatus, toolsError, tools }], nextCursor: null });
    expect((await check([mcp("fixture")])).get("resource-fixture")?.status).toBe(status);
  });
});
