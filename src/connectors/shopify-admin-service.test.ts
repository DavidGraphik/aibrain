import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import os from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ config: vi.fn(), workspace: vi.fn(), catalog: vi.fn() }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: mocks.config }));
vi.mock("@/admin/policy-service", () => ({ workspacePolicyForIdentity: mocks.workspace }));
vi.mock("@/catalog/access-service", () => ({ catalogRuntimeEnforcer: mocks.catalog }));
import { FileLocalSessionStore } from "@/auth/local-session-store";
import { startAdminOAuth, completeAdminOAuth, executeShopifyAdmin, assertShopifyAdminExecution, adminCapability, ADMIN_START, ADMIN_CALLBACK } from "./shopify-admin-service";
import { SHOPIFY_ADMIN_SCOPES } from "./shopify-admin-api";
import { ShopifyStore } from "./shopify-store";
import { SHOPIFY_CLIENT_ID } from "./shopify-contracts";
import type { InstallationConfig } from "@/config/installation-schema";
import type { AuthSession } from "@/auth/types";
const actor = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const secret = "test-admin-secret", clientId = "0123456789abcdef0123456789abcdef", origin = "https://brain.example";
const session: AuthSession = { provider: "local", tenant: { id: "modtime", name: "MODTIME" }, user: { id: actor, name: "Test", email: "test@example.test" }, expiresAt: new Date(Date.now() + 86400000).toISOString() };
let root: string, config: InstallationConfig, sessionId: string, price: string, shop: string, returnedScopes: string[];
const provider = vi.fn(async (url: unknown, options?: RequestInit) => {
  if (String(url).endsWith("access_token")) return Response.json({ access_token: "synthetic-admin-access", refresh_token: "synthetic-admin-refresh", scope: returnedScopes.join(","), expires_in: 3600, refresh_token_expires_in: 800000 });
  const { query, variables } = JSON.parse(options?.body as string);
  if (query.includes("currentAppInstallation")) return Response.json({ data: { shop: { myshopifyDomain: shop }, currentAppInstallation: { accessScopes: returnedScopes.map(handle => ({ handle })) } } });
  if (query.includes("productVariantsBulkUpdate")) {
    price = variables.variants[0].price;
    return Response.json({ data: { productVariantsBulkUpdate: { productVariants: [{ id: variables.variants[0].id, price }], userErrors: [] } } });
  }
  return Response.json({ data: { productVariant: { id: "gid://shopify/ProductVariant/123", price } } });
});
beforeEach(async () => {
  vi.clearAllMocks(); root = await realpath(await mkdtemp(path.join(os.tmpdir(), "admin-service-")));
  config = { installationId: "modtime", publicUrl: origin, paths: { dataRoot: root, usersRoot: path.join(root, "users") } } as InstallationConfig;
  mocks.config.mockResolvedValue(config);
  mocks.workspace.mockResolvedValue({ roleId: "admin", role: { canManageWorkspace: true }, policy: { capabilities: { execute: true } } });
  mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => true });
  sessionId = (await new FileLocalSessionStore({ rootDirectory: path.join(root, "sessions") }).create("modtime", actor)).sessionId;
  for (const [key, value] of Object.entries({ MODTIME_SHOPIFY_ADMIN_ENABLED: "1", MODTIME_SHOPIFY_ADMIN_USER_IDS: `${actor},${other}`, MODTIME_SHOPIFY_ADMIN_CLIENT_ID: clientId, MODTIME_SHOPIFY_ADMIN_CLIENT_SECRET: secret, MODTIME_SHOPIFY_ADMIN_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString("base64") })) vi.stubEnv(key, value);
  returnedScopes = [...SHOPIFY_ADMIN_SCOPES]; price = "199.00"; shop = "c7f82c-f0.myshopify.com";
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function connect() {
  const started = new URL(await startAdminOAuth(session, sessionId, origin + ADMIN_START));
  expect(started.searchParams.get("scope")).toBe(SHOPIFY_ADMIN_SCOPES.join(","));
  const p = new URLSearchParams({ shop, state: started.searchParams.get("state")!, code: "synthetic-code", timestamp: String(Math.floor(Date.now() / 1000)) });
  p.set("hmac", createHmac("sha256", secret).update(new URLSearchParams([...p].sort(([a], [b]) => a.localeCompare(b))).toString().replace(/\+/g, "%20")).digest("hex"));
  const callback = origin + ADMIN_CALLBACK + "?" + p;
  await expect(completeAdminOAuth(session, sessionId, callback, provider)).resolves.toMatchObject({ connected: true, writeVerified: false });
  await expect(completeAdminOAuth(session, sessionId, callback, provider)).rejects.toThrow("STATE_INVALID");
}
const read = { query: 'query { productVariant(id: "gid://shopify/ProductVariant/123") { id price } }' };
it("uses separate encrypted credentials and a browser session bound OAuth grant", async () => {
  await expect(startAdminOAuth(session, "invalid", origin + ADMIN_START)).rejects.toThrow("SESSION_INVALID");
  const stranger = await new FileLocalSessionStore({ rootDirectory: path.join(root, "sessions") }).create("modtime", other);
  await expect(startAdminOAuth(session, stranger.sessionId, origin + ADMIN_START)).rejects.toThrow("SESSION_INVALID");
  mocks.workspace.mockResolvedValueOnce({ role: { canManageWorkspace: false }, policy: { capabilities: { execute: true } } });
  await expect(startAdminOAuth(session, sessionId, origin + ADMIN_START)).rejects.toThrow("ADMIN_REQUIRED");
  await connect();
  const encrypted = await readFile(path.join(root, "connectors/shopify-admin/token.json"), "utf8");
  expect(encrypted).not.toContain("synthetic-admin-access"); expect(encrypted).not.toContain("synthetic-admin-refresh");
  await expect(readFile(path.join(root, "connectors/shopify-orders/token.json"))).rejects.toThrow();
  await expect(readFile(path.join(root, "connectors/shopify-themes/token.json"))).rejects.toThrow();
});
it("executes catalog changes through ordinary server session and reads the actual provider result without cards or plans", async () => {
  await connect(); provider.mockClear();
  const updated = await executeShopifyAdmin(session, { query: "mutation Update($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id price } userErrors { field message } } }", variables: { productId: "gid://shopify/Product/456", variants: [{ id: "gid://shopify/ProductVariant/123", price: "249.00" }] } }, provider);
  expect(updated).toMatchObject({ data: { productVariantsBulkUpdate: { productVariants: [{ price: "249.00" }] } }, operationType: "mutation" });
  expect(await executeShopifyAdmin(session, read, provider)).toMatchObject({ data: { productVariant: { price: "249.00" } } });
  expect(await adminCapability("modtime", actor, provider)).toMatchObject({ status: "connected", approvalRequiredOperations: [], effectiveOperations: ["shopify-admin-graphql"] });
  await expect(readFile(path.join(root, "connectors/shopify-admin/plans.json"))).rejects.toThrow();
});
it("denies foreign tenant, actor, expired or nonlocal session and revoked write or execute even for queries", async () => {
  await connect(); provider.mockClear();
  for (const invalid of [
    { ...session, tenant: { id: "foreign", name: "Foreign" } },
    { ...session, user: { ...session.user, id: "33333333-3333-4333-8333-333333333333" } },
    { ...session, expiresAt: new Date(0).toISOString() },
    { ...session, expiresAt: "invalid" },
    { ...session, provider: "demo" as const },
  ]) await expect(executeShopifyAdmin(invalid, read, provider)).rejects.toThrow();
  mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => false });
  await expect(executeShopifyAdmin(session, read, provider)).rejects.toThrow("CATALOG_DENIED");
  mocks.catalog.mockResolvedValue({ allowsConnector: () => false, allowsConnectorWrite: () => true });
  await expect(executeShopifyAdmin(session, read, provider)).rejects.toThrow("CATALOG_DENIED");
  mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => true });
  mocks.workspace.mockResolvedValue({ role: {}, policy: { capabilities: { execute: false } } });
  await expect(executeShopifyAdmin(session, read, provider)).rejects.toThrow("EXECUTE_DENIED");
  expect(provider).not.toHaveBeenCalled();
});
it("rechecks mutable policy before dispatch and verifies the actual Shopify identity on every execution", async () => {
  await connect(); provider.mockClear();
  mocks.catalog.mockResolvedValueOnce({ allowsConnector: () => true, allowsConnectorWrite: () => true }).mockResolvedValueOnce({ allowsConnector: () => true, allowsConnectorWrite: () => false });
  await expect(executeShopifyAdmin(session, read, provider)).rejects.toThrow("CATALOG_DENIED");
  expect(provider).not.toHaveBeenCalled();
  shop = "foreign.myshopify.com";
  await expect(executeShopifyAdmin(session, read, provider)).rejects.toThrow();
  expect(provider.mock.calls).toHaveLength(1);
  expect(JSON.parse(provider.mock.calls[0][1]?.body as string).query).toContain("currentAppInstallation");
});
it("refuses the Orders app and requires consent for full general scopes", async () => {
  vi.stubEnv("MODTIME_SHOPIFY_CLIENT_ID", clientId);
  await expect(startAdminOAuth(session, sessionId, origin + ADMIN_START)).rejects.toThrow("ADMIN_NOT_CONFIGURED");
  vi.stubEnv("MODTIME_SHOPIFY_CLIENT_ID", "fedcba9876543210fedcba9876543210");
  vi.stubEnv("MODTIME_SHOPIFY_ADMIN_CLIENT_ID", SHOPIFY_CLIENT_ID);
  await expect(startAdminOAuth(session, sessionId, origin + ADMIN_START)).rejects.toThrow("ADMIN_NOT_CONFIGURED");
  vi.stubEnv("MODTIME_SHOPIFY_ADMIN_CLIENT_ID", clientId);
  returnedScopes = ["read_products", "read_themes", "read_files"];
  await expect(connect()).rejects.toThrow("TOKEN_INVALID");
  await expect(readFile(path.join(root, "connectors/shopify-admin/token.json"))).rejects.toThrow();
});

