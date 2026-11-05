import { expect, it, vi } from "vitest";
import { nativeAppToolsForTurn } from "./native-app-tools";
import { connectedAppConfig, markConnectedAppConfigApplied, previousConnectedAppPolicies } from "./connected-app-config";
import { CatalogRuntimeEnforcer } from "@/catalog/runtime-enforcement";
import type { CatalogState, CatalogPrincipal } from "@/catalog/contracts";
const state: CatalogState = { schemaVersion: 1, installationId: "company", revision: 1,
  resources: [{ id: "mail", kind: "app", label: "Mail", appId: "native_mail", mcp: null, connectorId: null,
    credentialMode: "personal-oauth", sharedResource: false, managedBy: "company" }],
  rules: [{ id: "rule", scope: "installation", subjectId: null, resourceId: "mail", effect: "allow", operations: ["read"] }] };
const principal: CatalogPrincipal = { installationId: "company", userId: "00000000-0000-4000-8000-000000000001",
  roleId: "workspace-member", groupIds: [], workspaceCanExecute: true };
const tools = [{ name: "messages/read", isEnabled: true, isReadOnly: true }, { name: "messages/send", isEnabled: true, isReadOnly: false },
  { name: "disabled", isEnabled: false, isReadOnly: true }, { name: "unknown", isEnabled: true }];
const known = tools.map(tool => tool.name).sort();
const writable: CatalogState = { ...state, rules: [{ ...state.rules[0], operations: ["read", "write"] }] };
function fixture(metadata: unknown = { apps: [{ id: "native_mail", toolSummaries: tools }] }, apps: unknown = {}) {
  return { request: vi.fn(async (method: string, _params?: unknown) => method === "config/read" ? { config: { apps } }
    : method === "app/installed" ? { apps: [{ id: "native_mail", enabled: true, callable: true }] } : metadata) };
}

it("accepts native slash tool names while requiring current grants and explicit turn write permission", async () => {
  const transport = fixture();
  expect(await nativeAppToolsForTurn(transport, async () => new CatalogRuntimeEnforcer(state, principal), ["native_mail"], "tools", true))
    .toEqual({ native_mail: { allowed: ["messages/read"], known } });
  expect(await nativeAppToolsForTurn(transport, async () => new CatalogRuntimeEnforcer(writable, principal), ["native_mail"], "tools", true))
    .toEqual({ native_mail: { allowed: ["messages/read", "messages/send"], known } });
  expect(await nativeAppToolsForTurn(transport, async () => new CatalogRuntimeEnforcer(writable, principal), ["native_mail"], "tools"))
    .toEqual({ native_mail: { allowed: ["messages/read"], known } });
  expect(await nativeAppToolsForTurn(transport, async () => new CatalogRuntimeEnforcer(writable, { ...principal, workspaceCanExecute: false }), ["native_mail"], "tools", true))
    .toEqual({ native_mail: { allowed: ["messages/read"], known } });
});

it("clears inherited tool enables and previous apps missing from native metadata", async () => {
  const transport = fixture(undefined, { native_mail: { enabled: true, tools: { "legacy/send": { enabled: true } } },
    foreign: { enabled: true, tools: { "files/read": { enabled: true } } } });
  const policies = await nativeAppToolsForTurn(transport, async () => new CatalogRuntimeEnforcer(state, principal), ["native_mail"], "tools");
  expect(policies.foreign).toEqual({ allowed: [], known: ["files/read"] });
  expect(policies.native_mail.known).toContain("legacy/send");
  expect(connectedAppConfig(["native_mail"], policies).apps).toMatchObject({
    native_mail: { tools: { "messages/read": { enabled: true }, "messages/send": { enabled: false }, "legacy/send": { enabled: false } } },
    foreign: { enabled: false, tools: { "files/read": { enabled: false } } },
  });
});

it("disables a previously connected app after read grant revocation", async () => {
  const transport = fixture(undefined, { native_mail: { enabled: true, tools: { "messages/send": { enabled: true } } } });
  const policies = await nativeAppToolsForTurn(transport, async () => new CatalogRuntimeEnforcer({ ...writable, rules: [] }, principal), ["native_mail"], "tools", true);
  expect(policies).toEqual({ native_mail: { allowed: [], known: ["messages/send"] } });
  expect(connectedAppConfig(["native_mail"], policies).apps).toMatchObject({ native_mail: { enabled: false, tools: { "messages/send": { enabled: false } } } });
});

