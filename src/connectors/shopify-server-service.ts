import "server-only";
import path from "node:path";
import type { AuthSession } from "@/auth/types";
import { FileLocalSessionStore } from "@/auth/local-session-store";
import { workspacePolicyForIdentity } from "@/admin/policy-service";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";
import { loadInstallationConfig } from "@/config/installation";
import type { InstallationConfig } from "@/config/installation-schema";
import { gmailOAuthEncryptionKey } from "@/connectors/gmail-oauth-store";
import type { ConnectorCapabilitySnapshot } from "@/connectors/contracts";
import { SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CONNECTOR_ID, SHOPIFY_SCOPES, SHOPIFY_CALLBACK, SHOPIFY_START, shopifyFail } from "./shopify-contracts";
import { ShopifyStore } from "./shopify-store";
import { exchangeShopifyToken, validShopifyHmac, ShopifyOrdersClient, shopifyPeriod } from "./shopify-api";

async function authorized(installationId: string, userId: string) {
  const config = await loadInstallationConfig();
  if (installationId !== "modtime" || config.installationId !== installationId || !process.env.MODTIME_REPORTING_USER_IDS?.split(",").includes(userId)) shopifyFail("ACTOR_DENIED");
  const workspace = await workspacePolicyForIdentity(installationId, userId, config);
  if (!(await catalogRuntimeEnforcer(installationId, userId)).allowsConnector(SHOPIFY_CONNECTOR_ID)) shopifyFail("CATALOG_DENIED");
  return { config, workspace };
}
function configuration(config: Readonly<InstallationConfig>) {
  if (config.installationId !== "modtime" || process.env.MODTIME_SHOPIFY_OAUTH_ENABLED !== "1") shopifyFail("NOT_CONFIGURED");
  const secret = process.env.MODTIME_SHOPIFY_CLIENT_SECRET;
  if (!secret || /\s/.test(secret) || process.env.MODTIME_SHOPIFY_CLIENT_ID !== SHOPIFY_CLIENT_ID) shopifyFail("NOT_CONFIGURED");
  const base = new URL(config.publicUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.port || base.pathname !== "/") shopifyFail("CALLBACK_CONFIGURATION_INVALID");
  let key; try { key = gmailOAuthEncryptionKey(process.env.MODTIME_SHOPIFY_OAUTH_ENCRYPTION_KEY); } catch { shopifyFail("NOT_CONFIGURED"); }
  return { secret, key, origin: base.origin, redirectUri: base.origin + SHOPIFY_CALLBACK };
}
async function operator(session: AuthSession, sessionId: string) {
  if (session.provider !== "local" || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) shopifyFail("SESSION_INVALID");
  const ctx = await authorized(session.tenant.id, session.user.id);
  if (!ctx.workspace.role.canManageWorkspace) shopifyFail("ADMIN_REQUIRED");
  // The cookie is revalidated in the durable store, not merely trusted because the route supplied it.
  const resolved = await new FileLocalSessionStore({ rootDirectory: path.join(ctx.config.paths.dataRoot, "sessions") }).read(sessionId, "modtime");
  if (!resolved || resolved.record.userId !== session.user.id) shopifyFail("SESSION_INVALID");
  return ctx;
}
export async function startShopifyOAuth(session: AuthSession, sessionId: string, requestUrl: string) {
  const { config } = await operator(session, sessionId), oauth = configuration(config);
  const request = new URL(requestUrl);
  if (request.origin !== oauth.origin || request.pathname !== SHOPIFY_START || request.search || request.hash) shopifyFail("CALLBACK_INVALID");
  const state = await new ShopifyStore(config, oauth.key).createState(session.user.id, sessionId, oauth.redirectUri);
  const url = new URL(`https://${SHOPIFY_SHOP}/admin/oauth/authorize`);
  url.search = new URLSearchParams({ client_id: SHOPIFY_CLIENT_ID, scope: SHOPIFY_SCOPES.join(","), redirect_uri: oauth.redirectUri, state }).toString();
  return url.href;
}
export async function completeShopifyOAuth(session: AuthSession, sessionId: string, callbackUrl: string, fetcher: typeof fetch = fetch) {
  const { config } = await operator(session, sessionId), oauth = configuration(config), url = new URL(callbackUrl);
  if (url.origin + url.pathname !== oauth.redirectUri || url.username || url.password || url.hash || url.searchParams.has("error") || callbackUrl.length > 16_384) shopifyFail("CALLBACK_INVALID");
  if (!await validShopifyHmac(url.searchParams, oauth.secret, url.host)) shopifyFail("CALLBACK_INVALID");
  const store = new ShopifyStore(config, oauth.key);
  await store.consumeState(session.user.id, sessionId, url.searchParams.get("state") ?? "", oauth.redirectUri);
  const version = await store.install(session.user.id, async () => {
    const token = await exchangeShopifyToken(oauth.secret, { code: url.searchParams.get("code")!, expiring: "1" }, fetcher);
    await new ShopifyOrdersClient(token.accessToken, fetcher).probe(); return token;
  });
  return { connected: true, shop: SHOPIFY_SHOP, version };
}
async function withShopify<T>(config: Readonly<InstallationConfig>, fetcher: typeof fetch, read: (client: ShopifyOrdersClient, version: number) => Promise<T>) {
  const oauth = configuration(config);
  return new ShopifyStore(config, oauth.key).withAccess(
    token => exchangeShopifyToken(oauth.secret, { grant_type: "refresh_token", refresh_token: token.refreshToken }, fetcher),
    (access, version) => read(new ShopifyOrdersClient(access, fetcher), version),
  );
}
export async function readShopifyOrders(installationId: string, userId: string, input: unknown, fetcher: typeof fetch = fetch) {
  const { config } = await authorized(installationId, userId);
  shopifyPeriod(input); // Reject bad periods before reading credentials or making provider requests.
  return withShopify(config, fetcher, client => client.summary(input));
}
type Capability = ConnectorCapabilitySnapshot & { accountEmail: null; connectionVersion: number | null; connectUrl: string | null; disconnectUrl: null };
export async function shopifyCapability(installationId: string, userId: string, fetcher: typeof fetch = fetch): Promise<Capability> {
  const { config, workspace } = await authorized(installationId, userId);
  const base = { connectorId: SHOPIFY_CONNECTOR_ID, label: "Shopify Orders · MODTIME", accountEmail: null, connectionVersion: null,
    connectUrl: workspace.role.canManageWorkspace ? SHOPIFY_START : null, disconnectUrl: null, approvalRequiredOperations: [] };
  try { configuration(config); }
  catch { return { ...base, connectUrl: null, status: "not_configured", statusCode: "MODTIME_SHOPIFY_NOT_CONFIGURED", checkedAt: null, effectiveOperations: [] }; }
  try {
    const verified = await withShopify(config, fetcher, async (client, version) => { await client.probe(); return version; });
    return { ...base, connectionVersion: verified, status: "connected", statusCode: null, checkedAt: new Date().toISOString(), effectiveOperations: ["orders-read"] };
  } catch (e) {
    const code = shopifyErrorCode(e), login = ["MODTIME_SHOPIFY_LOGIN_REQUIRED", "MODTIME_SHOPIFY_REAUTH_REQUIRED"].includes(code);
    return { ...base, status: login ? "reauth_required" : "degraded", statusCode: code, checkedAt: new Date().toISOString(), effectiveOperations: [] };
  }
}
export function shopifyErrorCode(error: unknown) { return error instanceof Error && /^MODTIME_SHOPIFY_[A-Z_]+$/.test(error.message) ? error.message : "MODTIME_SHOPIFY_FAILED"; }
