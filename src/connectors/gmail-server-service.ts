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
  GMAIL_CONNECTOR_ID,
  GMAIL_MINIMUM_SCOPES,
  GMAIL_RESOURCE_ID,
  type GmailConnectionSnapshot,
  type GmailProfile,
} from "@/connectors/gmail-contracts";
import {
  exchangeGmailCode,
  gmailAuthorizationUrl,
  readGmailProfile,
  refreshGmailToken,
  revokeGmailToken,
} from "@/connectors/gmail-api";
import {
  FileGmailOAuthStateStore,
  FileGmailTokenStore,
  GmailOAuthStoreError,
  gmailOAuthEncryptionKey,
} from "@/connectors/gmail-oauth-store";

type Fetcher = typeof fetch;

export class GmailConnectorError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "GmailConnectorError"; }
}

function code(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "GMAIL_CONNECTOR_FAILED";
}

function oauthConfiguration(config: Readonly<InstallationConfig>) {
  if (!config.connectors?.gmail?.enabled) throw new GmailConnectorError("GMAIL_NOT_ENABLED", "Gmail is not enabled for this installation.", 404);
  const clientId = process.env.AIBRAIN_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.AIBRAIN_GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new GmailConnectorError("GMAIL_GOOGLE_CLOUD_NOT_CONFIGURED", "Google Cloud OAuth is not configured on this server.", 503);
  const encryptionKey = gmailOAuthEncryptionKey(process.env.AIBRAIN_GOOGLE_OAUTH_ENCRYPTION_KEY?.trim());
  return { clientId, clientSecret, encryptionKey, redirectUri: `${config.publicUrl}/api/connectors/gmail/oauth/callback` };
}

async function context(session: AuthSession) {
  const config = await loadInstallationConfig();
  if (session.provider !== "local" || session.tenant.id !== config.installationId) throw new GmailConnectorError("GMAIL_TENANT_MISMATCH", "Authenticated session does not belong to this installation.", 403);
  const workspace = await workspacePolicyForIdentity(config.installationId, session.user.id, config);
  const principal: ConnectorPrincipal = { installationId: config.installationId, userId: session.user.id, roleId: workspace.roleId };
  const catalog = await catalogRuntimeEnforcer(config.installationId, session.user.id);
  if (!catalog.allowsConnector(GMAIL_CONNECTOR_ID)) throw new GmailConnectorError("GMAIL_CATALOG_DENIED", "Gmail is not authorized for this user.", 403);
  return { config, principal };
}

async function bindingForUser(config: Readonly<InstallationConfig>, principal: ConnectorPrincipal) {
  return new FileConnectorBindingStore(config.installationId, config.paths.dataRoot).resolve(principal, GMAIL_CONNECTOR_ID, { allowShared: false });
}

export async function gmailAccessForIdentity(
  config: Readonly<InstallationConfig>,
  userId: string,
  fetcher: Fetcher = fetch,
  rejectedAccessToken?: string,
) {
  const oauth = oauthConfiguration(config);
  const principal: ConnectorPrincipal = { installationId: config.installationId, userId, roleId: null };
  const binding = await bindingForUser(config, principal);
  if (binding.userId !== userId || binding.status !== "active") throw new GmailConnectorError("GMAIL_REAUTH_REQUIRED", "Gmail requires authentication.", 401);
  const tokens = new FileGmailTokenStore(config, oauth.encryptionKey);
  let current = (await tokens.read(userId, binding.credentialRef)).token;
  if (Date.parse(current.expiresAt) <= Date.now() + 60_000 || current.accessToken === rejectedAccessToken) {
    current = await refreshGmailToken(fetcher, { clientId: oauth.clientId, clientSecret: oauth.clientSecret, token: current });
    await tokens.put(userId, current, binding.credentialRef);
  }
  return { accessToken: current.accessToken, binding };
}

/** Retry only authenticated reads once after a provider rejects the access token.
 * Resolving again preserves personal binding/revocation checks and reuses a token
 * already renewed by another request instead of refreshing the rejected token.
 */
export async function withGmailReadAccess<T>(config: Readonly<InstallationConfig>, userId: string, read: (accessToken: string) => Promise<T>, fetcher: Fetcher = fetch): Promise<T> {
  const access = await gmailAccessForIdentity(config, userId, fetcher);
  try { return await read(access.accessToken); }
  catch (error) {
    if (code(error) !== "GMAIL_REAUTH_REQUIRED" || !error || typeof error !== "object" || !("status" in error) || error.status !== 401) throw error;
    const renewed = await gmailAccessForIdentity(config, userId, fetcher, access.accessToken);
    return read(renewed.accessToken);
  }
}

export async function startGmailOAuth(session: AuthSession) {
  const { config } = await context(session);
  const oauth = oauthConfiguration(config);
  const state = await new FileGmailOAuthStateStore(config).create(session.user.id, oauth.redirectUri);
  return gmailAuthorizationUrl({ clientId: oauth.clientId, redirectUri: oauth.redirectUri, state: state.state, codeVerifier: state.codeVerifier });
}

