import "server-only";

import type { AuthSession } from "@/auth/types";
import { workspacePolicyForIdentity } from "@/admin/policy-service";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";
import { loadInstallationConfig } from "@/config/installation";
import type { InstallationConfig } from "@/config/installation-schema";
import { FileConnectorBindingStore } from "@/connectors/binding-store";
import { credentialBindingFingerprint } from "@/connectors/authorization";
import { ConnectorError, type ConnectorPrincipal, type CredentialBinding } from "@/connectors/contracts";
import {
  OUTLOOK_API_SCOPES,
  OUTLOOK_CONNECTOR_ID,
  OUTLOOK_RESOURCE_ID,
  type OutlookConnectionSnapshot,
  type OutlookProfile,
} from "@/connectors/outlook-contracts";
import {
  exchangeOutlookCode,
  outlookAuthorizationUrl,
  readOutlookProfile,
  refreshOutlookToken,
} from "@/connectors/outlook-api";
import {
  FileOutlookOAuthStateStore,
  FileOutlookTokenStore,
  OutlookOAuthStoreError,
  outlookOAuthEncryptionKey,
} from "@/connectors/outlook-oauth-store";

type Fetcher = typeof fetch;

export class OutlookConnectorError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "OutlookConnectorError"; }
}

function code(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "OUTLOOK_CONNECTOR_FAILED";
}

function oauthConfiguration(config: Readonly<InstallationConfig>) {
  const outlook = config.connectors?.outlook;
  if (!outlook?.enabled) throw new OutlookConnectorError("OUTLOOK_NOT_ENABLED", "Outlook is not enabled for this installation.", 404);
  if (!outlook.tenantId) throw new OutlookConnectorError("OUTLOOK_ENTRA_TENANT_NOT_CONFIGURED", "The Microsoft Entra tenant is not configured on this server.", 503);
  const clientId = process.env.AIBRAIN_MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.AIBRAIN_MICROSOFT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new OutlookConnectorError("OUTLOOK_ENTRA_NOT_CONFIGURED", "Microsoft Entra OAuth is not configured on this server.", 503);
  const encryptionKey = outlookOAuthEncryptionKey(process.env.AIBRAIN_MICROSOFT_OAUTH_ENCRYPTION_KEY?.trim());
  return { tenantId: outlook.tenantId, clientId, clientSecret, encryptionKey, redirectUri: `${config.publicUrl}/api/connectors/outlook/oauth/callback` };
}

async function context(session: AuthSession, requireEnabled = true) {
  const config = await loadInstallationConfig();
  if (session.provider !== "local" || session.tenant.id !== config.installationId) throw new OutlookConnectorError("OUTLOOK_TENANT_MISMATCH", "Authenticated session does not belong to this installation.", 403);
  if (requireEnabled && !config.connectors?.outlook?.enabled) throw new OutlookConnectorError("OUTLOOK_NOT_ENABLED", "Outlook is not enabled for this installation.", 404);
  const workspace = await workspacePolicyForIdentity(config.installationId, session.user.id, config);
  const principal: ConnectorPrincipal = { installationId: config.installationId, userId: session.user.id, roleId: workspace.roleId };
  const catalog = await catalogRuntimeEnforcer(config.installationId, session.user.id);
  if (!catalog.allowsConnector(OUTLOOK_CONNECTOR_ID)) throw new OutlookConnectorError("OUTLOOK_CATALOG_DENIED", "Outlook is not authorized for this user.", 403);
  return { config, principal };
}

async function bindingForUser(config: Readonly<InstallationConfig>, principal: ConnectorPrincipal) {
  return new FileConnectorBindingStore(config.installationId, config.paths.dataRoot).resolve(principal, OUTLOOK_CONNECTOR_ID, { allowShared: false });
}

