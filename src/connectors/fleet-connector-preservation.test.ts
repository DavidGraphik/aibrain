import { beforeEach, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { CatalogResource, CatalogState } from "@/catalog/contracts";

const mocked = vi.hoisted(() => ({
  installationId: "insijets-demo", resources: [] as CatalogResource[],
  internal: [] as CatalogResource[],
  instantlyFails: false,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => ({
  installationId: mocked.installationId, paths: { dataRoot: "/synthetic/fleet" },
  connectors: { instantly: { enabled: true } },
}) }));
vi.mock("@/admin/policy-service", () => ({ workspacePolicyForIdentity: async () => ({
  roleId: "workspace-member", groups: [], policy: { capabilities: { execute: true } },
}) }));
vi.mock("@/catalog/store", () => ({ FileCatalogStore: class {} }));
vi.mock("@/catalog/baseline", () => ({ ensureInstallationCatalog: async () => ({
  schemaVersion: 1, installationId: mocked.installationId, revision: 1,
  resources: mocked.resources, rules: mocked.resources.map(resource => ({
    id: `allow-${resource.id}`, resourceId: resource.id, scope: "installation",
    subjectId: null, effect: "allow", operations: ["read"],
  })),
}) satisfies CatalogState }));
vi.mock("@/g03-products/connectors", () => ({ internalConnectorsForIdentity: async () => mocked.internal }));
vi.mock("@/connectors/server-service", () => ({ codexManagedAppCapabilities: async () => [] }));
vi.mock("@/connectors/modtime-reporting", () => ({ MODTIME_REPORTING_RESOURCES: [], modtimeReportingCapabilities: async () => [] }));
vi.mock("@/connectors/composio-service", () => ({ composioCapabilitiesForSession: async () => [], composioCapability: async () => null }));
vi.mock("@/connectors/native-connection-health", () => ({ nativeConnectionHealthForIdentity: async () => new Map() }));
vi.mock("@/connectors/trinalum-capabilities", () => ({ trinalumConnectorHealth: async () => new Map([
  ["trinalum-sibema", { status: "connected", statusCode: null }],
]) }));
vi.mock("@/connectors/company-mail-server-service", () => ({
  companyMailCapabilityForSession: async () => ({ connectorId: "company-mail", status: "connected", statusCode: null }),
  companyMailAccessForIdentity: async () => ({}),
}));
vi.mock("@/connectors/instantly-service", () => ({ instantlyCapability: async () => {
  if (mocked.instantlyFails) throw new Error("provider unavailable");
  return { connectorId: "instantly", status: "connected", statusCode: null };
} }));
vi.mock("@/connectors/gmail-server-service", () => ({
  gmailCapabilityForSession: async () => ({ connectorId: "gmail", status: "not_configured", statusCode: "GMAIL_NOT_ENABLED" }),
  gmailAccessForIdentity: async () => { throw new Error("NO_GMAIL_BINDING"); },
}));
vi.mock("@/connectors/outlook-server-service", () => ({
  outlookCapabilityForSession: async () => ({ connectorId: "outlook", status: "not_configured", statusCode: "OUTLOOK_NOT_ENABLED" }),
  outlookAccessForIdentity: async () => { throw new Error("NO_OUTLOOK_BINDING"); },
}));

import { resolveAvailableConnectorsForTurn } from "./mentions";
import { connectorMentionDeveloperInstructions, projectConnectorMention } from "./mentions-contract";

const USER = "00000000-0000-4000-8000-000000000001";
const resource = (id: string, credentialMode: CatalogResource["credentialMode"] = "personal-credential"): CatalogResource => ({
  id, kind: "connector", label: id, credentialMode, managedBy: "company",
  sharedResource: false, appId: null, connectorId: id, mcp: null,
});
const session = (): AuthSession => ({
  provider: "local", tenant: { id: mocked.installationId, name: "Synthetic fleet" },
  user: { id: USER, name: "Actor", email: "actor@example.test" }, expiresAt: "2099-01-01T00:00:00.000Z",
});
beforeEach(() => {
  mocked.installationId = "insijets-demo";
  mocked.resources = [resource("company-mail"), resource("instantly")];
  mocked.internal = [];
  mocked.instantlyFails = false;
});

it("automatically retains company mail and Instantly without composer selection", async () => {
  const result = await resolveAvailableConnectorsForTurn(mocked.installationId, USER, [], session());
  expect(result.map(row => row.resource.id)).toEqual(["company-mail", "instantly"]);
  expect(connectorMentionDeveloperInstructions(result)).toContain('"toolNamespace":"aibrain_instantly"');
  expect(connectorMentionDeveloperInstructions(result)).toContain('"toolNamespace":"aibrain_company_mail"');
});

it.each([true, false])("keeps company mail callable when Instantly health fails (session=%s)", async withSession => {
  mocked.instantlyFails = true;
  const result = await resolveAvailableConnectorsForTurn(mocked.installationId, USER, [], withSession ? session() : undefined);
  expect(result.map(row => row.resource.id)).toEqual(["company-mail"]);
});

it("preserves Trinalum scoped broker discovery without enabling Sage", async () => {
  mocked.installationId = "trinalum-production";
  mocked.resources = [resource("trinalum-sibema", "shared-resource"), resource("g03-sage", "none")];
  const result = await resolveAvailableConnectorsForTurn(mocked.installationId, USER, [], session());
  expect(result.map(row => row.resource.id)).toEqual(["trinalum-sibema"]);
  expect(connectorMentionDeveloperInstructions(result)).toContain('"toolNamespace":"trinalum_business"');
});

it("retains per-identity G03 production and department dispatch metadata", async () => {
  mocked.installationId = "g03-production";
  mocked.resources = [resource("g03-sage", "none")];
  mocked.internal = [resource("g03-production", "none"), resource("g03-app-planning", "none")];
  const result = await resolveAvailableConnectorsForTurn(mocked.installationId, USER, [], session());
  expect(result.map(row => row.resource.id)).toEqual(["g03-app-planning", "g03-production"]);
  const instructions = connectorMentionDeveloperInstructions(result);
  expect(instructions).toContain('"toolNamespace":"aibrain_g03_production"');
  expect(instructions).toContain('"readArguments":{"id":"planning","published":true}');
});

it("never presents the unprovisioned G03 Sage tile as usable without health metadata", () => {
  expect(projectConnectorMention(resource("g03-sage", "none"), new Map())).toMatchObject({
    canRead: false, status: "admin_setup_required", statusCode: "G03_SAGE_API_PENDING",
  });
});
