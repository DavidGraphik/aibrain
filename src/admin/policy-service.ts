import { readdir } from "node:fs/promises";
import { loadInstallationConfig } from "@/config/installation";
import type { InstallationConfig } from "@/config/installation-schema";
import { effectiveWorkspacePolicy, FileWorkspaceAdminStore } from "@/admin/workspace-admin-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function workspacePolicyForIdentity(
  installationId: string,
  userId: string,
  configuredInstallation?: Readonly<InstallationConfig>,
) {
  const installation = configuredInstallation ?? await loadInstallationConfig();
  if (installation.installationId !== installationId || !UUID.test(userId)) {
    throw new Error("The identity does not belong to this installation.");
  }
  const entries = await readdir(installation.paths.usersRoot, { withFileTypes: true });
  const provisionedUserIds = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && UUID.test(entry.name))
    .map((entry) => entry.name);
  if (!provisionedUserIds.includes(userId)) throw new Error("The identity is not provisioned.");
  const store = new FileWorkspaceAdminStore(installation.installationId, installation.paths.dataRoot);
  const state = await store.read(provisionedUserIds);
  return effectiveWorkspacePolicy(state, userId);
}
