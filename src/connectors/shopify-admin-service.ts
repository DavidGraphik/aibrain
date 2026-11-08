import "server-only";
import path from "node:path";
import type { AuthSession } from "@/auth/types";
import { FileLocalSessionStore } from "@/auth/local-session-store";
import { workspacePolicyForIdentity } from "@/admin/policy-service";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";
import { loadInstallationConfig } from "@/config/installation";
import { gmailOAuthEncryptionKey } from "./gmail-oauth-store";
import { ShopifyStore } from "./shopify-store";
import { SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, shopifyFail, type ShopifyCredentialProfile } from "./shopify-contracts";
import { exchangeShopifyToken, validShopifyHmac } from "./shopify-api";
import { ShopifyAdminClient, SHOPIFY_ADMIN_SCOPES, type ShopifyAdminExecutionOptions } from "./shopify-admin-api";
import { SHOPIFY_THEMES_ID } from "./shopify-themes-api";
import { shopifyErrorCode } from "./shopify-server-service";

export const ADMIN_START = "/api/connectors/shopify/admin/oauth/start";
export const ADMIN_CALLBACK = "/api/connectors/shopify/admin/oauth/callback";

export function shopifyAdminEnabled() {
  return process.env.MODTIME_SHOPIFY_ADMIN_ENABLED === "1" ||
    process.env.MODTIME_SHOPIFY_ADMIN_ENABLED !== "0" && process.env.MODTIME_SHOPIFY_THEMES_ENABLED === "1";
}

