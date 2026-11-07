import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import type { InstallationConfig } from "@/config/installation-schema";
import { FileWorkbenchStore } from "./filesystem-store";
import { getWritableProject, updateProject } from "./store";
import { resolveProjectAccess } from "./shared-access";
import { readValidatedJson } from "@/storage";
import { FileWorkspaceAdminStore } from "@/admin/workspace-admin-store";
import { workspacePolicyForIdentity } from "@/admin/policy-service";
import { automationWorkspaceContext, validateAutomationAudience } from "@/automations/server-service";
const context = vi.hoisted(() => ({ installation: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => context.installation }));
vi.mock("@/storage", async original => {
  const actual = await original<typeof import("@/storage")>();
  return { ...actual, readValidatedJson: vi.fn(actual.readValidatedJson) };
});
const owner = "00000000-0000-4000-8000-000000000011", member = "00000000-0000-4000-8000-000000000012", outsider = "00000000-0000-4000-8000-000000000014";
const session = (id = owner): AuthSession => ({ provider: "local", user: { id, email: `${id}@example.test`, name: "QA" }, tenant: { id: "access-qa", name: "QA" }, expiresAt: "2030-01-01T00:00:00Z" });
let root: string, installation: InstallationConfig, store: FileWorkbenchStore;
const statePath = (id = owner) => path.join(installation.paths.usersRoot, id, "state/workbench.json");
async function profile(id: string, enabled = true, email = session(id).user.email) {
  await mkdir(path.join(installation.paths.usersRoot, id), { recursive: true, mode: 0o700 });
  await writeFile(path.join(installation.paths.usersRoot, id, "user.json"), JSON.stringify({ schemaVersion: 1, userId: id, email, enabled, displayName: "QA", workerId: `worker-${id}` }), { mode: 0o600 });
}
async function replace(value: unknown, id = owner) {
  const target = statePath(id), temporary = `${target}.fixture`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, target);
}
async function fixture(large = false) {
  const project = await store.createProject(owner, "Access project");
  const thread = await store.createThread(owner, project.id, "Preserved history");
  await store.load(owner); // provision the ordinary standalone project once
  const state = JSON.parse(await readFile(statePath(), "utf8"));
  if (large) state.threads.find((item: { id: string }) => item.id === thread.id).messages = [{ id: randomUUID(), role: "user", content: `PRIVATE_HISTORY_${"x".repeat(17 * 1024 * 1024)}`, status: "complete", createdAt: new Date().toISOString(), activity: [], plan: [], approvals: [], diff: "", attachments: [], artifacts: [] }];
  await replace(state);
  return { project, thread, state };
}
const canonicalReads = (id = owner) => vi.mocked(readValidatedJson).mock.calls.filter(([file]) => file === statePath(id));
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "access-metadata-"));
  installation = { installationId: "access-qa", paths: { dataRoot: root, usersRoot: path.join(root, "users") } } as InstallationConfig;
  context.installation = installation;
  for (const id of [owner, member, outsider]) await profile(id);
  store = FileWorkbenchStore.fromInstallation(installation);
  vi.stubEnv("AIBRAIN_ADMIN_USER_IDS", owner);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("current bounded project-access metadata", () => {
  it("shares concurrent cold metadata reads without sharing mutable responses", async () => {
    const { project } = await fixture(true);
    vi.mocked(readValidatedJson).mockClear();
    const snapshots = await Promise.all(Array.from({ length: 8 }, () => store.loadAccessSnapshot(owner)));
    expect(canonicalReads()).toHaveLength(1);
    expect(snapshots.every(value => value.threads.every(thread => thread.messages.length === 0))).toBe(true);
    snapshots[0].projects.find(value => value.id === project.id)!.name = "Changed response";
    expect(snapshots[1].projects.find(value => value.id === project.id)!.name).toBe("Access project");
    expect((await store.loadAccessSnapshot(owner)).projects.find(value => value.id === project.id)!.name).toBe("Access project");
  });

  it("does not retain failed concurrent metadata reads", async () => {
    await fixture();
    const actual = await vi.importActual<typeof import("@/storage")>("@/storage");
    vi.mocked(readValidatedJson).mockImplementation(async (file, schema) => {
      if (file === statePath()) throw new Error("Synthetic unavailable read");
      return actual.readValidatedJson(file, schema);
    });
    try {
      const failed = await Promise.allSettled(Array.from({ length: 4 }, () => store.loadAccessSnapshot(owner)));
      expect(failed.every(value => value.status === "rejected")).toBe(true);
    } finally { vi.mocked(readValidatedJson).mockImplementation(actual.readValidatedJson); }
    expect((await store.loadAccessSnapshot(owner)).projects.some(project => project.name === "Access project")).toBe(true);
  });

  it("does not coalesce a replacement identity behind an older in-flight read", async () => {
    const { project, state } = await fixture();
    const actual = await vi.importActual<typeof import("@/storage")>("@/storage");
    let release!: () => void, started!: () => void, first = true;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(readValidatedJson).mockImplementation(async (file, schema) => {
      const value = await actual.readValidatedJson(file, schema);
      if (file === statePath() && first) { first = false; started(); await blocked; }
      return value;
    });
    const older = store.loadAccessSnapshot(owner);
    try {
      await entered;
      state.projects.find((value: { id: string }) => value.id === project.id).name = "Replacement";
      await replace(state);
      expect((await store.loadAccessSnapshot(owner)).projects.find(value => value.id === project.id)!.name).toBe("Replacement");
      release();
      expect((await older).projects.find(value => value.id === project.id)!.name).toBe("Replacement");
    } finally { release(); await older; vi.mocked(readValidatedJson).mockImplementation(actual.readValidatedJson); }
  });

  it("parses a >16MiB history once across repeated host-style writable checks, keeps only metadata, and preserves history", async () => {
    const { project, thread } = await fixture(true);
    const original = await readFile(statePath()); expect(original.length).toBeGreaterThan(16 * 1024 * 1024);
    vi.mocked(readValidatedJson).mockClear();
    for (let check = 0; check < 8; check++) expect((await getWritableProject(session(), project.id)).id).toBe(project.id);
    expect(canonicalReads()).toHaveLength(1);
    const selected = await store.loadAccessSnapshot(owner);
    expect(selected.threads.every(item => item.messages.length === 0)).toBe(true);
    expect(JSON.stringify(selected)).not.toContain("PRIVATE_HISTORY_");
    selected.projects[0].name = "mutated response";
    expect((await store.loadAccessSnapshot(owner)).projects[0].name).not.toBe("mutated response");
    expect(createHash("sha256").update(await readFile(statePath())).digest("hex")).toBe(createHash("sha256").update(original).digest("hex"));
    expect((await store.getThread(owner, thread.id)).messages[0].content).toContain("PRIVATE_HISTORY_");
  });

  it("invalidates atomic replacement and same-inode, same-size updates even when mtime is restored", async () => {
    const { project, state } = await fixture();
    expect((await getWritableProject(session(), project.id)).name).toBe("Access project");
    state.projects.find((item: { id: string }) => item.id === project.id).name = "Access changed";
    await replace(state);
    expect((await getWritableProject(session(), project.id)).name).toBe("Access changed");
    const { stat } = await import("node:fs/promises"); const previous = await stat(statePath());
    const text = await readFile(statePath(), "utf8");
    await writeFile(statePath(), text.replace('"Access changed"', '"Access revoked"'));
    await utimes(statePath(), previous.atime, previous.mtime);
    expect((await getWritableProject(session(), project.id)).name).toBe("Access revoked");
    state.projects = state.projects.filter((item: { id: string }) => item.id !== project.id); state.threads = [];
    await replace(state);
    await expect(getWritableProject(session(), project.id)).rejects.toThrow("Projecte no trobat");
  });

  it.each(["once", "continuously"] as const)("does not publish metadata from a canonical revision replaced %s during its cold read", async mode => {
    const { state } = await fixture();
    const actual = await vi.importActual<typeof import("@/storage")>("@/storage");
    let revisions = 0;
    vi.mocked(readValidatedJson).mockImplementation(async (file, schema) => {
      const value = await actual.readValidatedJson(file, schema);
      if (file === statePath() && (mode === "continuously" || revisions === 0)) {
        revisions++; state.revision++;
        state.projects[0].name = `Revision ${revisions}`;
        await replace(state);
      }
      return value;
    });
    try {
      if (mode === "continuously") {
        await expect(store.loadAccessSnapshot(owner)).rejects.toThrow("ha canviat");
        expect(revisions).toBe(3);
      } else {
        expect((await store.loadAccessSnapshot(owner)).projects[0].name).toBe("Revision 1");
        expect(revisions).toBe(1);
      }
    } finally { vi.mocked(readValidatedJson).mockImplementation(actual.readValidatedJson); }
  });

  it("keeps current account/email/tenant and foreign-grant gates outside the cache", async () => {
    const { project } = await fixture(); await getWritableProject(session(), project.id);
    const accessRead = vi.spyOn(FileWorkbenchStore.prototype, "loadAccessSnapshot"); accessRead.mockClear();
    await expect(resolveProjectAccess(session(outsider), project.id)).rejects.toThrow("Projecte no trobat");
    expect(accessRead.mock.calls.map(([id]) => id)).not.toContain(owner);
    accessRead.mockRestore();
    await profile(owner, false); await expect(getWritableProject(session(), project.id)).rejects.toThrow("Projecte no trobat");
    await profile(owner, true, "changed@example.test"); await expect(getWritableProject(session(), project.id)).rejects.toThrow("Projecte no trobat");
    await profile(owner); await expect(getWritableProject({ ...session(), tenant: { id: "foreign", name: "foreign" } }, project.id)).rejects.toThrow("instalación");
    await expect(new FileWorkbenchStore({ installationId: "foreign", usersRoot: installation.paths.usersRoot }).loadAccessSnapshot(owner)).rejects.toThrow("instal·lació");
  });

  it("refreshes sharing roles and revocation after a warm metadata hit", async () => {
    const { project } = await fixture();
    const sharing = { visibility: "shared" as const, members: [{ id: randomUUID(), name: "Member", email: session(member).user.email, role: "editor" as const, status: "active" as const, addedAt: new Date().toISOString() }] };
    await updateProject(session(), project.id, { sharing });
    await expect(getWritableProject(session(member), project.id)).resolves.toMatchObject({ id: project.id });
    await updateProject(session(), project.id, { sharing: { ...sharing, members: sharing.members.map(item => ({ ...item, role: "viewer" })) } });
    await expect(getWritableProject(session(member), project.id)).rejects.toThrow("permisos");
    await updateProject(session(), project.id, { sharing: { visibility: "private", members: [] } });
    await expect(resolveProjectAccess(session(member), project.id)).rejects.toThrow("Projecte no trobat");
  });

  it("final shared-project revalidation intersects the durable grant with current sharing even before index sync", async () => {
    const { project } = await fixture();
    await updateProject(session(), project.id, { sharing: { visibility: "shared", members: [{ id: randomUUID(), name: "Member", email: session(member).user.email, role: "editor", status: "active", addedAt: new Date().toISOString() }] } });
    await getWritableProject(session(member), project.id); // warm both owners' metadata
    const state = JSON.parse(await readFile(statePath(), "utf8"));
    state.projects.find((item: { id: string }) => item.id === project.id).sharing.members[0].role = "viewer";
    await replace(state); // canonical revocation can precede index reconciliation
    await expect(getWritableProject(session(member), project.id)).rejects.toThrow("permisos");
    state.projects.find((item: { id: string }) => item.id === project.id).sharing = { visibility: "private", members: [] };
    await replace(state);
    await expect(resolveProjectAccess(session(member), project.id)).rejects.toThrow("Projecte no trobat");
  });

  it("does not cache group policy or audience authority with project metadata", async () => {
    const { project } = await fixture(); await getWritableProject(session(), project.id);
    const admin = new FileWorkspaceAdminStore(installation.installationId, root);
    const ids = [owner, member, outsider]; await admin.read(ids);
    let groupId = "";
    await admin.mutate(ids, owner, state => { const group = admin.newGroup("Bounded QA", ""); groupId = group.id; group.memberIds = [owner]; state.groups.push(group); return { action: "group.created", targetType: "group", targetId: groupId, summary: "Fixture" }; });
    const audience = { membershipPolicy: "current" as const, userIds: [owner], groupIds: [groupId] };
    validateAutomationAudience(audience, await automationWorkspaceContext(installation), owner);
    expect((await workspacePolicyForIdentity(installation.installationId, owner, installation)).policy.capabilities.respond).toBe(true);
    await admin.mutate(ids, owner, state => { state.groups[0].policy.capabilities.respond = false; return { action: "group.updated", targetType: "group", targetId: groupId, summary: "Fixture" }; });
    await getWritableProject(session(), project.id);
    expect((await workspacePolicyForIdentity(installation.installationId, owner, installation)).policy.capabilities.respond).toBe(false);
    await admin.mutate(ids, owner, state => { state.groups = []; return { action: "group.deleted", targetType: "group", targetId: groupId, summary: "Fixture" }; });
    const fresh = await automationWorkspaceContext(installation);
    expect(() => validateAutomationAudience(audience, fresh, owner)).toThrow("audiencia");
  });

  it.each(["symlink", "hardlink", "corrupt"])("a warm hit cannot hide a %s canonical file", async fault => {
    const { project } = await fixture(); await getWritableProject(session(), project.id);
    const backup = `${statePath()}.saved`; await rename(statePath(), backup);
    if (fault === "symlink") await symlink(backup, statePath());
    else if (fault === "hardlink") await link(backup, statePath());
    else await writeFile(statePath(), "broken canonical");
    await expect(getWritableProject(session(), project.id)).rejects.toThrow();
    if (fault !== "corrupt") await unlink(statePath());
  });
});
