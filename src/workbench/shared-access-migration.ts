import { readdir } from "node:fs/promises";
import type { InstallationConfig } from "@/config/installation-schema";
import { FileLocalUserStore, type LocalUser } from "@/auth/local-user-store";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import type { WorkbenchSnapshot } from "@/workbench/types";
import {
  FileSharedAccessIndex,
  type SharedAccessIndexRebuildResult,
} from "@/workbench/shared-access-index";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SharedAccessIndexMigrationReport = SharedAccessIndexRebuildResult & {
  operation: "shared-access-index-rebuild";
  installationId: string;
  scannedUserDirectories: number;
  enabledOwners: number;
  ownersWithSnapshots: number;
  skippedDisabledUserIds: string[];
  skippedSymlinkUserIds: string[];
  skippedWithoutSnapshotUserIds: string[];
};

/**
 * Offline-only projection rebuild. It intentionally receives no AuthSession:
 * callers run it as a privileged operator before deployment or restart, not
 * from an end-user request path.
 */
export class SharedAccessIndexMigration {
  private readonly installation: Readonly<InstallationConfig>;

  constructor(installation: Readonly<InstallationConfig>) {
    this.installation = installation;
  }

  async run(options: { operatorUserId: string; dryRun?: boolean }): Promise<SharedAccessIndexMigrationReport> {
    if (!UUID.test(options.operatorUserId)) throw new Error("Shared access migration operator id is invalid.");
    const dryRun = options.dryRun ?? true;
    const localUsers = new FileLocalUserStore(this.installation.paths.usersRoot);
    const entries = await readdir(this.installation.paths.usersRoot, { withFileTypes: true });
    const skippedDisabledUserIds: string[] = [];
    const skippedSymlinkUserIds: string[] = [];
    const enabledUsers: LocalUser[] = [];
    let scannedUserDirectories = 0;

    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (!UUID.test(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        skippedSymlinkUserIds.push(entry.name);
        continue;
      }
      if (!entry.isDirectory()) continue;
      scannedUserDirectories += 1;
      const user = await localUsers.read(entry.name);
      if (!user) continue;
      if (!user.enabled) {
        skippedDisabledUserIds.push(user.userId);
        continue;
      }
      enabledUsers.push(user);
    }

    if (!enabledUsers.some((user) => user.userId === options.operatorUserId)) {
      throw new Error("Shared access migration requires an enabled local operator.");
    }

    const store = FileWorkbenchStore.fromInstallation(this.installation);
    const owners: { owner: LocalUser; snapshot: WorkbenchSnapshot }[] = [];
    const skippedWithoutSnapshotUserIds: string[] = [];
    for (const owner of enabledUsers) {
      const snapshot = await store.readExistingSnapshotForMaintenance(owner.userId);
      if (!snapshot) {
        skippedWithoutSnapshotUserIds.push(owner.userId);
        continue;
      }
      owners.push({ owner, snapshot });
    }

    const rebuilt = await new FileSharedAccessIndex({
      dataRoot: this.installation.paths.dataRoot,
      installationId: this.installation.installationId,
    }).rebuildFromPrivilegedSnapshots({
      operatorUserId: options.operatorUserId,
      owners,
      users: enabledUsers,
      dryRun,
    });
    return {
      operation: "shared-access-index-rebuild",
      installationId: this.installation.installationId,
      scannedUserDirectories,
      enabledOwners: enabledUsers.length,
      ownersWithSnapshots: owners.length,
      skippedDisabledUserIds,
      skippedSymlinkUserIds,
      skippedWithoutSnapshotUserIds,
      ...rebuilt,
    };
  }
}
