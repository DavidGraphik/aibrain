import "server-only";

import type { AuthSession } from "@/auth/types";
import { workspacePolicyForIdentity } from "@/admin/policy-service";
import { FileCatalogStore } from "@/catalog/store";
import { CatalogEnforcedTransport, type CatalogRuntimeTransport } from "@/catalog/runtime-enforcement";
import type { CatalogCommand } from "@/catalog/contracts";
import { catalogRuntimeEnforcer } from "@/catalog/access-service";
import { loadInstallationConfig } from "@/config/installation";
import { workerAppServerForUser } from "@/runtime/worker-runtime-service";
import {
  FileCompanySkillPackageStore,
  readVersionedSkillPackage,
} from "@/catalog/skill-packages";
import { ensureInstallationCatalog } from "@/catalog/baseline";
import { managedSkillsForInstallation } from "@/catalog/managed-skills";

export class CatalogAdminError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); this.name = "CatalogAdminError"; }
}

async function catalogContext(session: AuthSession) {
  const installation = await loadInstallationConfig();
  if (session.tenant.id !== installation.installationId) throw new CatalogAdminError("CATALOG_TENANT_MISMATCH", "La sesión no pertenece a esta instalación.", 403);
  const workspace = await workspacePolicyForIdentity(installation.installationId, session.user.id, installation);
  if (!workspace.role.canManageWorkspace) throw new CatalogAdminError("CATALOG_ADMIN_REQUIRED", "Solo GraphikAI o un administrador del workspace puede gestionar el catálogo.", 403);
  const store = new FileCatalogStore(installation.installationId, installation.paths.dataRoot);
  await ensureInstallationCatalog(store, installation);
  return { installation, workspace, store };
}

export async function catalogSnapshot(session: AuthSession) {
  const { installation, store } = await catalogContext(session);
  const packageStore = new FileCompanySkillPackageStore(installation.installationId, installation.paths.dataRoot);
  const [companyPackages, packageAudit, managedPackages] = await Promise.all([
    packageStore.read(),
    packageStore.auditLog(100),
    Promise.all(managedSkillsForInstallation(installation).map(async ({ id }) => {
      const skill = await readVersionedSkillPackage(`${process.cwd()}/skills`, id);
      return { ...skill.manifest, digest: skill.digest, source: skill.source };
    })),
  ]);
  return {
    schemaVersion: 1,
    installationId: installation.installationId,
    state: await store.read(),
    packages: [
      ...managedPackages.map((skill) => ({ ...skill, status: "active" as const })),
      ...companyPackages.packages.map(({ package: skill, status, revision, updatedAt, updatedBy }) => ({ ...skill.manifest, digest: skill.digest, source: skill.source, status, revision, updatedAt, updatedBy })),
    ],
    audit: [...await store.auditLog(100), ...packageAudit]
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, 100),
  };
}

export async function executeCatalogCommand(session: AuthSession, command: CatalogCommand) {
  const { installation, store } = await catalogContext(session);
  if (command.action === "upsert-skill-package") {
    const packageStore = new FileCompanySkillPackageStore(installation.installationId, installation.paths.dataRoot);
    const result = await packageStore.upsert(session.user.id, command.package);
    const current = await store.read();
    const existing = current.resources.find((resource) => resource.id === command.package.id);
    if (existing?.managedBy === "graphikai") {
      throw new CatalogAdminError("CATALOG_MANAGED_RESOURCE", "Una skill base de GraphikAI no puede sustituirse desde la empresa.", 409);
    }
    if (!existing || existing.kind !== "skill" || existing.label !== command.package.label) {
      await store.mutate(session.user.id, (state) => {
        const resource = state.resources.find((candidate) => candidate.id === command.package.id);
        const next = { id: command.package.id, kind: "skill" as const, label: command.package.label, credentialMode: "none" as const, managedBy: "company" as const, sharedResource: false, appId: null, connectorId: null, mcp: null };
        if (resource) Object.assign(resource, next); else state.resources.push(next);
        return { action: "catalog.resource-upserted" as const, targetId: command.package.id, summary: `Paquete de skill ${command.package.id} registrado.` };
      });
    }
    return { schemaVersion: 1, changed: result.changed, record: result.record, snapshot: await catalogSnapshot(session) };
  }
  if (command.action === "revoke-skill-package") {
    const packageStore = new FileCompanySkillPackageStore(installation.installationId, installation.paths.dataRoot);
    const result = await packageStore.revoke(session.user.id, command.skillId);
    return { schemaVersion: 1, changed: result.changed, record: result.record, snapshot: await catalogSnapshot(session) };
  }
  const state = await store.mutate(session.user.id, (current) => {
    if (command.action === "upsert-resource") {
      const existing = current.resources.find((resource) => resource.id === command.resource.id);
      if (existing?.managedBy === "graphikai") {
        throw new CatalogAdminError("CATALOG_MANAGED_RESOURCE", "Los recursos base de GraphikAI solo se gestionan desde la configuración de instalación.", 409);
      }
      if (existing) Object.assign(existing, structuredClone(command.resource));
      else current.resources.push(structuredClone(command.resource));
      return { action: "catalog.resource-upserted" as const, targetId: command.resource.id, summary: `Recurso de catálogo ${command.resource.id} actualizado.` };
    }
    if (!current.resources.some((resource) => resource.id === command.rule.resourceId)) {
      throw new CatalogAdminError("CATALOG_RESOURCE_NOT_FOUND", "El recurso indicado no existe en el catálogo.", 404);
    }
    const existing = current.rules.find((rule) => rule.id === command.rule.id);
    if (existing) Object.assign(existing, structuredClone(command.rule));
    else current.rules.push(structuredClone(command.rule));
    return { action: "catalog.rule-set" as const, targetId: command.rule.id, summary: `Regla de catálogo ${command.rule.id} actualizada.` };
  });
  return { schemaVersion: 1, state, audit: await store.auditLog(1) };
}

export { catalogRuntimeEnforcer } from "@/catalog/access-service";

/** The only server-side route from a worker client to app/MCP inventories. */
export async function catalogTransportForUser(installationId: string, userId: string): Promise<CatalogRuntimeTransport> {
  const client = (await workerAppServerForUser(userId)).client;
  return new CatalogEnforcedTransport(client, await catalogRuntimeEnforcer(installationId, userId));
}
