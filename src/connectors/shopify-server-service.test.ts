import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createHmac } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import type { AuthSession } from "@/auth/types";
const mocks = vi.hoisted(() => ({ config: vi.fn(), workspace: vi.fn(), catalog: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: mocks.config }));
vi.mock("@/admin/policy-service", () => ({ workspacePolicyForIdentity: mocks.workspace }));
vi.mock("@/catalog/access-service", () => ({ catalogRuntimeEnforcer: mocks.catalog }));
import { FileLocalSessionStore } from "@/auth/local-session-store";
import { startShopifyOAuth, completeShopifyOAuth, shopifyCapability, readShopifyOrders } from "./shopify-server-service";
import { SHOPIFY_CLIENT_ID, SHOPIFY_SHOP } from "./shopify-contracts";
const user = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222", secret = "synthetic-client-secret", origin = "https://brain.example";
const session: AuthSession = { provider: "local", tenant: { id: "modtime", name: "MODTIME" }, user: { id: user, name: "Test", email: "test@example.test" }, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
const roots: string[] = [];
let config: InstallationConfig, sessionId: string;
beforeEach(async () => {
  vi.clearAllMocks();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "shopify-service-test-"))); roots.push(root);
  config = { installationId: "modtime", publicUrl: origin, paths: { dataRoot: root } } as InstallationConfig;
  sessionId = (await new FileLocalSessionStore({ rootDirectory: path.join(root, "sessions") }).create("modtime", user)).sessionId;
  mocks.config.mockResolvedValue(config); mocks.workspace.mockResolvedValue({ role: { canManageWorkspace: true } }); mocks.catalog.mockResolvedValue({ allowsConnector: () => true });
  vi.stubEnv("MODTIME_REPORTING_USER_IDS", `${user},${other}`); vi.stubEnv("MODTIME_SHOPIFY_OAUTH_ENABLED", "1"); vi.stubEnv("MODTIME_SHOPIFY_CLIENT_ID", SHOPIFY_CLIENT_ID);
  vi.stubEnv("MODTIME_SHOPIFY_CLIENT_SECRET", secret); vi.stubEnv("MODTIME_SHOPIFY_OAUTH_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
});
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function signed(state: string, patch = {}) {
  const p = new URLSearchParams({ shop: SHOPIFY_SHOP, state, code: "synthetic-code", timestamp: String(Math.floor(Date.now() / 1000)), ...patch });
  p.set("hmac", createHmac("sha256", secret).update(new URLSearchParams([...p].sort(([a], [b]) => a.localeCompare(b))).toString().replace(/\+/g, "%20")).digest("hex"));
  return origin + "/api/connectors/shopify/oauth/callback?" + p;
}
const provider = () => vi.fn(async (url: unknown) => new Response(JSON.stringify(String(url).includes("access_token") ? {
  access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, refresh_token_expires_in: 7_776_000, scope: "read_orders,read_draft_orders",
} : { data: { shop: { myshopifyDomain: SHOPIFY_SHOP, currencyCode: "USD" }, currentAppInstallation: { accessScopes: [{ handle: "read_orders" }, { handle: "read_draft_orders" }] }, orders: { nodes: [] }, draftOrders: { nodes: [] } } })));
const begin = async () => new URL(await startShopifyOAuth(session, sessionId, origin + "/api/connectors/shopify/oauth/start")).searchParams.get("state")!;
it("requires a current real actor-bound session, installation, role and catalog before starting", async () => {
  await expect(startShopifyOAuth({ ...session, provider: "demo" }, sessionId, origin)).rejects.toThrow("SESSION_INVALID");
  await expect(startShopifyOAuth({ ...session, expiresAt: "2000-01-01T00:00:00Z" }, sessionId, origin)).rejects.toThrow("SESSION_INVALID");
  await expect(startShopifyOAuth({ ...session, user: { ...session.user, id: other } }, sessionId, origin)).rejects.toThrow("SESSION_INVALID");
  await expect(startShopifyOAuth(session, "x".repeat(64), origin)).rejects.toThrow("SESSION_INVALID");
  mocks.workspace.mockResolvedValue({ role: { canManageWorkspace: false } }); await expect(begin()).rejects.toThrow("ADMIN_REQUIRED");
  mocks.workspace.mockResolvedValue({ role: { canManageWorkspace: true } }); mocks.catalog.mockResolvedValue({ allowsConnector: () => false }); await expect(begin()).rejects.toThrow("CATALOG_DENIED");
  mocks.config.mockResolvedValue({ ...config, installationId: "foreign" }); await expect(begin()).rejects.toThrow("ACTOR_DENIED");
});
it("uses exact HTTPS callback allowlist and verifies before a single token exchange", async () => {
  await expect(startShopifyOAuth(session, sessionId, "http://brain.example/api/connectors/shopify/oauth/start")).rejects.toThrow();
  const state = await begin(), fetcher = provider();
  await expect(completeShopifyOAuth(session, sessionId, signed(state).replace(origin, "https://foreign.example"), fetcher)).rejects.toThrow();
  await expect(completeShopifyOAuth(session, sessionId, signed(state, { shop: "foreign.myshopify.com" }), fetcher)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  expect(await completeShopifyOAuth(session, sessionId, signed(state), fetcher)).toMatchObject({ connected: true, version: 1 });
  await expect(completeShopifyOAuth(session, sessionId, signed(state), fetcher)).rejects.toThrow("STATE_INVALID"); expect(fetcher).toHaveBeenCalledTimes(3);
  const capability = await shopifyCapability("modtime", user, fetcher); expect(capability).toMatchObject({ status: "connected", connectionVersion: 1, effectiveOperations: ["orders-read"] });
  expect(JSON.stringify(capability)).not.toContain("synthetic");
});
it("rejects callback in a different valid session of same actor and revoked catalog without requests", async () => {
  const state = await begin(), fetcher = provider();
  const another = (await new FileLocalSessionStore({ rootDirectory: path.join(config.paths.dataRoot, "sessions") }).create("modtime", user)).sessionId;
  await expect(completeShopifyOAuth(session, another, signed(state), fetcher)).rejects.toThrow("STATE_INVALID");
  mocks.catalog.mockResolvedValue({ allowsConnector: () => false });
  await expect(completeShopifyOAuth(session, sessionId, signed(state), fetcher)).rejects.toThrow("CATALOG_DENIED"); expect(fetcher).not.toHaveBeenCalled();
});
it("settings distinguishes missing config, consent and failed provider readback", async () => {
  const fetcher = provider(); expect(await shopifyCapability("modtime", user, fetcher)).toMatchObject({ status: "reauth_required" }); expect(fetcher).not.toHaveBeenCalled();
  vi.stubEnv("MODTIME_SHOPIFY_OAUTH_ENABLED", "0"); expect(await shopifyCapability("modtime", user, fetcher)).toMatchObject({ status: "not_configured", connectUrl: null });
  vi.stubEnv("MODTIME_SHOPIFY_OAUTH_ENABLED", "1"); const state = await begin(); await completeShopifyOAuth(session, sessionId, signed(state), fetcher);
  const failed = await shopifyCapability("modtime", user, async () => { throw Error(secret); }); expect(failed.status).toBe("degraded"); expect(JSON.stringify(failed)).not.toContain(secret);
  const revoked = await shopifyCapability("modtime", user, async () => new Response("not logged", { status: 401 })); expect(revoked).toMatchObject({ status: "reauth_required", statusCode: "MODTIME_SHOPIFY_REAUTH_REQUIRED" });
});
it("shares one verified installation credential with both authorized actors without granting another actor access", async () => {
  const fetcher = provider(), state = await begin();
  await completeShopifyOAuth(session, sessionId, signed(state), fetcher);
  mocks.workspace.mockResolvedValue({ role: { canManageWorkspace: false } });
  expect(await shopifyCapability("modtime", other, fetcher)).toMatchObject({ status: "connected", connectionVersion: 1, connectUrl: null });
  const beforeDenied = fetcher.mock.calls.length;
  await expect(shopifyCapability("modtime", "33333333-3333-4333-8333-333333333333", fetcher)).rejects.toThrow("ACTOR_DENIED");
  expect(fetcher).toHaveBeenCalledTimes(beforeDenied);
  mocks.catalog.mockResolvedValue({ allowsConnector: () => false });
  await expect(shopifyCapability("modtime", other, fetcher)).rejects.toThrow("CATALOG_DENIED");
  expect(fetcher).toHaveBeenCalledTimes(beforeDenied);
});
it("read rechecks actor/catalog and date limits before provider requests", async () => {
  const fetcher = provider();
  await expect(readShopifyOrders("foreign", user, {}, fetcher)).rejects.toThrow("ACTOR_DENIED");
  await expect(readShopifyOrders("modtime", user, { since: "2000-01-01", until: "2000-01-02" }, fetcher)).rejects.toThrow("PERIOD_INVALID");
  mocks.catalog.mockResolvedValue({ allowsConnector: () => false }); await expect(readShopifyOrders("modtime", user, {}, fetcher)).rejects.toThrow("CATALOG_DENIED"); expect(fetcher).not.toHaveBeenCalled();
});
