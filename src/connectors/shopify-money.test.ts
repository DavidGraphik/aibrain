import { it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ShopifyOrdersClient } from "./shopify-api";
import { SHOPIFY_SHOP } from "./shopify-contracts";
const today = new Date().toISOString().slice(0, 10), createdAt = today + "T00:00:00Z", period = { since: today, until: today };
const money = (amount: string, currencyCode = "USD") => ({ shopMoney: { amount, currencyCode } });
function order(id: string, amounts = ["120.00", "90.00", "120.00", "30.00", "90.00"], patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, createdAt, test: false, fullyPaid: true, cancelledAt: null, displayFinancialStatus: "PARTIALLY_REFUNDED",
    ...Object.fromEntries(["totalPriceSet", "currentTotalPriceSet", "totalReceivedSet", "totalRefundedSet", "netPaymentSet"].map((field, i) => [field, money(amounts[i])])), ...patch };
}
function client(pages: Array<{ nodes: Record<string, unknown>[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } }>, currency = "USD", drafts: Record<string, unknown>[] = []) {
  let page = 0;
  const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
    const { query } = JSON.parse(String(options?.body));
    let data;
    if (query.includes("currentAppInstallation")) data = { shop: { myshopifyDomain: SHOPIFY_SHOP, currencyCode: currency }, currentAppInstallation: { accessScopes: [{ handle: "read_orders" }, { handle: "read_draft_orders" }] } };
    else if (query.includes("draftOrders")) data = { draftOrders: { nodes: drafts, pageInfo: { hasNextPage: false } } };
    else data = { orders: pages[page++] };
    return new Response(JSON.stringify({ data }));
  });
  return { api: new ShopifyOrdersClient("synthetic-token", fetcher), fetcher };
}
const single = (rows: Record<string, unknown>[]) => client([{ nodes: rows, pageInfo: { hasNextPage: false } }]);
it("aggregates monetary creation cohort with refunds, unpaid/partial, cancelled and excluded tests", async () => {
  const rows = [order("paid"), order("unpaid", ["200", "200", "0", "0", "0"], { fullyPaid: false, displayFinancialStatus: "PENDING" }),
    order("cancelled", ["50", "0", "50", "50", "0"], { cancelledAt: createdAt, displayFinancialStatus: "REFUNDED" }),
    order("partial", ["80", "80", "20", "0", "20"], { fullyPaid: false, displayFinancialStatus: "PARTIALLY_PAID" }),
    order("test", ["99999", "99999", "99999", "0", "99999"], { test: true })];
  const { api, fetcher } = single(rows), result = await api.summary(period);
  expect(result).toMatchObject({ orders: 4, paidOrders: 2, notFullyPaidOrders: 2, cancelledOrders: 1, testOrdersExcluded: 1, purchaseCAC: null, reconciledROAS: null, newCustomers: null });
  expect(result.monetary.allNonTestOrders).toEqual({ orderValueBeforeReturns: "450.00", orderValueAfterReturns: "370.00", amountReceived: "190.00", amountRefunded: "80.00", netPayments: "110.00" });
  expect(result.monetary.nonCancelledOrders).toMatchObject({ orderValueBeforeReturns: "400.00", amountReceived: "140.00", amountRefunded: "30.00", netPayments: "110.00" });
  expect(result.monetary.cancelledOrders).toMatchObject({ orderValueBeforeReturns: "50.00", orderValueAfterReturns: "0.00", amountReceived: "50.00", amountRefunded: "50.00", netPayments: "0.00" });
  expect(result.financialStatusCounts).toMatchObject({ PARTIALLY_REFUNDED: 1, PENDING: 1, REFUNDED: 1, PARTIALLY_PAID: 1 });
  expect(result.monetary).toMatchObject({ grossSales: null, netSales: null, profit: null });
  const queries = fetcher.mock.calls.map(([, options]) => String(options?.body)).join(" ");
  expect(queries).not.toMatch(/presentmentMoney|customer\s*\{|email|shippingAddress|transactions|mutation/);
  expect(result.monetary.eventTiming).toContain("not a payment/refund-event ledger");
});
it("uses only Shopify shopMoney despite different customer presentment currencies; rejects mixed shop currencies", async () => {
  const a = order("a"), b = order("b");
  a.totalPriceSet = { ...money("120"), presentmentMoney: { amount: "99999", currencyCode: "EUR" } };
  b.totalPriceSet = { ...money("120"), presentmentMoney: { amount: "88888", currencyCode: "JPY" } };
  expect((await single([a, b]).api.summary(period)).monetary.allNonTestOrders.orderValueBeforeReturns).toBe("240.00");
  await expect(single([a, order("foreign", undefined, { netPaymentSet: money("90", "EUR") })]).api.summary(period)).rejects.toThrow("MONEY_CURRENCY_MISMATCH");
  await expect(client([{ nodes: [a], pageInfo: { hasNextPage: false } }], "EUR").api.summary(period)).rejects.toThrow("MONEY_CURRENCY_MISMATCH");
});
it("preserves exact fractional decimals, large values, negatives and verified empty zero without inventing absent data", async () => {
  const small = ["0.100000000000000001", "0.100000000000000001", "0.100000000000000001", "0", "0.100000000000000001"];
  const other = ["0.2", "0.2", "0.2", "0", "0.2"];
  const result = await single([order("tiny", small), order("other", other), order("negative-net", ["0", "0", "0", "0.01", "-0.01"])]).api.summary(period);
  expect(result.monetary.allNonTestOrders.amountReceived).toBe("0.300000000000000001");
  expect(result.monetary.allNonTestOrders.netPayments).toBe("0.290000000000000001");
  const large = "999999999999999999.99";
  expect((await single([order("large1", [large, large, large, "0", large]), order("large2", [large, large, large, "0", large])]).api.summary(period)).monetary.allNonTestOrders.amountReceived).toBe("1999999999999999999.98");
  const empty = await single([]).api.summary(period); expect(empty.orders).toBe(0); expect(empty.monetary.allNonTestOrders.netPayments).toBe("0.00");
  await expect(single([order("missing", undefined, { totalReceivedSet: null })]).api.summary(period)).rejects.toThrow();
});
it("rejects malformed amounts, inconsistent refund math and invalid payment/cancellation state", async () => {
  for (const amount of ["NaN", "1e2", "Infinity", " 1", "1.0000000000000000001", 12.3])
    await expect(single([order("bad", undefined, { totalPriceSet: { shopMoney: { amount, currencyCode: "USD" } } })]).api.summary(period)).rejects.toThrow("MONEY_INVALID");
  await expect(single([order("bad-net", undefined, { netPaymentSet: money("91") })]).api.summary(period)).rejects.toThrow("MONEY_RECONCILIATION_FAILED");
  for (const patch of [{ cancelledAt: "not-a-date" }, { cancelledAt: undefined }, { displayFinancialStatus: "new-unknown-status" }, { fullyPaid: "true" }])
    await expect(single([order("bad-status", undefined, patch)]).api.summary(period)).rejects.toThrow("INCOMPLETE_RESPONSE");
  expect((await single([order("null-status", undefined, { displayFinancialStatus: null })]).api.summary(period)).financialStatusCounts.UNKNOWN).toBe(1);
});
it("rejects out-of-cohort rows, duplicates across pages, cycles and incomplete page limits", async () => {
  const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString(), tomorrow = new Date(Date.parse(today) + 86_400_000).toISOString();
  for (const date of [yesterday, tomorrow, "bad-date"])
    await expect(single([order("out", undefined, { createdAt: date })]).api.summary(period)).rejects.toThrow("INCOMPLETE_RESPONSE");
  await expect(client([{ nodes: [order("duplicate")], pageInfo: { hasNextPage: true, endCursor: "a" } }, { nodes: [order("duplicate")], pageInfo: { hasNextPage: false } }]).api.summary(period)).rejects.toThrow("INCOMPLETE_RESPONSE");
  await expect(client(["a", "b", "a"].map((cursor, i) => ({ nodes: [order(String(i))], pageInfo: { hasNextPage: true, endCursor: cursor } }))).api.summary(period)).rejects.toThrow("INCOMPLETE_RESPONSE");
  await expect(client(Array.from({ length: 10 }, (_, i) => ({ nodes: [order(String(i))], pageInfo: { hasNextPage: true, endCursor: String(i) } }))).api.summary(period)).rejects.toThrow("PAGINATION_LIMIT");
  await expect(client([{ nodes: [], pageInfo: { hasNextPage: true, endCursor: "a" } }]).api.summary(period)).rejects.toThrow("INCOMPLETE_RESPONSE");
});
it("sums complete pages once and keeps completed drafts out of monetary totals", async () => {
  const { api, fetcher } = client([{ nodes: [order("a")], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } }, { nodes: [order("b")], pageInfo: { hasNextPage: false } }], "USD", [{ id: "draft", createdAt, status: "COMPLETED" }]);
  const result = await api.summary(period); expect(result.orders).toBe(2); expect(result.completedDraftOrders).toBe(1);
  expect(result.monetary.allNonTestOrders.netPayments).toBe("180.00");
  expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body)).variables.after).toBe("cursor-1");
  expect(JSON.stringify(result)).not.toContain('"id":');
});