async function context(installationId: string, userId: string) {
  const config = await loadInstallationConfig();
  const actors = (process.env.MODTIME_SHOPIFY_ADMIN_USER_IDS ?? process.env.MODTIME_SHOPIFY_THEME_USER_IDS)?.split(",").map(id => id.trim()) ?? [];
  if (installationId !== "modtime" || config.installationId !== installationId || !shopifyAdminEnabled() || !actors.includes(userId)) shopifyFail("ADMIN_ACTOR_DENIED");
  const workspace = await workspacePolicyForIdentity(installationId, userId, config);
  const catalog = await catalogRuntimeEnforcer(installationId, userId);
  // GraphQL can select mutations using operationName. Check the write grant for
  // every request instead of attempting to infer permission from its text.
  if (!catalog.allowsConnector(SHOPIFY_THEMES_ID) || !catalog.allowsConnectorWrite(SHOPIFY_THEMES_ID)) shopifyFail("CATALOG_DENIED");
  if (!workspace.policy.capabilities.execute) shopifyFail("ADMIN_EXECUTE_DENIED");
  // Reuse the merchant-owned Website Editor app when no dedicated app is set.
  // Keep credential triples atomic: a partial override must not combine one
  // app's ID with another app's secret or encryption key.
  const overridden = [process.env.MODTIME_SHOPIFY_ADMIN_CLIENT_ID, process.env.MODTIME_SHOPIFY_ADMIN_CLIENT_SECRET, process.env.MODTIME_SHOPIFY_ADMIN_ENCRYPTION_KEY].some(value => value !== undefined);
  const clientId = overridden ? process.env.MODTIME_SHOPIFY_ADMIN_CLIENT_ID : process.env.MODTIME_SHOPIFY_THEME_CLIENT_ID;
  const secret = overridden ? process.env.MODTIME_SHOPIFY_ADMIN_CLIENT_SECRET : process.env.MODTIME_SHOPIFY_THEME_CLIENT_SECRET;
  const encryptionKey = overridden ? process.env.MODTIME_SHOPIFY_ADMIN_ENCRYPTION_KEY : process.env.MODTIME_SHOPIFY_THEME_ENCRYPTION_KEY;
  if (!clientId || !/^[a-f0-9]{32}$/.test(clientId) || [SHOPIFY_CLIENT_ID, process.env.MODTIME_SHOPIFY_CLIENT_ID].includes(clientId) || !secret || /\s/.test(secret)) shopifyFail("ADMIN_NOT_CONFIGURED");
  let key; try { key = gmailOAuthEncryptionKey(encryptionKey); } catch { shopifyFail("ADMIN_NOT_CONFIGURED"); }
  const origin = new URL(config.publicUrl);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.port || origin.username || origin.password || origin.search || origin.hash) shopifyFail("CALLBACK_CONFIGURATION_INVALID");
  const profile: ShopifyCredentialProfile = { clientId, scopes: SHOPIFY_ADMIN_SCOPES, directory: "shopify-admin" };
  const store = new ShopifyStore(config, key, Date.now, profile);
  const withAccess = <T>(fn: (client: ShopifyAdminClient, version: number) => Promise<T>, fetcher: typeof fetch = fetch) => store.withAccess(
    token => exchangeShopifyToken(secret, { grant_type: "refresh_token", refresh_token: token.refreshToken }, fetcher, Date.now(), profile),
    (token, version) => fn(new ShopifyAdminClient(token, fetcher), version),
  );
  return { config, workspace, store, withAccess, profile, secret, origin: origin.origin };
}
function validateSession(session: AuthSession) {
  if (session.provider !== "local" || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) shopifyFail("SESSION_INVALID");
}
async function operator(session: AuthSession, sessionId: string) {
  validateSession(session);
  const ctx = await context(session.tenant.id, session.user.id);
  if (!ctx.workspace.role.canManageWorkspace) shopifyFail("ADMIN_REQUIRED");
  const resolved = await new FileLocalSessionStore({ rootDirectory: path.join(ctx.config.paths.dataRoot, "sessions") }).read(sessionId, "modtime");
  if (resolved?.record.userId !== session.user.id) shopifyFail("SESSION_INVALID");
  return ctx;
}
export async function startAdminOAuth(session: AuthSession, sessionId: string, requestUrl: string) {
  const ctx = await operator(session, sessionId), url = new URL(requestUrl);
  if (url.href !== ctx.origin + ADMIN_START) shopifyFail("CALLBACK_INVALID");
  const redirectUri = ctx.origin + ADMIN_CALLBACK, state = await ctx.store.createState(session.user.id, sessionId, redirectUri);
  return `https://${SHOPIFY_SHOP}/admin/oauth/authorize?` + new URLSearchParams({ client_id: ctx.profile.clientId, scope: SHOPIFY_ADMIN_SCOPES.join(","), redirect_uri: redirectUri, state });
}
export async function completeAdminOAuth(session: AuthSession, sessionId: string, requestUrl: string, fetcher: typeof fetch = fetch) {
  const ctx = await operator(session, sessionId), url = new URL(requestUrl), redirectUri = ctx.origin + ADMIN_CALLBACK;
  if (url.origin + url.pathname !== redirectUri || url.hash || url.username || url.password || url.searchParams.has("error") || requestUrl.length > 16384 || !await validShopifyHmac(url.searchParams, ctx.secret, url.host, ctx.profile)) shopifyFail("CALLBACK_INVALID");
  await ctx.store.consumeState(session.user.id, sessionId, url.searchParams.get("state") ?? "", redirectUri);
  const version = await ctx.store.install(session.user.id, async () => {
    const token = await exchangeShopifyToken(ctx.secret, { code: url.searchParams.get("code")!, expiring: "1" }, fetcher, Date.now(), ctx.profile);
    await new ShopifyAdminClient(token.accessToken, fetcher).identity();
    return token;
  });
  return { connected: true, version, writeVerified: false };
}
export async function adminCapability(installationId: string, userId: string, fetcher: typeof fetch = fetch) {
  const ctx = await context(installationId, userId);
  const base = { connectorId: SHOPIFY_THEMES_ID, label: "Shopify Website · MODTIME", accountEmail: null, disconnectUrl: null, connectUrl: ctx.workspace.role.canManageWorkspace ? ADMIN_START : null, approvalRequiredOperations: [] };
  try {
    const verified = await ctx.withAccess(async (client, version) => ({ ...await client.identity(), version }), fetcher);
    return { ...base, status: "connected" as const, statusCode: null, connectionVersion: verified.version, checkedAt: new Date().toISOString(), effectiveOperations: ["shopify-admin-graphql"], shop: verified.shop, scopes: verified.scopes };
  } catch (error) {
    return { ...base, status: "reauth_required" as const, statusCode: shopifyErrorCode(error), connectionVersion: null, checkedAt: new Date().toISOString(), effectiveOperations: [] };
  }
}
/** Called only by the authenticated, foreground runtime. This server session is
 * runtime identity, not an approval receipt or an extra user authorization. */
export async function assertShopifyAdminExecution(session: AuthSession) {
  validateSession(session);
  await context(session.tenant.id, session.user.id);
}
export async function executeShopifyAdmin(session: AuthSession, input: unknown, fetcher: typeof fetch = fetch, options?: ShopifyAdminExecutionOptions) {
  validateSession(session);
  const ctx = await context(session.tenant.id, session.user.id);
  return ctx.withAccess(async client => {
    // Re-read mutable server policy immediately before provider dispatch.
    validateSession(session);
    await context(session.tenant.id, session.user.id);
    return client.execute(input, options);
  }, fetcher);
}
