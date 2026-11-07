import { describe, expect, it } from "vitest";
import { isComposioToolkitConfig } from "./composio-config";
import { ComposioApi } from "./composio-api";
const config = { slug: "github", label: "GitHub", authConfigId: "ac_test", scopes: ["read:user"], readTools: [{ slug: "GITHUB_TEST_READ", version: "20260901_00" }] };
describe("reviewed provider configuration", () => {
  it("rejects unpinned or malformed manifests", () => {
    expect(isComposioToolkitConfig(config)).toBe(true);
    expect(isComposioToolkitConfig({ ...config, readTools: [{ slug: "GITHUB_TEST_READ", version: "latest" }] })).toBe(false);
    expect(isComposioToolkitConfig({ ...config, slug: "../gmail" })).toBe(false);
    expect(isComposioToolkitConfig({ ...config, scopes: [] })).toBe(false);
  });
  it("fetches versioned provider tool schemas and rejects cross-toolkit substitution", async () => {
    const fetcher = async () => Response.json({ slug: "GITHUB_TEST_READ", version: "20260901_00", toolkit: { slug: "github" }, input_parameters: { type: "object" }, description: "Read synthetic marker" });
    expect(await new ComposioApi("synthetic", fetcher).tools(config)).toHaveLength(1);
    await expect(new ComposioApi("synthetic", async () => Response.json({ slug: "GITHUB_TEST_READ", version: "20260901_00", toolkit: { slug: "gmail" }, input_parameters: {} })).tools(config)).rejects.toMatchObject({ code: "COMPOSIO_TOOL_DEFINITION_MISMATCH" });
  });
  it("never redirects a user to an untrusted hosted-link destination", async () => {
    let call = 0;
    const api = new ComposioApi("synthetic", async () => Response.json(++call === 1 ? { id: "ac_test", toolkit: { slug: "github" }, status: "ENABLED", auth_scheme: "OAUTH2" } : { redirect_url: "https://evil.example/consent" }));
    await expect(api.begin(config, "synthetic-user", "https://brain.example/callback")).rejects.toMatchObject({ code: "COMPOSIO_LINK_INVALID" });
  });
});
