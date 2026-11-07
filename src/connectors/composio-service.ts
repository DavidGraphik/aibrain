import "server-only";
import { ON_CONNECT, resolveComposioToolkit, provisionComposioToolkit } from "./composio-provisioning";
import path from "node:path";
import type { AuthSession } from "@/auth/types";
import { loadInstallationConfig } from "@/config/installation";
import type { InstallationConfig } from "@/config/installation-schema";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";
import { FileConnectorBindingStore } from "./binding-store";
import { FileGmailOAuthStateStore } from "./gmail-oauth-store";
import { ComposioApi, ComposioError, composioUserId } from "./composio-api";
import { composioConnectorId } from "./composio-config";
import type { GmailConnectionSnapshot } from "./gmail-contracts";
import { ResourceLockManager } from "@/storage";

export function composioErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "COMPOSIO_UNAVAILABLE";
}
async function context(config: Readonly<InstallationConfig>, userId: string, slug: string, fetcher?: typeof fetch, provision = false) {
  let toolkit = config.connectors?.composio?.toolkits.find(t => t.slug === slug);
  if (!toolkit) throw new ComposioError("COMPOSIO_TOOLKIT_NOT_ENABLED");
  const id = composioConnectorId(slug);
  if (!(await catalogRuntimeEnforcer(config.installationId, userId)).allowsConnector(id)) throw new ComposioError("COMPOSIO_CATALOG_DENIED");
  toolkit = provision ? await provisionComposioToolkit(config, toolkit, fetcher) : await resolveComposioToolkit(config, toolkit);
  const api = new ComposioApi(process.env.AIBRAIN_COMPOSIO_API_KEY ?? "", fetcher);
  const principal = { installationId: config.installationId, userId, roleId: null };
  const bindings = new FileConnectorBindingStore(config.installationId, config.paths.dataRoot);
  const remoteUser = composioUserId(config.installationId, userId);
  const states = new FileGmailOAuthStateStore(config, Date.now, "composio");
  const callback = `${config.publicUrl}/api/connectors/composio/${slug}/callback`;
  return { toolkit, id, api, principal, bindings, remoteUser, states, callback };
}
async function sessionConfig(session: AuthSession) {
  const config = await loadInstallationConfig();
  if (session.provider !== "local" || config.installationId !== session.tenant.id) throw new ComposioError("COMPOSIO_TENANT_MISMATCH");
  return config;
}
function accountId(ref: string) {
  if (!/^composio:[A-Za-z0-9_-]{1,150}$/.test(ref)) throw new ComposioError("COMPOSIO_BINDING_INVALID");
  return ref.slice("composio:".length);
}
function locked<T>(config: Readonly<InstallationConfig>, userId: string, slug: string, action: () => Promise<T>) {
  return new ResourceLockManager({ rootDirectory: path.join(config.paths.dataRoot, "connectors", "composio", "operation-locks"), defaultTimeoutMs: 5_000 }).withLock(`${userId}:${slug}`, action);
}
export async function startComposio(session: AuthSession, slug: string) {
  const config = await sessionConfig(session);
  const c = await context(config, session.user.id, slug, undefined, true);
  // Bind the exact auth config into the durable, one-use state receipt.
  const receipt = `${c.callback}?auth_config=${encodeURIComponent(c.toolkit.authConfigId)}`;
  const state = await c.states.create(session.user.id, receipt);
  return c.api.begin(c.toolkit, c.remoteUser, `${c.callback}?state=${encodeURIComponent(state.state)}`);
}
export async function completeComposio(session: AuthSession, slug: string, input: { state: string; status: string; accountId: string }, fetcher?: typeof fetch) {
  const config = await sessionConfig(session);
  return locked(config, session.user.id, slug, async () => {
    const c = await context(config, session.user.id, slug, fetcher);
    const receipt = await c.states.consume(session.user.id, input.state);
    if (receipt.redirectUri !== `${c.callback}?auth_config=${encodeURIComponent(c.toolkit.authConfigId)}` || input.status.toLowerCase() !== "success") throw new ComposioError("COMPOSIO_CALLBACK_INVALID");
    await c.api.account(c.toolkit, c.remoteUser, input.accountId);
    const prior = await c.bindings.readPersonalForManagement(c.principal, c.id).catch(error => {
      if (composioErrorCode(error) !== "ENOENT") throw error;
      return null;
    });
    await c.bindings.put({ schemaVersion: 1, connectorId: c.id, credentialRef: `composio:${input.accountId}`, installationId: config.installationId, userId: session.user.id, scopes: [...c.toolkit.scopes], status: "active", version: (prior?.version ?? 0) + 1 });
  });
}
export async function composioCapability(config: Readonly<InstallationConfig>, userId: string, slug: string, fetcher?: typeof fetch): Promise<GmailConnectionSnapshot> {
  const toolkit = config.connectors?.composio?.toolkits.find(t => t.slug === slug);
  if (!toolkit) throw new ComposioError("COMPOSIO_TOOLKIT_NOT_ENABLED");
  const base = { connectorId: composioConnectorId(slug), label: toolkit.label, checkedAt: null, effectiveOperations: [], approvalRequiredOperations: [], accountEmail: null, connectionVersion: null, connectUrl: null, disconnectUrl: null };
  let c;
  try { c = await context(config, userId, slug, fetcher); }
  catch (error) {
    if (composioErrorCode(error) === "COMPOSIO_CATALOG_DENIED") throw error;
    return { ...base, status: "not_configured", statusCode: composioErrorCode(error) };
  }
  try {
    if (c.toolkit.authConfigId === ON_CONNECT) return { ...base, status: process.env.AIBRAIN_COMPOSIO_CATALOG_API_KEY ? "reauth_required" : "not_configured", statusCode: "COMPOSIO_LOGIN_REQUIRED", connectUrl: process.env.AIBRAIN_COMPOSIO_CATALOG_API_KEY ? `/api/connectors/composio/${slug}/connect` : null };
    await c.api.verifyConfig(c.toolkit);
    const urls = { connectUrl: `/api/connectors/composio/${slug}/connect`, disconnectUrl: `/api/connectors/composio/${slug}/disconnect` };
    const binding = await c.bindings.readPersonalForManagement(c.principal, c.id).catch(error => {
      if (composioErrorCode(error) !== "ENOENT") throw error;
      return null;
    });
    if (!binding) return { ...base, ...urls, disconnectUrl: null, status: "reauth_required", statusCode: "COMPOSIO_LOGIN_REQUIRED" };
    if (binding.status !== "active" || !toolkit.scopes.every(s => binding.scopes.includes(s))) return { ...base, ...urls, status: "reauth_required", statusCode: "COMPOSIO_REVOKED" };
    await c.api.account(c.toolkit, c.remoteUser, accountId(binding.credentialRef));
    return { ...base, ...urls, status: "connected", statusCode: null, checkedAt: new Date().toISOString(), connectionVersion: binding.version, effectiveOperations: toolkit.readTools.map(t => t.slug) };
  } catch (error) {
    return { ...base, status: composioErrorCode(error) === "COMPOSIO_REAUTH_REQUIRED" ? "reauth_required" : "degraded", statusCode: composioErrorCode(error), checkedAt: new Date().toISOString(), connectUrl: `/api/connectors/composio/${slug}/connect`, disconnectUrl: `/api/connectors/composio/${slug}/disconnect` };
  }
}
export async function composioCapabilitiesForSession(session: AuthSession) {
  const config = await loadInstallationConfig();
  // This optional local-auth integration must not break legacy/demo Settings.
  if (!config.connectors?.composio?.toolkits.length || session.provider !== "local") return [];
  if (config.installationId !== session.tenant.id) throw new ComposioError("COMPOSIO_TENANT_MISMATCH");
  const results: GmailConnectionSnapshot[] = [];
  const toolkits = config.connectors.composio.toolkits;
  // Read-only checks can overlap, but cap fan-out to protect the provider and
  // keep manifest order. Each check still enforces this user's catalog access.
  for (let offset = 0; offset < toolkits.length; offset += 4) {
    const batch = await Promise.all(toolkits.slice(offset, offset + 4).map(async toolkit => {
      try { return await composioCapability(config, session.user.id, toolkit.slug); }
      catch (error) {
        if (composioErrorCode(error) === "COMPOSIO_CATALOG_DENIED") return null;
        throw error;
      }
    }));
    results.push(...batch.filter((item): item is GmailConnectionSnapshot => item !== null));
  }
  return results;
}
export async function disconnectComposio(session: AuthSession, slug: string, fetcher?: typeof fetch) {
  const config = await sessionConfig(session);
  return locked(config, session.user.id, slug, async () => {
    const c = await context(config, session.user.id, slug, fetcher);
    const binding = await c.bindings.readPersonalForManagement(c.principal, c.id);
    // Preserve the handle for a retry when provider revocation fails. Local access stops first.
    if (binding.status !== "revoked") await c.bindings.put({ ...binding, status: "revoked", version: binding.version + 1 });
    try {
      await c.api.account(c.toolkit, c.remoteUser, accountId(binding.credentialRef), false, true);
      await c.api.revoke(accountId(binding.credentialRef));
      return { status: "revoked", providerRevoked: true };
    } catch { return { status: "revoked", providerRevoked: false, errorCode: "COMPOSIO_REVOCATION_PENDING" }; }
  });
}
export async function composioReadTool(config: Readonly<InstallationConfig>, userId: string, slug: string, tool: string | null, args: Record<string, unknown>, fetcher?: typeof fetch) {
  return locked(config, userId, slug, async () => {
    const c = await context(config, userId, slug, fetcher);
    const binding = await c.bindings.resolve(c.principal, c.id, { allowShared: false });
    if (binding.status !== "active" || !c.toolkit.scopes.every(s => binding.scopes.includes(s))) throw new ComposioError("COMPOSIO_REAUTH_REQUIRED");
    const id = accountId(binding.credentialRef);
    if (tool !== null) return c.api.execute(c.toolkit, c.remoteUser, id, tool, args);
    await c.api.account(c.toolkit, c.remoteUser, id);
    return c.api.tools(c.toolkit);
  });
}