export async function outlookAccessForIdentity(config: Readonly<InstallationConfig>, userId: string, fetcher: Fetcher = fetch, rejectedAccessToken?: string) {
  const oauth = oauthConfiguration(config);
  const principal: ConnectorPrincipal = { installationId: config.installationId, userId, roleId: null };
  const binding = await bindingForUser(config, principal);
  if (binding.userId !== userId || binding.status !== "active") throw new OutlookConnectorError("OUTLOOK_REAUTH_REQUIRED", "Outlook requires authentication.", 401);
  const tokens = new FileOutlookTokenStore(config, oauth.encryptionKey);
  let current = (await tokens.read(userId, binding.credentialRef)).token;
  if (Date.parse(current.expiresAt) <= Date.now() + 60_000 || current.accessToken === rejectedAccessToken) {
    current = await refreshOutlookToken(fetcher, { tenantId: oauth.tenantId, clientId: oauth.clientId, clientSecret: oauth.clientSecret, token: current });
    await tokens.put(userId, current, binding.credentialRef);
  }
  return { accessToken: current.accessToken, tenantId: oauth.tenantId, binding };
}

/** Retry only authenticated reads once after a provider rejects the access token.
 * Resolving again preserves personal binding/revocation checks and reuses a token
 * already renewed by another request instead of refreshing the rejected token.
 */
export async function withOutlookReadAccess<T>(config: Readonly<InstallationConfig>, userId: string, read: (accessToken: string) => Promise<T>, fetcher: Fetcher = fetch): Promise<T> {
  const access = await outlookAccessForIdentity(config, userId, fetcher);
  try { return await read(access.accessToken); }
  catch (error) {
    if (code(error) !== "OUTLOOK_REAUTH_REQUIRED" || !error || typeof error !== "object" || !("status" in error) || error.status !== 401) throw error;
    const renewed = await outlookAccessForIdentity(config, userId, fetcher, access.accessToken);
    return read(renewed.accessToken);
  }
}

export async function startOutlookOAuth(session: AuthSession) {
  const { config } = await context(session);
  const oauth = oauthConfiguration(config);
  const state = await new FileOutlookOAuthStateStore(config).create(session.user.id, oauth.redirectUri);
  return outlookAuthorizationUrl({ tenantId: oauth.tenantId, clientId: oauth.clientId, redirectUri: oauth.redirectUri, state: state.state, codeVerifier: state.codeVerifier });
}

export async function completeOutlookOAuth(session: AuthSession, input: { state: string; code: string }, fetcher: Fetcher = fetch) {
  const { config, principal } = await context(session);
  const oauth = oauthConfiguration(config);
  const consumed = await new FileOutlookOAuthStateStore(config).consume(session.user.id, input.state);
  if (consumed.redirectUri !== oauth.redirectUri || !/^[A-Za-z0-9._~+/-]{8,4096}$/u.test(input.code)) throw new OutlookConnectorError("OUTLOOK_OAUTH_CALLBACK_INVALID", "Outlook OAuth callback is invalid.", 400);
  const token = await exchangeOutlookCode(fetcher, { tenantId: oauth.tenantId, clientId: oauth.clientId, clientSecret: oauth.clientSecret, redirectUri: oauth.redirectUri, code: input.code, codeVerifier: consumed.codeVerifier });
  const profile = await readOutlookProfile(fetcher, token.accessToken, oauth.tenantId);
  const bindings = new FileConnectorBindingStore(config.installationId, config.paths.dataRoot);
  let existing: CredentialBinding | null = null;
  try { existing = await bindings.readPersonalForManagement(principal, OUTLOOK_CONNECTOR_ID); }
  catch (error) { if (code(error) !== "ENOENT") throw error; }
  const stored = await new FileOutlookTokenStore(config, oauth.encryptionKey).put(session.user.id, token, existing?.credentialRef);
  const binding = await bindings.put({ schemaVersion: 1, connectorId: OUTLOOK_CONNECTOR_ID, credentialRef: stored.credentialRef, installationId: config.installationId, userId: session.user.id, scopes: [...OUTLOOK_API_SCOPES], status: "active", version: (existing?.version ?? 0) + 1 });
  return { profile, bindingVersion: binding.version, bindingFingerprint: credentialBindingFingerprint(binding) };
}

