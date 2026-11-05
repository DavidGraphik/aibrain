import type { CatalogResource } from "@/catalog/contracts";
import type { CatalogRuntimeTransport } from "@/catalog/runtime-enforcement";
import type { McpServerOauthLoginCompletedNotification } from "../../contracts/codex/0.162.1/types/v2/McpServerOauthLoginCompletedNotification";

export class NativeConnectionError extends Error {
  constructor(readonly code: string, readonly status = 409) {
    super(code);
    this.name = "NativeConnectionError";
  }
}

export type NativeConnectionContext = {
  installationId: string;
  userId: string;
  resource: CatalogResource;
  /** Must revalidate this identity and the resource's current catalogue policy per RPC. */
  transport: CatalogRuntimeTransport;
};

type Login = {
  server: string;
  loginId: string;
  startedAt: number;
  state: "pending" | "completed" | "failed";
};
const logins = new Map<string, Login>();
const starting = new Set<string>();
const earlyCompletions = new Map<string, { loginId: string; success: boolean }>();
const changing = new Set<string>();
const LOGIN_TTL_MS = 10 * 60_000;
const MAX_LOGINS = 128;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const keyFor = (context: Pick<NativeConnectionContext, "installationId" | "userId">, server: string) =>
  JSON.stringify([context.installationId, context.userId, server]);

function expireLogins(now: number) {
  for (const [key, login] of logins) if (now - login.startedAt >= LOGIN_TTL_MS) logins.delete(key);
}

/** Completion is accepted only from the originating employee's runtime and the
 * exact native login ID. Older uncorrelated notifications cannot complete a login.
 * No provider URL, token or free-form provider error is retained. After a restart,
 * connection status is rediscovered; an absent receipt is never a successful login. */
export function completeNativeConnectionOAuth(
  identity: Pick<NativeConnectionContext, "installationId" | "userId">,
  notification: McpServerOauthLoginCompletedNotification,
  now = Date.now(),
) {
  expireLogins(now);
  if (notification.threadId !== null || typeof notification.loginId !== "string") return false;
  const login = logins.get(keyFor(identity, notification.name));
  if ((!login || login.state !== "pending") && starting.has(keyFor(identity, notification.name))) {
    earlyCompletions.set(keyFor(identity, notification.name), { loginId: notification.loginId, success: notification.success });
    return true;
  }
  if (!login || login.loginId !== notification.loginId || login.state !== "pending") return false;
  login.state = notification.success ? "completed" : "failed";
  return true;
}

function loginSnapshot(context: NativeConnectionContext, now: number) {
  expireLogins(now);
  const login = context.resource.mcp ? logins.get(keyFor(context, context.resource.mcp.server)) : null;
  return login ? { state: login.state, startedAt: new Date(login.startedAt).toISOString() } : null;
}

export type NativeConnectionSnapshot = {
  resourceId: string;
  kind: "app" | "mcp";
  status: "connected" | "not_configured" | "disabled" | "reauth_required" | "unavailable";
  code: string | null;
  checkedAt: string;
  login: ReturnType<typeof loginSnapshot>;
  capabilities: { oauthLogin: boolean; localEnable: boolean; localDisable: boolean; providerRevoke: false };
  tools: Array<{ name: string; title: string | null; description: string | null; inputSchema: unknown; operation: "read" | "write" }>;
};

function mcpServer(context: NativeConnectionContext) {
  const resource = context.resource;
  if (resource.kind !== "mcp" || !resource.mcp) throw new NativeConnectionError("NATIVE_APP_AUTH_MANAGED_EXTERNALLY");
  return resource.mcp.server;
}

function configurableServer(context: NativeConnectionContext) {
  const server = mcpServer(context);
  // Never allow a server ID to become another config key or a nested key path.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(server)) throw new NativeConnectionError("NATIVE_MCP_CONFIG_IDENTIFIER_UNSUPPORTED");
  return server;
}

