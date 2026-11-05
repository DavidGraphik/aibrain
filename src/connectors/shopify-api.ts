import "server-only";
import "@shopify/shopify-api/adapters/node";
import { shopifyApi, ApiVersion, LogSeverity } from "@shopify/shopify-api";
import { SHOPIFY_SHOP, exactShopifyScopes, exactShopifyProfileScopes, shopifyFail, type ShopifyToken, SHOPIFY_ORDERS_PROFILE, type ShopifyCredentialProfile } from "./shopify-contracts";
import { ShopifyMoneySummary, SHOPIFY_ORDER_MONEY_SELECTION } from "./shopify-money";

export async function boundedJson(response: Response, limit = 1_000_000): Promise<Record<string, unknown>> {
  if (!response.ok) shopifyFail(response.status === 401 ? "REAUTH_REQUIRED" : "PROVIDER_FAILED");
  const reader = response.body?.getReader(); if (!reader) shopifyFail("PROVIDER_FAILED");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length;
    if (bytes > limit) { await reader.cancel(); shopifyFail("RESPONSE_TOO_LARGE"); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) shopifyFail("RESPONSE_INVALID"); return value;
  } catch { shopifyFail("RESPONSE_INVALID"); }
}
export async function validShopifyHmac(params: URLSearchParams, secret: string, host: string, profile: ShopifyCredentialProfile = SHOPIFY_ORDERS_PROFILE) {
  const seen = new Set<string>();
  for (const [key] of params) { if (seen.has(key) || key === "signature") return false; seen.add(key); }
  if (params.get("shop") !== SHOPIFY_SHOP || !/^[a-f0-9]{64}$/i.test(params.get("hmac") ?? "") || !params.get("code")) return false;
  const sdk = shopifyApi({ apiKey: profile.clientId, apiSecretKey: secret, apiVersion: ApiVersion.July26,
    scopes: [...profile.scopes], hostName: host, isEmbeddedApp: false, logger: { level: LogSeverity.Error, log: () => {} } });
  try { return await sdk.utils.validateHmac(Object.fromEntries(params)); } catch { return false; }
}
export async function exchangeShopifyToken(secret: string, body: Record<string, string>, fetcher: typeof fetch = fetch, now = Date.now(), profile: ShopifyCredentialProfile = SHOPIFY_ORDERS_PROFILE): Promise<ShopifyToken> {
  let p;
  try { p = await boundedJson(await fetcher(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...body, client_id: profile.clientId, client_secret: secret }).toString(),
  }), 32_768); } catch (e) { shopifyFail(e instanceof Error && e.message === "MODTIME_SHOPIFY_REAUTH_REQUIRED" ? "REAUTH_REQUIRED" : "TOKEN_EXCHANGE_FAILED"); }
  if (typeof p.access_token !== "string" || !p.access_token || /\s/.test(p.access_token) || typeof p.refresh_token !== "string" || !p.refresh_token || /\s/.test(p.refresh_token) ||
    !(typeof p.scope === "string" && exactShopifyProfileScopes(p.scope, profile)) || p.associated_user || p.associated_user_scope || typeof p.expires_in !== "number" || !Number.isSafeInteger(p.expires_in) || p.expires_in <= 60 ||
    typeof p.refresh_token_expires_in !== "number" || !Number.isSafeInteger(p.refresh_token_expires_in) || p.refresh_token_expires_in <= 60) shopifyFail("TOKEN_INVALID");
  return { accessToken: p.access_token, refreshToken: p.refresh_token, scopes: [...profile.scopes], expiresAt: now + p.expires_in * 1000, refreshExpiresAt: now + p.refresh_token_expires_in * 1000 };
}
export function shopifyPeriod(input: unknown, now = Date.now()) {
  const p = input as Record<string, unknown>;
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).sort().join() !== "since,until") shopifyFail("PERIOD_INVALID");
  for (const value of [p.since, p.until]) if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) shopifyFail("PERIOD_INVALID");
  const since = p.since as string, until = p.until as string;
  // Full UTC days only, maximum 59 days back: never imply access beyond Shopify's 60-day history.
  const today = Date.parse(new Date(now).toISOString().slice(0, 10));
  if (Date.parse(since) < today - 59 * 86_400_000 || since > until || Date.parse(until) > today) shopifyFail("PERIOD_INVALID");
  return { since, until };
}
export class ShopifyOrdersClient {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  private async query(query: string, variables: Record<string, unknown> = {}) {
    let p;
    try { p = await boundedJson(await this.fetcher(`https://${SHOPIFY_SHOP}/admin/api/2026-07/graphql.json`, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": this.token }, body: JSON.stringify({ query, variables }),
    })); } catch (e) { shopifyFail(e instanceof Error && e.message === "MODTIME_SHOPIFY_REAUTH_REQUIRED" ? "REAUTH_REQUIRED" : "READ_FAILED"); }
    if (p.errors || !p.data || typeof p.data !== "object") shopifyFail("READ_FAILED");
    return p.data as Record<string, unknown>;
  }
  async identity() {
    const data = await this.query("query { shop { myshopifyDomain currencyCode } currentAppInstallation { accessScopes { handle } } }");
    const shop = data.shop as { myshopifyDomain?: string; currencyCode?: string };
    const app = data.currentAppInstallation as { accessScopes?: { handle: string }[] };
    if (shop?.myshopifyDomain !== SHOPIFY_SHOP || !/^[A-Z]{3}$/.test(shop.currencyCode ?? "") || !Array.isArray(app?.accessScopes) || !exactShopifyScopes(app.accessScopes.map(s => s.handle))) shopifyFail("IDENTITY_OR_SCOPES_MISMATCH");
    return { shop: SHOPIFY_SHOP, currency: shop.currencyCode! };
  }
  async probe() {
    await this.identity();
    // Scope listings alone do not establish data access. Read one identifier per resource, never return it.
    const data = await this.query("query { orders(first:1) { nodes { id } } draftOrders(first:1) { nodes { id } } }");
    for (const field of ["orders", "draftOrders"]) {
      const list = data[field] as { nodes?: { id: string }[] };
      if (!Array.isArray(list?.nodes) || list.nodes.length > 1 || !list.nodes.every(row => typeof row.id === "string")) shopifyFail("READ_FAILED");
    }
  }
  async summary(input: unknown) {
    const period = shopifyPeriod(input), identity = await this.identity();
    const end = new Date(Date.parse(period.until) + 86_400_000).toISOString();
    const filter = `created_at:>='${period.since}T00:00:00Z' created_at:<'${end}'`;
    const counts = { orders: 0, paidOrders: 0, notFullyPaidOrders: 0, cancelledOrders: 0, testOrdersExcluded: 0, openDraftOrders: 0, completedDraftOrders: 0 };
    const money = new ShopifyMoneySummary(identity.currency);
    const financialStatusCounts: Record<string, number> = Object.fromEntries(["AUTHORIZED", "EXPIRED", "PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "PENDING", "REFUNDED", "VOIDED", "UNKNOWN"].map(s => [s, 0]));
    // Return aggregate counts and money only: no names, addresses, email, line items or customer identifiers.
    for (const field of ["orders", "draftOrders"] as const) {
      let after: string | null = null; const seen = new Set<string>(), cursors = new Set<string>(); let complete = false;
      for (let page = 0; page < 10; page++) {
        const selection = field === "orders" ? `id createdAt fullyPaid test cancelledAt displayFinancialStatus ${SHOPIFY_ORDER_MONEY_SELECTION}` : "id createdAt status";
        // DraftOrderSortKeys has no CREATED_AT in API 2026-07; stable ID ordering is supported.
        const sortKey = field === "orders" ? "CREATED_AT" : "ID";
        const data = await this.query(`query($after:String,$filter:String!){ ${field}(first:100,after:$after,query:$filter,sortKey:${sortKey}){ nodes { ${selection} } pageInfo { hasNextPage endCursor } } }`, { after, filter });
        const list = data[field] as { nodes?: Record<string, unknown>[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
        if (!Array.isArray(list?.nodes) || list.nodes.length > 100 || typeof list.pageInfo?.hasNextPage !== "boolean" || list.pageInfo.hasNextPage && list.nodes.length === 0) shopifyFail("INCOMPLETE_RESPONSE");
        for (const row of list.nodes) {
          if (!row || typeof row.id !== "string" || seen.has(row.id) || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt)) || Date.parse(row.createdAt) < Date.parse(period.since) || Date.parse(row.createdAt) >= Date.parse(end)) shopifyFail("INCOMPLETE_RESPONSE");
          seen.add(row.id);
          if (field === "orders") {
            if (typeof row.test !== "boolean" || typeof row.fullyPaid !== "boolean") shopifyFail("INCOMPLETE_RESPONSE");
            if (row.test) counts.testOrdersExcluded++; else {
              if (row.cancelledAt !== null && (typeof row.cancelledAt !== "string" || !Number.isFinite(Date.parse(row.cancelledAt)))) shopifyFail("INCOMPLETE_RESPONSE");
              if (row.displayFinancialStatus !== null && (typeof row.displayFinancialStatus !== "string" || !Object.hasOwn(financialStatusCounts, row.displayFinancialStatus) || row.displayFinancialStatus === "UNKNOWN")) shopifyFail("INCOMPLETE_RESPONSE");
              const cancelled = row.cancelledAt !== null;
              counts.orders++; if (row.fullyPaid) counts.paidOrders++; else counts.notFullyPaidOrders++;
              if (cancelled) counts.cancelledOrders++;
              financialStatusCounts[row.displayFinancialStatus === null ? "UNKNOWN" : row.displayFinancialStatus as string]++;
              money.add(row, cancelled);
            }
          } else {
            if (!["OPEN", "INVOICE_SENT", "COMPLETED"].includes(String(row.status))) shopifyFail("INCOMPLETE_RESPONSE");
            if (row.status === "COMPLETED") counts.completedDraftOrders++; else counts.openDraftOrders++;
          }
        }
        if (!list.pageInfo.hasNextPage) { complete = true; break; }
        if (typeof list.pageInfo.endCursor !== "string" || !list.pageInfo.endCursor || list.pageInfo.endCursor.length > 4096 || cursors.has(list.pageInfo.endCursor)) shopifyFail("INCOMPLETE_RESPONSE");
        cursors.add(list.pageInfo.endCursor); after = list.pageInfo.endCursor;
      }
      if (!complete) shopifyFail("PAGINATION_LIMIT");
    }
    return { source: "Shopify Admin API live read", ...identity, period, timeBasis: "UTC creation date; current paid/draft status", checkedAt: new Date().toISOString(), ...counts,
      financialStatusCounts, monetary: money.snapshot(),
      readConsistency: "Bounded paged live read, not a transactional snapshot; provider records can change while pages are being read.",
      paymentCountBasis: "paidOrders uses Shopify fullyPaid (received >= order total), not financial status PAID. Includes cancelled/refunded orders if Shopify reports fullyPaid. notFullyPaidOrders includes pending/partial/authorized states, not only zero-payment orders.",
      historyDaysMaximum: 60, firstCustomerStatus: "unknown", newCustomers: null, purchaseCAC: null, reconciledROAS: null,
      note: "Paid orders are not proven new customers. Drafts are a separate funnel count, never added to paid orders. No full customer history, spend attribution or profitability is established." };
  }
}
