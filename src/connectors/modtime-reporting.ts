import { adminCapability, shopifyAdminEnabled } from "./shopify-admin-service";
import { themeCapability, THEME_UNCONFIGURED_CAPABILITY } from "./shopify-themes-service";
import { SHOPIFY_THEMES_ID } from "./shopify-themes-api";
import "server-only";
import { shopifyCapability } from "@/connectors/shopify-server-service";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";
import type { CatalogResource } from "@/catalog/contracts";
import type { ConnectorCapabilitySnapshot } from "@/connectors/contracts";

export const MODTIME_META_ID = "modtime-meta-ads";
export const MODTIME_SHOPIFY_ID = "modtime-shopify-orders";
const ACCOUNT = "act_1958171757928333";
const CONNECTION = "ca_1l0lnTCJTV9F";
const PROXY = "https://backend.composio.dev/api/v3.1/tools/execute/proxy";
const ATTRIBUTION_WINDOWS = ["7d_click", "1d_view"] as const;
const ACTION_REPORT_TIME = "conversion";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MODTIME_REPORTING_RESOURCES: CatalogResource[] = [
  [MODTIME_META_ID, "Meta Ads · MODTIME"], [MODTIME_SHOPIFY_ID, "Shopify Orders · MODTIME"], [SHOPIFY_THEMES_ID, "Shopify Website · MODTIME"],
].map(([id, label]) => ({ id, label, kind: "connector", credentialMode: "shared-resource",
  managedBy: "company", sharedResource: true, appId: null, connectorId: id, mcp: null }));

export function modtimeReportingEnabled(installationId: string) {
  const users = process.env.MODTIME_REPORTING_USER_IDS?.split(",") ?? [];
  return installationId === "modtime" && users.length > 0 && users.every(id => UUID.test(id));
}

export function validateMetaPeriod(input: unknown, now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("MODTIME_DATE_RANGE_INVALID");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== "since,until") throw new Error("MODTIME_DATE_RANGE_INVALID");
  const dates = [value.since, value.until];
  if (!dates.every(d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d)) throw new Error("MODTIME_DATE_RANGE_INVALID");
  const since = value.since as string, until = value.until as string;
  const span = Date.parse(until) - Date.parse(since);
  if (span < 0 || span > 89 * 86400000 || until > new Date(now).toISOString().slice(0, 10)) throw new Error("MODTIME_DATE_RANGE_INVALID");
  return { since, until };
}

export function completeMetaWeeks(timeZone: string, now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  const day = (offset: number) => new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10);
  return { accountLocalToday: today, latest: { since: day(-7), until: day(-1) }, previous: { since: day(-14), until: day(-8) } };
}

