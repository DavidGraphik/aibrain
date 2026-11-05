import { expect, it, vi } from "vitest";
import type { ClientRequest } from "../../contracts/codex/0.162.1/types/ClientRequest";
import type { CatalogRuntimeTransport } from "@/catalog/runtime-enforcement";
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
    if (rpc.method === "app/installed") result = { apps: [{ id: appId, enabled: this.enabled, callable: this.enabled }] };
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
      if (!lose) this.receive({ protocolVersion: 1, type: "event", event: { eventId: `native-${++this.sequence}`, sequence: this.sequence,
        occurredAt: "2026-11-05T00:00:00.000Z", message: { kind: "rpc-response", rpc: { id: rpc.id, result } } } });
    });
  }
}
function fixture() {
  const socket = new NativeWireSocket();
  const factory: WebSocketFactory = { supportsAuthorizationHeaders: true, create() { setTimeout(() => socket.open(), 0); return socket; } };
  const wire = new WebSocketAppServerTransport({ endpoint: "ws://127.0.0.1:4500/fixture", socketFactory: factory,
    auth: { placement: "authorization-header", credentialProvider: { getCredential: async () => ({ kind: "capability-token" as const, token: "synthetic-fixture-credential-000000" }) } },
    journal: new InMemoryTransportEventJournal(), heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 30_000 });
  const router = new AppServerRpcRouter(wire);
  const transport: CatalogRuntimeTransport = { request: (method, params, purpose) => router.request({ method, id: purpose, ...(params === undefined ? {} : { params }) } as ClientRequest, 100) };
  const context: NativeConnectionContext = { installationId: "native-fixture", userId: `00000000-0000-4000-8000-${String(++identity).padStart(12, "0")}`,
    resource: { id: "native-mail", kind: "mcp", label: "Fixture", appId: null, connectorId: null,
      credentialMode: "personal-oauth", sharedResource: false, managedBy: "company", mcp: { server: "mail", readTools: ["read"], sensitiveWriteTools: [] } }, transport };
  return { socket, router, transport, context };
}

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
