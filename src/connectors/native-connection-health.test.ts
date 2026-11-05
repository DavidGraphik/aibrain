import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogResource } from "@/catalog/contracts";
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
    mocks.request.mockResolvedValue({ data: [{ id: "files", isEnabled: true, isAccessible: true }], nextCursor: null });
    expect((await check([app("files")])).get("resource-files")).toEqual(connected);
    expect(mocks.transportForUser).toHaveBeenCalledExactlyOnceWith("tenant-a", "user-a");
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith("app/list", { forceRefetch: true, threadId: null }, "connector-native-connection-health", 10_000);
    mocks.request.mockClear().mockResolvedValue({ data: [{ name: "files", runtimeStatus: "connected", authStatus: "oAuth" }], nextCursor: null });
    expect((await check([mcp("files")], "user-b")).get("resource-files")).toEqual(connected);
    expect(mocks.transportForUser).toHaveBeenLastCalledWith("tenant-a", "user-b");
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith("mcpServerStatus/list", { detail: "toolsAndAuthOnly", threadId: null }, "connector-native-connection-health", 10_000);
  });

  it("requires enabled, accessible apps and maps missing or malformed apps without affecting healthy ones", async () => {
    mocks.request.mockResolvedValue({ data: [
      { id: "ready", isEnabled: true, isAccessible: true, providerRef: "private-reference" },
      { id: "login", isEnabled: true, isAccessible: false },
      { id: "disabled", isEnabled: false, isAccessible: true },
      { id: "malformed", isEnabled: true },
    ], nextCursor: null });
    const result = await check(["ready", "login", "disabled", "malformed", "absent"].map(app));
    expect(result.get("resource-ready")).toEqual(connected);
    expect(result.get("resource-login")).toMatchObject({ status: "reauth_required" });
    expect(result.get("resource-disabled")).toMatchObject({ status: "not_configured" });
    expect(result.get("resource-malformed")).toMatchObject({ status: "degraded" });
    expect(result.get("resource-absent")).toMatchObject({ status: "not_configured" });
    expect(JSON.stringify([...result])).not.toContain("private-reference");
  });

  it("requires a connected MCP runtime and handles login and unavailable states independently", async () => {
    const rows = [
      { name: "ready", runtimeStatus: "connected", authStatus: "oAuth" },
      { name: "noauth", runtimeStatus: "connected", authStatus: "unsupported" },
      { name: "unknown-auth", runtimeStatus: "connected", authStatus: "unknown" },
      { name: "login", runtimeStatus: "connected", authStatus: "notLoggedIn" },
      { name: "authenticate", runtimeStatus: "authenticationRequired", authStatus: "unknown" },
      { name: "starting", runtimeStatus: "starting", authStatus: "oAuth" },
      { name: "failed", runtimeStatus: "failed", authStatus: "oAuth" },
      { name: "malformed", runtimeStatus: "connected" },
    ];
    mocks.request.mockResolvedValue({ data: rows, nextCursor: null });
    const result = await check([...rows.map(({ name }) => mcp(name)), mcp("absent")]);
    for (const name of ["ready", "noauth", "unknown-auth"]) expect(result.get(`resource-${name}`)).toEqual(connected);
    for (const name of ["login", "authenticate"]) expect(result.get(`resource-${name}`)).toMatchObject({ status: "reauth_required" });
    for (const name of ["starting", "failed", "malformed", "absent"]) expect(result.get(`resource-${name}`)).toMatchObject({ status: "degraded" });
  });

  it("follows server cursors beyond twenty pages, including empty filtered pages, for apps and MCP", async () => {
    mocks.request.mockImplementation(async (method, params) => {
      const page = params.cursor === undefined ? 0 : Number(String(params.cursor).slice(5));
      if (page < 25) return { data: [], nextCursor: `page-${page + 1}` };
      return { data: method === "app/list" ? [{ id: "files", isEnabled: true, isAccessible: true }]
        : [{ name: "search", runtimeStatus: "connected", authStatus: "bearerToken" }], nextCursor: null };
    });
    expect(await check([app("files"), mcp("search")])).toEqual(new Map([
      ["resource-files", connected], ["resource-search", connected],
    ]));
    expect(mocks.request).toHaveBeenCalledTimes(52);
    expect(mocks.request.mock.calls.every(([, params]) => params.limit === undefined)).toBe(true);
  });

  it("never matches a foreign server through a legacy alias or exports unrequested provider entries", async () => {
    mocks.request.mockResolvedValue({ data: [
      { name: "foreign", server: "allowed", runtimeStatus: "connected", authStatus: "oAuth", providerRef: "foreign-private" },
      { server: "allowed", runtimeStatus: "connected", authStatus: "oAuth" },
    ], nextCursor: null });
    const result = await check([mcp("allowed")]);
    expect([...result.keys()]).toEqual(["resource-allowed"]);
    expect(result.get("resource-allowed")).toMatchObject({ status: "degraded" });
    expect(JSON.stringify([...result])).not.toMatch(/foreign|providerRef/);
  });

  it.each(["app/list", "mcpServerStatus/list"])("isolates a %s provider failure from the other inventory", async failingMethod => {
    mocks.request.mockImplementation(async method => {
      if (method === failingMethod) throw new Error("private provider failure");
      return { data: method === "app/list" ? [{ id: "files", isEnabled: true, isAccessible: true }]
        : [{ name: "search", runtimeStatus: "connected", authStatus: "oAuth" }], nextCursor: null };
    });
    const result = await check([app("files"), mcp("search")]);
    expect(result.get(failingMethod === "app/list" ? "resource-files" : "resource-search")).toMatchObject({ status: "degraded" });
    expect(result.get(failingMethod === "app/list" ? "resource-search" : "resource-files")).toEqual(connected);
    expect(JSON.stringify([...result])).not.toContain("private provider failure");
  });

  it("fails closed for a transport failure, malformed page, cursor cycle or duplicate entry", async () => {
    mocks.transportForUser.mockRejectedValueOnce(new Error("private auth failure"));
    const failed = await check([app("files"), mcp("search")]);
    expect([...failed.values()]).toEqual([
      { status: "degraded", statusCode: "NATIVE_CONNECTION_UNAVAILABLE" },
      { status: "degraded", statusCode: "NATIVE_CONNECTION_UNAVAILABLE" },
    ]);
    expect(mocks.request).not.toHaveBeenCalled();
    for (const response of [
      { data: null, nextCursor: null },
      { data: [{ id: "files", isEnabled: true, isAccessible: true }], nextCursor: "repeat" },
      { data: [{ id: "files", isEnabled: true, isAccessible: true }, { id: "files", isEnabled: true, isAccessible: true }], nextCursor: null },
    ]) {
      mocks.request.mockResolvedValue(response);
      expect((await check([app("files")])).get("resource-files")).toMatchObject({ status: "degraded" });
    }
  });
});
