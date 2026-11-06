import "server-only";
import { randomUUID } from "node:crypto";

import type { AuthSession } from "@/auth/types";
import { workspacePolicyForIdentity } from "@/admin/policy-service";
import { ensureInstallationCatalog } from "@/catalog/baseline";
import { isNativeAppId, type CatalogResource } from "@/catalog/contracts";
import { allowsCatalogOperation } from "@/catalog/resolver";
import { CatalogRuntimeDeniedError, type CatalogRuntimeTransport } from "@/catalog/runtime-enforcement";
import { FileCatalogStore } from "@/catalog/store";
import { loadInstallationConfig } from "@/config/installation";
import { workerAppServerForUser } from "@/runtime/worker-runtime-service";
import { personalNativeConnectionsEnabled } from "@/runtime/native-connection-identity";
import { currentWorkerExecutionOrigin } from "@/runtime/workers/kernel-ownership";
import { NativeOAuthCallbackStore, NATIVE_OAUTH_PORT_MIN, NATIVE_OAUTH_PORT_MAX } from "@/connectors/native-oauth-callback";

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const denied = () => new CatalogRuntimeDeniedError("NATIVE_CONNECTION_SCOPE_DENIED", "This personal connection operation is not available.");
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));

/** Model credentials and provider credentials are separate. Managed personal
 * apps must never inherit the operator's account through a shared worker login. */
export function assertPersonalNativeConnectionIdentity(userId: string, environment: Readonly<Record<string, string | undefined>> = process.env) {
  if (!personalNativeConnectionsEnabled(userId, environment)) throw denied();
}

function sameTarget(left: CatalogResource, right: CatalogResource) {
  return left.id === right.id && left.kind === right.kind && left.appId === right.appId
    && JSON.stringify(left.mcp) === JSON.stringify(right.mcp) && right.credentialMode === "personal-oauth" && !right.sharedResource;
}

/** A narrow management channel, deliberately separate from model execution.
 * It can only authenticate or enable/disable the one assigned personal resource.
 * No provider URL, command, credential, arbitrary setting or tool call is accepted. */
export class NativeConnectionTransport implements CatalogRuntimeTransport {
  constructor(private readonly inner: CatalogRuntimeTransport, private readonly resource: CatalogResource,
    private readonly revalidate: () => Promise<CatalogResource>,
    private readonly validateCallbackLease?: (url: string, port: number) => Promise<void>) {}

  /** Only the server's coordinator may choose this fixed first-party callback.
   * Ordinary transport callers still cannot write URLs, ports or other settings. */
  async configureCallback(callbackUrl: string, port: number, publicUrl: string) {
    const resource = await this.revalidate(), server = resource.mcp?.server;
    const url = new URL(callbackUrl), origin = new URL(publicUrl);
    if (!this.validateCallbackLease || !sameTarget(this.resource, resource) || !server || !/^[A-Za-z0-9_-]{1,128}$/.test(server)
      || origin.protocol !== "https:" || url.origin !== origin.origin || url.search || url.hash || url.username || url.password
      || url.pathname !== "/api/connectors/native/callback"
      || !Number.isInteger(port) || port < NATIVE_OAUTH_PORT_MIN || port > NATIVE_OAUTH_PORT_MAX) throw denied();
    const id = randomUUID();
    for (const [field, value] of [["callback_url", url.href], ["callback_port", port]] as const) {
      await this.validateCallbackLease(url.href, port);
      if (!sameTarget(resource, await this.revalidate())) throw denied();
      await this.inner.request("config/value/write", { keyPath: `mcp_servers.${server}.oauth.${field}`, value, mergeStrategy: "upsert" }, `native-oauth-config:${id}:${field}`, 15_000);
    }
    await this.request("config/mcpServer/reload", undefined, `native-oauth-config:${id}:reload`, 15_000);
    const effective = await this.request("config/read", { includeLayers: false }, `native-oauth-config:${id}:readback`, 15_000);
    const config = record(effective) && record(effective.config) ? effective.config.mcp_servers : null;
    const entry = record(config) ? config[server] : null;
    const oauth = record(entry) && record(entry.oauth) ? entry.oauth : null;
    if (!oauth || oauth.callback_url !== url.href || oauth.callback_port !== port) throw denied();
    return { staticClientConfigured: oauth.client_id_configured === true };
  }

