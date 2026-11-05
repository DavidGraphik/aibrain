import { expect, it, vi } from "vitest";
import { nativeAppToolsForTurn } from "./native-app-tools";
import { connectedAppConfig } from "./connected-app-config";
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
  return { request: vi.fn(async (method: string) => method === "config/read" ? { config: { apps } } : metadata) };
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

it("reads previous config with no allowed apps and fails closed if the snapshot is unavailable", async () => {
  const transport = fixture(undefined, { foreign: { enabled: true, tools: { "files/read": { enabled: true } } } });
  expect(await nativeAppToolsForTurn(transport, async () => new CatalogRuntimeEnforcer(state, principal), [], "tools"))
    .toEqual({ foreign: { allowed: [], known: ["files/read"] } });
  expect(transport.request).toHaveBeenCalledExactlyOnceWith("config/read", { includeLayers: false }, "tools:config", 10_000);
  transport.request.mockResolvedValue({});
  await expect(nativeAppToolsForTurn(transport, async () => new CatalogRuntimeEnforcer(state, principal), [], "tools")).rejects.toThrow("NATIVE_APP_CONFIG_UNAVAILABLE");
});
