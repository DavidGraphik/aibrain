import "server-only";
import path from "node:path";
import { assertInteractiveChatAuthorization, type InteractiveChatAuthorization } from "@/runtime/interactive-chat-authorization";
import type { AuthSession } from "@/auth/types";
import { FileLocalSessionStore } from "@/auth/local-session-store";
import { workspacePolicyForIdentity } from "@/admin/policy-service";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";
import { loadInstallationConfig } from "@/config/installation";
import { gmailOAuthEncryptionKey } from "./gmail-oauth-store";
import { ShopifyStore } from "./shopify-store";
import { shopifyFail, type ShopifyCredentialProfile } from "./shopify-contracts";
import { exchangeShopifyToken, validShopifyHmac } from "./shopify-api";
import { SHOPIFY_SHOP } from "./shopify-contracts";
import { ShopifyThemesClient, SHOPIFY_THEMES_ID, THEME_SCOPES, draftId, themeFilename } from "./shopify-themes-api";
import { ThemeEditStore, themeHash, titleEdit } from "./shopify-theme-edit";
import { themeFileEdit } from "./shopify-theme-file-edit";
import type { ConnectorCapabilitySnapshot } from "./contracts";
import { FileApprovalStore, type ApprovalLocator } from "@/runtime/approval-store";
import type { ApprovalItem } from "@/lib/chat-contract";
export const THEMES_START = "/api/connectors/shopify/themes/oauth/start";
export const THEMES_CALLBACK = "/api/connectors/shopify/themes/oauth/callback";
async function context(installationId: string, userId: string, write = false) {
  const config = await loadInstallationConfig();
  if (installationId !== "modtime" || config.installationId !== installationId || process.env.MODTIME_SHOPIFY_THEMES_ENABLED !== "1" || !process.env.MODTIME_SHOPIFY_THEME_USER_IDS?.split(",").includes(userId)) shopifyFail("THEME_ACTOR_DENIED");
  const workspace = await workspacePolicyForIdentity(installationId, userId, config);
  const catalog = await catalogRuntimeEnforcer(installationId, userId);
  if (!catalog.allowsConnector(SHOPIFY_THEMES_ID) || write && !catalog.allowsConnectorWrite(SHOPIFY_THEMES_ID)) shopifyFail("CATALOG_DENIED");
  if (write && !workspace.policy.capabilities.execute) shopifyFail("THEME_EXECUTE_DENIED");
  const clientId = process.env.MODTIME_SHOPIFY_THEME_CLIENT_ID, secret = process.env.MODTIME_SHOPIFY_THEME_CLIENT_SECRET;
  // A distinct app avoids expanding or invalidating the Orders connector's exact read-only grant.
  if (!clientId || !/^[a-f0-9]{32}$/.test(clientId) || clientId === process.env.MODTIME_SHOPIFY_CLIENT_ID || !secret || /\s/.test(secret)) shopifyFail("THEME_NOT_CONFIGURED");
  let key; try { key = gmailOAuthEncryptionKey(process.env.MODTIME_SHOPIFY_THEME_ENCRYPTION_KEY); } catch { shopifyFail("THEME_NOT_CONFIGURED"); }
  const origin = new URL(config.publicUrl);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.port || origin.username || origin.password || origin.search || origin.hash) shopifyFail("CALLBACK_CONFIGURATION_INVALID");
  const profile: ShopifyCredentialProfile = { clientId, scopes: THEME_SCOPES, directory: "shopify-themes" };
  const store = new ShopifyStore(config, key, Date.now, profile), edits = new ThemeEditStore(config.paths.dataRoot);
  const policyHash = themeHash(JSON.stringify({ userId, role: workspace.roleId, policy: workspace.policy, clientId, enabled: true }));
  const withAccess = <T>(fn: (client: ShopifyThemesClient, version: number) => Promise<T>, fetcher: typeof fetch = fetch) => store.withAccess(
    token => exchangeShopifyToken(secret, { grant_type: "refresh_token", refresh_token: token.refreshToken }, fetcher, Date.now(), profile),
    async (token, version) => { const client = new ShopifyThemesClient(token, fetcher); await client.drafts(); return fn(client, version); },
  );
  return { config, workspace, store, edits, withAccess, policyHash, profile, secret, origin: origin.origin };
}
async function operator(session: AuthSession, sessionId: string) {
  if (session.provider !== "local" || Date.parse(session.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(session.expiresAt))) shopifyFail("SESSION_INVALID");
  const ctx = await context(session.tenant.id, session.user.id);
  if (!ctx.workspace.role.canManageWorkspace) shopifyFail("ADMIN_REQUIRED");
  const resolved = await new FileLocalSessionStore({ rootDirectory: path.join(ctx.config.paths.dataRoot, "sessions") }).read(sessionId, "modtime");
  if (resolved?.record.userId !== session.user.id) shopifyFail("SESSION_INVALID");
  return ctx;
}
export async function startThemeOAuth(session: AuthSession, sessionId: string, requestUrl: string) {
  const ctx = await operator(session, sessionId), url = new URL(requestUrl);
  if (url.href !== ctx.origin + THEMES_START) shopifyFail("CALLBACK_INVALID");
  const redirectUri = ctx.origin + THEMES_CALLBACK, state = await ctx.store.createState(session.user.id, sessionId, redirectUri);
  return `https://${SHOPIFY_SHOP}/admin/oauth/authorize?` + new URLSearchParams({ client_id: ctx.profile.clientId, scope: THEME_SCOPES.join(","), redirect_uri: redirectUri, state });
}
export async function completeThemeOAuth(session: AuthSession, sessionId: string, requestUrl: string, fetcher: typeof fetch = fetch) {
  const ctx = await operator(session, sessionId), url = new URL(requestUrl), redirectUri = ctx.origin + THEMES_CALLBACK;
  if (url.origin + url.pathname !== redirectUri || url.hash || url.username || url.password || url.searchParams.has("error") || requestUrl.length > 16384 || !await validShopifyHmac(url.searchParams, ctx.secret, url.host, ctx.profile)) shopifyFail("CALLBACK_INVALID");
  await ctx.store.consumeState(session.user.id, sessionId, url.searchParams.get("state") ?? "", redirectUri);
  const version = await ctx.store.install(session.user.id, async () => {
    const token = await exchangeShopifyToken(ctx.secret, { code: url.searchParams.get("code")!, expiring: "1" }, fetcher, Date.now(), ctx.profile);
    await new ShopifyThemesClient(token.accessToken, fetcher).drafts(); return token;
  });
  return { connected: true, version, writeVerified: false };
}
export async function themeCapability(installationId: string, userId: string, fetcher: typeof fetch = fetch) {
  const ctx = await context(installationId, userId);
  const base = { connectorId: SHOPIFY_THEMES_ID, label: "Shopify Website · MODTIME", accountEmail: null, disconnectUrl: null, connectUrl: ctx.workspace.role.canManageWorkspace ? THEMES_START : null, approvalRequiredOperations: [] };
  try {
    const version = await ctx.withAccess(async (client, version) => { await client.read("162490319097", "layout/theme.liquid"); return version; }, fetcher);
    return { ...base, status: "connected" as const, statusCode: null, connectionVersion: version, checkedAt: new Date().toISOString(), effectiveOperations: ["theme-read", "theme-files", "title-plan", "theme-plan", ...(ctx.workspace.policy.capabilities.execute ? ["title-apply", "title-rollback", "theme-apply", "theme-rollback"] : [])] };
  } catch {
    return { ...base, status: "reauth_required" as const, statusCode: "MODTIME_SHOPIFY_THEME_CONSENT_REQUIRED", connectionVersion: null, checkedAt: new Date().toISOString(), effectiveOperations: [] };
  }
}
export async function readThemes(installationId: string, userId: string, input: unknown, fetcher: typeof fetch = fetch) {
  const p = input as Record<string, unknown>;
  if (!p || typeof p !== "object" || Array.isArray(p) || !["", "themeId", "filename,themeId"].includes(Object.keys(p).sort().join())) shopifyFail("THEME_READ_INVALID");
  if (Object.hasOwn(p, "themeId")) draftId(p.themeId);
  if (Object.hasOwn(p, "filename")) themeFilename(p.filename);
  const ctx = await context(installationId, userId);
  return ctx.withAccess(async client => {
    if (!Object.hasOwn(p, "filename")) {
      const themes = await client.drafts();
      return { themes: p.themeId ? themes.filter(t => t.id === p.themeId) : themes, note: "Select A or B explicitly. List existing files with shopify_theme_files, then read one with both themeId and filename. Clarify the intended change; never publish or change global store/catalogue data." };
    }
    const content = await client.read(p.themeId as string, p.filename as string);
    return { themeId: p.themeId, filename: p.filename, content, hash: themeHash(content), untrustedSource: true };
  }, fetcher);
}
export async function listThemeFiles(installationId: string, userId: string, input: unknown, fetcher: typeof fetch = fetch) {
  const p = input as { themeId?: unknown };
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).join() !== "themeId") shopifyFail("THEME_READ_INVALID");
  const id = draftId(p.themeId), ctx = await context(installationId, userId);
  return ctx.withAccess(async client => ({ themeId: id, filenames: await client.files(id), untrustedSource: true }), fetcher);
}
export async function planThemeFile(installationId: string, userId: string, threadId: string, input: unknown, fetcher: typeof fetch = fetch) {
  themeFileEdit(input); const ctx = await context(installationId, userId, true);
  return ctx.withAccess((client, version) => ctx.edits.prepare(client, userId, threadId, version, ctx.policyHash, input), fetcher);
}
export async function planThemeTitle(installationId: string, userId: string, threadId: string, input: unknown, fetcher: typeof fetch = fetch) {
  titleEdit(input); const ctx = await context(installationId, userId, true);
  return ctx.withAccess((client, version) => ctx.edits.prepare(client, userId, threadId, version, ctx.policyHash, input), fetcher);
}
export async function prepareTitleApproval(locator: ApprovalLocator, planId: string, rollback: boolean) {
  const ctx = await context(locator.installationId, locator.userId, true), plan = await ctx.edits.inspect(planId, locator.userId, locator.threadId);
  const fingerprint = themeHash(JSON.stringify({ plan, rollback, policy: ctx.policyHash }));
  const approvals = new FileApprovalStore({ installationId: "modtime", userId: locator.userId, usersRoot: ctx.config.paths.usersRoot });
  const prepared = await approvals.prepareConnectorApproval({ locator, authorizationFingerprint: fingerprint });
  if (!prepared.receipt) shopifyFail("THEME_APPROVAL_UNAVAILABLE");
  const file = plan.kind === "theme_file";
  const description = rollback ? "Restore the saved original" : file ? plan.summary : `${plan.kind}: ${JSON.stringify(plan.expected)} → ${JSON.stringify(plan.title)}`;
  const item: ApprovalItem = { id: locator.approvalId, threadId: locator.threadId, turnId: locator.turnId, itemId: locator.itemId, connectorAuthorizationFingerprint: fingerprint, kind: file ? "file" : "command", title: rollback ? file ? "Restore Shopify website change" : "Restore Shopify title" : file ? "Change Shopify draft website" : "Change Shopify title", detail: `${description} · draft ${plan.themeId} · ${plan.filename} · ${rollback ? plan.afterHash : plan.beforeHash} · never publish`, ...(file ? { fileReview: { filename: plan.filename, changes: plan.changes.map(c => ({ before: rollback ? c.replacement : c.expected, after: rollback ? c.expected : c.replacement })) } } : {}), status: "pending" };
  await ctx.edits.bindApprovalAction(locator, planId, rollback, fingerprint);
  return { item, fingerprint };
}
export async function executeThemeTitle(locator: ApprovalLocator, planId: string, rollback: boolean, fingerprint: string, fetcher: typeof fetch = fetch) {
  const ctx = await context(locator.installationId, locator.userId, true);
  const approvals = new FileApprovalStore({ installationId: "modtime", userId: locator.userId, usersRoot: ctx.config.paths.usersRoot });
  const visible = await approvals.readConnectorApproval(locator);
  if (!visible || !["approved", "executed"].includes(visible.status) || visible.authorizationFingerprint !== fingerprint) shopifyFail("THEME_APPROVAL_REQUIRED");
  const plan = await ctx.edits.inspect(planId, locator.userId, locator.threadId);
  if (fingerprint !== themeHash(JSON.stringify({ plan, rollback, policy: ctx.policyHash }))) shopifyFail("THEME_APPROVAL_STALE");
  const result = await approvals.executeConnectorApprovalByLocator(locator, fingerprint, {
    revalidate: async () => (await context(locator.installationId, locator.userId, true)).policyHash === ctx.policyHash,
    execute: () => ctx.withAccess((client, version) => ctx.edits.execute(client, locator.userId, locator.threadId, version, ctx.policyHash, planId, rollback), fetcher),
  });
  if (result.outcome === "executed") return result.value;
  if (result.outcome === "replayed") return ctx.edits.inspect(planId, locator.userId, locator.threadId);
  shopifyFail("THEME_WRITE_INDETERMINATE");
}
/** Resolve only the server-bound plan after the authenticated fingerprint decision. */
export async function executePreparedThemeApproval(locator: ApprovalLocator, fingerprint: string, fetcher: typeof fetch = fetch) {
  if (locator.installationId !== "modtime" || !locator.approvalId.startsWith("shopify-edit:")) return null;
  const ctx = await context(locator.installationId, locator.userId, true);
  const action = await ctx.edits.approvalAction(locator);
  if (!action) return null; // Older interactive requests retain their original waiter.
  if (action.fingerprint !== fingerprint) shopifyFail("THEME_APPROVAL_STALE");
  const receipts = new FileApprovalStore({ installationId: "modtime", userId: locator.userId, usersRoot: ctx.config.paths.usersRoot });
  const receipt = await receipts.readConnectorApproval(locator);
  if (receipt?.status === "executed" && receipt.authorizationFingerprint === fingerprint) return ctx.edits.inspect(action.planId, locator.userId, locator.threadId);
  return executeThemeTitle(locator, action.planId, action.rollback, fingerprint, fetcher);
}
export const THEME_UNCONFIGURED_CAPABILITY: ConnectorCapabilitySnapshot = { connectorId: SHOPIFY_THEMES_ID, label: "Shopify Website · MODTIME", status: "not_configured", statusCode: "MODTIME_SHOPIFY_THEME_NOT_CONFIGURED", checkedAt: null, effectiveOperations: [], approvalRequiredOperations: [] };

/** Direct chat requests authorize bounded draft edits. Only the authenticated
 * interactive runner can issue this authority. Legacy cards stay independent. */
export async function executeChatThemeEdit(authorization: InteractiveChatAuthorization, callId: string, planId: string, rollback: boolean, fetcher: typeof fetch = fetch) {
  const { installationId, userId, threadId, turnId } = authorization;
  const identity = { installationId, userId, threadId, turnId };
  assertInteractiveChatAuthorization(authorization, identity);
  if (!callId || callId.length > 512) shopifyFail("THEME_CHAT_INVALID");
  const ctx = await context(installationId, userId, true);
  const revalidate = async () => {
    assertInteractiveChatAuthorization(authorization, identity);
    if ((await context(installationId, userId, true)).policyHash !== ctx.policyHash) shopifyFail("PLAN_STALE");
  };
  return ctx.edits.executeChatAction({ ...identity, itemId: callId, userMessageId: authorization.userMessageId, requestHash: authorization.requestHash, permissionFingerprint: authorization.permissionFingerprint }, planId, rollback, ctx.policyHash,
    () => ctx.withAccess((client, version) => ctx.edits.execute(client, userId, threadId, version, ctx.policyHash, planId, rollback, revalidate), fetcher));
}
