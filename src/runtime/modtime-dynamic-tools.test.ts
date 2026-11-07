vi.mock("server-only", () => ({}));
import { beforeEach, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ orders: vi.fn(), meta: vi.fn(), admin: vi.fn(), status: vi.fn(), assertAdmin: vi.fn(), requestFile: vi.fn() }));
vi.mock("@/connectors/shopify-server-service", () => ({ readShopifyOrders: mocks.orders }));
vi.mock("@/connectors/modtime-reporting", () => ({ MODTIME_META_ID: "modtime-meta-ads", readModtimeMeta: mocks.meta }));
vi.mock("@/connectors/shopify-admin-service", () => ({ executeShopifyAdmin: mocks.admin, adminCapability: mocks.status, assertShopifyAdminExecution: mocks.assertAdmin }));
vi.mock("./shopify-request-file", () => ({ readShopifyRequestFile: mocks.requestFile }));
import { handleModtimeTool, MODTIME_DYNAMIC_TOOLS } from "./modtime-dynamic-tools";
const params = { namespace: "modtime_business", tool: "shopify_orders", threadId: "thread", turnId: "turn", callId: "call", arguments: { since: "2026-09-30", until: "2026-09-30" } };
const ctx = { installationId: "modtime", userId: "actor", runtimeThreadId: "thread", runtimeTurnId: "turn", selectedIds: ["modtime-shopify-orders"] };
beforeEach(() => { vi.clearAllMocks(); mocks.assertAdmin.mockReset().mockResolvedValue(undefined); mocks.requestFile.mockReset(); mocks.orders.mockResolvedValue({ paidOrders: 1, newCustomers: null }); });
it("denies unselected/foreign thread/turn/tenant before touching credentials", async () => {
  for (const patch of [{ selectedIds: [] }, { selectedIds: ["modtime-meta-ads"] }, { runtimeThreadId: "other" }, { runtimeTurnId: "other" }, { installationId: "foreign" }])
    expect((await handleModtimeTool(params, { ...ctx, ...patch })).success).toBe(false);
  expect(mocks.orders).not.toHaveBeenCalled();
});
it("passes only authorized actor and bounded input to the server reader, redacts failures", async () => {
  expect((await handleModtimeTool(params, ctx)).success).toBe(true);
  expect(mocks.orders).toHaveBeenCalledWith("modtime", "actor", params.arguments);
  mocks.orders.mockRejectedValue(Error("sensitive-token")); expect(JSON.stringify(await handleModtimeTool(params, ctx))).not.toContain("sensitive-token");
});
it("rejects theme writes in an unselected/foreign/background turn or with model-supplied approval flags", async () => {
  const apply = { ...params, tool: "shopify_title_apply", arguments: { planId: "a".repeat(64) } };
  for (const patch of [{ selectedIds: [] }, { installationId: "foreign" }, { runtimeTurnId: "different" }]) expect((await handleModtimeTool(apply, { ...ctx, selectedIds: ["modtime-shopify-themes"], ...patch })).success).toBe(false);
  expect((await handleModtimeTool(apply, { ...ctx, selectedIds: ["modtime-shopify-themes"], backgroundExecution: true })).success).toBe(false);
  expect((await handleModtimeTool({ ...apply, arguments: { ...apply.arguments, approved: true } }, { ...ctx, selectedIds: ["modtime-shopify-themes"] })).success).toBe(false);
});

it("exposes broad draft editing tools without publication or media upload and guards all new operations", async () => {
  const definitions = JSON.stringify(MODTIME_DYNAMIC_TOOLS);
  for (const name of ["shopify_theme_files", "shopify_theme_plan", "shopify_theme_apply", "shopify_theme_rollback"]) {
    expect(definitions).toContain(name);
    expect((await handleModtimeTool({ ...params, tool: name }, { ...ctx, selectedIds: [] })).success).toBe(false);
  }
  for (const name of ["shopify_theme_apply", "shopify_theme_rollback"]) {
    expect((await handleModtimeTool({ ...params, tool: name, arguments: { planId: "a".repeat(64) } }, { ...ctx, selectedIds: ["modtime-shopify-themes"], backgroundExecution: true })).success).toBe(false);
  }
  expect(definitions).toContain("blocks and block_order together");
  expect(definitions).toContain("Cannot create/delete theme files");
});

