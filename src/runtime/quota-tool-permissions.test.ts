import { describe, expect, it } from "vitest";
import {
  attestQuotaToolPermissions,
  createQuotaToolPermissions,
  hasAttestedQuotaToolPermissions,
  privateCodexToolPermissionsRequired,
  quotaToolPermissionConfigOverrides,
  quotaToolPermissionId,
} from "@/runtime/quota-tool-permissions";

const roots = {
  workspace: "/data/users/user/workspace/projects/project",
  codexHome: "/data/users/user/runtime/codex-home",
  transportAudit: "/data/users/user/audit/transport",
};

describe("quota tool permissions", () => {
  it("requires credential privacy for MODTIME independently of quotas without changing other installations", () => {
    expect(privateCodexToolPermissionsRequired({ installationId: "modtime" })).toBe(true);
    expect(privateCodexToolPermissionsRequired({ installationId: "modtime", usageLimits: null })).toBe(true);
    expect(privateCodexToolPermissionsRequired({ installationId: "trinalum" })).toBe(false);
    expect(privateCodexToolPermissionsRequired({ installationId: "trinalum-production" })).toBe(true);
    expect(privateCodexToolPermissionsRequired({ installationId: "other", usageLimits: {} })).toBe(true);
  });
  it("keeps read-only mode and exact project/temp writes while hiding private runtime state", () => {
    const policy = createQuotaToolPermissions(roots);
    const read = policy.config.permissions[policy.readOnlyId];
    const write = policy.config.permissions[policy.workspaceWriteId];
    expect(read).toEqual({ extends: ":read-only", filesystem: {
      "/etc/aibrain": "deny",
      ...Object.fromEntries([
        "sessions", "archived_sessions", "log", "logs", "memories",
        "history.jsonl", "session_index.jsonl", "config.toml", "auth.json*",
        "state_*.sqlite*", "logs_*.sqlite*", "goals_*.sqlite*", "memories_*.sqlite*", "queue_*.sqlite*", "thread_history_*.sqlite*",
      ].map((entry) => [`${roots.codexHome}/${entry}`, "deny"])),
      [roots.transportAudit]: "deny",
      [`${roots.codexHome}/skills`]: "read",
      [`${roots.codexHome}/plugins`]: "read",
      [`${roots.codexHome}/tmp/arg0`]: "read",
    } });
    expect(read.filesystem).not.toHaveProperty(roots.codexHome);
    expect(read.filesystem).not.toHaveProperty(`${roots.codexHome}/*.jsonl`);
    expect(write).toEqual({ extends: policy.readOnlyId, filesystem: {
      ":workspace_roots": "write", ":tmpdir": "write", ":slash_tmp": "write",
    } });
    expect(write.filesystem).not.toHaveProperty("/data/users/user/artifacts");
    expect(write.filesystem).not.toHaveProperty("/source-ro");
    expect(quotaToolPermissionId(policy, "read-only")).toBe(policy.readOnlyId);
    expect(quotaToolPermissionId(policy, "workspace-write")).toBe(policy.workspaceWriteId);
  });

  it("provides TOML startup definitions independent of the per-turn project root", () => {
    const overrides = quotaToolPermissionConfigOverrides(roots);
    expect(overrides[0]).toBe(`default_permissions=${JSON.stringify(createQuotaToolPermissions(roots).readOnlyId)}`);
    expect(overrides[1]).toContain(`"${roots.codexHome}/sessions"="deny"`);
    expect(overrides[1]).toContain('":workspace_roots"="write"');
    expect(overrides.join("\n")).not.toContain(roots.workspace);
    expect(quotaToolPermissionConfigOverrides({ ...roots, codexHome: '/data/users/quoted "name"/codex' })[1])
      .toContain('quoted \\"name\\"');
  });

  it("uses identical startup and project profiles for the same employee roots", () => {
    const startup = createQuotaToolPermissions({ ...roots, workspace: "/data/users/user/workspace" });
    for (const workspace of [roots.workspace, "/data/users/user/workspace/projects/another"]) {
      const project = createQuotaToolPermissions({ ...roots, workspace });
      expect(project.readOnlyId).toBe(startup.readOnlyId);
      expect(project.workspaceWriteId).toBe(startup.workspaceWriteId);
      expect(project.config).toEqual(startup.config);
      expect(project.workspace).toBe(workspace);
    }
  });

  it("accepts either attested fixed profile on warm resume, then permits a mode downgrade", () => {
    const client = {};
    const policy = createQuotaToolPermissions(roots);
    expect(hasAttestedQuotaToolPermissions(client, "thread", policy)).toBe(false);
    attestQuotaToolPermissions(client, { thread: { id: "thread" }, cwd: roots.workspace,
      activePermissionProfile: { id: policy.workspaceWriteId }, approvalPolicy: "never" }, policy);
    expect(hasAttestedQuotaToolPermissions(client, "thread", policy)).toBe(true);
    expect(quotaToolPermissionId(policy, "read-only")).toBe(policy.readOnlyId);
    expect(hasAttestedQuotaToolPermissions({}, "thread", policy)).toBe(false);
    expect(hasAttestedQuotaToolPermissions(client, "thread", createQuotaToolPermissions({
      ...roots, workspace: "/data/users/user/workspace/projects/different",
    }))).toBe(false);
  });

  it.each([
    { activePermissionProfile: null },
    { activePermissionProfile: { id: "unrestricted-profile" } },
    { cwd: "/another-project" },
    { approvalPolicy: "on-request" },
  ])("refuses missing or stale profile evidence: %j", (override) => {
    const client = {};
    const policy = createQuotaToolPermissions(roots);
    expect(() => attestQuotaToolPermissions(client, {
      thread: { id: "thread" }, cwd: roots.workspace,
      activePermissionProfile: { id: policy.readOnlyId }, approvalPolicy: "never", ...override,
    }, policy)).toThrow("permisos privados");
    expect(hasAttestedQuotaToolPermissions(client, "thread", policy)).toBe(false);
  });
});
