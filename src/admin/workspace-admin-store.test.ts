import { mkdtemp, readFile, rm, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectiveWorkspacePolicy, FileWorkspaceAdminStore } from "@/admin/workspace-admin-store";

const ownerId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
let root = "";
let previousAdmins: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aibrain-admin-"));
  previousAdmins = process.env.AIBRAIN_ADMIN_USER_IDS;
  process.env.AIBRAIN_ADMIN_USER_IDS = ownerId;
});

afterEach(async () => {
  if (previousAdmins === undefined) delete process.env.AIBRAIN_ADMIN_USER_IDS;
  else process.env.AIBRAIN_ADMIN_USER_IDS = previousAdmins;
  await rm(root, { recursive: true, force: true });
});

describe("FileWorkspaceAdminStore", () => {
  it("persists roles and groups, applies group restrictions deny-wins and audits the actor", async () => {
    const store = new FileWorkspaceAdminStore("example-qa", root, () => Date.parse("2026-08-28T10:00:00.000Z"));
    const initial = await store.read([ownerId, memberId]);
    expect(initial.assignments).toEqual([
      { userId: ownerId, roleId: "workspace-owner" },
      { userId: memberId, roleId: "workspace-member" },
    ]);

    const state = await store.mutate([ownerId, memberId], ownerId, (current) => {
      const group = store.newGroup("Finanzas", "Acceso de consulta");
      group.memberIds = [memberId];
      group.policy.apps["managed-browser"] = false;
      group.policy.capabilities.execute = false;
      current.groups.push(group);
      return { action: "group.created", targetType: "group", targetId: group.id, summary: "Grupo creado." };
    });
    const effective = effectiveWorkspacePolicy(state, memberId);
    expect(effective.policy.apps["managed-browser"]).toBe(false);
    expect(effective.policy.capabilities.execute).toBe(false);
    expect(effective.policy.capabilities.consult).toBe(true);

    const reloaded = await new FileWorkspaceAdminStore("example-qa", root).read([ownerId, memberId]);
    expect(reloaded.groups).toHaveLength(1);
    const audit = await store.auditLog();
    expect(audit).toMatchObject([{ sequence: 1, actorUserId: ownerId, action: "group.created", installationId: "example-qa" }]);
  });

  it("rejects state reuse across tenants", async () => {
    await new FileWorkspaceAdminStore("example-qa", root).read([ownerId]);
    await expect(new FileWorkspaceAdminStore("other-qa", root).read([ownerId]))
      .rejects.toThrow("another installation");
  });

  it("uses the operator bootstrap only once and never promotes later members from environment", async () => {
    const laterId = "00000000-0000-4000-8000-000000000003";
    const store = new FileWorkspaceAdminStore("example-qa", root);
    await store.read([ownerId, memberId]);

    process.env.AIBRAIN_ADMIN_USER_IDS = `${ownerId},${laterId}`;
    const reconciled = await store.read([ownerId, memberId, laterId]);
    expect(reconciled.assignments).toContainEqual({ userId: laterId, roleId: "workspace-member" });
  });

  it("fails closed when no provisioned owner is configured for first bootstrap", async () => {
    delete process.env.AIBRAIN_ADMIN_USER_IDS;
    await expect(new FileWorkspaceAdminStore("example-qa", root).read([ownerId]))
      .rejects.toThrow("Workspace owner bootstrap is required");
  });

  it("does not persist an ownerless state when bootstrap sees no users", async () => {
    const store = new FileWorkspaceAdminStore("example-qa", root);
    await expect(store.read([])).rejects.toThrow("Workspace owner bootstrap is required");
    await expect(readFile(path.join(root, "workspace-admin", "state.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not impose a hardcoded user cap on assignments or group membership", async () => {
    const memberIds = Array.from(
      { length: 501 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1_000).padStart(12, "0")}`,
    );
    const userIds = [ownerId, ...memberIds];
    const store = new FileWorkspaceAdminStore("example-qa", root);
    const initial = await store.read(userIds);
    expect(initial.assignments).toHaveLength(userIds.length);

    const updated = await store.mutate(userIds, ownerId, (current) => {
      const group = store.newGroup("Tota la plantilla", "Sense límit comercial hardcoded");
      group.memberIds = memberIds;
      current.groups.push(group);
      return { action: "group.created", targetType: "group", targetId: group.id, summary: "Grup creat." };
    });
    expect(updated.groups[0]?.memberIds).toHaveLength(memberIds.length);
  });
});

 it("durably records conversation reads without changing roles or retaining messages", async () => {
  const store = new FileWorkspaceAdminStore("example-qa", root);
  const before = await store.read([ownerId, memberId]);
  await store.recordConversationRead(ownerId, memberId, "thread-1");
  expect(await store.auditLog()).toMatchObject([{ actorUserId: ownerId, targetId: memberId, action: "member.conversations-read", summary: "Conversation thread-1 consulted" }]);
  expect(await store.read([ownerId, memberId])).toEqual(before);
 });


it("reads current policy without rewriting it and observes a later membership removal", async () => {
  const store = new FileWorkspaceAdminStore("example-qa", root);
  await store.read([ownerId, memberId]);
  await store.mutate([ownerId, memberId], ownerId, state => {
    const group = store.newGroup("Scan", "Synthetic"); group.memberIds = [memberId]; state.groups.push(group);
    return { action: "group.created", targetType: "group", targetId: group.id, summary: "Synthetic" };
  });
  const file = path.join(root, "workspace-admin", "state.json");
  const before = await lstat(file, { bigint: true });
  expect((await store.readCurrent([ownerId, memberId])).groups[0].memberIds).toEqual([memberId]);
  const after = await lstat(file, { bigint: true });
  expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.mtimeNs, before.ctimeNs]);
  await store.mutate([ownerId, memberId], ownerId, state => {
    state.groups[0].memberIds = [];
    return { action: "group.updated", targetType: "group", targetId: state.groups[0].id, summary: "Removed" };
  });
  expect((await store.readCurrent([ownerId, memberId])).groups[0].memberIds).toEqual([]);
  await expect(new FileWorkspaceAdminStore("foreign-qa", root).readCurrent([ownerId])).rejects.toThrow("another installation");
});
