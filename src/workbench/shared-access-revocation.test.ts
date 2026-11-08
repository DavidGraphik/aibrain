import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/auth/types";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { loadInstallationConfig } from "@/config/installation";
import { UserProvisioner } from "@/users/provisioner";
import { FileWorkbenchStore } from "@/workbench/filesystem-store";
import * as historyStorage from "@/workbench/segmented-history";
import { FileSharedAccessIndex } from "@/workbench/shared-access-index";
import { createReadableThreadReader, loadSharedWorkbench, resolveProjectAccess, resolveThreadAccess, syncOwnSharedAccess } from "@/workbench/shared-access";
import { createProject, createThread, getThreadRuntimeContext, updateProject } from "@/workbench/store";
import type { ProjectMember, ProjectSharing } from "@/workbench/types";
import { GET as projectGET } from "@/app/api/projects/[projectId]/route";
import { GET as threadGET, PATCH as threadPATCH } from "@/app/api/threads/[threadId]/route";
import { GET as workbenchGET } from "@/app/api/workbench/route";
import { GET as projectsGET } from "@/app/api/projects/route";

const historyPolicy = vi.hoisted(() => ({ segmented: false }));
vi.mock("@/workbench/history-format-policy", () => ({
  get WORKBENCH_HISTORY_MIGRATION_ENABLED() { return historyPolicy.segmented; },
}));
vi.mock("@/workbench/segmented-history", async original => ({
  ...await original<typeof import("@/workbench/segmented-history")>(),
  WORKBENCH_SEGMENT_THRESHOLD: 1024,
}));
const auth = vi.hoisted(() => ({ session: null as AuthSession | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth/session", () => ({ getSession: async () => auth.session }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: async () => true }));

const ownerId = "00000000-0000-4000-8000-000000000021", memberId = "00000000-0000-4000-8000-000000000022", outsiderId = "00000000-0000-4000-8000-000000000023";
const privateHistory = "OWNER_HISTORY_MUST_NOT_LEAK_AFTER_REVOCATION";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aibrain-stale-shared-access-"));
  const dataRoot = path.join(root, "data"), configPath = path.join(root, "installation.json");
  await mkdir(dataRoot, { mode: 0o700 });
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, installationId: "shared-qa", companyName: "Shared QA", companySlug: "shared-qa", publicUrl: "https://shared.example.test", branding: { productName: "AiBrain", logoPath: "/logo.svg", faviconPath: "/favicon.ico", accentColor: "#111111" }, paths: { dataRoot, companyContextRoot: path.join(dataRoot, "company"), usersRoot: path.join(dataRoot, "users"), sourceReadRoot: path.join(root, "source"), publishWriteRoot: path.join(root, "publish"), backupsRoot: path.join(dataRoot, "backups") } }));
  vi.stubEnv("AIBRAIN_INSTALLATION_CONFIG", configPath);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); auth.session = null; await rm(root, { recursive: true, force: true }); });