export async function completeGmailOAuth(session: AuthSession, input: { state: string; code: string }, fetcher: Fetcher = fetch) {
  const { config, principal } = await context(session);
  const oauth = oauthConfiguration(config);
  const consumed = await new FileGmailOAuthStateStore(config).consume(session.user.id, input.state);
  if (consumed.redirectUri !== oauth.redirectUri || !/^[A-Za-z0-9._~+/-]{8,4096}$/u.test(input.code)) throw new GmailConnectorError("GMAIL_OAUTH_CALLBACK_INVALID", "Gmail OAuth callback is invalid.", 400);
  const token = await exchangeGmailCode(fetcher, { clientId: oauth.clientId, clientSecret: oauth.clientSecret, redirectUri: oauth.redirectUri, code: input.code, codeVerifier: consumed.codeVerifier });
  const profile = await readGmailProfile(fetcher, token.accessToken);
  const bindings = new FileConnectorBindingStore(config.installationId, config.paths.dataRoot);
  let existing: CredentialBinding | null = null;
  try { existing = await bindings.readPersonalForManagement(principal, GMAIL_CONNECTOR_ID); }
  catch (error) { if (code(error) !== "ENOENT") throw error; }
  const stored = await new FileGmailTokenStore(config, oauth.encryptionKey).put(session.user.id, token, existing?.credentialRef);
  const binding = await bindings.put({ schemaVersion: 1, connectorId: GMAIL_CONNECTOR_ID, credentialRef: stored.credentialRef, installationId: config.installationId, userId: session.user.id, scopes: [...GMAIL_MINIMUM_SCOPES], status: "active", version: (existing?.version ?? 0) + 1 });
  return { profile, bindingVersion: binding.version, bindingFingerprint: credentialBindingFingerprint(binding) };
}

async function connectedReadback(config: Readonly<InstallationConfig>, principal: ConnectorPrincipal, fetcher: Fetcher): Promise<{ binding: CredentialBinding; profile: GmailProfile }> {
  const binding = await bindingForUser(config, principal);
  const profile = await withGmailReadAccess(config, principal.userId, (token) => readGmailProfile(fetcher, token), fetcher);
  return { binding, profile };
}

export async function gmailCapabilityForSession(session: AuthSession, fetcher: Fetcher = fetch): Promise<GmailConnectionSnapshot> {
  let config: Readonly<InstallationConfig>;
  let principal: ConnectorPrincipal;
  try { ({ config, principal } = await context(session)); }
  catch (error) { if (error instanceof GmailConnectorError && error.code === "GMAIL_CATALOG_DENIED") throw error; throw error; }
  const base = { connectorId: GMAIL_CONNECTOR_ID, label: "Google", effectiveOperations: [], approvalRequiredOperations: [], connectUrl: "/api/connectors/gmail/oauth/start", disconnectUrl: null, accountEmail: null, connectionVersion: null };
  if (!config.connectors?.gmail?.enabled) return { ...base, status: "not_configured", statusCode: "GMAIL_NOT_ENABLED", checkedAt: null, connectUrl: null };
  try { oauthConfiguration(config); }
  catch (error) { return { ...base, status: "not_configured", statusCode: code(error), checkedAt: null, connectUrl: null }; }
  try {
    const { binding, profile } = await connectedReadback(config, principal, fetcher);
    return { ...base, status: "connected", statusCode: null, checkedAt: new Date().toISOString(), effectiveOperations: ["search", "read"], accountEmail: profile.emailAddress, connectionVersion: binding.version, disconnectUrl: "/api/connectors/gmail/disconnect" };
  } catch (error) {
    const errorCode = code(error);
    if (errorCode === "CONNECTOR_BINDING_NOT_FOUND") return { ...base, status: "reauth_required", statusCode: "GMAIL_LOGIN_REQUIRED", checkedAt: null };
    if (errorCode === "CONNECTOR_BINDING_REVOKED" || errorCode === "GMAIL_REAUTH_REQUIRED") return { ...base, status: "reauth_required", statusCode: errorCode, checkedAt: null };
    return { ...base, status: "degraded", statusCode: errorCode, checkedAt: new Date().toISOString(), disconnectUrl: "/api/connectors/gmail/disconnect" };
  }
}

export async function disconnectGmail(session: AuthSession, fetcher: Fetcher = fetch) {
  const { config, principal } = await context(session);
  const oauth = oauthConfiguration(config);
  const bindings = new FileConnectorBindingStore(config.installationId, config.paths.dataRoot);
  const binding = await bindings.resolve(principal, GMAIL_CONNECTOR_ID, { allowShared: false });
  const tokens = new FileGmailTokenStore(config, oauth.encryptionKey);
  const token = (await tokens.read(session.user.id, binding.credentialRef)).token;
  const revoked = await bindings.revoke(principal, GMAIL_CONNECTOR_ID, { allowShared: false, manageShared: false, expectedVersion: binding.version });
  try {
    await revokeGmailToken(fetcher, token.refreshToken || token.accessToken);
    await tokens.clear(session.user.id, binding.credentialRef);
    return { status: "revoked" as const, providerRevoked: true, bindingVersion: revoked.version };
  } catch (error) {
    return { status: "revoked" as const, providerRevoked: false, bindingVersion: revoked.version, errorCode: code(error) };
  }
}

export function gmailConnectorErrorCode(error: unknown) {
  if (error instanceof GmailConnectorError || error instanceof GmailOAuthStoreError || error instanceof ConnectorError) return error.code;
  return code(error);
}

export { GMAIL_RESOURCE_ID };
