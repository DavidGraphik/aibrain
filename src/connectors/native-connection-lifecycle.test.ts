import { describe, expect, it, vi } from "vitest";
import type { NativeConnectionContext } from "./native-connection-lifecycle";
import { completeNativeConnectionOAuth, nativeConnectionSnapshot, setNativeConnectionEnabled, startNativeConnectionOAuth } from "./native-connection-lifecycle";

const callback = "https://brain.example/native-callback/employee";
const authUrl = `https://provider.example/authorize?state=opaque&redirect_uri=${encodeURIComponent(callback)}`;
const callbackConfig = { config: { mcp_oauth_callback_url: callback, mcp_oauth_callback_port: 43100, mcp_servers: { mail: { enabled: false } } } };
let sequence = 0;
function fixture(overrides: Record<string, unknown> = {}) {
  const entry = { name: "mail", runtimeStatus: "connected", authStatus: "oAuth", toolsError: null,
    tools: {
      search: { name: "search", inputSchema: { type: "object" }, description: "Search mail" },
      write: { name: "write", inputSchema: { type: "object" } },
      foreign: { name: "foreign", inputSchema: { type: "object" } },
    }, ...overrides };
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "mcpServerStatus/list") return { data: [entry], nextCursor: null };
    if (method === "mcpServer/oauth/login") return { authorizationUrl: authUrl, loginId: "native-login" };
    if (method === "config/read") return callbackConfig;
    return {};
  });
  const context: NativeConnectionContext = { installationId: "tenant-a", userId: `user-${++sequence}`,
    resource: { id: "personal-mail", label: "Mail", kind: "mcp", credentialMode: "personal-oauth", managedBy: "company", sharedResource: false,
      appId: null, connectorId: null, mcp: { server: "mail", readTools: ["search"], sensitiveWriteTools: ["write"] } }, transport: { request } };
  return { context, request, entry };
}

