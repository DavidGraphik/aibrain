import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  target: "10000000-0000-4000-8000-000000000002", actor: "10000000-0000-4000-8000-000000000001",
  targetEmail: "employee@example.invalid", support: true, ownerMode: true, enabled: true, actorEnabled: true, initial: false, policy: true,
  installation: "g03-production", actorEmail: "david@example.invalid", expired: false,
  ownerCheck: vi.fn(), revoked: false,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "a".repeat(43) }) }) }));
vi.mock("@/auth/profile-avatar", () => ({ profileAvatarOverride: () => null }));
vi.mock("@/auth/private-owner-identity-provider", () => ({
  isPrivateOwnerAuthRequested: () => state.ownerMode, isPrivateOwnerAuthConfigured: () => true,
  assertPrivateOwnerSession: state.ownerCheck,
}));
vi.mock("@/auth/support-access-policy", () => ({ readSupportAccessPolicy: async () => state.policy ? { operatorUserId: state.actor } : null }));
vi.mock("@/auth/auth-context", () => ({ createLocalSessionContext: async () => ({
  installation: { installationId: "g03-production", companyName: "G03", companySlug: "g03", publicUrl: "https://g03.example", paths: { dataRoot: "/tmp/synthetic-private-support" } },
  sessions: { read: async () => state.revoked ? null : ({ record: {
    installationId: state.installation, userId: state.target, sessionIdHash: "a".repeat(64),
    idleExpiresAt: Date.now() + (state.expired ? -1 : 60000), absoluteExpiresAt: Date.now() + 60000,
    ...(state.support ? { support: { actorUserId: state.actor, actorEmail: state.actorEmail, reason: "Employee QA with original permissions" } } : {}),
  } }), revokeUser: vi.fn() },
  users: { read: async (id: string) => id === state.target
    ? { userId: id, email: state.targetEmail, displayName: "Employee", enabled: state.enabled }
    : { userId: id, email: "david@example.invalid", enabled: state.actorEnabled },
    hasInitialPasswordMarker: async () => state.initial, readAvatarUrl: async () => null },
}) }));
import { getSession } from "./session";
beforeEach(() => {
  Object.assign(state, { target: "10000000-0000-4000-8000-000000000002", actor: "10000000-0000-4000-8000-000000000001",
    targetEmail: "employee@example.invalid", support: true, ownerMode: true, enabled: true, actorEnabled: true, initial: false, policy: true,
    installation: "g03-production", actorEmail: "david@example.invalid", expired: false, revoked: false });
  state.ownerCheck.mockReset().mockImplementation(async identity => {
    if (identity.userId !== "10000000-0000-4000-8000-000000000001" || identity.email !== "david@example.invalid") throw Error("Owner unavailable");
  });
});
describe("private owner audited employee support", () => {
  it("checks owner actor while preserving employee session identity and provenance", async () => {
    expect(await getSession()).toMatchObject({ user: { id: state.target, email: "employee@example.invalid" }, support: { actorEmail: state.actorEmail } });
    expect(state.ownerCheck).toHaveBeenCalledWith({ installationId: "g03-production", userId: state.actor, email: state.actorEmail });
  });
  it("keeps ordinary employee cookies rejected by the complete owner guard", async () => {
    state.support = false; expect(await getSession()).toBeNull();
    expect(state.ownerCheck).toHaveBeenCalledWith({ installationId: "g03-production", userId: state.target, email: "employee@example.invalid" });
  });
  it("retains ordinary owner admission without support", async () => {
    state.support = false; state.target = state.actor; state.targetEmail = "david@example.invalid";
    expect(await getSession()).toMatchObject({ user: { id: state.actor, email: state.targetEmail } });
    expect(state.ownerCheck).toHaveBeenCalledWith({ installationId: "g03-production", userId: state.actor, email: state.targetEmail });
  });
  it.each(["policy", "enabled", "actorEnabled"] as const)("denies removed/expired policy or disabled profile: %s", async key => {
    state[key] = false; expect(await getSession()).toBeNull(); expect(state.ownerCheck).not.toHaveBeenCalled();
  });
  it.each(["initial", "expired", "revoked"] as const)("denies initial-login, expired session and revocation: %s", async key => {
    state[key] = true; expect(await getSession()).toBeNull(); expect(state.ownerCheck).not.toHaveBeenCalled();
  });
  it("denies foreign installation before checking owner", async () => {
    state.installation = "trinalum-production"; expect(await getSession()).toBeNull(); expect(state.ownerCheck).not.toHaveBeenCalled();
  });
  it("denies forged actor email", async () => {
    state.actorEmail = "forged@example.invalid"; expect(await getSession()).toBeNull(); expect(state.ownerCheck).not.toHaveBeenCalled();
  });
  it("denies a non-owner actor even when the temporary policy names it", async () => {
    state.actor = "10000000-0000-4000-8000-000000000003"; expect(await getSession()).toBeNull(); expect(state.ownerCheck).toHaveBeenCalled();
  });
  it("denies unavailable/expired private QA owner profile", async () => {
    state.ownerCheck.mockRejectedValue(Error("QA profile expired")); expect(await getSession()).toBeNull();
  });
  it("does not introduce a hosted-mode owner requirement", async () => {
    state.ownerMode = false; expect(await getSession()).toMatchObject({ user: { id: state.target } }); expect(state.ownerCheck).not.toHaveBeenCalled();
  });
});
