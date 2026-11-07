import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const access = vi.hoisted(() => ({ allowed: true }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => ({ installationId: "modtime" }) }));
vi.mock("@/admin/policy-service", () => ({ workspacePolicyForIdentity: async () => ({ role: { canManageWorkspace: false } }) }));
vi.mock("@/catalog/access-service", () => ({ catalogRuntimeEnforcer: async () => ({ allowsConnector: () => access.allowed }) }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => ({ installationId: "modtime" }) }));
vi.mock("@/admin/policy-service", () => ({ workspacePolicyForIdentity: async () => ({ role: { canManageWorkspace: true } }) }));
import { completeMetaWeeks, ModtimeMetaReadClient, modtimeReportingCapabilities, readModtimeMeta, readModtimeMetaWeeks, validateMetaPeriod } from "../../src/connectors/modtime-reporting";
import { handleModtimeTool } from "../../src/runtime/modtime-dynamic-tools";
const userId = "e5474187-2242-42e4-96a8-608212f5d027";
const period = { since: "2026-09-01", until: "2026-09-07" };
const identity = { id: "act_1958171757928333", currency: "EUR", timezone_name: "Europe/Madrid" };
const row = { account_id: "1958171757928333", date_start: period.since, date_stop: period.until, spend: "50", impressions: "1000" };
function provider(...data: unknown[]) {
  return vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ status: 200, data: data.shift() }), { status: 200 }));
}
beforeEach(() => { access.allowed = true; vi.stubEnv("MODTIME_REPORTING_USER_IDS", userId); vi.stubEnv("MODTIME_COMPOSIO_API_KEY", "test-key"); vi.stubEnv("MODTIME_SHOPIFY_OAUTH_ENABLED", ""); });
afterEach(() => vi.unstubAllEnvs());
describe("MODTIME fixed read-only adapter", () => {
  it("derives complete local weeks from the server clock, across UTC midnight and DST", () => {
    expect(completeMetaWeeks("America/Los_Angeles", Date.parse("2026-09-30T12:00:00Z"))).toEqual({ accountLocalToday: "2026-09-30", latest: { since: "2026-09-23", until: "2026-09-29" }, previous: { since: "2026-09-16", until: "2026-09-22" } });
    expect(completeMetaWeeks("America/Los_Angeles", Date.parse("2026-09-30T01:00:00Z")).latest).toEqual({ since: "2026-09-22", until: "2026-09-28" });
    expect(completeMetaWeeks("America/Los_Angeles", Date.parse("2026-11-03T12:00:00Z")).latest).toEqual({ since: "2026-10-27", until: "2026-11-02" });
  });
  it("preserves missing impressions as null and empty provider rows as unavailable, never zero", async () => {
    const missing = { ...row, spend: "0", impressions: undefined, inline_link_clicks: "0" };
    expect((await new ModtimeMetaReadClient("key", provider(identity, { data: [missing] })).insights(period)).rows[0]).toMatchObject({ spend: 0, impressions: null, linkClicks: 0 });
    expect(await new ModtimeMetaReadClient("key", provider(identity, { data: [] })).insights(period)).toMatchObject({ rows: [], dataAvailability: "no_reported_rows_not_zero" });
    await expect(new ModtimeMetaReadClient("key", provider(identity, { data: [{ ...row, impressions: " " }] })).insights(period)).rejects.toThrow("MODTIME_META_INVALID_METRIC");
  });
  it("weekly tool makes two separate bounded queries and rejects caller-supplied dates", async () => {
    const fetcher = provider(identity, identity, { data: [] }, identity, { data: [] });
    const result = await readModtimeMetaWeeks("modtime", userId, {}, fetcher);
    expect(result.latest.period).toEqual(result.windows.latest);
    expect(result.previous.period).toEqual(result.windows.previous);
    expect(fetcher).toHaveBeenCalledTimes(5);
    await expect(readModtimeMetaWeeks("modtime", userId, period, provider())).rejects.toThrow("MODTIME_DATE_RANGE_INVALID");
    await expect(readModtimeMetaWeeks("trinalum-production", userId, {}, provider())).rejects.toThrow("MODTIME_ACTOR_DENIED");
  });
  it("binds every call to the existing MODTIME account and connection and keeps unverified metrics null", async () => {
    const fetcher = provider(identity, { data: [row] });
    const result = await readModtimeMeta("modtime", userId, period, fetcher);
    expect(result.purchaseCAC).toBeNull(); expect(result.reconciledROAS).toBeNull();
    expect(result.rows[0]).toMatchObject({ spend: 50, metaAttributedRevenue: null, metaReportedROAS: null });
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe("https://backend.composio.dev/api/v3.1/tools/execute/proxy");
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe("GET"); expect(body.connected_account_id).toBe("ca_1l0lnTCJTV9F");
      expect(body.endpoint).toMatch(/^https:\/\/graph.facebook.com\/v23.0\/act_1958171757928333(?:\/insights)?$/);
    }
  });
  it("does not double-count overlapping Meta purchase attribution buckets", async () => {
    const fetcher = provider(identity, { data: [{ ...row, actions: [{ action_type: "purchase", value: "99" }, { action_type: "offsite_conversion.fb_pixel_purchase", value: "2" }], action_values: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "150" }] }] });
    const result = await new ModtimeMetaReadClient("key", fetcher).insights(period);
    expect(result.rows[0]).toMatchObject({ metaAttributedPurchases: 2, metaAttributedRevenue: 150, metaReportedROAS: 3 });
    expect(result).toMatchObject({ attributionWindows: ["7d_click", "1d_view"], actionReportTime: "conversion", accountTimeZone: "Europe/Madrid" });
    const request = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(request.parameters).toEqual(expect.arrayContaining([{ name: "action_attribution_windows", value: '["7d_click","1d_view"]', type: "query" }, { name: "action_report_time", value: "conversion", type: "query" }]));
  });
  it("rejects whitespace metrics and duplicate exact purchase buckets", async () => {
    await expect(new ModtimeMetaReadClient("key", provider(identity, { data: [{ ...row, spend: "  " }] })).insights(period)).rejects.toThrow("MODTIME_META_INVALID_METRIC");
    await expect(new ModtimeMetaReadClient("key", provider(identity, { data: [{ ...row, actions: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "1" }, { action_type: "offsite_conversion.fb_pixel_purchase", value: "2" }] }] })).insights(period)).rejects.toThrow("MODTIME_META_DUPLICATE_ATTRIBUTION");
  });
  it.each([{ ...period, account: "foreign" }, { since: "2026-02-30", until: "2026-03-01" }, { since: "2026-01-01", until: "2026-09-01" }, { since: "9999-01-01", until: "9999-01-01" }, { since: period.until, until: period.since }])("rejects unbounded, invalid or injected requests", input => expect(() => validateMetaPeriod(input)).toThrow("MODTIME_DATE_RANGE_INVALID"));
  it("denies foreign installations, actors and revoked catalog access before fetching", async () => {
    const fetcher = provider(identity);
    await expect(readModtimeMeta("trinalum-production", userId, period, fetcher)).rejects.toThrow("MODTIME_ACTOR_DENIED");
    await expect(readModtimeMeta("modtime", "foreign", period, fetcher)).rejects.toThrow("MODTIME_ACTOR_DENIED");
    access.allowed = false;
    await expect(readModtimeMeta("modtime", userId, period, fetcher)).rejects.toThrow("MODTIME_CONNECTOR_REVOKED");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects foreign provider accounts and incomplete pagination", async () => {
    await expect(new ModtimeMetaReadClient("key", provider({ ...identity, id: "act_other" })).insights(period)).rejects.toThrow("MODTIME_META_ACCOUNT_MISMATCH");
    await expect(new ModtimeMetaReadClient("key", provider(identity, { data: [row], paging: { next: "foreign" } })).insights(period)).rejects.toThrow("MODTIME_META_INCOMPLETE_RESPONSE");
    await expect(new ModtimeMetaReadClient("key", provider(identity, { data: [{ ...row, account_id: "foreign" }] })).insights(period)).rejects.toThrow("MODTIME_META_ACCOUNT_OR_PERIOD_MISMATCH");
  });
  it("marks Shopify unconnected, never converting public catalog data into order access", async () => {
    const fetcher = provider(identity);
    const result = await modtimeReportingCapabilities("modtime", userId, fetcher);
    expect(result.map(c => [c.connectorId, c.status])).toEqual([["modtime-meta-ads", "connected"], ["modtime-shopify-orders", "not_configured"]]);
    expect(result[1].effectiveOperations).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1); // Only Meta identity; disabled Shopify makes no request.
    expect(await modtimeReportingCapabilities("trinalum-production", userId, provider(identity))).toEqual([]);
  });
  it("rejects cross-turn tool requests without fetching", async () => {
    const result = await handleModtimeTool({ namespace: "modtime_business", tool: "meta_insights", threadId: "other", turnId: "turn", callId: "call", arguments: period }, { installationId: "modtime", userId, runtimeThreadId: "thread", runtimeTurnId: "turn", selectedIds: [] });
    expect(result.success).toBe(false); expect(result.contentItems).toEqual([{ type: "inputText", text: '{"error":"MODTIME_TURN_DENIED"}' }]);
  });
});
