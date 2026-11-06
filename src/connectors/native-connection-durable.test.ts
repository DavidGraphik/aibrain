import { expect, it, vi } from "vitest";
import type { ClientRequest } from "../../contracts/codex/0.162.1/types/ClientRequest";
import { CatalogEnforcedTransport, CatalogRuntimeEnforcer, type CatalogRuntimeTransport } from "@/catalog/runtime-enforcement";
import type { CatalogState, CatalogPrincipal } from "@/catalog/contracts";
import { nativeAppToolsForTurn } from "@/runtime/native-app-tools";
import { connectedAppConfig } from "@/runtime/connected-app-config";
import { InMemoryTransportEventJournal, type AppServerRequest } from "@/runtime/transport/contracts";
import { AppServerRpcRouter } from "@/runtime/transport/app-server-rpc-router";
import { WebSocketAppServerTransport } from "@/runtime/transport/websocket-app-server-transport";
import type { WebSocketFactory, WebSocketLike } from "@/runtime/transport/websocket-types";
import { nativeConnectionHealthForIdentity } from "./native-connection-health";
import { nativeConnectionSnapshot, setNativeConnectionEnabled, startNativeConnectionOAuth, type NativeConnectionContext } from "./native-connection-lifecycle";

const mocks = vi.hoisted(() => ({ transport: null as CatalogRuntimeTransport | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/catalog/server-service", () => ({ catalogTransportForUser: async () => mocks.transport }));
const appId = "connector_0123456789abcdef0123456789abcdef";
let identity = 0;

/** Only the remote wire is synthetic. The production transport's accepted-ID
 * cache, event journal, ACK handling and RPC router all run unchanged. */
class NativeWireSocket implements WebSocketLike {
  readyState = 0;
  bufferedAmount = 0;
  readonly requests: AppServerRequest[] = [];
  enabled = true;
  installedDelayMs = 0;
  installedCommitted = true;
  loseNext: string | null = null;
  private sequence = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) { this.listeners.get(type)?.delete(listener); }
  private emit(type: string, value: unknown) { for (const fn of this.listeners.get(type) ?? []) fn(value); }
  private receive(value: unknown) { this.emit("message", { data: JSON.stringify(value) }); }
  open() { this.readyState = 1; this.emit("open", {}); }
  close(code?: number, reason?: string) { this.readyState = 3; this.emit("close", { code, reason }); }
  send(raw: string) {
    const frame = JSON.parse(raw);
    if (frame.type === "resume") { queueMicrotask(() => this.receive({ protocolVersion: 1, type: "ready", sessionId: "native-fixture", replaySupported: true })); return; }
    if (frame.type !== "request") return;
    const request = frame.request as AppServerRequest;
    this.requests.push(request);
    if (request.kind !== "rpc-request") throw new Error("Fixture admits RPC requests only");
    const rpc = request.rpc;
    let result: unknown = {};
    if (rpc.method === "app/installed") result = { apps: this.installedCommitted || rpc.params?.forceRefresh
      ? [{ id: appId, enabled: this.enabled, callable: this.enabled }] : [] };
    if (rpc.method === "app/read") result = { apps: [{ id: appId, toolSummaries: [
      { name: "get_profile", isEnabled: true, isReadOnly: true },
      { name: "send_email", isEnabled: true, isReadOnly: false },
    ] }], missingAppIds: [] };
    if (rpc.method === "mcpServerStatus/list") result = { data: [{ name: "mail", runtimeStatus: this.enabled ? "connected" : "disabled",
      authStatus: "notLoggedIn", toolsError: null, tools: { read: { name: "read", inputSchema: { type: "object" } } } }], nextCursor: null };
    if (rpc.method === "config/read") result = { config: { mcp_servers: { mail: { enabled: this.enabled } },
      mcp_oauth_callback_url: "https://brain.example/callback", mcp_oauth_callback_port: 43100 } };
    if (rpc.method === "config/value/write") this.enabled = rpc.params.value === true;
    if (rpc.method === "mcpServer/oauth/login") result = { authorizationUrl: `https://provider.example/authorize?redirect_uri=${encodeURIComponent("https://brain.example/callback")}`, loginId: "fixture-login" };
    const lose = this.loseNext === rpc.method;
    if (lose) this.loseNext = null;
    queueMicrotask(() => {
      this.receive({ protocolVersion: 1, type: "accepted", clientRequestId: request.clientRequestId });
      const respond = () => {
        if (rpc.method === "app/installed" && rpc.params?.forceRefresh) this.installedCommitted = true;
        if (!lose) this.receive({ protocolVersion: 1, type: "event", event: { eventId: `native-${++this.sequence}`, sequence: this.sequence,
          occurredAt: "2026-11-05T00:00:00.000Z", message: { kind: "rpc-response", rpc: { id: rpc.id, result } } } });
      };
      if (rpc.method === "app/installed" && rpc.params?.forceRefresh && this.installedDelayMs > 0) setTimeout(respond, this.installedDelayMs);
      else respond();
    });
  }
}
function fixture(useDeclaredTimeouts = false) {
  const socket = new NativeWireSocket();
  const factory: WebSocketFactory = { supportsAuthorizationHeaders: true, create() { setTimeout(() => socket.open(), 0); return socket; } };
  const wire = new WebSocketAppServerTransport({ endpoint: "ws://127.0.0.1:4500/fixture", socketFactory: factory,
    auth: { placement: "authorization-header", credentialProvider: { getCredential: async () => ({ kind: "capability-token" as const, token: "synthetic-fixture-credential-000000" }) } },
    journal: new InMemoryTransportEventJournal(), heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 30_000 });
  const router = new AppServerRpcRouter(wire);
  const transport: CatalogRuntimeTransport = { request: (method, params, purpose, timeoutMs) => router.request({ method, id: purpose, ...(params === undefined ? {} : { params }) } as ClientRequest, useDeclaredTimeouts ? timeoutMs ?? 100 : 100) };
  const context: NativeConnectionContext = { installationId: "native-fixture", userId: `00000000-0000-4000-8000-${String(++identity).padStart(12, "0")}`,
    resource: { id: "native-mail", kind: "mcp", label: "Fixture", appId: null, connectorId: null,
      credentialMode: "personal-oauth", sharedResource: false, managedBy: "company", mcp: { server: "mail", readTools: ["read"], sensitiveWriteTools: [] } }, transport };
  return { socket, router, transport, context };
}

it("awaits a cold hosted snapshot beyond 10s before admitting only the assigned native read tools", async () => {
  vi.useFakeTimers();
  const { socket, router, transport, context } = fixture(true);
  socket.installedCommitted = false;
  socket.installedDelayMs = 18_000;
  const resource = { ...context.resource, id: "native-gmail", kind: "app" as const, appId, mcp: null };
  const state: CatalogState = { schemaVersion: 1, installationId: context.installationId, revision: 1, resources: [resource], rules: [
    { id: "own-read", resourceId: resource.id, scope: "user", subjectId: context.userId, effect: "allow", operations: ["read"] },
    { id: "no-write", resourceId: resource.id, scope: "user", subjectId: context.userId, effect: "deny", operations: ["write"] },
  ] };
  const principal: CatalogPrincipal = { installationId: context.installationId, userId: context.userId,
    roleId: "workspace-member", groupIds: [], workspaceCanExecute: true };
  const catalog = new CatalogRuntimeEnforcer(state, principal);
  mocks.transport = new CatalogEnforcedTransport(transport, catalog);
  try {
    let resolved = false;
    const health = nativeConnectionHealthForIdentity(context.installationId, context.userId, [resource]).then(value => { resolved = true; return value; });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(resolved).toBe(false);
    expect(socket.requests.some(request => request.kind === "rpc-request" && request.rpc.method === "app/read")).toBe(false);
    await vi.advanceTimersByTimeAsync(8_000);
    expect((await health).get(resource.id)).toMatchObject({ status: "connected" });
    const policies = await nativeAppToolsForTurn(transport, async () => catalog, [appId], "cold-turn", true);
    expect(connectedAppConfig([appId], policies)).toMatchObject({ "features.apps": true, apps: {
      [appId]: { enabled: true, tools: { get_profile: { enabled: true }, send_email: { enabled: false } } },
    } });
    for (let turn = 0; turn < 2; turn++) {
      expect((await nativeConnectionHealthForIdentity(context.installationId, context.userId, [resource])).get(resource.id)).toMatchObject({ status: "connected" });
    }
    expect(socket.requests.filter(request => request.kind === "rpc-request" && request.rpc.method === "app/installed" && request.rpc.params?.forceRefresh)).toHaveLength(1);
  } finally { await router.close(); vi.useRealTimers(); }
});

it("keeps a hosted snapshot unavailable beyond its bounded readiness deadline closed", async () => {
  vi.useFakeTimers();
  const { socket, router, transport, context } = fixture(true);
  socket.installedCommitted = false;
  socket.installedDelayMs = 50_000;
  mocks.transport = transport;
  const resource = { ...context.resource, kind: "app" as const, appId, mcp: null };
  try {
    const health = nativeConnectionHealthForIdentity(context.installationId, context.userId, [resource]);
    await vi.advanceTimersByTimeAsync(45_001);
    expect((await health).get(resource.id)).toMatchObject({ status: "degraded", statusCode: "NATIVE_APP_READINESS_UNAVAILABLE" });
    expect(socket.requests.some(request => request.kind === "rpc-request" && request.rpc.method === "app/read")).toBe(false);
  } finally { await router.close(); vi.useRealTimers(); }
});

it("reproduces the R3 timeout with a reused accepted ID, then admits repeated fresh native health reads", async () => {
  const { socket, router, transport, context } = fixture();
  try {
    await transport.request("app/installed", { forceRefresh: true }, "legacy-fixed-health");
    await expect(transport.request("app/installed", { forceRefresh: true }, "legacy-fixed-health")).rejects.toMatchObject({ name: "AppServerRequestTimeoutError" });
    expect(socket.requests).toHaveLength(1); // Actual accepted-ID deduplication, no second provider observation.
    mocks.transport = transport;
    const resource = { ...context.resource, id: "native-gmail", kind: "app" as const, appId, mcp: null };
    for (let n = 0; n < 2; n++) expect((await nativeConnectionHealthForIdentity(context.installationId, context.userId, [resource])).get(resource.id)).toMatchObject({ status: "connected" });
    socket.enabled = false;
    expect((await nativeConnectionHealthForIdentity(context.installationId, context.userId, [resource])).get(resource.id)).toMatchObject({ status: "not_configured" });
    expect(socket.requests).toHaveLength(4);
  } finally { await router.close(); }
});

it("keeps lifecycle methods distinct within an operation and reads fresh state after disable/enable", async () => {
  const { socket, router, context } = fixture();
  try {
    await nativeConnectionSnapshot(context);
    expect(await setNativeConnectionEnabled(context, false)).toMatchObject({ enabled: false, connection: { status: "disabled" } });
    expect(await setNativeConnectionEnabled(context, true)).toMatchObject({ enabled: true });
    const requests = socket.requests;
    expect(new Set(requests.map(request => request.clientRequestId)).size).toBe(requests.length);
    const mutations = requests.filter(request => request.kind === "rpc-request" && request.rpc.method === "config/value/write");
    expect(mutations).toHaveLength(2);
    const operationIds = requests.map(request => request.clientRequestId.split(":")[1]);
    expect(new Set(operationIds).size).toBe(3);
  } finally { await router.close(); }
});

it("reads back an uncertain local config change without replaying the acknowledged mutation", async () => {
  const { socket, router, context } = fixture();
  try {
    socket.loseNext = "config/value/write";
    await expect(setNativeConnectionEnabled(context, false)).rejects.toMatchObject({ code: "NATIVE_CONNECTION_RPC_UNAVAILABLE" });
    expect(await setNativeConnectionEnabled(context, false)).toMatchObject({ enabled: false, connection: { status: "disabled" } });
    expect(socket.requests.filter(request => request.kind === "rpc-request" && request.rpc.method === "config/value/write")).toHaveLength(1);
  } finally { await router.close(); }
});

it("does not issue another OAuth start after an acknowledged mutation loses its response", async () => {
  const { socket, router, context } = fixture();
  try {
    socket.loseNext = "mcpServer/oauth/login";
    await expect(startNativeConnectionOAuth(context)).rejects.toMatchObject({ code: "NATIVE_CONNECTION_RPC_UNAVAILABLE" });
    await expect(startNativeConnectionOAuth(context)).rejects.toMatchObject({ code: "NATIVE_OAUTH_OUTCOME_UNCERTAIN" });
    expect(socket.requests.filter(request => request.kind === "rpc-request" && request.rpc.method === "mcpServer/oauth/login")).toHaveLength(1);
  } finally { await router.close(); }
});
