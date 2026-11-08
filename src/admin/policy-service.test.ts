import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";
import { workspacePolicyForIdentity } from "./policy-service";
import { FileWorkspaceAdminStore } from "./workspace-admin-store";
vi.mock("server-only", () => ({}));

const owner = randomUUID(), member = randomUUID(), disabled = randomUUID();
let root: string, usersRoot: string, config: InstallationConfig;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "workspace-profile-policy-"));
  usersRoot = path.join(root, "users"); await mkdir(usersRoot, { mode: 0o700 });
  config = { installationId: "example-qa", paths: { dataRoot: root, usersRoot } } as InstallationConfig;
  vi.stubEnv("AIBRAIN_ADMIN_USER_IDS", owner);
  await profile(owner);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function profile(userId: string, enabled = true) {
  await mkdir(path.join(usersRoot, userId), { recursive: true, mode: 0o700 });
  await writeFile(path.join(usersRoot, userId, "user.json"), JSON.stringify({ schemaVersion: 1, userId, email: `${userId}@example.test`, displayName: "Synthetic", enabled, workerId: "synthetic-worker" }));
}
const lookup = (id = owner) => workspacePolicyForIdentity(config.installationId, id, config);
const statePath = () => path.join(root, "workspace-admin", "state.json");

it("repeated normal policy lookups never provision preserved orphan worker directories", async () => {
  const orphans = Array.from({ length: 8 }, () => randomUUID());
  for (const id of orphans) {
    await mkdir(path.join(usersRoot, id, "worker"), { recursive: true });
    await writeFile(path.join(usersRoot, id, "worker", "audit.txt"), "Preserved worker evidence");
  }
  for (let i = 0; i < 3; i++) expect((await lookup()).roleId).toBe("workspace-owner");
  const state = JSON.parse(await readFile(statePath(), "utf8"));
  expect(state.assignments).toEqual([{ userId: owner, roleId: "workspace-owner" }]);
  await expect(lookup(orphans[0])).rejects.toThrow("not provisioned");
  for (const id of orphans) expect(await readFile(path.join(usersRoot, id, "worker", "audit.txt"), "utf8")).toBe("Preserved worker evidence");
});

it("removes a deleted profile's assignments without recreating them and preserves real disabled profiles, roles and groups", async () => {
  await profile(member); await profile(disabled, false);
  const store = new FileWorkspaceAdminStore(config.installationId, root);
  await store.mutate([owner, member, disabled], owner, state => {
    state.assignments.find(item => item.userId === disabled)!.roleId = "workspace-admin";
    const group = store.newGroup("Reference", "Synthetic restriction"); group.memberIds = [member, disabled]; group.policy.capabilities.execute = false; state.groups.push(group);
    return { action: "group.created", targetType: "group", targetId: group.id, summary: "Synthetic" };
  });
  await mkdir(path.join(usersRoot, member, "worker"));
  await writeFile(path.join(usersRoot, member, "worker", "audit.txt"), "Keep");
  await unlink(path.join(usersRoot, member, "user.json"));
  for (let i = 0; i < 3; i++) {
    expect((await lookup()).roleId).toBe("workspace-owner");
    const reference = await lookup(disabled);
    expect(reference.roleId).toBe("workspace-admin"); expect(reference.policy.capabilities.execute).toBe(false);
    expect(reference.groups[0].memberIds).toEqual([disabled]);
  }
  const state = JSON.parse(await readFile(statePath(), "utf8"));
  expect(state.assignments.map((item: { userId: string }) => item.userId).sort()).toEqual([owner, disabled].sort());
  await expect(lookup(member)).rejects.toThrow("not provisioned");
  expect(await readFile(path.join(usersRoot, member, "worker", "audit.txt"), "utf8")).toBe("Keep");
});

it.each(["malformed", "mismatched", "symlink"])("fails closed on a %s profile before policy reconciliation", async kind => {
  await lookup(); const before = await readFile(statePath());
  const id = randomUUID(); await profile(id);
  const file = path.join(usersRoot, id, "user.json");
  if (kind === "malformed") await writeFile(file, "{invalid");
  if (kind === "mismatched") {
    const value = JSON.parse(await readFile(file, "utf8")); value.userId = randomUUID(); await writeFile(file, JSON.stringify(value));
  }
  if (kind === "symlink") { await unlink(file); await symlink(path.join(usersRoot, owner, "user.json"), file); }
  await expect(lookup(id)).rejects.toThrow(); await expect(lookup()).rejects.toThrow();
  expect(await readFile(statePath())).toEqual(before);
});

it("denies missing and symlink-directory identities without bootstrapping assignments", async () => {
  const missing = randomUUID(), linked = randomUUID();
  await symlink(path.join(usersRoot, owner), path.join(usersRoot, linked));
  await expect(lookup(missing)).rejects.toThrow("not provisioned");
  await expect(lookup(linked)).rejects.toThrow("not provisioned");
  await expect(workspacePolicyForIdentity("foreign-qa", owner, config)).rejects.toThrow("does not belong");
  await expect(readFile(statePath())).rejects.toMatchObject({ code: "ENOENT" });
});
