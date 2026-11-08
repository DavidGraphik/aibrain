import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AuthSession } from "@/auth/types";
import type { InstallationConfig } from "@/config/installation-schema";
import type { NativeConnectionContext } from "./native-connection-lifecycle";
import { completeNativeConnectionOAuth } from "./native-connection-lifecycle";
import { NativeConnectionTransport } from "@/catalog/native-connection-transport";
import { NativeOAuthCallbackStore } from "./native-oauth-callback";
import { startNativeOAuthForSession, finishNativeOAuthForSession, changeNativeConnection } from "./native-connection-server-service";
const mocks = vi.hoisted(() => ({ factory: vi.fn(), resources: vi.fn(), installation: vi.fn(), origin: vi.fn(), stop: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/catalog/native-connection-transport", async load => ({ ...await load<object>(), catalogConnectionTransportForUser: mocks.factory, nativeConnectionResourcesForSession: mocks.resources }));
vi.mock("@/config/installation", async load => ({ ...await load<object>(), loadInstallationConfig: mocks.installation }));
vi.mock("@/runtime/workers/kernel-ownership", async load => ({ ...await load<object>(), currentWorkerExecutionOrigin: mocks.origin }));
vi.mock("@/runtime/worker-runtime-service", () => ({ stopWorkerRuntimeForUser: mocks.stop }));
let root: string, servers: Server[], sequence = 0;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), "native-oauth-flow-"))); servers = []; vi.clearAllMocks(); });
afterEach(async () => { for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
function fixture(options: { staticClient?: boolean; nativeSuffix?: boolean } = {}) {
  const number = ++sequence;
  const session: AuthSession = { provider: "local", tenant: { id: "company-qa", name: "Company" }, user: { id: `11111111-1111-4111-8111-${String(number).padStart(12, "0")}`, name: "Employee", email: "employee@example.test" }, expiresAt: "2099-01-01T00:00:00Z" };
  const resource = { id: "personal-mail", kind: "mcp" as const, label: "Mail", credentialMode: "personal-oauth" as const,
    managedBy: "company" as const, sharedResource: false, appId: null, connectorId: null,
    mcp: { server: "mail", readTools: ["read_fixture"], sensitiveWriteTools: [] } };
  const generation = { generation: "33333333-3333-4333-8333-333333333333", instanceId: "app", dev: 1, ino: 2 };
  const state = { enabled: true, authenticated: false, allowed: true, port: 0, url: "", starts: 0, callbackCalls: 0 };
  const effects: string[] = [];
  mocks.origin.mockImplementation(async () => generation);
  mocks.installation.mockResolvedValue({ installationId: "company-qa", publicUrl: "https://brain.example", paths: { dataRoot: root, usersRoot: path.join(root, "users"), publishWriteRoot: path.join(root, "publish") } } as InstallationConfig);
  mocks.resources.mockImplementation(async () => state.allowed ? [resource] : []);
  const inner = { request: vi.fn(async (method: string, params: unknown) => {
    effects.push(method);
    if (method === "config/value/write") {
      const p = params as { keyPath: string; value: unknown };
      if (p.keyPath.endsWith("callback_url")) state.url = p.value as string;
      else if (p.keyPath.endsWith("callback_port")) state.port = p.value as number;
      else state.enabled = p.value as boolean;
      return {};
    }
    if (method === "config/read") return { config: { mcp_servers: { mail: { enabled: state.enabled, oauth: { callback_url: state.url, callback_port: state.port, ...(options.staticClient ? { client_id: "synthetic-static-client", client_secret: "synthetic-static-secret" } : {}) } } } } };
    if (method === "config/mcpServer/reload") return {};
    if (method === "mcpServerStatus/list") return { data: [{ name: "mail", runtimeStatus: state.enabled ? null : "disabled", authStatus: state.authenticated ? "oAuth" : "notLoggedIn", toolsError: null,
      tools: state.authenticated ? { read_fixture: { name: "read_fixture", inputSchema: { type: "object" } } } : {} }], nextCursor: null };
    if (method === "mcpServer/oauth/login") {
      state.starts++; const loginId = `native-login-${number}-${state.starts}`, nativeState = `synthetic-state-${number}-${state.starts}`;
      expect(params).toMatchObject({ name: "mail", clientRegistration: "dcr", timeoutSecs: 600 });
      const server = createServer((request, response) => {
        state.callbackCalls++;
        const url = new URL(request.url!, "http://127.0.0.1");
        expect(url.searchParams.get("state")).toBe(nativeState);
        expect(request.headers.authorization).toBeUndefined(); expect(request.headers.cookie).toBeUndefined();
        state.authenticated = true;
        completeNativeConnectionOAuth({ installationId: session.tenant.id, userId: session.user.id }, { name: "mail", threadId: null, loginId, success: true });
        response.end("Synthetic native SDK response");
      });
      servers.push(server); await new Promise<void>(resolve => server.listen(state.port, "127.0.0.1", resolve));
      return { loginId, authorizationUrl: `https://provider.example/authorize?state=${nativeState}&redirect_uri=${encodeURIComponent(state.url + (options.nativeSuffix ? "/opaque-sdk-suffix" : ""))}` };
    }
    throw Error("Unexpected fixture RPC");
  }) };
  const current = async () => { if (!state.allowed) throw Object.assign(Error("revoked"), { code: "NATIVE_CONNECTION_SCOPE_DENIED" }); return resource; };
  const transport = new NativeConnectionTransport(inner, resource, current, async (url, port) => {
    await new NativeOAuthCallbackStore(session.tenant.id, root, "https://brain.example").assertPreparing(url,
      { userId: session.user.id, resourceId: resource.id, server: "mail", generation }, port);
  });
  const context: NativeConnectionContext = { installationId: session.tenant.id, userId: session.user.id, resource, transport,
    callback: { dataRoot: root, publicUrl: "https://brain.example", generation: async () => generation,
      configure: (url, port) => transport.configureCallback(url, port, "https://brain.example") } };
  mocks.factory.mockResolvedValue(context); mocks.stop.mockResolvedValue(true);
  const callback = (authorizationUrl: string) => {
    const url = new URL(authorizationUrl), redirect = url.searchParams.get("redirect_uri")!;
    return redirect + `?code=synthetic&state=${encodeURIComponent(url.searchParams.get("state")!)}`;
  };
  return { session, state, effects, callback, generation };
}

describe("management routes orchestration with actual persisted leases and loopback forwarding (synthetic native RPC, no model)", () => {
  it("provisions before exposing a login, forwards once, correlates completion and verifies global native inventory", async () => {
    const f = fixture(), login = await startNativeOAuthForSession(f.session, "personal-mail");
    expect(f.effects.indexOf("config/value/write")).toBeLessThan(f.effects.indexOf("mcpServer/oauth/login"));
    const url = f.callback(login.authorizationUrl);
    expect(await finishNativeOAuthForSession(f.session, url)).toBe("verified");
    expect(f.state.callbackCalls).toBe(1);
    await expect(finishNativeOAuthForSession(f.session, url)).rejects.toMatchObject({ code: "NATIVE_OAUTH_ATTEMPT_EXPIRED" });
    expect(f.state.callbackCalls).toBe(1);
    expect(f.effects).not.toContain("turn/start"); expect(f.effects).not.toContain("mcpServer/tool/call");
  });
  it.each(["http://0.0.0.0:3000", "https://0.0.0.0:3000"])("accepts a legitimate callback behind Next standalone's internal %s origin", async internalOrigin => {
    const f = fixture(), login = await startNativeOAuthForSession(f.session, "personal-mail");
    const publicReturn = new URL(f.callback(login.authorizationUrl));
    const internalReturn = new URL(publicReturn.pathname + publicReturn.search, internalOrigin);
    expect(await finishNativeOAuthForSession(f.session, internalReturn.href)).toBe("verified");
    expect(f.state.callbackCalls).toBe(1);
    await expect(finishNativeOAuthForSession(f.session, internalReturn.href)).rejects.toMatchObject({ code: "NATIVE_OAUTH_ATTEMPT_EXPIRED" });
    expect(f.state.callbackCalls).toBe(1);
  });
  it("revalidates revocation before callback I/O, then disconnects and allows a fresh reconnect without reusing the old port", async () => {
    const f = fixture(), first = await startNativeOAuthForSession(f.session, "personal-mail"), firstPort = f.state.port;
    f.state.allowed = false;
    await expect(finishNativeOAuthForSession(f.session, f.callback(first.authorizationUrl))).rejects.toMatchObject({ code: "NATIVE_OAUTH_SCOPE_DENIED" });
    expect(f.state.callbackCalls).toBe(0);
    f.state.allowed = true;
    expect(await changeNativeConnection(f.session, "personal-mail", "disconnect")).toMatchObject({ enabled: false, providerCredentialsRevoked: false });
    await expect(finishNativeOAuthForSession(f.session, f.callback(first.authorizationUrl))).rejects.toMatchObject({ code: "NATIVE_OAUTH_ATTEMPT_EXPIRED" });
    const next = await startNativeOAuthForSession(f.session, "personal-mail");
    expect(f.state.port).not.toBe(firstPort);
    expect(await finishNativeOAuthForSession(f.session, f.callback(next.authorizationUrl))).toBe("verified");
    expect(f.state.callbackCalls).toBe(1);
  });
});

 it("does not expose the pinned SDK's random static-client redirect suffix as a usable connection link", async () => {
  const f=fixture({staticClient:true,nativeSuffix:true});
  await expect(startNativeOAuthForSession(f.session,"personal-mail")).rejects.toMatchObject({code:"NATIVE_OAUTH_STATIC_CALLBACK_UNSUPPORTED"});
  expect(f.state.callbackCalls).toBe(0);
 });
