import { afterEach, expect, it, vi } from "vitest";
import { ComposioError } from "@/connectors/composio-api";
const state = vi.hoisted(() => ({ session: {} as unknown, start: vi.fn(), warn: vi.fn() }));
vi.mock("@/operations/server-logger", () => ({ operationalLogger: { warn: state.warn } }));
vi.mock("@/auth/session", () => ({ getSession: async () => state.session }));
vi.mock("@/connectors/composio-service", () => ({ startComposio: state.start }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => ({ publicUrl: "https://brain.example" }) }));
import { GET } from "./route";
const context = { params: Promise.resolve({ toolkit: "airtable" }) };
afterEach(() => { vi.restoreAllMocks(); state.start.mockReset(); state.warn.mockReset(); state.session = {}; });

it("starts OAuth without exposing the provider response", async () => {
  state.start.mockResolvedValue("https://connect.composio.dev/link/test");
  const response = await GET(new Request("https://brain.example/api/connectors/composio/airtable/connect"), context);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("https://connect.composio.dev/link/test");
});
it("returns to connector settings on failure using the configured origin", async () => {
  state.start.mockRejectedValue(new ComposioError("COMPOSIO_AUTH_CONFIG_SCOPE_MISMATCH"));
  const response = await GET(new Request("http://internal:3000/api/connectors/composio/airtable/connect", { headers: { "x-forwarded-host": "untrusted.example" } }), context);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("https://brain.example/?settings=connectors&connection=failed");
  expect(state.warn).toHaveBeenCalledWith("connectors.composio_connect_failed", { code: "COMPOSIO_AUTH_CONFIG_SCOPE_MISMATCH" });
});
it("does not call the provider without a session or from another site", async () => {
  state.session = null;
  expect((await GET(new Request("https://brain.example/connect"), context)).status).toBe(401);
  state.session = {};
  expect((await GET(new Request("https://brain.example/connect", { headers: { "sec-fetch-site": "cross-site" } }), context)).status).toBe(403);
  expect(state.start).not.toHaveBeenCalled();
});
