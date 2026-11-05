import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: mocks.config }));
import { shopifyPublicRequestUrl } from "./shopify-request-url";
import { SHOPIFY_CALLBACK, SHOPIFY_START } from "./shopify-contracts";
const origin = "https://modtime.example";
const headers = { host: "modtime.example", "x-forwarded-host": "modtime.example", "x-forwarded-proto": "https" };
beforeEach(() => {
  mocks.config.mockResolvedValue({ installationId: "modtime", publicUrl: origin });
  vi.stubEnv("HOSTNAME", "0.0.0.0"); vi.stubEnv("PORT", "3000");
});
afterEach(() => vi.unstubAllEnvs());
it("normalizes only the configured Next standalone listener behind pinned HTTPS ingress", async () => {
  expect(await shopifyPublicRequestUrl(new Request("https://0.0.0.0:3000" + SHOPIFY_START, { headers }), SHOPIFY_START)).toBe(origin + SHOPIFY_START);
  expect(await shopifyPublicRequestUrl(new Request(origin + SHOPIFY_START, { headers }), SHOPIFY_START)).toBe(origin + SHOPIFY_START);
  const query = "?code=synthetic%2Bcode&state=synthetic&hmac=synthetic&timestamp=123";
  expect(await shopifyPublicRequestUrl(new Request("https://0.0.0.0:3000" + SHOPIFY_CALLBACK + query, { headers }), SHOPIFY_CALLBACK)).toBe(origin + SHOPIFY_CALLBACK + query);
});
it.each([
  ["https://foreign.example", headers],
  ["https://0.0.0.0:3001", headers],
  ["http://0.0.0.0:3000", headers],
  ["https://0.0.0.0:3000", { ...headers, host: "foreign.example" }],
  ["https://0.0.0.0:3000", { ...headers, "x-forwarded-host": "foreign.example" }],
  ["https://0.0.0.0:3000", { ...headers, "x-forwarded-host": "modtime.example, foreign.example" }],
  ["https://0.0.0.0:3000", { ...headers, "x-forwarded-proto": "http" }],
  ["https://0.0.0.0:3000", { ...headers, "x-forwarded-proto": "https,http" }],
  ["https://0.0.0.0:3000", { host: "modtime.example" }],
])("rejects foreign origins and ambiguous or insecure proxy headers: %s", async (base, requestHeaders) => {
  await expect(shopifyPublicRequestUrl(new Request(base + SHOPIFY_START, { headers: requestHeaders }), SHOPIFY_START)).rejects.toThrow("CALLBACK_INVALID");
  await expect(shopifyPublicRequestUrl(new Request(base + SHOPIFY_CALLBACK, { headers: requestHeaders }), SHOPIFY_CALLBACK)).rejects.toThrow("CALLBACK_INVALID");
});
it("rejects wrong paths, start queries, fragments and another installation", async () => {
  for (const suffix of ["/wrong", SHOPIFY_START + "?next=foreign", SHOPIFY_START + "#fragment"]) {
    await expect(shopifyPublicRequestUrl(new Request(origin + suffix, { headers }), SHOPIFY_START)).rejects.toThrow("CALLBACK_INVALID");
  }
  await expect(shopifyPublicRequestUrl(new Request(origin + SHOPIFY_START, { headers }), SHOPIFY_CALLBACK)).rejects.toThrow("CALLBACK_INVALID");
  mocks.config.mockResolvedValue({ installationId: "other", publicUrl: origin });
  await expect(shopifyPublicRequestUrl(new Request(origin + SHOPIFY_START, { headers }), SHOPIFY_START)).rejects.toThrow("CALLBACK_CONFIGURATION_INVALID");
});

it.each(["/api/connectors/shopify/admin/oauth/start", "/api/connectors/shopify/admin/oauth/callback"] as const)("normalizes general admin OAuth path %s", async path => {
  expect(await shopifyPublicRequestUrl(new Request("https://0.0.0.0:3000" + path, { headers }), path)).toBe(origin + path);
  await expect(shopifyPublicRequestUrl(new Request("https://foreign.example" + path, { headers }), path)).rejects.toThrow("CALLBACK_INVALID");
});
