import "server-only";

import { workspacePolicyForIdentity } from "@/admin/policy-service";
import type { CatalogPrincipal } from "@/catalog/contracts";
import { CatalogRuntimeEnforcer } from "@/catalog/runtime-enforcement";
import { FileCatalogStore } from "@/catalog/store";
import { loadInstallationConfig } from "@/config/installation";
import { skillProvenanceInstructions, synchronizeEffectiveSkills } from "@/catalog/skill-packages";
import { ensureInstallationCatalog } from "@/catalog/baseline";

async function catalogAccessContext(installationId: string, userId: string) {
  const installation = await loadInstallationConfig();
  if (installation.installationId !== installationId) throw new Error("Catalog installation mismatch.");
  const effective = await workspacePolicyForIdentity(installationId, userId, installation);
  const principal: CatalogPrincipal = {
    installationId, userId, roleId: effective.roleId, groupIds: effective.groups.map(({ id }) => id),
    workspaceCanExecute: effective.policy.capabilities.execute,
  };
  const store = new FileCatalogStore(installationId, installation.paths.dataRoot);
  const state = await ensureInstallationCatalog(store, installation);
  return { installation, principal, state };
}

export async function catalogRuntimeEnforcer(installationId: string, userId: string) {
  const { state, principal } = await catalogAccessContext(installationId, userId);
  return new CatalogRuntimeEnforcer(state, principal);
}

export async function synchronizeCatalogSkillsForUser(installationId: string, userId: string, selectedSkillId: string | null) {
  const { installation, state, principal } = await catalogAccessContext(installationId, userId);
  const result = await synchronizeEffectiveSkills({ config: installation, userId, state, principal });
  return { result, developerInstructions: skillProvenanceInstructions(result, selectedSkillId) };
}
