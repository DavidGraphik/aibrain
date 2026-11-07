import { describe, expect, it, vi } from "vitest";
import { defaultWorkspacePolicy, type WorkspaceGroup } from "@/admin/contracts";
import type { LocalUser } from "@/auth/local-user-store";
import { DEFAULT_AUTOMATION_EXECUTION_CONTEXT, type AutomationTask } from "@/automations/contracts";
import {
  canonicalAutomationUsers,
  canonicalizeAutomationAudience,
  invalidAutomationAudienceTargets,
  resolveCurrentAutomationAudience,
} from "@/automations/audience-policy";
import { validateAutomationAudience, visibleAutomationTasks, type AutomationWorkspaceContext } from "@/automations/server-service";

vi.mock("server-only", () => ({}));

const ownerId = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const userC = "00000000-0000-4000-8000-000000000003";
const disabledId = "00000000-0000-4000-8000-000000000004";
const foreignId = "00000000-0000-4000-8000-000000000099";
const groupId = "00000000-0000-4000-8000-000000000010";

const users: LocalUser[] = [
  { schemaVersion: 1, userId: ownerId, email: "owner@example.com", displayName: "Owner", enabled: true, workerId: "owner-worker" },
  { schemaVersion: 1, userId: userB, email: "b@example.com", displayName: "B", enabled: true, workerId: "b-worker" },
  { schemaVersion: 1, userId: userC, email: "c@example.com", displayName: "C", enabled: true, workerId: "c-worker" },
  { schemaVersion: 1, userId: disabledId, email: "disabled@example.com", displayName: "Disabled", enabled: false, workerId: "disabled-worker" },
];

function group(memberIds: string[]): WorkspaceGroup {
  return {
    id: groupId,
    name: "Operaciones",
    description: "",
    memberIds,
    policy: defaultWorkspacePolicy(),
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function task(audience: AutomationTask["audience"]): AutomationTask {
  return {
    schemaVersion: 1,
    id: "10000000-0000-4000-8000-000000000001",
    installationId: "audience-qa",
    userId: ownerId,
    audience,
    name: "Informe",
    prompt: "Prepara el informe.",
    projectId: "20000000-0000-4000-8000-000000000001",
    projectName: "Operaciones",
    timeZone: "Europe/Madrid",
    schedule: { kind: "daily", hour: 9, minute: 0 },
    executionContext: DEFAULT_AUTOMATION_EXECUTION_CONTEXT,
    state: "active",
    nextRunAt: "2026-08-31T07:00:00.000Z",
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    retryAt: null,
    manualRun: null,
    deletedAt: null,
    cancellationRequestedAt: null,
    lease: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function workspace(groups: WorkspaceGroup[]): AutomationWorkspaceContext {
  return {
    installation: {
      schemaVersion: 1,
      installationId: "audience-qa",
      companyName: "Audience QA",
      companySlug: "audience-qa",
      publicUrl: "http://localhost:3000",
      branding: { productName: "AiBrain", logoPath: "/logo.svg", faviconPath: "/favicon.ico", accentColor: "#111111" },
      paths: { dataRoot: "/tmp/data", companyContextRoot: "/tmp/company", usersRoot: "/tmp/users", sourceReadRoot: "/tmp/source", publishWriteRoot: "/tmp/publish", backupsRoot: "/tmp/backups" },
    },
    users,
    state: {
      schemaVersion: 1,
      installationId: "audience-qa",
      revision: 1,
      roles: [],
      assignments: [],
      groups,
    },
  };
}

describe("automation current-membership audience", () => {
  it("supports owner-only and two direct users", () => {
    expect([...resolveCurrentAutomationAudience({ membershipPolicy: "current", userIds: [ownerId], groupIds: [] }, users, [])])
      .toEqual([ownerId]);
    expect([...resolveCurrentAutomationAudience({ membershipPolicy: "current", userIds: [userB, userC], groupIds: [] }, users, [])])
      .toEqual([userB, userC]);
  });

  it("resolves a group at read time, deduplicates mixed selectors, and revokes removed or disabled members", () => {
    const audience = { membershipPolicy: "current" as const, userIds: [userB, disabledId], groupIds: [groupId] };
    expect([...resolveCurrentAutomationAudience(audience, users, [group([userB, userC, disabledId])])].sort())
      .toEqual([userB, userC].sort());
    expect([...resolveCurrentAutomationAudience(audience, users, [group([])])])
      .toEqual([userB]);
  });

  it("normalizes duplicate local profiles to one recipient identity", () => {
    const duplicateId = "00000000-0000-4000-8000-000000000005";
    const duplicate = {
      schemaVersion: 1 as const,
      userId: duplicateId,
      email: "b@example.com",
      displayName: "B Full Name",
      enabled: true,
      workerId: "b-full-worker",
    };
    const duplicatedUsers = [...users, duplicate];
    expect(canonicalAutomationUsers(duplicatedUsers).filter(({ email }) => email === "b@example.com"))
      .toEqual([duplicate]);
    expect(canonicalizeAutomationAudience({
      membershipPolicy: "current",
      userIds: [userB, duplicateId],
      groupIds: [],
    }, duplicatedUsers)).toEqual({
      membershipPolicy: "current",
      userIds: [duplicateId],
      groupIds: [],
    });
    expect([...resolveCurrentAutomationAudience({
      membershipPolicy: "current",
      userIds: [userB],
      groupIds: [groupId],
    }, duplicatedUsers, [group([duplicateId])])].sort()).toEqual([userB, duplicateId].sort());
    expect([...resolveCurrentAutomationAudience({
      membershipPolicy: "current",
      userIds: [duplicateId],
      groupIds: [],
    }, duplicatedUsers, [])]).toEqual([duplicateId]);
    expect([...resolveCurrentAutomationAudience({
      membershipPolicy: "current",
      userIds: [duplicateId],
      groupIds: [],
    }, duplicatedUsers, [])]).not.toContain(userB);
  });

  it("rejects cross-company, removed, and disabled target ids", () => {
    const audience = { membershipPolicy: "current" as const, userIds: [foreignId, disabledId], groupIds: [foreignId] };
    expect(invalidAutomationAudienceTargets(audience, users, [group([])]))
      .toEqual({ userIds: [foreignId, disabledId], groupIds: [foreignId] });
    expect(() => validateAutomationAudience(audience, workspace([group([])])))
      .toThrow("ajenos a esta empresa");
  });

  it("keeps owner management separate from audience result visibility and lets admins follow existing policy", () => {
    const automation = task({ membershipPolicy: "current", userIds: [userB], groupIds: [] });
    expect(visibleAutomationTasks([automation], ownerId, workspace([]), false)[0]?.access)
      .toEqual({ canManage: true, canViewResults: false });
    expect(visibleAutomationTasks([automation], userB, workspace([]), false)[0]?.access)
      .toEqual({ canManage: false, canViewResults: true });
    expect(visibleAutomationTasks([automation], userC, workspace([]), false)).toEqual([]);
    expect(visibleAutomationTasks([automation], userC, workspace([]), true)[0]?.access)
      .toEqual({ canManage: true, canViewResults: true });
  });
});