describe("native personal connection lifecycle", () => {
  it("matches an underscored provider app ID exactly and still requires effective callability", async () => {
    const appId = "connector_00000000000000000000000000000001";
    const { context, request } = fixture();
    context.resource = { ...context.resource, kind: "app", appId, mcp: null };
    request.mockResolvedValue({ apps: [{ id: "foreign", enabled: true, callable: true }, { id: appId, enabled: true, callable: true }] });
    expect(await nativeConnectionSnapshot(context)).toMatchObject({ status: "connected", code: null, capabilities: { oauthLogin: false } });
    request.mockResolvedValue({ apps: [{ id: appId, enabled: true, callable: false }] });
    expect(await nativeConnectionSnapshot(context)).toMatchObject({ status: "unavailable", code: "NATIVE_APP_NOT_CALLABLE" });
    expect(request.mock.calls.every(([method]) => method === "app/installed")).toBe(true);
  });

  it("discovers real permitted tools without exposing foreign tools or raw provider metadata", async () => {
    const { context, request } = fixture({ providerToken: "private", httpOrigin: "https://private-provider.example" });
    const snapshot = await nativeConnectionSnapshot(context);
    expect(snapshot.status).toBe("connected");
    expect(snapshot.tools.map(tool => [tool.name, tool.operation])).toEqual([["search", "read"], ["write", "write"]]);
    expect(JSON.stringify(snapshot)).not.toMatch(/private|foreign/);
    expect(request).toHaveBeenCalledExactlyOnceWith("mcpServerStatus/list", { serverName: "mail", threadId: null, detail: "toolsAndAuthOnly", limit: 100 }, expect.stringMatching(/^connector-native-lifecycle:[a-f0-9-]{36}:[0-9]+$/), 15_000);
  });

  it.each([
    [{ runtimeStatus: "starting" }, "unavailable"],
    [{ runtimeStatus: "authenticationRequired" }, "reauth_required"],
    [{ runtimeStatus: "disabled" }, "disabled"],
    [{ toolsError: "private-provider-error" }, "unavailable"],
    [{ tools: {} }, "unavailable"],
  ])("does not treat a listed server as callable: %j", async (overrides, status) => {
    expect((await nativeConnectionSnapshot(fixture(overrides).context)).status).toBe(status);
  });

  it("uses effective installed-app state, not display metadata or accessibility", async () => {
    const { context, request } = fixture();
    context.resource = { ...context.resource, kind: "app", appId: "gmail", mcp: null };
    request.mockResolvedValue({ apps: [{ id: "gmail", enabled: true, callable: false, isAccessible: true }] });
    expect(await nativeConnectionSnapshot(context)).toMatchObject({ status: "unavailable", code: "NATIVE_APP_NOT_CALLABLE", capabilities: { oauthLogin: false } });
    await expect(startNativeConnectionOAuth(context)).rejects.toMatchObject({ code: "NATIVE_APP_AUTH_MANAGED_EXTERNALLY" });
    expect(request.mock.calls.every(([method]) => method === "app/installed")).toBe(true);
  });

  it("starts only the exact configured server's OAuth, without supplied scopes or callback", async () => {
    const { context, request } = fixture({ authStatus: "notLoggedIn", runtimeStatus: "authenticationRequired" });
    const result = await startNativeConnectionOAuth(context);
    expect(result).toMatchObject({ completion: "pending", verification: "provider-consent-required", loginId: "native-login" });
    expect(request).toHaveBeenLastCalledWith("mcpServer/oauth/login", { name: "mail", threadId: null }, expect.stringMatching(/^connector-native-lifecycle:[a-f0-9-]{36}:[0-9]+$/), 15_000);
    await expect(startNativeConnectionOAuth(context)).rejects.toMatchObject({ code: "NATIVE_OAUTH_ALREADY_PENDING" });
    const completed = { name: "mail", threadId: null, loginId: "native-login", success: true };
    expect(completeNativeConnectionOAuth({ ...context, userId: "foreign" }, completed)).toBe(false);
    expect(completeNativeConnectionOAuth(context, { ...completed, loginId: "wrong" })).toBe(false);
    expect(completeNativeConnectionOAuth(context, { ...completed, threadId: "foreign-thread" })).toBe(false);
    expect(completeNativeConnectionOAuth(context, completed)).toBe(true);
    expect(await nativeConnectionSnapshot(context)).toMatchObject({ login: { state: "completed" }, status: "reauth_required" });
  });

  it("correlates completion arriving before the login response, without accepting another login", async () => {
    const { context, request } = fixture({ authStatus: "notLoggedIn" });
    const original = request.getMockImplementation()!;
    request.mockImplementation(async method => {
      if (method === "mcpServer/oauth/login") {
        completeNativeConnectionOAuth(context, { name: "mail", threadId: null, loginId: "native-login", success: true });
        return { authorizationUrl: authUrl, loginId: "native-login" };
      }
      return original(method);
    });
    expect(await startNativeConnectionOAuth(context)).toMatchObject({ completion: "completed" });
    expect(await nativeConnectionSnapshot(context)).toMatchObject({ login: { state: "completed" } });
  });

  it("does not invent completion for older servers without login IDs", async () => {
    const { context, request } = fixture({ authStatus: "notLoggedIn" });
    request.mockImplementation(async method => method === "config/read" ? callbackConfig : method === "mcpServer/oauth/login"
      ? { authorizationUrl: authUrl } : { data: [{ name: "mail", runtimeStatus: "authenticationRequired", authStatus: "notLoggedIn", tools: {} }], nextCursor: null });
    expect(await startNativeConnectionOAuth(context)).toMatchObject({ loginId: null, completion: "uncorrelated" });
    expect(completeNativeConnectionOAuth(context, { name: "mail", threadId: null, success: true })).toBe(false);
  });

  it.each(["file:///tmp/private", "javascript:alert(1)", "http://provider.example/auth", "http://127.0.0.1:4000/auth", "https://user:secret@provider.example/auth"])("rejects unsafe provider authorization URL %s", async url => {
    const { context, request, entry } = fixture({ authStatus: "notLoggedIn" });
    request.mockImplementation(async method => method === "config/read" ? callbackConfig : method === "mcpServer/oauth/login" ? { authorizationUrl: url, loginId: "id" } : { data: [entry], nextCursor: null });
    await expect(startNativeConnectionOAuth(context)).rejects.toMatchObject({ code: "NATIVE_OAUTH_RESPONSE_INVALID" });
  });

  it.each([undefined, "http://127.0.0.1/callback", "https://localhost/callback", "https://[::1]/callback", "https://[::ffff:127.0.0.1]/callback"])("blocks a remote worker's unreachable callback %s before starting consent", async configured => {
    const { context, request, entry } = fixture({ authStatus: "notLoggedIn" });
    request.mockImplementation(async method => method === "config/read"
      ? { config: { ...(configured ? { mcp_oauth_callback_url: configured } : {}), mcp_servers: { mail: { enabled: true } } } }
      : { data: [entry], nextCursor: null });
    await expect(startNativeConnectionOAuth(context)).rejects.toMatchObject({ code: "NATIVE_OAUTH_CALLBACK_UNREACHABLE" });
    expect(request.mock.calls.some(([method]) => method === "mcpServer/oauth/login")).toBe(false);
  });

  it.each([
    ["http://127.0.0.1:1234/callback", "NATIVE_OAUTH_CALLBACK_UNREACHABLE"],
    ["https://foreign.example/callback", "NATIVE_OAUTH_CALLBACK_MISMATCH"],
    ["https://brain.example/another-employee", "NATIVE_OAUTH_CALLBACK_MISMATCH"],
    [null, "NATIVE_OAUTH_CALLBACK_UNVERIFIED"],
  ])("checks the real native redirect against provisioned ingress %s", async (actual, code) => {
    const { context, request, entry } = fixture({ authStatus: "notLoggedIn" });
    request.mockImplementation(async method => method === "config/read" ? callbackConfig
      : method === "mcpServer/oauth/login" ? { authorizationUrl: `https://provider.example/authorize${actual ? `?redirect_uri=${encodeURIComponent(actual)}` : ""}`, loginId: "id" }
        : { data: [entry], nextCursor: null });
    await expect(startNativeConnectionOAuth(context)).rejects.toMatchObject({ code });
  });

  it("accepts the provider callback suffix while keeping live ingress acceptance explicit", async () => {
    const { context, request, entry } = fixture({ authStatus: "notLoggedIn" });
    request.mockImplementation(async method => method === "config/read" ? callbackConfig
      : method === "mcpServer/oauth/login" ? { authorizationUrl: `https://provider.example/authorize?redirect_uri=${encodeURIComponent(callback + "/provider-callback-id")}`, loginId: "id" }
        : { data: [entry], nextCursor: null });
    expect(await startNativeConnectionOAuth(context)).toMatchObject({ completion: "pending", callbackVerification: "configured-external-ingress-live-acceptance-required" });
  });

  it("requires a configured listener port rather than inferring it from the external callback URL", async () => {
    const { context, request, entry } = fixture({ authStatus: "notLoggedIn" });
    request.mockImplementation(async method => method === "config/read"
      ? { config: { mcp_oauth_callback_url: "https://brain.example:8443/native-callback", mcp_servers: { mail: { enabled: true } } } }
      : { data: [entry], nextCursor: null });
    await expect(startNativeConnectionOAuth(context)).rejects.toMatchObject({ code: "NATIVE_OAUTH_CALLBACK_LISTENER_NOT_CONFIGURED" });
    expect(request.mock.calls.some(([method]) => method === "mcpServer/oauth/login")).toBe(false);
  });

  it("locally disables exactly one configured MCP and explicitly retains remote credentials", async () => {
    const { context, request, entry } = fixture();
    let disabled = false;
    request.mockImplementation(async method => {
      if (method === "config/value/write") { disabled = true; return { status: "ok" }; }
      if (method === "config/read") return callbackConfig;
      if (method === "mcpServerStatus/list") return { data: [{ ...entry, runtimeStatus: disabled ? "disabled" : "connected" }], nextCursor: null };
      return {};
    });
    const result = await setNativeConnectionEnabled(context, false);
    expect(result).toMatchObject({ effect: "local-connection-disabled", providerCredentialsRevoked: false, connection: { status: "disabled" } });
    expect(request).toHaveBeenCalledWith("config/value/write", { keyPath: "mcp_servers.mail.enabled", value: false, mergeStrategy: "upsert" }, expect.stringMatching(/^connector-native-lifecycle:[a-f0-9-]{36}:[0-9]+$/), 15_000);
    expect(request.mock.calls.some(([method]) => /logout|revoke|plugin/.test(method))).toBe(false);
  });

  it("requires effective configuration and runtime disable readback", async () => {
    const { context, request, entry } = fixture();
    request.mockImplementation(async method => method === "config/read" ? { config: { mcp_servers: { mail: { enabled: true } } } }
      : method === "mcpServerStatus/list" ? { data: [entry], nextCursor: null } : {});
    await expect(setNativeConnectionEnabled(context, false)).rejects.toMatchObject({ code: "NATIVE_CONNECTION_CONFIG_NOT_EFFECTIVE" });
    request.mockImplementation(async method => method === "config/read" ? { config: { mcp_servers: { mail: { enabled: false } } } }
      : method === "mcpServerStatus/list" ? { data: [entry], nextCursor: null } : {});
    await expect(setNativeConnectionEnabled(context, false)).rejects.toMatchObject({ code: "NATIVE_CONNECTION_DISABLE_PENDING" });
  });

  it("rejects nested config paths before sending any mutation", async () => {
    const { context, request } = fixture();
    context.resource.mcp!.server = "mail.other";
    await expect(setNativeConnectionEnabled(context, false)).rejects.toMatchObject({ code: "NATIVE_MCP_CONFIG_IDENTIFIER_UNSUPPORTED" });
    expect(request).not.toHaveBeenCalled();
  });

  it("redacts provider errors and revalidates transport on every operation", async () => {
    const { context, request } = fixture();
    request.mockRejectedValue(new Error("https://provider.example?token=secret"));
    await expect(nativeConnectionSnapshot(context)).rejects.toMatchObject({ code: "NATIVE_CONNECTION_RPC_UNAVAILABLE", message: "NATIVE_CONNECTION_RPC_UNAVAILABLE" });
    request.mockRejectedValue(Object.assign(new Error("private"), { code: "NATIVE_CONNECTION_SCOPE_DENIED" }));
    await expect(startNativeConnectionOAuth(context)).rejects.toMatchObject({ code: "NATIVE_CONNECTION_SCOPE_DENIED" });
  });
});