it("dispatches general Shopify through ordinary session without selection or approval records", async () => {
  const session = { provider: "local" as const, tenant: { id: "modtime", name: "MODTIME" }, user: { id: "actor", name: "George", email: "george@example.test" }, expiresAt: "2099-01-01T00:00:00Z" };
  const call = { ...params, tool: "shopify_admin_graphql", arguments: { query: "query { shop { name } }" } };
  mocks.admin.mockResolvedValue({ data: { shop: { name: "MODTIME" } } });
  expect((await handleModtimeTool(call, { ...ctx, selectedIds: [], session })).success).toBe(true);
  expect(mocks.admin).toHaveBeenCalledWith(session, call.arguments);
  mocks.admin.mockClear();
  for (const patch of [{ session: undefined }, { backgroundExecution: true }, { readOnly: true }, { userId: "foreign" }, { runtimeTurnId: "foreign" }, { signal: AbortSignal.abort() }]) {
    expect((await handleModtimeTool(call, { ...ctx, session, ...patch })).success).toBe(false);
  }
  expect(mocks.admin).not.toHaveBeenCalled();
});

it("loads image request JSON only from trusted workspace after current actor authorization, using the same merchant tool", async () => {
  const session = { provider: "local" as const, tenant: { id: "modtime", name: "MODTIME" }, user: { id: "actor", name: "George", email: "george@example.test" }, expiresAt: "2099-01-01T00:00:00Z" };
  const call = { ...params, tool: "shopify_admin_graphql", arguments: { requestFile: "drafts/image.json" } };
  const request = { query: "mutation Upload($themeId:ID!,$files:[OnlineStoreThemeFilesUpsertFileInput!]!){themeFilesUpsert(themeId:$themeId,files:$files){upsertedThemeFiles{filename} userErrors{message}}}", variables: { themeId: "gid://shopify/OnlineStoreTheme/123", files: [{ filename: "assets/image.png", body: { type: "BASE64", value: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" } }] } };
  mocks.requestFile.mockResolvedValue(request);
  expect((await handleModtimeTool(call, { ...ctx, session, requestWorkspace: "/trusted/actor/project" })).success).toBe(true);
  expect(mocks.assertAdmin).toHaveBeenCalledWith(session);
  expect(mocks.requestFile).toHaveBeenCalledWith("/trusted/actor/project", "drafts/image.json");
  expect(mocks.assertAdmin.mock.invocationCallOrder[0]).toBeLessThan(mocks.requestFile.mock.invocationCallOrder[0]);
  expect(mocks.admin).toHaveBeenCalledWith(session, request, undefined, { workspaceRequestFile: true });
  mocks.admin.mockClear(); mocks.requestFile.mockClear();
  for (const patch of [{ session: undefined }, { backgroundExecution: true }, { readOnly: true }, { userId: "foreign" }, { runtimeTurnId: "foreign" }, { installationId: "foreign" }, { signal: AbortSignal.abort() }]) {
    expect((await handleModtimeTool(call, { ...ctx, session, ...patch })).success).toBe(false);
  }
  expect(mocks.requestFile).not.toHaveBeenCalled();
  mocks.assertAdmin.mockRejectedValue(Error("MODTIME_SHOPIFY_CATALOG_DENIED"));
  expect((await handleModtimeTool(call, { ...ctx, session })).success).toBe(false);
  expect(mocks.requestFile).not.toHaveBeenCalled(); expect(mocks.admin).not.toHaveBeenCalled();
});

it("denies mixed file/inline fields and cancellation during file reading before provider dispatch", async () => {
  const session = { provider: "local" as const, tenant: { id: "modtime", name: "MODTIME" }, user: { id: "actor", name: "George", email: "george@example.test" }, expiresAt: "2099-01-01T00:00:00Z" };
  const call = { ...params, tool: "shopify_admin_graphql", arguments: { requestFile: "image.json", query: "query{shop{name}}" } };
  expect((await handleModtimeTool(call, { ...ctx, session })).success).toBe(false);
  expect(mocks.requestFile).not.toHaveBeenCalled();
  const controller = new AbortController();
  mocks.requestFile.mockImplementation(async () => { controller.abort(); return { query: "query{shop{name}}" }; });
  expect((await handleModtimeTool({ ...call, arguments: { requestFile: "image.json" } }, { ...ctx, session, requestWorkspace: "/trusted/actor/project", signal: controller.signal })).success).toBe(false);
  expect(mocks.admin).not.toHaveBeenCalled();
});
