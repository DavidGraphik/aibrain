import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import { loadInstallationConfig } from "@/config/installation";
import { UserProvisioner } from "@/users/provisioner";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import { FileSharedAccessIndex } from "@/workbench/shared-access-index";
import { loadSharedWorkbench, resolveProjectAccess, resolveThreadAccess } from "@/workbench/shared-access";
import { createProject, createThread, getThreadRuntimeContext, updateProject, updateThread } from "@/workbench/store";

vi.mock("server-only", () => ({}));

const ownerId = "00000000-0000-4000-8000-000000000011";
const memberId = "00000000-0000-4000-8000-000000000012";
const outsiderId = "00000000-0000-4000-8000-000000000014";
const editorId = "00000000-0000-4000-8000-000000000015";
let root = "";
let previousConfig: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aibrain-shared-"));
  const dataRoot = path.join(root, "data");
  await mkdir(dataRoot, { mode: 0o700 });
  const configPath = path.join(root, "installation.json");
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    installationId: "shared-qa",
    companyName: "Shared QA",
    companySlug: "shared-qa",
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

describe("shared project visibility", () => {
  it("authorizes a durable shared-project grant before opening the owner snapshot", async () => {
    const installation = await loadInstallationConfig();
    const provisioner = new UserProvisioner(installation);
    await provisioner.provision({ userId: ownerId, email: "owner@example.com", displayName: "Owner" });
    await provisioner.provision({ userId: memberId, email: "member@example.com", displayName: "Member" });
    await provisioner.provision({ userId: outsiderId, email: "outsider@example.com", displayName: "Outsider" });
    await provisioner.provision({ userId: editorId, email: "editor@example.com", displayName: "Editor" });
    const ownerSession: AuthSession = {
      provider: "local",
      user: { id: ownerId, name: "Owner", email: "owner@example.com" },
      tenant: { id: "shared-qa", name: "Shared QA" },
      expiresAt: "2026-08-29T00:00:00.000Z",
    };
    const memberSession: AuthSession = {
      provider: "local",
      user: { id: memberId, name: "Member", email: "member@example.com" },
      tenant: { id: "shared-qa", name: "Shared QA" },
      expiresAt: "2026-08-29T00:00:00.000Z",
    };
    const outsiderSession: AuthSession = {
      provider: "local",
      user: { id: outsiderId, name: "Outsider", email: "outsider@example.com" },
      tenant: { id: "shared-qa", name: "Shared QA" },
      expiresAt: "2026-08-29T00:00:00.000Z",
    };
    const editorSession: AuthSession = {
      provider: "local",
      user: { id: editorId, name: "Editor", email: "editor@example.com" },
      tenant: { id: "shared-qa", name: "Shared QA" },
      expiresAt: "2026-08-29T00:00:00.000Z",
    };
    const project = await createProject(ownerSession, "Plan compartido");
    await updateProject(ownerSession, project.id, {
      sharing: {
        visibility: "shared",
        members: [{
          id: "00000000-0000-4000-8000-000000000013",
          email: "member@example.com",
          name: "Member",
          role: "viewer",
          status: "active",
          addedAt: "2026-08-28T10:00:00.000Z",
        }, {
          id: "00000000-0000-4000-8000-000000000016",
          email: "editor@example.com",
          name: "Editor",
          role: "editor",
          status: "active",
          addedAt: "2026-08-28T10:00:00.000Z",
        }],
      },
    });
    const thread = await createThread(ownerSession, project.id, "Conversación visible");

    const readSpy = vi.spyOn(
      FileWorkbenchStore.prototype as unknown as { read: (userId: string) => unknown },
      "read",
    );
    const metadataReadSpy = vi.spyOn(FileWorkbenchStore.prototype, "loadAccessSnapshot");
    const outsiderSnapshot = await loadSharedWorkbench(outsiderSession);
    expect(outsiderSnapshot.projects.some((item) => item.id === project.id)).toBe(false);
    expect(readSpy.mock.calls.map(([userId]) => userId)).not.toContain(ownerId);

    metadataReadSpy.mockClear();
    readSpy.mockClear();
    await expect(resolveProjectAccess(outsiderSession, project.id)).rejects.toThrow("Projecte no trobat");
    expect(readSpy.mock.calls.map(([userId]) => userId)).not.toContain(ownerId);

    expect(metadataReadSpy.mock.calls.map(([userId]) => userId)).not.toContain(ownerId);
    metadataReadSpy.mockClear();
    readSpy.mockClear();
    const access = await resolveProjectAccess(memberSession, project.id);
    expect(access.ownerUserId).toBe(ownerId);
    expect(access.provenance).toMatchObject({ source: "shared-access-index" });
    expect(metadataReadSpy.mock.calls.map(([userId]) => userId)).toContain(ownerId);

    const threadAccess = await resolveThreadAccess(memberSession, thread.id);
    expect(threadAccess.provenance).toMatchObject({ source: "shared-access-index" });

    readSpy.mockClear();
    const metadataSnapshot = await loadSharedWorkbench(memberSession, true);
    expect(metadataSnapshot.threads.find(item => item.id === thread.id)).toMatchObject({ messages: [], historyLoaded: false, access: { role: "viewer" } });
    expect(readSpy).not.toHaveBeenCalled();
    const outsiderMetadata = await loadSharedWorkbench(outsiderSession, true);
    expect(outsiderMetadata.threads.some(item => item.id === thread.id)).toBe(false);
    await expect(resolveThreadAccess(outsiderSession, thread.id)).rejects.toThrow("Fil no trobat");
    const snapshot = await loadSharedWorkbench(memberSession);
    expect(snapshot.projects.find((item) => item.id === project.id)?.access)
      .toEqual({ role: "viewer", canEdit: false, canManage: false });
    expect(snapshot.threads.some((item) => item.projectId === project.id)).toBe(true);

    const editorSnapshot = await loadSharedWorkbench(editorSession);
    expect(editorSnapshot.projects.find((item) => item.id === project.id)?.access)
      .toEqual({ role: "editor", canEdit: true, canManage: false });
    expect((await getThreadRuntimeContext(editorSession, thread.id)).visibleProjects)
      .toContainEqual({ id: project.id, name: project.name });
    await expect(getThreadRuntimeContext(memberSession, thread.id)).rejects.toThrow("només lectura");

    await expect(updateThread(memberSession, thread.id, { pinned: true }))
      .resolves.toMatchObject({ id: thread.id, pinned: true, title: "Conversación visible" });
    expect((await loadSharedWorkbench(memberSession)).threads.find((item) => item.id === thread.id)?.pinned).toBe(true);
    expect((await loadSharedWorkbench(ownerSession)).threads.find((item) => item.id === thread.id)?.pinned).toBe(false);
    expect((await loadSharedWorkbench(editorSession)).threads.find((item) => item.id === thread.id)?.pinned).toBe(false);
    await expect(updateThread(memberSession, thread.id, { title: "No autorizado" }))
      .rejects.toThrow("només lectura");

    const ownerSnapshot = await loadSharedWorkbench(ownerSession);
    expect(ownerSnapshot.projects.find((item) => item.id === project.id)?.access)
      .toEqual({ role: "owner", canEdit: true, canManage: true });

    const index = new FileSharedAccessIndex({
      dataRoot: installation.paths.dataRoot,
      installationId: installation.installationId,
    });
    await loadSharedWorkbench(ownerSession);
    const syncCountBefore = (await index.readAudit())
      .filter((entry) => entry.payload.action === "sync").length;
    await loadSharedWorkbench(ownerSession);
    const syncCountAfter = (await index.readAudit())
      .filter((entry) => entry.payload.action === "sync").length;
    expect(syncCountAfter).toBe(syncCountBefore);

    await expect(resolveProjectAccess({ ...memberSession, user: { ...memberSession.user, email: "other@example.com" } }, project.id))
      .rejects.toThrow("Projecte no trobat");

    const audit = await index.readAudit();
    expect(audit.some((entry) => entry.payload.action === "resolve" && entry.payload.outcome === "denied" && entry.payload.actorUserId === outsiderId)).toBe(true);
    expect(audit.some((entry) => entry.payload.action === "resolve" && entry.payload.outcome === "allowed" && entry.payload.actorUserId === memberId && entry.payload.grantFingerprint)).toBe(true);
    metadataReadSpy.mockRestore(); readSpy.mockRestore();
  }, 15_000);
});
