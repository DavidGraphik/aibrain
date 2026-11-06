import { beforeEach, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { CatalogResource, CatalogRule, CatalogState } from "@/catalog/contracts";
import type { InstallationConfig } from "@/config/installation-schema";

const mocked = vi.hoisted(() => ({
  config: null as unknown,
  catalog: null as unknown,
  roleId: "workspace-member",
  health: [] as Array<{ connectorId: string; status: string; statusCode: string | null }>,
  loadConfig: vi.fn(), workspace: vi.fn(), capabilities: vi.fn(),
  nativeHealth: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: mocked.loadConfig }));
vi.mock("@/admin/policy-service", () => ({ workspacePolicyForIdentity: mocked.workspace }));
vi.mock("@/catalog/store", () => ({ FileCatalogStore: class {} }));
vi.mock("@/catalog/baseline", () => ({ ensureInstallationCatalog: vi.fn(async () => mocked.catalog) }));
vi.mock("@/connectors/server-service", () => ({ codexManagedAppCapabilities: vi.fn(async () => []) }));
vi.mock("@/connectors/native-connection-health", () => ({ nativeConnectionHealthForIdentity: mocked.nativeHealth }));
vi.mock("@/connectors/modtime-reporting", () => ({ MODTIME_REPORTING_RESOURCES: [], modtimeReportingCapabilities: vi.fn(async () => []) }));
vi.mock("@/connectors/composio-service", () => ({
  composioCapabilitiesForSession: mocked.capabilities,
  composioCapability: vi.fn(async (_config: unknown, _userId: string, slug: string) => mocked.health.find(row => row.connectorId === `composio-${slug}`)),
}));
vi.mock("@/connectors/gmail-server-service", () => ({
  gmailCapabilityForSession: vi.fn(async () => mocked.health.find(row => row.connectorId === "gmail") ?? { connectorId: "gmail", status: "not_configured", statusCode: "GMAIL_NOT_ENABLED" }),
  gmailAccessForIdentity: vi.fn(async () => { throw new Error("NO_GMAIL_BINDING"); }),
}));
vi.mock("@/connectors/outlook-server-service", () => ({
  outlookCapabilityForSession: vi.fn(async () => mocked.health.find(row => row.connectorId === "outlook") ?? { connectorId: "outlook", status: "not_configured", statusCode: "OUTLOOK_NOT_ENABLED" }),
  outlookAccessForIdentity: vi.fn(async () => { throw new Error("NO_OUTLOOK_BINDING"); }),
}));

// Keep the catalog resolver unmocked: its real tenant, user and role rules decide
// visibility, independently of the synthetic provider connection snapshots.
import { resolveAvailableConnectorsForTurn } from "./mentions";

const INSTALLATION = "test-company";
const USER = "00000000-0000-4000-8000-000000000001";
const OTHER_USER = "00000000-0000-4000-8000-000000000002";
const session: AuthSession = {
  provider: "local", tenant: { id: INSTALLATION, name: "Test Company" },
  user: { id: USER, name: "Test User", email: "actor@example.test" },
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const resource = (id: string): CatalogResource => ({
  id, kind: "connector", label: id, credentialMode: "personal-oauth", managedBy: "company",
  sharedResource: false, appId: null, connectorId: id, mcp: null,
});
const grant = (id: string, scope: CatalogRule["scope"] = "installation", subjectId: string | null = null): CatalogRule => ({
  id: `rule-${id}`, resourceId: id, scope, subjectId, effect: "allow", operations: ["read"],
});
function setResources(resources: CatalogResource[], rules = resources.map(row => grant(row.id))) {
  mocked.catalog = { schemaVersion: 1, installationId: INSTALLATION, revision: 1, resources, rules } satisfies CatalogState;
  mocked.health = resources.map(row => ({ connectorId: row.connectorId!, status: "connected", statusCode: null }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.roleId = "workspace-member";
  mocked.config = {
    schemaVersion: 1, installationId: INSTALLATION, companyName: "Test Company", companySlug: INSTALLATION,
    publicUrl: "https://company.example.test", branding: { productName: "Test Brain", logoPath: "/brand.svg", faviconPath: "/favicon.ico", accentColor: "#123456" },
    paths: { dataRoot: "/synthetic/data", companyContextRoot: "/synthetic/company", usersRoot: "/synthetic/users", sourceReadRoot: "/synthetic/source", publishWriteRoot: "/synthetic/publish", backupsRoot: "/synthetic/backups" },
  } satisfies InstallationConfig;
  mocked.loadConfig.mockImplementation(async () => mocked.config);
  mocked.workspace.mockImplementation(async () => ({ roleId: mocked.roleId, groups: [], policy: { capabilities: { execute: true } } }));
  mocked.capabilities.mockImplementation(async () => mocked.health.filter(row => row.connectorId.startsWith("composio-")));
  mocked.nativeHealth.mockResolvedValue(new Map());
  setResources([resource("gmail"), resource("outlook")]);
});

it("blocks unknown native readiness but allows ordinary tasks with authoritative disabled or absent apps", async () => {
  const native = { ...resource("native-mail"), kind: "app" as const, connectorId: null, appId: "connector_own" };
  setResources([native]);
  mocked.nativeHealth.mockResolvedValue(new Map([[native.id, { status: "degraded", statusCode: "NATIVE_APP_READINESS_UNAVAILABLE" }]]));
  await expect(resolveAvailableConnectorsForTurn(INSTALLATION, USER, [], session)).rejects.toMatchObject({ code: "NATIVE_APP_READINESS_UNAVAILABLE" });
  for (const statusCode of ["NATIVE_APP_DISABLED", "NATIVE_APP_NOT_LISTED"]) {
    mocked.nativeHealth.mockResolvedValue(new Map([[native.id, { status: "not_configured", statusCode }]]));
    expect(await resolveAvailableConnectorsForTurn(INSTALLATION, USER, [], session)).toEqual([]);
  }
  expect(mocked.nativeHealth).toHaveBeenCalledWith(INSTALLATION, USER, [native], new Set());
});

it("makes connected personal resources available with no composer hints", async () => {
  const result = await resolveAvailableConnectorsForTurn(INSTALLATION, USER, undefined, session);
  expect(result.map(row => row.resource.id)).toEqual(["gmail", "outlook"]);
  expect(result.every(row => row.mention.canRead && row.mention.status === "connected")).toBe(true);
  expect(mocked.workspace).toHaveBeenCalledWith(INSTALLATION, USER, mocked.config);
  expect(mocked.capabilities).toHaveBeenCalledWith(session);
});

it("treats a valid hint as optional context without restricting the other connected resources", async () => {
  const result = await resolveAvailableConnectorsForTurn(INSTALLATION, USER, ["gmail"], session);
  expect(result.map(row => row.resource.id)).toEqual(["gmail", "outlook"]);
});

it("does not apply the twenty-hint bound to the automatic connection inventory", async () => {
  const resources = Array.from({ length: 32 }, (_, index) => resource(`composio-app-${String(index).padStart(2, "0")}`));
  setResources(resources);
  const result = await resolveAvailableConnectorsForTurn(INSTALLATION, USER, [], session);
  expect(result).toHaveLength(32);
  expect(result.map(row => row.resource.id)).toEqual(resources.map(row => row.id));
  expect(await resolveAvailableConnectorsForTurn(INSTALLATION, USER, [resources[0].id], session)).toHaveLength(32);
});

it("keeps healthy providers available when another provider's health check fails", async () => {
  setResources([resource("gmail"), resource("composio-files")]);
  mocked.capabilities.mockRejectedValueOnce(new Error("provider temporarily unavailable"));
  expect((await resolveAvailableConnectorsForTurn(INSTALLATION, USER, [], session)).map(row => row.resource.id))
    .toEqual(["gmail"]);
});

it("excludes a disconnected personal binding and rejects a stale hint to it", async () => {
  mocked.health.find(row => row.connectorId === "outlook")!.status = "reauth_required";
  expect((await resolveAvailableConnectorsForTurn(INSTALLATION, USER, [], session)).map(row => row.resource.id)).toEqual(["gmail"]);
  await expect(resolveAvailableConnectorsForTurn(INSTALLATION, USER, ["outlook"], session))
    .rejects.toMatchObject({ code: "CONNECTOR_MENTION_NOT_CONNECTED" });
});

it("rejects another session tenant or account before catalog or capability access", async () => {
  for (const foreign of [{ ...session, tenant: { ...session.tenant, id: "foreign-company" } },
    { ...session, user: { ...session.user, id: OTHER_USER } }]) {
    await expect(resolveAvailableConnectorsForTurn(INSTALLATION, USER, [], foreign))
      .rejects.toMatchObject({ code: "CONNECTOR_MENTION_IDENTITY_MISMATCH" });
  }
  expect(mocked.loadConfig).not.toHaveBeenCalled();
  expect(mocked.workspace).not.toHaveBeenCalled();
  expect(mocked.capabilities).not.toHaveBeenCalled();
});

it("uses real catalog user and role rules so another account's resources stay invisible", async () => {
  const resources = [resource("composio-public"), resource("composio-owner"), resource("composio-other-user")];
  setResources(resources, [grant(resources[0].id), grant(resources[1].id, "role", "workspace-owner"), grant(resources[2].id, "user", OTHER_USER)]);
  expect((await resolveAvailableConnectorsForTurn(INSTALLATION, USER, [], session)).map(row => row.resource.id)).toEqual(["composio-public"]);
  await expect(resolveAvailableConnectorsForTurn(INSTALLATION, USER, ["composio-other-user"], session))
    .rejects.toMatchObject({ code: "CONNECTOR_MENTION_DENIED" });
  mocked.roleId = "workspace-owner";
  expect((await resolveAvailableConnectorsForTurn(INSTALLATION, USER, [], session)).map(row => row.resource.id)).toEqual(["composio-owner", "composio-public"]);
});

it("cannot discover resources from another catalog tenant even when provider snapshots say connected", async () => {
  (mocked.catalog as CatalogState).installationId = "foreign-company";
  expect(await resolveAvailableConnectorsForTurn(INSTALLATION, USER, [], session)).toEqual([]);
  await expect(resolveAvailableConnectorsForTurn(INSTALLATION, USER, ["gmail"], session))
    .rejects.toMatchObject({ code: "CONNECTOR_MENTION_DENIED" });
});
