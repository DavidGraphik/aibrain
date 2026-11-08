import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseInstallationConfig } from "@/config/installation-schema";
import { FileConnectorBindingStore } from "@/connectors/binding-store";
import { INSTANTLY_CREDENTIAL_REF } from "@/connectors/instantly-contracts";
import { instantlyReadForIdentity } from "@/connectors/instantly-service";

const access = vi.hoisted(() => ({ allowed: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/catalog/access-service", () => ({ catalogRuntimeEnforcer: vi.fn(async () => ({ allowsConnector: () => access.allowed })) }));
const roots: string[] = [];
afterEach(async () => { access.allowed = true; vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("rechecks catalog grants and personal revocation before using a shared key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "instantly-access-")); roots.push(root);
  const fixture = JSON.parse(await readFile("config/installations/development.example.json", "utf8"));
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const config = parseInstallationConfig({ ...fixture, paths: { ...fixture.paths, dataRoot: root, companyContextRoot: path.join(root, "company-context"), usersRoot: path.join(root, "users"), backupsRoot: path.join(root, "backups") }, connectors: { instantly: { enabled: true, workspaceId } } });
  const user = "22222222-2222-4222-8222-222222222222";
  const binding = { schemaVersion: 1 as const, installationId: config.installationId, connectorId: "instantly", userId: null, credentialRef: INSTANTLY_CREDENTIAL_REF, scopes: ["instantly:read"], status: "active" as const, version: 1 };
  const store = new FileConnectorBindingStore(config.installationId, root);
  await store.put(binding);
  vi.stubEnv("AIBRAIN_INSTANTLY_API_KEY", "private-test-key");
  const fetcher = vi.fn(async () => Response.json({ id: workspaceId, name: "Workspace" }));
  await expect(instantlyReadForIdentity(config, user, "workspace", {}, fetcher)).resolves.toMatchObject({ workspaceId });
  access.allowed = false;
  await expect(instantlyReadForIdentity(config, user, "workspace", {}, fetcher)).rejects.toMatchObject({ code: "INSTANTLY_CATALOG_DENIED" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  access.allowed = true;
  await store.put({ ...binding, userId: user, status: "revoked" });
  await expect(instantlyReadForIdentity(config, user, "workspace", {}, fetcher)).rejects.toMatchObject({ code: "INSTANTLY_BINDING_INVALID" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(instantlyReadForIdentity(config, "33333333-3333-4333-8333-333333333333", "workspace", {}, fetcher)).resolves.toMatchObject({ workspaceId });
});

it("requires an enabled installation and never sends a missing credential", async () => {
  const fixture = JSON.parse(await readFile("config/installations/development.example.json", "utf8"));
  const config = parseInstallationConfig(fixture);
  const fetcher = vi.fn();
  await expect(instantlyReadForIdentity(config, "22222222-2222-4222-8222-222222222222", "workspace", {}, fetcher)).rejects.toMatchObject({ code: "INSTANTLY_NOT_CONFIGURED" });
  expect(fetcher).not.toHaveBeenCalled();
});