function session(userId: string, email: string): AuthSession { return { provider: "local", user: { id: userId, email, name: userId === ownerId ? "Owner" : "Member" }, tenant: { id: "shared-qa", name: "Shared QA" }, expiresAt: new Date(Date.now() + 60_000).toISOString() }; }
function request(pathname: string, body?: unknown) { return new Request(`https://shared.example.test${pathname}`, body === undefined ? undefined : { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
async function fixture(role: "viewer" | "editor" = "editor") {
  const installation = await loadInstallationConfig(), provisioner = new UserProvisioner(installation);
  const owner = session(ownerId, "owner@example.test"), member = session(memberId, "member@example.test"), outsider = session(outsiderId, "outsider@example.test");
  for (const identity of [owner, member, outsider]) await provisioner.provision({ userId: identity.user.id, email: identity.user.email, displayName: identity.user.name });
  const project = await createProject(owner, "Shared secret project");
  const membership: ProjectMember = { id: memberId, email: member.user.email, name: "Member", role, status: "active", addedAt: new Date().toISOString() };
  await updateProject(owner, project.id, { sharing: { visibility: "shared", members: [membership] } });
  const store = FileWorkbenchStore.fromInstallation(installation);
  const thread = await store.createThread(ownerId, project.id, "Shared secret thread", undefined, privateHistory);
  await syncOwnSharedAccess(owner);
  const ownProject = await createProject(member, "Member's own project"), ownThread = await createThread(member, ownProject.id, "Own chat");
  const ownerState = JSON.parse(await readFile(path.join(installation.paths.usersRoot, ownerId, "state", "workbench.json"), "utf8"));
  expect(ownerState.schemaVersion).toBe(historyPolicy.segmented ? 2 : 1);
  if (historyPolicy.segmented) expect(ownerState.histories.some((ref: { threadId: string }) => ref.threadId === thread.id)).toBe(true);
  const index = new FileSharedAccessIndex({ dataRoot: installation.paths.dataRoot, installationId: installation.installationId });
  auth.session = member;
  const principal = await new FileLocalUserStore(installation.paths.usersRoot).read(memberId);
  if (!principal) throw new Error("Missing synthetic member");
  return { owner, member, outsider, project, thread, ownProject, ownThread, store, index, membership, principal };
}

describe.each(["v1", "v2"] as const)("canonical shared access while a durable index update is pending (%s)", format => {
  beforeEach(() => { historyPolicy.segmented = format === "v2"; });
  it.each(["removed", "private", "invited-local"] as const)("denies %s membership in workbench/project/thread/runtime without opening revoked history", async kind => {
    const f = await fixture();
    const scan = await createReadableThreadReader(f.member);
    expect((await scan(f.thread.id)).messages[0].content).toBe(privateHistory);
    const sharing: ProjectSharing = kind === "private" ? { visibility: "private", members: [] } : { visibility: "shared", members: kind === "removed" ? [] : [{ ...f.membership, status: "invited-local" }] };
    // Persist the canonical update without its later index synchronization,
    // reproducing an interrupted owner request rather than forging a grant.
    await f.store.updateProject(ownerId, f.project.id, { sharing });
    expect(await f.index.resolve({ principal: f.principal, resourceType: "thread", resourceId: f.thread.id })).not.toBeNull();
    await expect(scan(f.thread.id)).rejects.toThrow("Fil no trobat");
    const historyRead = vi.spyOn(historyStorage, "readWorkbenchDisk");
    const fullRead = vi.spyOn(FileWorkbenchStore.prototype, "load"), metadataRead = vi.spyOn(FileWorkbenchStore.prototype, "loadAccessSnapshot");
    const snapshot = await loadSharedWorkbench(f.member);
    expect(snapshot.projects.some(project => project.id === f.project.id)).toBe(false); expect(snapshot.threads.some(thread => thread.id === f.thread.id)).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(privateHistory);
    await expect(resolveProjectAccess(f.member, f.project.id)).rejects.toThrow("Projecte no trobat");
    await expect(resolveThreadAccess(f.member, f.thread.id, { includeTurnContext: true })).rejects.toThrow("Fil no trobat");
    const runtime = await getThreadRuntimeContext(f.member, f.ownThread.id);
    expect(runtime.visibleProjects).not.toContainEqual({ id: f.project.id, name: f.project.name });
    expect(runtime.visibleProjects).toContainEqual({ id: f.ownProject.id, name: f.ownProject.name });
    expect((await projectGET(request(`/api/projects/${f.project.id}`), { params: Promise.resolve({ projectId: f.project.id }) })).status).toBe(404);
    expect((await threadGET(request(`/api/threads/${f.thread.id}`), { params: Promise.resolve({ threadId: f.thread.id }) })).status).toBe(404);
    for (const response of [await workbenchGET(), await projectsGET(request("/api/projects"))]) {
      expect(response.status).toBe(200); const text = await response.text();
      expect(text).not.toContain(f.project.id); expect(text).not.toContain(f.thread.id); expect(text).not.toContain(privateHistory);
    }
    expect(fullRead.mock.calls.some(([userId]) => userId === ownerId)).toBe(false);
    const ownerStatePath = path.join(root, "data", "users", ownerId, "state", "workbench.json");
    expect(historyRead.mock.calls.some(([file]) => file === ownerStatePath)).toBe(false);
    expect(metadataRead.mock.calls.some(([userId, threadId, options]) => userId === ownerId && (threadId !== undefined || options?.includeTurnContext))).toBe(false);
    expect(await f.index.resolve({ principal: f.principal, resourceType: "thread", resourceId: f.thread.id })).not.toBeNull();
  });

  it.each(["canonical-viewer", "indexed-viewer"] as const)("uses the stricter %s role on every projection and blocks edits and turn execution", async kind => {
    const f = await fixture(kind === "indexed-viewer" ? "viewer" : "editor");
    await f.store.updateProject(ownerId, f.project.id, { sharing: { visibility: "shared", members: [{ ...f.membership, role: kind === "canonical-viewer" ? "viewer" : "editor" }] } });
    const snapshot = await loadSharedWorkbench(f.member);
    expect(snapshot.projects.find(project => project.id === f.project.id)?.access).toEqual({ role: "viewer", canEdit: false, canManage: false });
    expect(snapshot.threads.find(thread => thread.id === f.thread.id)?.access).toEqual({ role: "viewer", canEdit: false, canManage: false });
    expect((await resolveProjectAccess(f.member, f.project.id)).role).toBe("viewer");
    expect((await resolveThreadAccess(f.member, f.thread.id)).role).toBe("viewer");
    await expect(getThreadRuntimeContext(f.member, f.thread.id)).rejects.toThrow("només lectura");
    const response = await threadGET(request(`/api/threads/${f.thread.id}`), { params: Promise.resolve({ threadId: f.thread.id }) });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ thread: { access: { role: "viewer", canEdit: false }, messages: [{ content: privateHistory }] } });
    const patch = await threadPATCH(request(`/api/threads/${f.thread.id}`, { title: "Forbidden editor action" }), { params: Promise.resolve({ threadId: f.thread.id }) });
    expect(patch.status).toBe(409); expect((await f.store.getThread(ownerId, f.thread.id)).title).toBe(f.thread.title);
  });

  it("rechecks a disabled principal within the same reader without syncing the index per selection", async () => {
    const f = await fixture();
    const scan = await createReadableThreadReader(f.member);
    const sync = vi.spyOn(FileSharedAccessIndex.prototype, "syncOwnerSnapshot");
    expect((await scan(f.ownThread.id)).id).toBe(f.ownThread.id);
    const file = path.join(root, "data", "users", memberId, "user.json");
    const user = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...user, enabled: false }));
    await expect(scan(f.ownThread.id)).rejects.toThrow("Fil no trobat");
    expect(sync).not.toHaveBeenCalled();
  });

  it("does not read any foreign metadata or history without an indexed grant", async () => {
    const f = await fixture(), metadataRead = vi.spyOn(FileWorkbenchStore.prototype, "loadAccessSnapshot"), fullRead = vi.spyOn(FileWorkbenchStore.prototype, "load");
    await expect(resolveProjectAccess(f.outsider, f.project.id)).rejects.toThrow("Projecte no trobat");
    await expect(resolveThreadAccess(f.outsider, f.thread.id)).rejects.toThrow("Fil no trobat");
    expect((await loadSharedWorkbench(f.outsider)).projects.some(project => project.id === f.project.id)).toBe(false);
    expect(metadataRead.mock.calls.some(([userId]) => userId === ownerId)).toBe(false); expect(fullRead.mock.calls.some(([userId]) => userId === ownerId)).toBe(false);
  });

  it("rejects a still-indexed thread that moved to a different private project before opening history", async () => {
    const f = await fixture(), privateProject = await f.store.createProject(ownerId, "Owner-only project");
    const file = path.join(root, "data", "users", ownerId, "state", "workbench.json");
    const state = JSON.parse(await readFile(file, "utf8")) as { threads: Array<{ id: string; projectId: string }> };
    state.threads.find(thread => thread.id === f.thread.id)!.projectId = privateProject.id;
    await writeFile(file, JSON.stringify(state), { mode: 0o600 });
    const metadataRead = vi.spyOn(FileWorkbenchStore.prototype, "loadAccessSnapshot");
    await expect(resolveThreadAccess(f.member, f.thread.id)).rejects.toThrow("Fil no trobat");
    expect(metadataRead.mock.calls.some(([userId, threadId]) => userId === ownerId && threadId === f.thread.id)).toBe(false);
  });
});
