import "server-only";
import path from "node:path";
import { createLocalSessionContext } from "@/auth/auth-context";
import { FileSupportAccessStore } from "@/auth/support-access";
import { readSupportAccessPolicy } from "@/auth/support-access-policy";
import { loadInstallationConfig } from "@/config/installation";
export async function supportAccessEnabled() {
  const installation = await loadInstallationConfig();
  return Boolean(await readSupportAccessPolicy(installation.paths.dataRoot, installation.installationId));
}
export async function createSupportAccessStore() {
  const { installation, users, sessions } = await createLocalSessionContext();
  const policy = await readSupportAccessPolicy(installation.paths.dataRoot, installation.installationId);
  if (!policy) throw new Error("Support access disabled for this installation.");
  return new FileSupportAccessStore({ operatorUserId: policy.operatorUserId, root: path.join(installation.paths.dataRoot, "support-access"), installationId: installation.installationId, users, sessions });
}
