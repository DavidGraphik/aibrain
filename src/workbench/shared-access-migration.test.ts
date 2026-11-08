import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import { loadInstallationConfig } from "@/config/installation";
import { UserLifecycleService } from "@/users/lifecycle";
import { UserProvisioner } from "@/users/provisioner";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import { FileSharedAccessIndex } from "@/workbench/shared-access-index";
import { SharedAccessIndexMigration } from "@/workbench/shared-access-migration";
import { resolveProjectAccess } from "@/workbench/shared-access";

vi.mock("server-only", () => ({}));

const ownerId = "00000000-0000-4000-8000-000000000021";
const memberId = "00000000-0000-4000-8000-000000000022";
const outsiderId = "00000000-0000-4000-8000-000000000023";
const symlinkId = "00000000-0000-4000-8000-000000000024";
const disabledOwnerId = "00000000-0000-4000-8000-000000000026";
let root = "";
let previousConfig: string | undefined;

function session(userId: string, name: string, email: string): AuthSession {
  return {
    provider: "local",
    user: { id: userId, name, email },
    tenant: { id: "migration-qa", name: "Migration QA" },
    expiresAt: "2026-08-29T00:00:00.000Z",
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aibrain-shared-migration-"));
  const dataRoot = path.join(root, "data");
  await mkdir(dataRoot, { mode: 0o700 });
  const configPath = path.join(root, "installation.json");
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    installationId: "migration-qa",
    companyName: "Migration QA",
    companySlug: "migration-qa",
    publicUrl: "http://localhost:3000",
    branding: { productName: "AiBrain", logoPath: "/logo.svg", faviconPath: "/favicon.ico", accentColor: "#111111" },
    paths: {
      dataRoot,
      companyContextRoot: path.join(dataRoot, "company"),
      usersRoot: path.join(dataRoot, "users"),
      sourceReadRoot: path.join(root, "source"),
      publishWriteRoot: path.join(root, "publish"),
      backupsRoot: path.join(dataRoot, "backups"),
    },
  }));
  previousConfig = process.env.AIBRAIN_INSTALLATION_CONFIG;
  process.env.AIBRAIN_INSTALLATION_CONFIG = configPath;
});

afterEach(async () => {
  if (previousConfig === undefined) delete process.env.AIBRAIN_INSTALLATION_CONFIG;
  else process.env.AIBRAIN_INSTALLATION_CONFIG = previousConfig;
  await rm(root, { recursive: true, force: true });
});

describe("shared access legacy migration", () => {
  it("rebuilds grants offline, leaves requester retrieval closed, and removes revoked access", async () => {
    const installation = await loadInstallationConfig();
    const provisioner = new UserProvisioner(installation);
    await provisioner.provision({ userId: ownerId, email: "owner@example.com", displayName: "Owner" });
    await provisioner.provision({ userId: memberId, email: "member@example.com", displayName: "Member" });
    await provisioner.provision({ userId: outsiderId, email: "outsider@example.com", displayName: "Outsider" });
    await provisioner.provision({ userId: disabledOwnerId, email: "disabled@example.com", displayName: "Disabled" });
    await symlink(path.join(installation.paths.usersRoot, ownerId), path.join(installation.paths.usersRoot, symlinkId));

    // Direct storage writes model a share created before K1's index existed.
    const store = FileWorkbenchStore.fromInstallation(installation);
    const project = await store.createProject(ownerId, "Legacy shared project");
    await store.updateProject(ownerId, project.id, {
      sharing: {
        visibility: "shared",
        members: [{
          id: "00000000-0000-4000-8000-000000000025",
          email: "member@example.com",
          name: "Member",
          role: "viewer",
          status: "active",
          addedAt: "2026-08-28T10:00:00.000Z",
        }],
      },
    });
    await store.createThread(ownerId, project.id, "Legacy thread");
    const disabledProject = await store.createProject(disabledOwnerId, "Disabled legacy project");
    await store.updateProject(disabledOwnerId, disabledProject.id, {
      sharing: {
        visibility: "shared",
        members: [{
          id: "00000000-0000-4000-8000-000000000027",
          email: "member@example.com",
          name: "Member",
          role: "viewer",
          status: "active",
          addedAt: "2026-08-28T10:00:00.000Z",
        }],
      },
    });
    await new UserLifecycleService(installation).execute({
      schemaVersion: 1,
      requestId: "00000000-0000-4000-8000-000000000028",
      action: "disable",
      userId: disabledOwnerId,
    });

    const migration = new SharedAccessIndexMigration(installation);
    const dryRun = await migration.run({ operatorUserId: ownerId, dryRun: true });
    expect(dryRun).toMatchObject({ dryRun: true, changed: true, grantsBefore: 0, grantsAfter: 2, grantsAdded: 2 });
    expect(dryRun.skippedSymlinkUserIds).toEqual([symlinkId]);
    expect(dryRun.skippedDisabledUserIds).toEqual([disabledOwnerId]);
    const index = new FileSharedAccessIndex({ dataRoot: installation.paths.dataRoot, installationId: installation.installationId });
    await expect(lstat(path.join(installation.paths.dataRoot, "workbench-shared-access", "index.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const readSpy = vi.spyOn(
      FileWorkbenchStore.prototype as unknown as { read: (userId: string) => unknown },
      "read",
    );
    await expect(resolveProjectAccess(session(memberId, "Member", "member@example.com"), project.id))
      .rejects.toThrow("Projecte no trobat");
    expect(readSpy.mock.calls.map(([userId]) => userId)).not.toContain(ownerId);

    const applied = await migration.run({ operatorUserId: ownerId, dryRun: false });
    expect(applied).toMatchObject({ dryRun: false, changed: true, grantsBefore: 0, grantsAfter: 2, grantsAdded: 2 });
    const memberAccess = await resolveProjectAccess(session(memberId, "Member", "member@example.com"), project.id);
    expect(memberAccess.provenance).toMatchObject({ source: "shared-access-index" });

    readSpy.mockClear();
    await expect(resolveProjectAccess(session(outsiderId, "Outsider", "outsider@example.com"), project.id))
      .rejects.toThrow("Projecte no trobat");
    expect(readSpy.mock.calls.map(([userId]) => userId)).not.toContain(ownerId);

    const rerun = await migration.run({ operatorUserId: ownerId, dryRun: false });
    expect(rerun).toMatchObject({ changed: false, grantsBefore: 2, grantsAfter: 2, grantsAdded: 0, grantsRemoved: 0 });

    await store.updateProject(ownerId, project.id, { sharing: { visibility: "private", members: [] } });
    const revoked = await migration.run({ operatorUserId: ownerId, dryRun: false });
    expect(revoked).toMatchObject({ changed: true, grantsBefore: 2, grantsAfter: 0, grantsRemoved: 2 });
    readSpy.mockClear();
    await expect(resolveProjectAccess(session(memberId, "Member", "member@example.com"), project.id))
      .rejects.toThrow("Projecte no trobat");
    expect(readSpy.mock.calls.map(([userId]) => userId)).not.toContain(ownerId);
    const audit = await index.readAudit();
    expect(audit.filter((entry) => entry.payload.action === "rebuild")).toHaveLength(3);
  });
});