  async request(method: Parameters<CatalogRuntimeTransport["request"]>[0], params: unknown, purpose: string, timeoutMs?: number) {
    const resource = await this.revalidate();
    if (!sameTarget(this.resource, resource)) throw denied();
    const input = params == null ? {} : params;
    if (!record(input)) throw denied();
    const server = resource.mcp?.server;
    const appId = resource.appId;
    if (appId !== null && !isNativeAppId(appId)) throw denied();
    let projection: "status" | "installed" | "apps" | "config" | null = null;
    if (method === "mcpServerStatus/list" && resource.kind === "mcp" && server
      && keys(input, ["serverName", "name", "threadId", "detail", "cursor", "limit"])
      && input.threadId == null && (input.serverName == null || input.serverName === server)
      && (input.name == null || input.name === server)) projection = "status";
    else if (method === "app/installed" && resource.kind === "app" && appId
      && keys(input, ["threadId", "forceRefresh"]) && input.threadId == null) projection = "installed";
    else if (method === "app/read" && resource.kind === "app" && appId && keys(input, ["appIds", "includeTools"])
      && Array.isArray(input.appIds) && input.appIds.length === 1 && input.appIds[0] === appId) projection = "apps";
    else if (method === "mcpServer/oauth/login" && resource.kind === "mcp" && server
      && keys(input, ["name", "threadId", "clientRegistration", "timeoutSecs"]) && input.name === server && input.threadId == null
      && (input.clientRegistration == null || input.clientRegistration === "dcr")
      && (input.timeoutSecs == null || input.timeoutSecs === 600)) { /* native configured scopes only; verified remote DCR */ }
    else if (method === "config/value/write" && keys(input, ["keyPath", "value", "mergeStrategy"])
      && typeof input.value === "boolean" && input.mergeStrategy === "upsert"
      && ((server && /^[A-Za-z0-9_-]+$/.test(server) && input.keyPath === `mcp_servers.${server}.enabled`)
        || (appId && isNativeAppId(appId) && input.keyPath === `apps.${appId}.enabled`))) { /* one local setting, no credentials */ }
    else if (method === "config/mcpServer/reload" && Object.keys(input).length === 0) { /* native refresh */ }
    else if (method === "config/read" && keys(input, ["includeLayers"]) && input.includeLayers === false) projection = "config";
    else throw denied();
    const result = await this.inner.request(method, params, purpose, timeoutMs);
    if (!sameTarget(resource, await this.revalidate())) throw denied();
    if (!projection) return result;
    if (!record(result)) throw denied();
    if (projection === "config") {
      if (!record(result.config)) throw denied();
      const collection = server ? "mcp_servers" : "apps", id = server ?? appId!;
      const values = result.config[collection];
      const entry = record(values) && record(values[id]) ? values[id] : null;
      const nativeConfig = result.config;
      const callback = record(entry?.oauth) ? entry.oauth : {};
      return { config: {
        ...(typeof nativeConfig.mcp_oauth_callback_url === "string" ? { mcp_oauth_callback_url: nativeConfig.mcp_oauth_callback_url } : {}),
        ...(typeof nativeConfig.mcp_oauth_callback_port === "number" ? { mcp_oauth_callback_port: nativeConfig.mcp_oauth_callback_port } : {}),
        [collection]: entry ? { [id]: { enabled: entry.enabled !== false,
          ...(server && (typeof callback.callback_url === "string" || typeof callback.callback_port === "number") ? { oauth: {
            ...(typeof callback.callback_url === "string" ? { callback_url: callback.callback_url } : {}),
            ...(typeof callback.callback_port === "number" ? { callback_port: callback.callback_port } : {}),
            // Presence only. Client identifiers/secrets are not part of the
            // employee/browser projection or callback receipt.
            client_id_configured: typeof callback.client_id === "string" && callback.client_id.length > 0,
          } } : {}),
        } } : {},
      } };
    }
    const key = projection === "status" ? "data" : "apps";
    if (!Array.isArray(result[key])) throw denied();
    return { [key]: result[key].filter(entry => record(entry)
      && (projection === "status" ? entry.name === server : entry.id === appId)),
      ...(projection === "status" ? { nextCursor: result.nextCursor ?? null } : {}) };
  }
}

