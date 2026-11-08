import type { InstallationConfig } from "@/config/installation-schema";
import { resolveServerTurnPermissions } from "@/runtime/permission-turn";
import { featurePolicyForIdentity } from "@/settings/server-service";
import type { HostBinding } from "./store";
import { stableId } from "./contracts";
export async function currentHostPermissions(installation: Readonly<InstallationConfig>, binding: HostBinding, runKey: string) {
  if (["email-event-router", "sibema-event-router"].includes(binding.job) && !(await featurePolicyForIdentity(installation.installationId, binding.userId))["web-search"]) throw Error("HOST_WEB_PERMISSION_REVOKED");
  return resolveServerTurnPermissions(installation, { installationId: installation.installationId, userId: binding.userId,
    projectId: binding.projectId, turnId: stableId(`${runKey}:assistant`) });
}