async function rpc(context: NativeConnectionContext, method: Parameters<CatalogRuntimeTransport["request"]>[0], params: unknown) {
  try { return await context.transport.request(method, params, "connector-native-lifecycle", 15_000); }
  catch (error) {
    if (error instanceof NativeConnectionError) throw error;
    // Provider errors can contain URLs or credentials. Preserve only our known
    // policy failures; an unsupported native method remains an explicit blocker.
    const code = record(error) && typeof error.code === "string" && /^(CATALOG_|NATIVE_|RUNTIME_IDENTITY_)[A-Z0-9_]+$/.test(error.code)
      ? error.code : "NATIVE_CONNECTION_RPC_UNAVAILABLE";
    throw new NativeConnectionError(code, 503);
  }
}

function callbackUrl(value: unknown) {
  if (typeof value !== "string") throw new NativeConnectionError("NATIVE_OAUTH_CALLBACK_UNREACHABLE");
  let url: URL;
  try { url = new URL(value); } catch { throw new NativeConnectionError("NATIVE_OAUTH_CALLBACK_INVALID"); }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || ["[::1]", "[::]", "0.0.0.0"].includes(hostname)
      || /^127\./.test(hostname) || /^\[::ffff:7f[0-9a-f]{2}:/.test(hostname)) {
    throw new NativeConnectionError("NATIVE_OAUTH_CALLBACK_UNREACHABLE");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new NativeConnectionError("NATIVE_OAUTH_CALLBACK_INVALID");
  return url;
}

/** The browser runs on the employee's computer; a worker's default loopback
 * listener cannot receive its redirect. External callback ingress and its
 * private forwarding to the exact employee listener must be provisioned by the
 * host. A URL setting is readiness information, not proof of a working proxy. */
async function configuredCallback(context: NativeConnectionContext) {
  const response = await rpc(context, "config/read", { includeLayers: false });
  const config = record(response) && record(response.config) ? response.config : null;
  const servers = config?.mcp_servers;
  const server = record(servers) ? servers[mcpServer(context)] : null;
  const oauth = record(server) && record(server.oauth) ? server.oauth : null;
  const callback = callbackUrl(oauth?.callback_url ?? config?.mcp_oauth_callback_url);
  const listenerPort = oauth?.callback_port ?? config?.mcp_oauth_callback_port;
  // An external URL's port does not select Codex's listener port. A managed
  // ingress needs a stable, provisioned destination for this employee worker.
  if (typeof listenerPort !== "number" || !Number.isInteger(listenerPort) || listenerPort < 1 || listenerPort > 65535) {
    throw new NativeConnectionError("NATIVE_OAUTH_CALLBACK_LISTENER_NOT_CONFIGURED");
  }
  return callback;
}

function verifyNativeCallback(authorizationUrl: URL, configured: URL) {
  const values = authorizationUrl.searchParams.getAll("redirect_uri");
  if (values.length !== 1) throw new NativeConnectionError("NATIVE_OAUTH_CALLBACK_UNVERIFIED");
  const actual = callbackUrl(values[0]);
  // Codex may append a provider-specific callback ID when the provider does not
  // support issuer-bound callbacks. Never accept another callback origin/path.
  const prefix = configured.pathname.replace(/\/$/, "") + "/";
  if (actual.origin !== configured.origin || actual.search !== configured.search ||
      !(actual.pathname === configured.pathname || actual.pathname.startsWith(prefix))) {
    throw new NativeConnectionError("NATIVE_OAUTH_CALLBACK_MISMATCH");
  }
}

export async function nativeConnectionSnapshot(context: NativeConnectionContext, now = Date.now()): Promise<NativeConnectionSnapshot> {
  const resource = context.resource;
  if (resource.kind !== "app" && resource.kind !== "mcp") throw new NativeConnectionError("NATIVE_RESOURCE_REQUIRED", 400);
  const base = {
    resourceId: resource.id, kind: resource.kind, checkedAt: new Date(now).toISOString(), login: loginSnapshot(context, now),
    capabilities: { oauthLogin: false, localEnable: false, localDisable: false, providerRevoke: false as const },
    tools: [],
  };
  if (resource.kind === "app") {
    const response = await rpc(context, "app/installed", { threadId: null, forceRefresh: true });
    if (!record(response) || !Array.isArray(response.apps)) throw new NativeConnectionError("NATIVE_CONNECTION_INVENTORY_INVALID", 503);
    const matches = response.apps.filter(app => record(app) && app.id === resource.appId);
    if (!matches.length) return { ...base, status: "not_configured", code: "NATIVE_APP_NOT_INSTALLED" };
    const app = matches[0];
    if (matches.length !== 1 || !record(app) || typeof app.enabled !== "boolean" || typeof app.callable !== "boolean") {
      throw new NativeConnectionError("NATIVE_CONNECTION_INVENTORY_INVALID", 503);
    }
    return { ...base, status: !app.enabled ? "disabled" : app.callable ? "connected" : "unavailable",
      code: !app.enabled ? "NATIVE_APP_DISABLED" : app.callable ? null : "NATIVE_APP_NOT_CALLABLE" };
  }
  const server = mcpServer(context);
  const response = await rpc(context, "mcpServerStatus/list", { threadId: null, serverName: server, detail: "toolsAndAuthOnly", limit: 100 });
  if (!record(response) || !Array.isArray(response.data) || response.nextCursor) throw new NativeConnectionError("NATIVE_CONNECTION_INVENTORY_INVALID", 503);
  const matches = response.data.filter(item => record(item) && item.name === server);
  if (!matches.length) {
    const effective = await rpc(context, "config/read", { includeLayers: false });
    const servers = record(effective) && record(effective.config) ? effective.config.mcp_servers : null;
    const configured = record(servers) ? servers[server] : null;
    return record(configured) && configured.enabled === false
      ? { ...base, status: "disabled", code: "NATIVE_MCP_DISABLED" }
      : { ...base, status: "not_configured", code: "NATIVE_MCP_NOT_CONFIGURED" };
  }
  const item = matches[0];
  if (matches.length !== 1 || !record(item) || !record(item.tools) || typeof item.authStatus !== "string") {
    throw new NativeConnectionError("NATIVE_CONNECTION_INVENTORY_INVALID", 503);
  }
  const enabledConfigSupported = /^[A-Za-z0-9_-]{1,128}$/.test(server);
  const capabilities = {
    oauthLogin: ["notLoggedIn", "oAuth"].includes(item.authStatus),
    localEnable: enabledConfigSupported, localDisable: enabledConfigSupported, providerRevoke: false as const,
  };
  const allowed = new Map([
    ...(resource.mcp?.readTools ?? []).map(tool => [tool, "read"] as const),
    ...(resource.mcp?.sensitiveWriteTools ?? []).map(tool => [tool, "write"] as const),
  ]);
  const tools = Object.entries(item.tools).flatMap(([name, tool]) => {
    const operation = allowed.get(name);
    return operation && record(tool) && tool.name === name && record(tool.inputSchema)
      ? [{ name, operation, inputSchema: tool.inputSchema, title: typeof tool.title === "string" ? tool.title : null,
        description: typeof tool.description === "string" ? tool.description : null }] : [];
  });
  const status = item.runtimeStatus === "disabled" ? "disabled"
    : item.runtimeStatus === "authenticationRequired" || item.authStatus === "notLoggedIn" ? "reauth_required"
      : item.runtimeStatus === "connected" && ["unknown", "unsupported", "bearerToken", "oAuth"].includes(item.authStatus) && item.toolsError === null && tools.length ? "connected" : "unavailable";
  return { ...base, capabilities, tools, status,
    code: status === "connected" ? null : status === "disabled" ? "NATIVE_MCP_DISABLED" : status === "reauth_required" ? "NATIVE_MCP_LOGIN_REQUIRED" : "NATIVE_MCP_NOT_CALLABLE" };
}

export async function startNativeConnectionOAuth(context: NativeConnectionContext, now = Date.now()) {
  const server = mcpServer(context), key = keyFor(context, server);
  expireLogins(now);
  if (starting.has(key) || logins.get(key)?.state === "pending") throw new NativeConnectionError("NATIVE_OAUTH_ALREADY_PENDING");
  if (logins.size >= MAX_LOGINS) throw new NativeConnectionError("NATIVE_OAUTH_CAPACITY_REACHED", 503);
  starting.add(key);
  try {
    const before = await nativeConnectionSnapshot(context, now);
    if (before.status === "not_configured") throw new NativeConnectionError("NATIVE_MCP_NOT_CONFIGURED");
    if (!before.capabilities.oauthLogin) throw new NativeConnectionError("NATIVE_MCP_OAUTH_UNSUPPORTED");
    if (before.status === "disabled") throw new NativeConnectionError("NATIVE_MCP_DISABLED");
    const callback = await configuredCallback(context);
    const response = await rpc(context, "mcpServer/oauth/login", { name: server, threadId: null });
    if (!record(response) || typeof response.authorizationUrl !== "string") throw new NativeConnectionError("NATIVE_OAUTH_RESPONSE_INVALID", 503);
    let url: URL;
    try { url = new URL(response.authorizationUrl); } catch { throw new NativeConnectionError("NATIVE_OAUTH_RESPONSE_INVALID", 503); }
    if (url.username || url.password || url.protocol !== "https:" || url.hostname === "localhost" || url.hostname.endsWith(".localhost")
        || ["[::1]", "[::]", "0.0.0.0"].includes(url.hostname) || /^127\./.test(url.hostname) || /^\[::ffff:7f[0-9a-f]{2}:/.test(url.hostname)) {
      throw new NativeConnectionError("NATIVE_OAUTH_RESPONSE_INVALID", 503);
    }
    verifyNativeCallback(url, callback);
    const loginId = typeof response.loginId === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(response.loginId) ? response.loginId : null;
    const early = earlyCompletions.get(key);
    const state = loginId && early?.loginId === loginId ? early.success ? "completed" as const : "failed" as const : "pending" as const;
    if (loginId) logins.set(key, { server, loginId, startedAt: now, state });
    return { resourceId: context.resource.id, authorizationUrl: url.href, loginId,
      completion: loginId ? state : "uncorrelated" as const,
      verification: "provider-consent-required" as const,
      callbackVerification: "configured-external-ingress-live-acceptance-required" as const };
  } finally { starting.delete(key); earlyCompletions.delete(key); }
}

/** This is a real local disable/enable, verified against the effective config.
 * Codex 0.162.1 exposes no MCP OAuth logout/revoke RPC. Stored provider consent
 * is therefore explicitly retained; never report remote credentials revoked. */
export async function setNativeConnectionEnabled(context: NativeConnectionContext, enabled: boolean) {
  const server = configurableServer(context), key = keyFor(context, server);
  if (changing.has(key) || starting.has(key)) throw new NativeConnectionError("NATIVE_CONNECTION_CHANGE_PENDING");
  changing.add(key);
  try {
    const before = await nativeConnectionSnapshot(context);
    if (before.status === "not_configured") throw new NativeConnectionError("NATIVE_MCP_NOT_CONFIGURED");
    await rpc(context, "config/value/write", { keyPath: `mcp_servers.${server}.enabled`, value: enabled, mergeStrategy: "upsert" });
    await rpc(context, "config/mcpServer/reload", undefined);
    const effective = await rpc(context, "config/read", { includeLayers: false });
    const servers = record(effective) && record(effective.config) ? effective.config.mcp_servers : null;
    const entry = record(servers) ? servers[server] : null;
    if (!record(entry) || entry.enabled !== enabled) throw new NativeConnectionError("NATIVE_CONNECTION_CONFIG_NOT_EFFECTIVE");
    if (!enabled) logins.delete(key);
    const connection = await nativeConnectionSnapshot(context);
    if (!enabled && connection.status !== "disabled") throw new NativeConnectionError("NATIVE_CONNECTION_DISABLE_PENDING");
    return { connection, enabled, providerCredentialsRevoked: false as const,
      effect: enabled ? "local-connection-enabled" as const : "local-connection-disabled" as const };
  } finally { changing.delete(key); }
}
