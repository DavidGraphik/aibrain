import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseInstallationConfig, type InstallationConfig } from "@/config/installation-schema";
import type { AuthSession } from "@/auth/types";
import { ComposioApi, composioUserId } from "./composio-api";
import { completeComposio, composioCapabilitiesForSession, composioCapability, composioReadTool, disconnectComposio } from "./composio-service";
import { FileGmailOAuthStateStore } from "./gmail-oauth-store";
import { handleComposioTool, COMPOSIO_NAMESPACE } from "@/runtime/composio-dynamic-tools";
import { FileConnectorBindingStore } from "./binding-store";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ config: null as unknown, allowed: true, denied: null as string | null }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => state.config }));
vi.mock("@/catalog/access-service", () => ({ catalogRuntimeEnforcer: async () => ({ allowsConnector: (id: string) => state.allowed && id !== state.denied }) }));
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const toolkit = { slug: "github", label: "GitHub", authConfigId: "ac_test", scopes: ["read:user"], readTools: [{ slug: "GITHUB_TEST_READ", version: "20260901_00" }] };
let root: string, config: Readonly<InstallationConfig>;
const session = (userId = A) => ({ provider: "local", tenant: { id: "company-qa" }, user: { id: userId } }) as AuthSession;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const provider = (owner = A, status = "ACTIVE", revokeFails = false) => vi.fn<typeof fetch>(async (url, init) => {
  const u = String(url);
  if (u.includes("/auth_configs/")) return json({ id: "ac_test", toolkit: { slug: "github" }, status: "ENABLED", auth_scheme: "OAUTH2" });
  if (u.includes("/revoke")) return revokeFails ? json({}, 503) : json({});
  if (init?.method === "DELETE") return json({});
  if (u.includes("/tools/execute/")) return json({ successful: true, data: { marker: "synthetic-read" }, log_id: "synthetic-log" });
  return json({ items: [{ id: "ca_test", user_id: composioUserId("company-qa", owner), toolkit: { slug: "github" }, auth_config: { id: "ac_test" }, status }] });
});
async function receipt() { return new FileGmailOAuthStateStore(config, Date.now, "composio").create(A, "https://brain.example/api/connectors/composio/github/callback?auth_config=ac_test"); }
async function connect(fetcher = provider()) { const s = await receipt(); await completeComposio(session(), "github", { state: s.state, status: "success", accountId: "ca_test" }, fetcher); return s; }
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aibrain-composio-test-"));
  config = parseInstallationConfig({ schemaVersion: 1, installationId: "company-qa", companyName: "Company", companySlug: "company", publicUrl: "https://brain.example", branding: { productName: "Company AI", logoPath: "/logo.svg", faviconPath: "/favicon.svg", accentColor: "#315ee7" }, paths: { dataRoot: path.join(root, "data"), companyContextRoot: path.join(root, "data/context"), usersRoot: path.join(root, "data/users"), sourceReadRoot: path.join(root, "source"), publishWriteRoot: path.join(root, "publish"), backupsRoot: path.join(root, "data/backups") }, connectors: { composio: { toolkits: [toolkit] } } });
  state.config = config; state.allowed = true; state.denied = null; vi.stubEnv("AIBRAIN_COMPOSIO_API_KEY", "synthetic-key");
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
describe("personal connected apps lifecycle (synthetic provider, not live acceptance)", () => {
  it("checks at most four connectors concurrently, preserving order, authorization and individual failures", async () => {
    const toolkits = Array.from({ length: 9 }, (_, i) => ({ ...toolkit, slug: `github${i}`, authConfigId: `ac_github${i}` }));
    state.config = { ...config, connectors: { composio: { toolkits } } };
    state.denied = "composio-github8";
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let active = 0, peak = 0;
    const fetcher = vi.fn<typeof fetch>(async url => {
      active++; peak = Math.max(peak, active);
      await gate;
      active--;
      const id = String(url).split("/").at(-1)!;
      if (id === "ac_github5") return json({}, 503);
      return json({ id, toolkit: { slug: id.slice(3) }, status: "ENABLED", auth_scheme: "OAUTH2" });
    });
    vi.stubGlobal("fetch", fetcher);
    const pending = composioCapabilitiesForSession(session());
    try { await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4)); }
    finally { release(); }
    const results = await pending;
    expect(peak).toBe(4);
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(results.map(item => item.connectorId)).toEqual(toolkits.slice(0, 8).map(t => `composio-${t.slug}`));
    expect(results[5]).toMatchObject({ status: "degraded", statusCode: "COMPOSIO_PROVIDER_UNAVAILABLE" });
    expect(results[0]).toMatchObject({ status: "reauth_required" });
  });

  it("keeps optional inventories harmless for non-local or unconfigured sessions", async () => {
    const nonLocal = { ...session(), provider: "mock" } as unknown as AuthSession;
    expect(await composioCapabilitiesForSession(nonLocal)).toEqual([]);
    state.config = { ...config, connectors: undefined };
    expect(await composioCapabilitiesForSession(nonLocal)).toEqual([]);
    expect(await composioCapabilitiesForSession({ ...session(), tenant: { id: "other" } } as AuthSession)).toEqual([]);
    state.config = config;
    await expect(composioCapabilitiesForSession({ ...session(), tenant: { id: "other" } } as AuthSession)).rejects.toMatchObject({ code: "COMPOSIO_TENANT_MISMATCH" });
  });
  it("reproduces missing configuration without claiming a connection or making a provider call", async () => {
    vi.stubEnv("AIBRAIN_COMPOSIO_API_KEY", ""); const fetcher = provider();
    expect(await composioCapability(config, A, "github", fetcher)).toMatchObject({ status: "not_configured", connectUrl: null });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires provider ACTIVE readback, rejects cross-user callbacks and replay", async () => {
    const s = await receipt();
    await expect(completeComposio(session(B), "github", { state: s.state, status: "success", accountId: "ca_test" }, provider())).rejects.toMatchObject({ code: "GMAIL_OAUTH_STATE_IDENTITY_MISMATCH" });
    await completeComposio(session(), "github", { state: s.state, status: "success", accountId: "ca_test" }, provider());
    await expect(completeComposio(session(), "github", { state: s.state, status: "success", accountId: "ca_test" }, provider())).rejects.toMatchObject({ code: "GMAIL_OAUTH_STATE_REPLAYED" });
    expect(await composioCapability(config, B, "github", provider())).toMatchObject({ status: "reauth_required" });
    expect(await composioCapability(config, A, "github", provider())).toMatchObject({ status: "connected" });
  });
  it("does not bind a foreign or expired provider account despite a successful callback", async () => {
    for (const fetcher of [provider(B), provider(A, "EXPIRED")]) {
      const s = await receipt();
      await expect(completeComposio(session(), "github", { state: s.state, status: "success", accountId: "ca_test" }, fetcher)).rejects.toThrow();
    }
    const bindings = new FileConnectorBindingStore(config.installationId, config.paths.dataRoot);
    await expect(bindings.readPersonalForManagement({ installationId: config.installationId, userId: A, roleId: null }, "composio-github")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("blocks unavailable user connections, mismatched turns, policy revocation and unreviewed tools", async () => {
    const fetcher = provider(); await connect(fetcher); fetcher.mockClear();
    const context = { config, installationId: config.installationId, userId: A, runtimeThreadId: "thread", runtimeTurnId: "turn", selectedIds: [], fetcher };
    const call = { namespace: COMPOSIO_NAMESPACE, tool: "read", threadId: "thread", turnId: "turn", callId: "call", arguments: { toolkit: "github", tool: "GITHUB_TEST_READ", arguments: {} } };
    expect(await handleComposioTool(call, context)).toEqual({ success: false, contentItems: [{ type: "inputText", text: JSON.stringify("Composio connection is not available or verified for this user.") }] });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await handleComposioTool({ ...call, turnId: "other" }, { ...context, selectedIds: ["composio-github"] })).success).toBe(false);
    expect((await handleComposioTool(call, { ...context, selectedIds: ["composio-github"] })).success).toBe(true);
    expect(fetcher.mock.calls.some(([, init]) => init?.body && JSON.parse(String(init.body)).connected_account_id === "ca_test")).toBe(true);
    await expect(composioReadTool(config, A, "github", "GITHUB_DELETE_REPOSITORY", {}, fetcher)).rejects.toMatchObject({ code: "COMPOSIO_TOOL_DENIED" });
    state.allowed = false; fetcher.mockClear();
    await expect(composioReadTool(config, A, "github", "GITHUB_TEST_READ", {}, fetcher)).rejects.toMatchObject({ code: "COMPOSIO_CATALOG_DENIED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("blocks local use on failed revoke, supports retry, and reconnects with an increased binding version", async () => {
    await connect();
    expect(await disconnectComposio(session(), "github", provider(A, "ACTIVE", true))).toMatchObject({ providerRevoked: false });
    await expect(composioReadTool(config, A, "github", "GITHUB_TEST_READ", {}, provider())).rejects.toThrow();
    expect(await disconnectComposio(session(), "github", provider())).toMatchObject({ providerRevoked: true });
    await connect(); expect(await composioCapability(config, A, "github", provider())).toMatchObject({ status: "connected", connectionVersion: 3 });
  });
  it("rejects account substitution and auth-config drift before binding", async () => {
    const s = await receipt(); const changed = { ...config, connectors: { composio: { toolkits: [{ ...toolkit, authConfigId: "ac_other" }] } } };
    state.config = changed;
    await expect(completeComposio(session(), "github", { state: s.state, status: "success", accountId: "ca_test" }, provider())).rejects.toMatchObject({ code: "COMPOSIO_CALLBACK_INVALID" });
    expect(composioUserId("another-company", A)).not.toBe(composioUserId("company-qa", A));
    await expect(new ComposioApi("synthetic", provider(B)).account(toolkit, composioUserId("company-qa", A), "ca_test")).rejects.toMatchObject({ code: "COMPOSIO_ACCOUNT_IDENTITY_MISMATCH" });
  });
});