export async function catalogConnectionTransportForUser(session: AuthSession, resourceId: string) {
  const resolve = async () => {
    assertPersonalNativeConnectionIdentity(session.user.id);
    const installation = await loadInstallationConfig();
    if (installation.installationId !== session.tenant.id) throw denied();
    const workspace = await workspacePolicyForIdentity(installation.installationId, session.user.id, installation);
    const store = new FileCatalogStore(installation.installationId, installation.paths.dataRoot);
    const state = await ensureInstallationCatalog(store, installation);
    const principal = { installationId: installation.installationId, userId: session.user.id,
      roleId: workspace.roleId, groupIds: workspace.groups.map(group => group.id), workspaceCanExecute: workspace.policy.capabilities.execute };
    const resource = state.resources.find(resource => resource.id === resourceId);
    if (!resource || !["app", "mcp"].includes(resource.kind) || resource.credentialMode !== "personal-oauth" || resource.sharedResource
      || !allowsCatalogOperation(state, principal, resourceId, "read")) throw denied();
    if (!resource.mcp) return resource;
    const canWrite = principal.workspaceCanExecute && allowsCatalogOperation(state, principal, resourceId, "write");
    return { ...resource, mcp: { ...resource.mcp,
      readTools: resource.mcp.readTools.filter(tool => !resource.mcp!.sensitiveWriteTools.includes(tool)),
      sensitiveWriteTools: canWrite ? resource.mcp.sensitiveWriteTools : [],
    } };
  };
  const resource = await resolve();
  const installation = await loadInstallationConfig();
  const client = (await workerAppServerForUser(session.user.id)).client;
  if (client.handle.userId !== session.user.id || client.handle.installationId !== session.tenant.id) throw denied();
  const generation = () => currentWorkerExecutionOrigin(client.handle.roots.transportAudit);
  const transport = new NativeConnectionTransport(client, resource, resolve, async (url, port) => {
    const store = new NativeOAuthCallbackStore(installation.installationId, installation.paths.dataRoot, installation.publicUrl);
    await store.assertPreparing(url, { userId: session.user.id, resourceId: resource.id, server: resource.mcp!.server,
      generation: await generation() }, port);
  });
  return { installationId: session.tenant.id, userId: session.user.id, resource, transport,
    callback: { dataRoot: installation.paths.dataRoot, publicUrl: installation.publicUrl,
      generation,
      configure: (url: string, port: number) => transport.configureCallback(url, port, installation.publicUrl),
    } };
}

/** Policy-only lookup for callback validation/settings; does not start a worker. */
export async function nativeConnectionResourcesForSession(session: AuthSession) {
  assertPersonalNativeConnectionIdentity(session.user.id);
  const installation = await loadInstallationConfig();
  if (installation.installationId !== session.tenant.id) throw denied();
  const workspace = await workspacePolicyForIdentity(installation.installationId, session.user.id, installation);
  const state = await ensureInstallationCatalog(new FileCatalogStore(installation.installationId, installation.paths.dataRoot), installation);
  const principal = { installationId: installation.installationId, userId: session.user.id, roleId: workspace.roleId,
    groupIds: workspace.groups.map(group => group.id), workspaceCanExecute: workspace.policy.capabilities.execute };
  return state.resources.filter(resource => resource.kind === "mcp" && resource.credentialMode === "personal-oauth"
    && !resource.sharedResource && allowsCatalogOperation(state, principal, resource.id, "read"));
}
