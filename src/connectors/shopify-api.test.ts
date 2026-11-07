import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
vi.mock("server-only", () => ({}));
import { validShopifyHmac, exchangeShopifyToken, shopifyPeriod, ShopifyOrdersClient } from "./shopify-api";
import { SHOPIFY_SHOP } from "./shopify-contracts";
const secret = "synthetic-client-secret";
const grant = { access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token", expires_in: 3600, refresh_token_expires_in: 7_776_000, scope: "read_orders,read_draft_orders" };
const response = (data: unknown) => new Response(JSON.stringify(data));
function signed(patch = {}) {
  const p = new URLSearchParams({ shop: SHOPIFY_SHOP, state: "a".repeat(64), code: "synthetic +/& code", timestamp: String(Math.floor(Date.now() / 1000)), ...patch });
  p.set("hmac", createHmac("sha256", secret).update(new URLSearchParams([...p].sort(([a], [b]) => a.localeCompare(b))).toString().replace(/\+/g, "%20")).digest("hex")); return p;
}
const identity = { shop: { myshopifyDomain: SHOPIFY_SHOP, currencyCode: "USD" }, currentAppInstallation: { accessScopes: [{ handle: "read_orders" }, { handle: "read_draft_orders" }] } };
const orderMoney = () => ({ cancelledAt: null, displayFinancialStatus: "PAID", ...Object.fromEntries(["totalPriceSet", "currentTotalPriceSet", "totalReceivedSet", "netPaymentSet"].map(field => [field, { shopMoney: { amount: "10.00", currencyCode: "USD" } }])), totalRefundedSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } } });
describe("Shopify provider boundary", () => {
  it("uses official SDK for encoded HMAC and rejects tamper, duplicates, wrong shop and stale signatures", async () => {
    await expect(validShopifyHmac(signed(), secret, "brain.example")).resolves.toBe(true);
    for (const p of [signed({ shop: "foreign.myshopify.com" }), signed({ timestamp: "1" }), signed({ timestamp: String(Math.floor(Date.now() / 1000) + 1000) }), signed()]) {
      if (p.get("timestamp") !== "1" && p.get("shop") === SHOPIFY_SHOP && Number(p.get("timestamp")) <= Date.now() / 1000) p.append("code", "duplicate");
      await expect(validShopifyHmac(p, secret, "brain.example")).resolves.toBe(false);
    }
    const p = signed(); p.set("code", "tampered"); await expect(validShopifyHmac(p, secret, "brain.example")).resolves.toBe(false);
  });
  it("exchanges offline code only at exact store, rejects malformed/online/broader grants", async () => {
    const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) => response(grant));
    await exchangeShopifyToken(secret, { code: "synthetic", expiring: "1" }, fetcher);
    expect(fetcher.mock.calls[0][0]).toBe(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`);
    for (const patch of [{ scope: "read_orders" }, { scope: "read_orders,read_draft_orders,write_content" }, { associated_user: {} }, { expires_in: 0 }, { refresh_token: null }])
      await expect(exchangeShopifyToken(secret, { code: "x" }, async () => response({ ...grant, ...patch }))).rejects.toThrow("MODTIME_SHOPIFY_TOKEN_INVALID");
    await expect(exchangeShopifyToken(secret, {}, async () => { throw Error(secret); })).rejects.not.toThrow(secret);
  });
  it("bounds date input to current 60-day window, never future or arbitrary fields", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    expect(shopifyPeriod({ since: "2026-08-02", until: "2026-09-30" }, now).since).toBe("2026-08-02");
    for (const p of [{ since: "2026-08-01", until: "2026-09-30" }, { since: "2026-09-30", until: "2026-10-01" }, { since: "2026-09-31", until: "2026-09-31" }, { since: "2026-09-30", until: "2026-09-30", query: "mutation" }]) expect(() => shopifyPeriod(p, now)).toThrow();
  });
  it("checks scopes before data, aggregates only, excludes tests and does not double count drafts", async () => {
    const today = new Date().toISOString().slice(0, 10), createdAt = today + "T00:00:00Z";
    const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
      const { query } = JSON.parse(String(options?.body));
      if (query.includes("currentAppInstallation")) return response({ data: identity });
      if (query.includes("draftOrders")) return response({ data: { draftOrders: { nodes: [{ id: "draft-1", createdAt, status: "COMPLETED" }, { id: "draft-2", createdAt, status: "OPEN" }], pageInfo: { hasNextPage: false } } } });
      return response({ data: { orders: { nodes: [{ id: "order-1", createdAt, fullyPaid: true, test: false, ...orderMoney() }, { id: "order-2", createdAt, fullyPaid: true, test: true }], pageInfo: { hasNextPage: false } } } });
    });
    const summary = await new ShopifyOrdersClient("synthetic", fetcher).summary({ since: today, until: today });
    expect(summary).toMatchObject({ paidOrders: 1, orders: 1, testOrdersExcluded: 1, completedDraftOrders: 1, openDraftOrders: 1, newCustomers: null, purchaseCAC: null, historyDaysMaximum: 60 });
    expect(JSON.stringify(summary)).not.toContain("order-1");
    expect(fetcher.mock.calls.every(([, o]) => !String(o?.body).includes("mutation"))).toBe(true);
    const denied = vi.fn(async () => response({ data: { ...identity, currentAppInstallation: { accessScopes: [{ handle: "write_orders" }] } } }));
    await expect(new ShopifyOrdersClient("x", denied).summary({ since: today, until: today })).rejects.toThrow("IDENTITY_OR_SCOPES"); expect(denied).toHaveBeenCalledTimes(1);
  });
  it("rejects partial/paginated duplicate data rather than returning misleading counts", async () => {
    const today = new Date().toISOString().slice(0, 10); let n = 0;
    const fetcher = vi.fn(async () => response({ data: ++n === 1 ? identity : { orders: { nodes: [{ id: "same", createdAt: today + "T00:00:00Z", test: false, fullyPaid: true, ...orderMoney() }], pageInfo: { hasNextPage: true, endCursor: "cursor" } } } }));
    await expect(new ShopifyOrdersClient("x", fetcher).summary({ since: today, until: today })).rejects.toThrow("INCOMPLETE_RESPONSE");
  });
});
