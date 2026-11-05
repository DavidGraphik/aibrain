import { afterEach, beforeEach, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), cookies: vi.fn(), origin: vi.fn(), start: vi.fn(), complete: vi.fn() }));
vi.mock("@/auth/session", () => ({ getSession: mocks.session }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: mocks.origin }));
vi.mock("server-only", () => ({}));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => ({ installationId: "modtime", publicUrl: "https://brain.example" }) }));
vi.mock("@/connectors/shopify-server-service", () => ({ startShopifyOAuth: mocks.start, completeShopifyOAuth: mocks.complete, shopifyErrorCode: () => "MODTIME_SHOPIFY_FAILED" }));
vi.mock("@/connectors/shopify-themes-service", () => ({ completeThemeOAuth: mocks.complete, THEMES_CALLBACK: "/api/connectors/shopify/themes/oauth/callback" }));
import { GET as start } from "./start/route";
import { GET as callback } from "./callback/route";
import { GET as themeCallback } from "../themes/oauth/callback/route";
const session = { provider: "local", user: { id: "operator" }, tenant: { id: "modtime" } };
beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue(session); mocks.cookies.mockResolvedValue({ get: () => ({ value: "server-session" }) }); mocks.origin.mockResolvedValue(true); });
afterEach(() => vi.unstubAllEnvs());
it("routes reject anonymous and cross-origin initiation before OAuth", async () => {
  mocks.session.mockResolvedValue(null);
  expect((await start(new Request("https://brain.example/api/connectors/shopify/oauth/start"))).status).toBe(401);
  for (const [handler, callbackPath] of [[callback, "oauth/callback"], [themeCallback, "themes/oauth/callback"]] as const) {
    const response = await handler(new Request(`https://brain.example/api/connectors/shopify/${callbackPath}?code=sensitive-code&state=sensitive-state`));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login?settings=connectors");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toBe("");
  }
  expect(mocks.complete).not.toHaveBeenCalled();
  mocks.session.mockResolvedValue(session); mocks.origin.mockResolvedValue(false);
  expect((await start(new Request("https://brain.example/api/connectors/shopify/oauth/start"))).status).toBe(403); expect(mocks.start).not.toHaveBeenCalled();
});
it("normalizes the deployed standalone listener for both authenticated routes without weakening origin rejection", async () => {
  vi.stubEnv("HOSTNAME", "0.0.0.0"); vi.stubEnv("PORT", "3000");
  const headers = { host: "brain.example", "x-forwarded-host": "brain.example", "x-forwarded-proto": "https" };
  mocks.start.mockResolvedValue("https://c7f82c-f0.myshopify.com/admin/oauth/authorize?state=synthetic");
  expect((await start(new Request("https://0.0.0.0:3000/api/connectors/shopify/oauth/start", { headers }))).status).toBe(302);
  expect(mocks.start).toHaveBeenCalledWith(session, "server-session", "https://brain.example/api/connectors/shopify/oauth/start");
  expect((await callback(new Request("https://0.0.0.0:3000/api/connectors/shopify/oauth/callback?code=synthetic%2Bcode", { headers }))).status).toBe(303);
  expect(mocks.complete).toHaveBeenCalledWith(session, "server-session", "https://brain.example/api/connectors/shopify/oauth/callback?code=synthetic%2Bcode");
  mocks.start.mockClear(); mocks.origin.mockResolvedValue(false);
  expect((await start(new Request("https://0.0.0.0:3000/api/connectors/shopify/oauth/start", { headers }))).status).toBe(403);
  expect(mocks.start).not.toHaveBeenCalled();
});
it("passes only authenticated session cookie to service and never exposes callback secrets", async () => {
  mocks.start.mockResolvedValue("https://c7f82c-f0.myshopify.com/admin/oauth/authorize?state=synthetic");
  const url = "https://brain.example/api/connectors/shopify/oauth/start";
  const r = await start(new Request(url, { headers: { host: "brain.example" } })); expect(r.status).toBe(302); expect(mocks.start).toHaveBeenCalledWith(session, "server-session", url);
  mocks.complete.mockResolvedValue({ secret: "must-not-render" });
  const done = await callback(new Request("https://brain.example/api/connectors/shopify/oauth/callback?code=sensitive", { headers: { host: "brain.example" } }));
  expect(done.status).toBe(303); expect(done.headers.get("location")).toBe("/?settings=connectors&shopify=connected");
  expect(done.headers.get("cache-control")).toContain("no-store"); expect(done.headers.get("referrer-policy")).toBe("no-referrer"); expect(await done.text()).toBe("");
  mocks.complete.mockRejectedValue(Error("secret-token")); const denied = await callback(new Request("https://brain.example/api/connectors/shopify/oauth/callback")); expect(await denied.text()).not.toContain("secret-token");
});

it("returns failed callbacks to Connectors with only a sanitized code", async () => {
  mocks.complete.mockRejectedValue(Error("MODTIME_SHOPIFY_TOKEN_EXCHANGE_FAILED"));
  const response = await callback(new Request("https://brain.example/api/connectors/shopify/oauth/callback?code=secret-code&state=secret-state"));
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/?settings=connectors&shopify=failed&reason=MODTIME_SHOPIFY_FAILED");
  expect(await response.text()).toBe("");
});
