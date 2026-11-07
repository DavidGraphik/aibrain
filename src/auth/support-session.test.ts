import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const target = "10000000-0000-4000-8000-000000000002", actor = "10000000-0000-4000-8000-000000000001";
const state = vi.hoisted(() => ({ actorEnabled: true, policyEnabled: true, policyActor: "10000000-0000-4000-8000-000000000001", revoke: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth/support-access-policy", () => ({ readSupportAccessPolicy: async () => state.policyEnabled ? { operatorUserId: state.policyActor } : null }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "__Host-aibrain-session" ? { value: "a".repeat(43) } : undefined }) }));
vi.mock("@/auth/profile-avatar", () => ({ profileAvatarOverride: () => null }));
vi.mock("@/auth/auth-context", () => ({ createLocalSessionContext: async () => ({
  installation: { installationId: "g03-production", companyName: "G03", companySlug: "g03", publicUrl: "https://g03.example", paths: { dataRoot: "/tmp/synthetic-support" } },
  sessions: { read: async () => ({ record: { installationId: "g03-production", userId: "10000000-0000-4000-8000-000000000002", sessionIdHash: "a".repeat(64), idleExpiresAt: Date.now() + 60000, absoluteExpiresAt: Date.now() + 60000,
    support: { actorUserId: "10000000-0000-4000-8000-000000000001", actorEmail: "operator@example.invalid", reason: "UI isolation acceptance" } } }), revokeUser: state.revoke },
  users: { read: async (id: string) => id === "10000000-0000-4000-8000-000000000001"
    ? { userId: id, enabled: state.actorEnabled, email: "operator@example.invalid" }
    : { userId: id, enabled: true, email: "production-alias@example.invalid", displayName: "Jordi" }, hasInitialPasswordMarker: async () => false, readAvatarUrl: async () => null },
}) }));
import { getSession } from "./session";
beforeEach(() => { state.actorEnabled = true; state.policyEnabled = true; state.policyActor = actor; });
afterEach(() => vi.unstubAllEnvs());
describe("support session authentication boundary", () => {
  it("uses actual target profile and carries explicit support provenance", async () => {
    expect(await getSession()).toMatchObject({ provider: "local", user: { id: target, name: "Jordi" }, support: { actorEmail: "operator@example.invalid" } });
  });
  it("rejects an existing support cookie after marker removal or expiry", async () => {
    state.policyEnabled = false; expect(await getSession()).toBeNull();
  });
  it("rejects an existing support cookie after marker actor changes", async () => {
    state.policyActor = target; expect(await getSession()).toBeNull();
  });
  it("rejects existing support session when operator is disabled", async () => { state.actorEnabled = false; expect(await getSession()).toBeNull(); });
});
