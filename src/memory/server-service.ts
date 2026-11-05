import "server-only";

import type { AuthSession } from "@/auth/types";
import { loadInstallationConfig } from "@/config/installation";
import { LocalFileMemoryService } from "@/memory/local-file-memory-service";
import { FileMemoryProposalStore } from "@/memory/proposal-store";
import { workspacePolicyForIdentity } from "@/admin/policy-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export async function memoryServiceForSession(session: AuthSession) {
  const installation = await loadInstallationConfig();
  if (session.provider !== "local" || session.tenant.id !== installation.installationId) {
    throw new Error("Authenticated session does not belong to the local memory installation.");
  }
  return {
    context: {
      installationId: installation.installationId,
      userId: session.user.id,
    },
    service: new LocalFileMemoryService({ config: installation }),
  };
}

export async function memoryProposalServiceForSession(session: AuthSession, projectId: string) {
  if (!UUID.test(projectId)) throw new Error("Memory proposal project is invalid.");
  const installation = await loadInstallationConfig();
  if (session.provider !== "local" || session.tenant.id !== installation.installationId) {
    throw new Error("Authenticated session does not belong to the local memory installation.");
  }
  const effective = await workspacePolicyForIdentity(installation.installationId, session.user.id, installation);
  return {
    context: { installationId: installation.installationId, userId: session.user.id, projectId },
    store: new FileMemoryProposalStore({ config: installation }),
    allowCompanyScope: effective.role.canManageWorkspace,
  };
}
