import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import { provisionComposioToolkit, resolveComposioToolkit, verifiedComposioScopes } from "./composio-provisioning";
vi.mock("server-only", () => ({}));
const toolkit = { slug: "linear", label: "Linear", authConfigId: "on-connect", scopes: ["read"], readTools: [{ slug: "LINEAR_SEARCH_ISSUES", version: "20260819_00" }] };
let root: string;
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
async function setup(scopes: unknown = ["read"]) {
  root = await mkdtemp(path.join(os.tmpdir(), "composio-provision-"));
  const config = { installationId: "qa", paths: { dataRoot: root } } as InstallationConfig;
  vi.stubEnv("AIBRAIN_COMPOSIO_CATALOG_API_KEY", "test-only");
  const fetcher = vi.fn<typeof fetch>(async (url, init) => new Response(JSON.stringify(String(url).includes("/auth_configs?") ? { items: [], next_cursor: null } : String(url).includes("/toolkits/") ? { slug: "linear", composio_managed_auth_schemes: ["OAUTH2"] } : init?.method === "POST" ? { auth_config: { id: "ac_test" } } : { id: "ac_test", toolkit: { slug: "linear" }, status: "ENABLED", auth_scheme: "OAUTH2", credentials: { scopes } }), { status: 200 }));
  return { config, fetcher };
}
describe("first explicit connect provisioning", () => {
  it.each([["read", "write"], "read,write"])("normalizes provider scope representation %j", (scopes) => {
    expect(verifiedComposioScopes(scopes)).toEqual(["read", "write"]);
  });
  it.each([undefined, null, {}, ["read", 3], ["read", ""]])("rejects malformed scope readback %j", (scopes) => {
    expect(() => verifiedComposioScopes(scopes)).toThrow();
  });
  it("recovers a matching remote config after an interrupted create without creating a duplicate", async () => {
    const { config } = await setup();
    let name = "";
    let creates = 0;
    let interrupt = true;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/toolkits/")) return new Response(JSON.stringify({ slug: "linear", composio_managed_auth_schemes: ["OAUTH2"] }));
      const auth = { id: "ac_recover", name, toolkit: { slug: "linear" }, status: "ENABLED", auth_scheme: "OAUTH2", credentials: { scopes: ["read"] } };
      if (String(url).includes("/auth_configs?")) return new Response(JSON.stringify({ items: name ? [auth] : [] }));
      if (init?.method === "POST") { creates++; name = JSON.parse(String(init.body)).auth_config.name; return new Response(JSON.stringify({ auth_config: { id: "ac_recover" } })); }
      if (interrupt) { interrupt = false; throw new Error("connection interrupted"); }
      return new Response(JSON.stringify(auth));
    });
    await expect(provisionComposioToolkit(config, toolkit, fetcher)).rejects.toThrow();
    expect((await provisionComposioToolkit(config, toolkit, fetcher)).authConfigId).toBe("ac_recover");
    expect(creates).toBe(1);
  });
  it("does no provider work while resolving a catalog entry; concurrent connect creates once and survives reload", async () => {
    const { config, fetcher } = await setup();
    expect((await resolveComposioToolkit(config, toolkit)).authConfigId).toBe("on-connect");
    expect(fetcher).not.toHaveBeenCalled();
    const resolved = await Promise.all([provisionComposioToolkit(config, toolkit, fetcher), provisionComposioToolkit(config, toolkit, fetcher)]);
    expect(resolved.map(t => t.authConfigId)).toEqual(["ac_test", "ac_test"]);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect((await resolveComposioToolkit(config, toolkit)).authConfigId).toBe("ac_test");
    expect((await resolveComposioToolkit({ ...config, installationId: "foreign" }, toolkit)).authConfigId).toBe("on-connect");
    expect((await resolveComposioToolkit(config, { ...toolkit, scopes: ["other"] })).authConfigId).toBe("on-connect");
  });
  it("rejects scope expansion without persisting a usable config", async () => {
    const { config, fetcher } = await setup("read,write");
    await expect(provisionComposioToolkit(config, toolkit, fetcher)).rejects.toMatchObject({ code: "COMPOSIO_AUTH_CONFIG_SCOPE_MISMATCH" });
    expect((await resolveComposioToolkit(config, toolkit)).authConfigId).toBe("on-connect");
  });
});