async function connectedReadback(config: Readonly<InstallationConfig>, principal: ConnectorPrincipal, fetcher: Fetcher): Promise<{ binding: CredentialBinding; profile: OutlookProfile }> {
  const binding = await bindingForUser(config, principal);
  const tenantId = oauthConfiguration(config).tenantId;
  const profile = await withOutlookReadAccess(config, principal.userId, (token) => readOutlookProfile(fetcher, token, tenantId), fetcher);
  return { binding, profile };
}

export async function outlookCapabilityForSession(session: AuthSession, fetcher: Fetcher = fetch): Promise<OutlookConnectionSnapshot> {
  // A catalog tile can be provisioned before administrative OAuth setup.
  // Keep authorization mandatory, but report missing setup without enabling it.
  const { config, principal } = await context(session, false);
  const base = { connectorId: OUTLOOK_CONNECTOR_ID, label: "Microsoft 365", effectiveOperations: [], approvalRequiredOperations: [], connectUrl: "/api/connectors/outlook/oauth/start", disconnectUrl: null, accountEmail: null, connectionVersion: null };
  try { oauthConfiguration(config); }
  catch (error) { return { ...base, status: "not_configured", statusCode: code(error), checkedAt: null, connectUrl: null }; }
  try {
    const { binding, profile } = await connectedReadback(config, principal, fetcher);
    return { ...base, status: "connected", statusCode: null, checkedAt: new Date().toISOString(), effectiveOperations: ["search", "read"], accountEmail: profile.emailAddress, connectionVersion: binding.version, disconnectUrl: "/api/connectors/outlook/disconnect" };
  } catch (error) {
    const errorCode = code(error);
    if (errorCode === "CONNECTOR_BINDING_NOT_FOUND") return { ...base, status: "reauth_required", statusCode: "OUTLOOK_LOGIN_REQUIRED", checkedAt: null };
    if (errorCode === "CONNECTOR_BINDING_REVOKED" || errorCode === "OUTLOOK_REAUTH_REQUIRED") return { ...base, status: "reauth_required", statusCode: errorCode, checkedAt: null };
    return { ...base, status: "degraded", statusCode: errorCode, checkedAt: new Date().toISOString(), disconnectUrl: "/api/connectors/outlook/disconnect" };
  }
}

export async function disconnectOutlook(session: AuthSession) {
  const { config, principal } = await context(session);
  const oauth = oauthConfiguration(config);
  const bindings = new FileConnectorBindingStore(config.installationId, config.paths.dataRoot);
  const binding = await bindings.resolve(principal, OUTLOOK_CONNECTOR_ID, { allowShared: false });
  const revoked = await bindings.revoke(principal, OUTLOOK_CONNECTOR_ID, { allowShared: false, manageShared: false, expectedVersion: binding.version });
  try {
    await new FileOutlookTokenStore(config, oauth.encryptionKey).clear(session.user.id, binding.credentialRef);
    return { status: "revoked" as const, localCredentialDeleted: true, providerRevoked: false, providerRevocationCode: "OUTLOOK_PROVIDER_REVOCATION_NOT_SUPPORTED", bindingVersion: revoked.version };
  } catch (error) {
    return { status: "revoked" as const, localCredentialDeleted: false, providerRevoked: false, providerRevocationCode: "OUTLOOK_PROVIDER_REVOCATION_NOT_SUPPORTED", bindingVersion: revoked.version, errorCode: code(error) };
  }
}

export function outlookConnectorErrorCode(error: unknown) {
  if (error instanceof OutlookConnectorError || error instanceof OutlookOAuthStoreError || error instanceof ConnectorError) return error.code;
  return code(error);
}

export { OUTLOOK_RESOURCE_ID };
