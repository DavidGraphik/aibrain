import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { NativeConnectionContext } from "./native-connection-lifecycle";
import { changeNativeConnection, nativeConnectionFailure, nativeConnectionStatus, startNativeOAuthForSession } from "./native-connection-server-service";

const mocks = vi.hoisted(() => ({ factory: vi.fn(), stop: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/catalog/native-connection-transport", () => ({ catalogConnectionTransportForUser: mocks.factory }));
vi.mock("@/runtime/worker-runtime-service", () => ({ stopWorkerRuntimeForUser: mocks.stop }));

let sequence = 0;
function fixture(options: { enabled?: boolean; staleLoadedRuntime?: boolean; staysEnabledAfterRetire?: boolean; loginRequired?: boolean } = {}) {
  const userId = `11111111-1111-4111-8111-${String(++sequence).padStart(12, "0")}`;
  const session: AuthSession = { provider: "local", user: { id: userId, name: "Employee", email: "employee@example.test" },
    tenant: { id: "company-qa", name: "Company" }, expiresAt: "2099-01-01T00:00:00.000Z" };
  const state = { enabled: options.enabled ?? true, generation: 0, oauthStarts: 0 };
  const effects: string[] = [];
  const callback = "https://brain.example/native-callback/employee";
  const contexts: NativeConnectionContext[] = [];
  mocks.factory.mockImplementation(async (current: AuthSession, resourceId: string) => {
    if (current.user.id !== userId || current.tenant.id !== session.tenant.id || resourceId !== "personal-mail") {
      throw Object.assign(new Error("private policy details"), { code: "NATIVE_CONNECTION_SCOPE_DENIED", status: 403 });
    }
    const generation = state.generation;
    effects.push(`factory:${userId}:${generation}`);
    const transport = { request: vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      effects.push(`rpc:${generation}:${method}`);
      if (method === "mcpServerStatus/list") {
        const active = options.staysEnabledAfterRetire || options.staleLoadedRuntime && generation === 0 || state.enabled;
        return { data: [{ name: "mail", runtimeStatus: !active ? "disabled" : options.loginRequired ? "authenticationRequired" : "connected",
          authStatus: options.loginRequired ? "notLoggedIn" : "oAuth", toolsError: null,
          tools: { search: { name: "search", inputSchema: { type: "object" } } } }], nextCursor: null };
      }
      if (method === "config/value/write") {
        const input = params as { keyPath: string; value: boolean };
        expect(input.keyPath).toBe("mcp_servers.mail.enabled");
        state.enabled = input.value;
        return { status: "ok", version: "synthetic-config-version" };
      }
      if (method === "config/read") return { config: { mcp_oauth_callback_url: callback, mcp_oauth_callback_port: 43100,
        mcp_servers: { mail: { enabled: state.enabled } } } };
      if (method === "config/mcpServer/reload") return {};
      if (method === "mcpServer/oauth/login") {
        state.oauthStarts++;
        return { authorizationUrl: `https://provider.example/authorize?redirect_uri=${encodeURIComponent(callback)}`, loginId: `native-login-${sequence}` };
      }
      throw new Error(`Unexpected native method: ${method}`);
    }) };
    const context: NativeConnectionContext = { installationId: session.tenant.id, userId, transport,
      resource: { id: "personal-mail", label: "Mail", kind: "mcp", credentialMode: "personal-oauth", managedBy: "company", sharedResource: false,
        appId: null, connectorId: null, mcp: { server: "mail", readTools: ["search"], sensitiveWriteTools: [] } } };
    contexts.push(context);
    return context;
  });
  mocks.stop.mockImplementation(async (target: string) => {
    expect(target).toBe(userId);
    effects.push(`stop:${target}`);
    state.generation++;
    return true;
  });
  return { session, userId, state, effects, contexts };
}

beforeEach(() => { mocks.factory.mockReset(); mocks.stop.mockReset(); });

describe("native connection backend orchestration (synthetic runtime, no provider acceptance)", () => {
  it("disables then retires only this employee and confirms a fresh disabled worker", async () => {
    const { session, userId, state, effects, contexts } = fixture();
    const result = await changeNativeConnection(session, "personal-mail", "disconnect");
    expect(result).toMatchObject({ effect: "local-connection-disabled", enabled: false, providerCredentialsRevoked: false, connection: { status: "disabled" } });
    expect(state.enabled).toBe(false);
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(userId);
    expect(mocks.factory).toHaveBeenCalledTimes(2);
    expect(contexts[0].transport).not.toBe(contexts[1].transport);
    const write = effects.indexOf("rpc:0:config/value/write"), stop = effects.indexOf(`stop:${userId}`);
    expect(write).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(write);
    expect(effects.indexOf("rpc:1:mcpServerStatus/list")).toBeGreaterThan(stop);
    expect(effects.some(effect => /logout|revoke|tool\/call/.test(effect))).toBe(false);
  });

  it("handles the old loaded runtime remaining connected until its own retirement", async () => {
    const { session, effects } = fixture({ staleLoadedRuntime: true });
    expect(await changeNativeConnection(session, "personal-mail", "disconnect")).toMatchObject({ connection: { status: "disabled" } });
    expect(effects).toContain("rpc:0:config/read");
    expect(effects).toContain("rpc:1:mcpServerStatus/list");
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it("never returns successful disconnection when the fresh runtime is still enabled", async () => {
    const { session } = fixture({ staleLoadedRuntime: true, staysEnabledAfterRetire: true });
    await expect(changeNativeConnection(session, "personal-mail", "disconnect")).rejects.toMatchObject({ code: "NATIVE_CONNECTION_DISABLE_PENDING" });
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.factory).toHaveBeenCalledTimes(2);
  });

  it("does not report success if fresh identity revalidation fails after retirement", async () => {
    const { session } = fixture({ staleLoadedRuntime: true });
    const original = mocks.factory.getMockImplementation()!;
    mocks.factory.mockImplementation(async (...args) => {
      if (mocks.stop.mock.calls.length) throw Object.assign(new Error("private revoked grant"), { code: "NATIVE_CONNECTION_SCOPE_DENIED", status: 403 });
      return original(...args);
    });
    const error = await changeNativeConnection(session, "personal-mail", "disconnect").catch(error => error);
    expect(nativeConnectionFailure(error)).toEqual({ code: "NATIVE_CONNECTION_SCOPE_DENIED", status: 403 });
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it("preserves a failed retirement as failure instead of claiming a fresh connection state", async () => {
    const { session } = fixture({ staleLoadedRuntime: true });
    mocks.stop.mockRejectedValue(new Error("private runtime stop details"));
    const error = await changeNativeConnection(session, "personal-mail", "disconnect").catch(error => error);
    expect(nativeConnectionFailure(error)).toEqual({ code: "NATIVE_CONNECTION_UNAVAILABLE", status: 503 });
    expect(mocks.factory).toHaveBeenCalledTimes(1);
  });

  it("re-enables a disabled personal MCP before starting its own OAuth consent flow", async () => {
    const { session, state, effects } = fixture({ enabled: false, loginRequired: true });
    expect(await startNativeOAuthForSession(session, "personal-mail")).toMatchObject({ completion: "pending", verification: "provider-consent-required" });
    expect(state.enabled).toBe(true);
    expect(state.oauthStarts).toBe(1);
    expect(effects.indexOf("rpc:0:mcpServer/oauth/login")).toBeGreaterThan(effects.indexOf("rpc:0:config/value/write"));
    expect(effects).toContain("rpc:0:config/read");
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("enables a local connection without retiring a worker or inventing provider consent", async () => {
    const { session, state } = fixture({ enabled: false, loginRequired: true });
    expect(await changeNativeConnection(session, "personal-mail", "enable")).toMatchObject({ enabled: true, connection: { status: "reauth_required" } });
    expect(state.enabled).toBe(true);
    expect(state.oauthStarts).toBe(0);
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("uses the session factory for status and rejects invalid resource IDs before discovery", async () => {
    const { session } = fixture();
    expect(await nativeConnectionStatus(session, "personal-mail")).toMatchObject({ status: "connected" });
    expect(mocks.factory).toHaveBeenCalledExactlyOnceWith(session, "personal-mail");
    mocks.factory.mockClear();
    await expect(nativeConnectionStatus(session, "../foreign")).rejects.toMatchObject({ code: "NATIVE_RESOURCE_INVALID" });
    expect(mocks.factory).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
  });
});