function websiteAppFallback() {
  for (const suffix of ["CLIENT_ID", "CLIENT_SECRET", "ENCRYPTION_KEY", "USER_IDS"]) {
    vi.stubEnv(`MODTIME_SHOPIFY_THEME_${suffix}`, process.env[`MODTIME_SHOPIFY_ADMIN_${suffix}`]);
    vi.stubEnv(`MODTIME_SHOPIFY_ADMIN_${suffix}`, undefined);
  }
}
it("reuses Website Editor app settings while keeping prior theme credentials untouched and requiring a new scope grant", async () => {
  websiteAppFallback();
  const themes = new ShopifyStore(config, Buffer.alloc(32, 6), Date.now, { clientId, scopes: ["read_themes", "write_themes"], directory: "shopify-themes" });
  await themes.install(actor, async () => ({ accessToken: "synthetic-prior-theme-access", refreshToken: "synthetic-prior-theme-refresh", expiresAt: Date.now() + 3600000, refreshExpiresAt: Date.now() + 86400000, scopes: ["write_themes"] }));
  const prior = await readFile(path.join(root, "connectors/shopify-themes/token.json"), "utf8");
  expect(await adminCapability("modtime", actor, provider)).toMatchObject({ status: "reauth_required", statusCode: "MODTIME_SHOPIFY_LOGIN_REQUIRED" });
  expect(provider).not.toHaveBeenCalled();
  await expect(executeShopifyAdmin(session, read, provider)).rejects.toThrow("LOGIN_REQUIRED");
  await connect();
  expect(await adminCapability("modtime", actor, provider)).toMatchObject({ status: "connected", approvalRequiredOperations: [] });
  expect(await readFile(path.join(root, "connectors/shopify-themes/token.json"), "utf8")).toBe(prior);
  const encrypted = await readFile(path.join(root, "connectors/shopify-admin/token.json"), "utf8");
  expect(encrypted).not.toContain("synthetic-admin-access");
  expect(encrypted).not.toContain("synthetic-prior-theme-access");
  const exposed = JSON.stringify(await adminCapability("modtime", actor, provider));
  expect(exposed).not.toContain(secret); expect(exposed).not.toContain("synthetic-admin-access");
});
it("explicit admin settings override Website Editor identity and actor allowlist", async () => {
  vi.stubEnv("MODTIME_SHOPIFY_THEME_CLIENT_ID", "fedcba9876543210fedcba9876543210");
  vi.stubEnv("MODTIME_SHOPIFY_THEME_CLIENT_SECRET", "different-website-secret");
  vi.stubEnv("MODTIME_SHOPIFY_THEME_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
  vi.stubEnv("MODTIME_SHOPIFY_THEME_USER_IDS", other);
  const started = new URL(await startAdminOAuth(session, sessionId, origin + ADMIN_START));
  expect(started.searchParams.get("client_id")).toBe(clientId);
  await connect();
  vi.stubEnv("MODTIME_SHOPIFY_ADMIN_USER_IDS", other);
  await expect(executeShopifyAdmin(session, read, provider)).rejects.toThrow("ACTOR_DENIED");
});
it("does not silently mix partial dedicated credentials or activate general access without the explicit flag", async () => {
  websiteAppFallback();
  vi.stubEnv("MODTIME_SHOPIFY_ADMIN_CLIENT_ID", clientId);
  await expect(startAdminOAuth(session, sessionId, origin + ADMIN_START)).rejects.toThrow("ADMIN_NOT_CONFIGURED");
  vi.stubEnv("MODTIME_SHOPIFY_ADMIN_CLIENT_ID", undefined);
  vi.stubEnv("MODTIME_SHOPIFY_ADMIN_ENABLED", undefined);
  await expect(startAdminOAuth(session, sessionId, origin + ADMIN_START)).rejects.toThrow("ACTOR_DENIED");
});

it("enables general Shopify from the existing Website feature with an explicit opt-out", async () => {
  const { shopifyAdminEnabled } = await import("./shopify-admin-service");
  vi.stubEnv("MODTIME_SHOPIFY_ADMIN_ENABLED", "");
  vi.stubEnv("MODTIME_SHOPIFY_THEMES_ENABLED", "1");
  expect(shopifyAdminEnabled()).toBe(true);
  vi.stubEnv("MODTIME_SHOPIFY_ADMIN_ENABLED", "0");
  expect(shopifyAdminEnabled()).toBe(false);
});

it("checks session and current actor/catalog/execute before runtime request-file reads, without provider calls", async () => {
  await expect(assertShopifyAdminExecution(session)).resolves.toBeUndefined();
  await expect(assertShopifyAdminExecution({ ...session, expiresAt: new Date(0).toISOString() })).rejects.toThrow("SESSION_INVALID");
  await expect(assertShopifyAdminExecution({ ...session, tenant: { id: "foreign", name: "Foreign" } })).rejects.toThrow("ACTOR_DENIED");
  mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => false });
  await expect(assertShopifyAdminExecution(session)).rejects.toThrow("CATALOG_DENIED");
  mocks.catalog.mockResolvedValue({ allowsConnector: () => true, allowsConnectorWrite: () => true });
  mocks.workspace.mockResolvedValue({ role: {}, policy: { capabilities: { execute: false } } });
  await expect(assertShopifyAdminExecution(session)).rejects.toThrow("EXECUTE_DENIED");
  expect(provider).not.toHaveBeenCalled();
});