/** Exact existing MODTIME grant; caller cannot supply an account, URL, method or fields. */
export class ModtimeMetaReadClient {
  constructor(private readonly key: string, private readonly fetcher: typeof fetch = fetch) {
    if (!key) throw new Error("MODTIME_META_NOT_CONFIGURED");
  }
  private async read(suffix: string, query: Record<string, string>) {
    const response = await this.fetcher(PROXY, { method: "POST", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(30000), headers: { "x-api-key": this.key, "Content-Type": "application/json" },
      body: JSON.stringify({ connected_account_id: CONNECTION,
        endpoint: `https://graph.facebook.com/v23.0/${ACCOUNT}${suffix}`, method: "GET",
        parameters: Object.entries(query).map(([name, value]) => ({ name, value, type: "query" })) }) });
    if (!response.ok) throw new Error("MODTIME_META_PROVIDER_UNAVAILABLE");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("MODTIME_META_PROVIDER_UNAVAILABLE");
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1000000) { await reader.cancel(); throw new Error("MODTIME_META_RESPONSE_TOO_LARGE"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let envelope;
    try { envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("MODTIME_META_PROVIDER_UNAVAILABLE"); }
    if (envelope?.status !== 200 || !envelope.data || typeof envelope.data !== "object" || envelope.data.error) throw new Error("MODTIME_META_PROVIDER_UNAVAILABLE");
    return envelope.data;
  }
  async account() {
    const account = await this.read("", { fields: "id,currency,timezone_name" });
    if (account.id !== ACCOUNT || typeof account.currency !== "string" || !/^[A-Z]{3}$/.test(account.currency) ||
      typeof account.timezone_name !== "string" || !account.timezone_name) throw new Error("MODTIME_META_ACCOUNT_MISMATCH");
    try { new Intl.DateTimeFormat("en", { timeZone: account.timezone_name }); }
    catch { throw new Error("MODTIME_META_ACCOUNT_MISMATCH"); }
    return { accountId: ACCOUNT, currency: account.currency as string, accountTimeZone: account.timezone_name as string };
  }
  async insights(input: unknown) {
    const period = validateMetaPeriod(input);
    const identity = await this.account();
    const result = await this.read("/insights", { level: "account", time_range: JSON.stringify(period),
      action_attribution_windows: JSON.stringify(ATTRIBUTION_WINDOWS), action_report_time: ACTION_REPORT_TIME,
      fields: "account_id,date_start,date_stop,spend,impressions,inline_link_clicks,actions,action_values" });
    if (!Array.isArray(result.data) || result.data.length > 1 || result.paging?.next) throw new Error("MODTIME_META_INCOMPLETE_RESPONSE");
    const numeric = (value: unknown) => {
      if (typeof value !== "number" && typeof value !== "string" || typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error("MODTIME_META_INVALID_METRIC");
      return Number(value);
    };
    const rows = result.data.map((row: Record<string, unknown>) => {
      if (row.account_id !== ACCOUNT.slice(4) || row.date_start !== period.since || row.date_stop !== period.until) throw new Error("MODTIME_META_ACCOUNT_OR_PERIOD_MISMATCH");
      const purchase = (key: string) => {
        if (!Array.isArray(row[key])) return null;
        if (row[key].some(a => !a || typeof a !== "object")) throw new Error("MODTIME_META_INVALID_METRIC");
        const matches = row[key].filter((a: Record<string, unknown>) => a.action_type === "offsite_conversion.fb_pixel_purchase");
        if (matches.length > 1) throw new Error("MODTIME_META_DUPLICATE_ATTRIBUTION");
        const action = matches[0];
        return action ? numeric(action.value) : null;
      };
      const spend = numeric(row.spend), attributedRevenue = purchase("action_values");
      return { spend, impressions: row.impressions === undefined ? null : numeric(row.impressions), linkClicks: row.inline_link_clicks === undefined ? null : numeric(row.inline_link_clicks),
        metaAttributedPurchases: purchase("actions"), metaAttributedRevenue: attributedRevenue,
        metaReportedROAS: spend > 0 && attributedRevenue !== null ? attributedRevenue / spend : null };
    });
    return { source: "Meta Ads live API", ...identity, period, checkedAt: new Date().toISOString(),
      attributionWindows: ATTRIBUTION_WINDOWS, actionReportTime: ACTION_REPORT_TIME,
      attributionBasis: "Explicit report request: 7-day click and 1-day view, conversion-time reporting. This is not a claim about the ad set's configured attribution settings.",
      rows, dataAvailability: rows.length ? "reported_rows" : "no_reported_rows_not_zero", completeWeeklyPeriods: completeMetaWeeks(identity.accountTimeZone), purchaseCAC: null, reconciledROAS: null,
      attributionNote: "Meta attribution is provider-reported. Shopify reconciliation and verified new-customer CAC are unavailable." };
  }
}

async function authorized(installationId: string, userId: string, connectorId: string) {
  if (!modtimeReportingEnabled(installationId) || !process.env.MODTIME_REPORTING_USER_IDS?.split(",").includes(userId)) throw new Error("MODTIME_ACTOR_DENIED");
  const catalog = await catalogRuntimeEnforcer(installationId, userId);
  if (!catalog.allowsConnector(connectorId)) throw new Error("MODTIME_CONNECTOR_REVOKED");
}

export async function readModtimeMeta(installationId: string, userId: string, period: unknown, fetcher: typeof fetch = fetch) {
  await authorized(installationId, userId, MODTIME_META_ID);
  return new ModtimeMetaReadClient(process.env.MODTIME_COMPOSIO_API_KEY ?? "", fetcher).insights(period);
}

export async function readModtimeMetaWeeks(installationId: string, userId: string, input: unknown, fetcher: typeof fetch = fetch) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new Error("MODTIME_DATE_RANGE_INVALID");
  await authorized(installationId, userId, MODTIME_META_ID);
  const client = new ModtimeMetaReadClient(process.env.MODTIME_COMPOSIO_API_KEY ?? "", fetcher);
  const identity = await client.account();
  const windows = completeMetaWeeks(identity.accountTimeZone);
  const latest = await client.insights(windows.latest), previous = await client.insights(windows.previous);
  if ([latest, previous].some(r => r.currency !== identity.currency || r.accountTimeZone !== identity.accountTimeZone)) throw new Error("MODTIME_META_ACCOUNT_MISMATCH");
  return { ...identity, windows, latest, previous, purchaseCAC: null, reconciledROAS: null };
}

export async function modtimeReportingCapabilities(installationId: string, userId: string, fetcher: typeof fetch = fetch) {
  if (!modtimeReportingEnabled(installationId)) return [];
  const result: Array<ConnectorCapabilitySnapshot & { accountEmail: null; connectionVersion: number | null; connectUrl: string | null; disconnectUrl: null }> = [];
  for (const resource of MODTIME_REPORTING_RESOURCES) {
    if (resource.id === SHOPIFY_THEMES_ID && process.env.MODTIME_SHOPIFY_THEMES_ENABLED !== "1") continue;
    try { await authorized(installationId, userId, resource.id); } catch { continue; }
    if (resource.id === SHOPIFY_THEMES_ID) {
      if (!process.env.MODTIME_SHOPIFY_THEME_USER_IDS?.split(",").includes(userId)) continue;
      try { result.push(await (shopifyAdminEnabled() ? adminCapability : themeCapability)(installationId, userId, fetcher)); }
      catch { result.push({ ...THEME_UNCONFIGURED_CAPABILITY, accountEmail: null, connectionVersion: null, connectUrl: null, disconnectUrl: null }); }
      continue;
    }
    if (resource.id === MODTIME_SHOPIFY_ID) {
      try { result.push(await shopifyCapability(installationId, userId, fetcher)); } catch { /* Denied actors receive no card. */ }
      continue;
    }
    let status: ConnectorCapabilitySnapshot["status"] = "not_configured";
    let statusCode: string | null = "SHOPIFY_AUTHORIZATION_SETUP_REQUIRED";
    if (resource.id === MODTIME_META_ID) {
      try {
        await new ModtimeMetaReadClient(process.env.MODTIME_COMPOSIO_API_KEY ?? "", fetcher).account();
        status = "connected"; statusCode = null;
      } catch { status = "degraded"; statusCode = "MODTIME_META_READBACK_FAILED"; }
    }
    result.push({ connectorId: resource.id, label: resource.label, status, statusCode,
      checkedAt: new Date().toISOString(), effectiveOperations: status === "connected" ? ["insights-read"] : [],
      approvalRequiredOperations: [], accountEmail: null, connectionVersion: null, connectUrl: null, disconnectUrl: null });
  }
  return result;
}