it("does not enable ambiguous apps, duplicate tools or incomplete descriptors", async () => {
  const transport = fixture({ apps: [{ id: "native_mail", toolSummaries: [tools[0], tools[0], tools[3]] }] });
  const resolve = async () => new CatalogRuntimeEnforcer(state, principal);
  expect(await nativeAppToolsForTurn(transport, resolve, ["native_mail"], "tools"))
    .toEqual({ native_mail: { allowed: [], known: ["messages/read", "unknown"] } });
  transport.request.mockImplementation(async method => method === "config/read" ? { config: { apps: {} } }
    : method === "app/installed" ? { apps: [{ id: "native_mail", enabled: true, callable: true }] }
    : { apps: [{ id: "native_mail", toolSummaries: tools }, { id: "native_mail", toolSummaries: tools }] });
  expect(await nativeAppToolsForTurn(transport, resolve, ["native_mail"], "tools")).toEqual({ native_mail: { allowed: [], known: [] } });
});

it("isolates metadata failure with safe negatives while ordinary chat can continue", async () => {
  const transport = fixture(undefined, { native_mail: { tools: { "messages/send": { enabled: true } } } });
  const original = transport.request.getMockImplementation()!;
  transport.request.mockImplementation(async method => {
    if (method === "app/read") throw new Error("private provider metadata failure");
    return original(method);
  });
  const policies = await nativeAppToolsForTurn(transport, async () => new CatalogRuntimeEnforcer(state, principal), ["native_mail"], "tools");
  expect(policies).toEqual({ native_mail: { allowed: [], known: ["messages/send"] } });
  expect(connectedAppConfig(["native_mail"], policies).apps).toMatchObject({ native_mail: { enabled: false, tools: { "messages/send": { enabled: false } } } });
});

it("reads complete committed runtime IDs with no permitted apps and disables the feature if inventory is unavailable", async () => {
  const transport = fixture(undefined, { foreign: { enabled: true, tools: { "files/read": { enabled: true } } } });
  expect(await nativeAppToolsForTurn(transport, async () => new CatalogRuntimeEnforcer(state, principal), [], "tools"))
    .toEqual({ native_mail: { allowed: [], known: [] }, foreign: { allowed: [], known: ["files/read"] } });
  expect(transport.request).toHaveBeenCalledWith("app/installed", { forceRefresh: false }, "tools:installed", 10_000);
  expect(transport.request.mock.calls.some(([method]) => method === "app/read")).toBe(false);
  transport.request.mockResolvedValue({});
  const unknown = await nativeAppToolsForTurn(transport, async () => new CatalogRuntimeEnforcer(state, principal), [], "tools");
  expect(connectedAppConfig([], unknown)).toMatchObject({ "features.apps": false });
});

it("clears a thread-only app even after it disappears from both base configuration and runtime inventory", async () => {
  const client = {};
  markConnectedAppConfigApplied(client, "thread", ["qa-files"], {}, { "qa-files": { allowed: ["files/read"], known: ["files/read"] } });
  const transport = fixture();
  transport.request.mockImplementation(async method => method === "config/read" ? { config: { apps: {} } } : { apps: [] });
  const policies = await nativeAppToolsForTurn(transport, async () => new CatalogRuntimeEnforcer(state, principal), [], "tools", false,
    previousConnectedAppPolicies(client, "thread"));
  expect(connectedAppConfig([], policies)).toMatchObject({ "features.apps": false,
    apps: { "qa-files": { enabled: false, tools: { "files/read": { enabled: false } } } } });
});

it("cold recovery disables revoked installed IDs without reading their provider metadata", async () => {
  const transport = fixture();
  transport.request.mockImplementation(async method => method === "config/read" ? { config: { apps: {} } }
    : method === "app/installed" ? { apps: [{ id: "native_mail", enabled: true, callable: true }, { id: "revoked-app", enabled: true, callable: true }] }
      : { apps: [{ id: "native_mail", toolSummaries: tools }] });
  const policies = await nativeAppToolsForTurn(transport, async () => new CatalogRuntimeEnforcer(state, principal), ["native_mail"], "tools");
  expect(connectedAppConfig(["native_mail"], policies).apps).toMatchObject({
    "revoked-app": { enabled: false }, native_mail: { enabled: true },
  });
  const metadata = transport.request.mock.calls.filter(([method]) => method === "app/read");
  expect(metadata).toHaveLength(1);
  expect(metadata[0][1]).toEqual({ appIds: ["native_mail"], includeTools: true });
});
