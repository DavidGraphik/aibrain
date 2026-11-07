import { readdir } from "node:fs/promises";
import { FileLocalUserStore } from "@/auth/local-user-store";
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
  const users = new FileLocalUserStore(installation.paths.usersRoot);
  const profiles = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && UUID.test(entry.name))
    .map((entry) => users.read(entry.name)));
  // Worker/audit directories can outlive their profile. Only validated profiles
  // are provisioned; retain disabled profiles for existing role/group semantics.
  const provisionedUserIds = profiles.flatMap((profile) => profile ? [profile.userId] : []);
  if (!provisionedUserIds.includes(userId)) throw new Error("The identity is not provisioned.");
  const store = new FileWorkspaceAdminStore(installation.installationId, installation.paths.dataRoot);
  const state = await store.read(provisionedUserIds);
  return effectiveWorkspacePolicy(state, userId);
}
