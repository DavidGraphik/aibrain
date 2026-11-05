import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePasswordRecoveryStore } from "@/auth/password-recovery-store";
import { LocalAuthService } from "@/auth/auth-service";
import type {
  AuthIdentityProvider,
  IdentityCredentials,
  VerifiedIdentity,
} from "@/auth/identity-provider";
import { IdentityProviderError } from "@/auth/identity-provider";
import { FileLocalAuthChallengeStore } from "@/auth/local-auth-challenge-store";
import { FileLocalSessionStore } from "@/auth/local-session-store";
import { FileLocalUserStore } from "@/auth/local-user-store";

const routeFixture = vi.hoisted(() => ({ service: null as unknown, binding: "", cookie: vi.fn(), logs: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth/auth-context", () => ({ createLocalAuthService: async () => routeFixture.service }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: async () => true }));
vi.mock("@/auth/rate-limit-context", () => ({ checkAuthRateLimit: async () => ({ allowed: true, retryAfterSeconds: 60 }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: routeFixture.binding }) }) }));
vi.mock("@/auth/session-cookie", () => ({ PASSWORD_RECOVERY_COOKIE: "synthetic-recovery-cookie", clearPasswordRecoveryCookie: async () => { routeFixture.binding = ""; }, setLocalSessionCookie: (...args: unknown[]) => routeFixture.cookie(...args) }));
vi.mock("@/operations/server-logger", () => ({ operationalLogger: { info: (...args: unknown[]) => routeFixture.logs(...args), warn: (...args: unknown[]) => routeFixture.logs(...args), error: (...args: unknown[]) => routeFixture.logs(...args) } }));
import { POST as completeRecoveryRoute } from "@/app/api/auth/password/recovery/route";
beforeEach(() => { routeFixture.binding = ""; routeFixture.logs.mockClear(); routeFixture.cookie.mockClear(); });

const USER_ID = "0198b9f0-6631-7000-8000-000000000010";
const identity: VerifiedIdentity = {
  userId: USER_ID,
  email: "employee@example.test",
  accessToken: "access-token-synthetic-0001",
  refreshToken: "refresh-token-synthetic-001",
};
const roots: string[] = [];

class FakeIdentityProvider implements AuthIdentityProvider {
  available = true;
  passwordUpdates = 0;
  recoveryRequests = 0;
  signOuts = 0;
  lastVerifier = "";
  lastProof: import("@/auth/identity-provider").RecoveryVerificationProof | null = null;
  recoveryIdentity = identity;

  private check() {
    if (!this.available) throw new IdentityProviderError("provider_unavailable", "offline");
  }
  async verifyPassword(email: string, password: string) {
    this.check();
    if (email !== identity.email || password !== "Temporary-pass-123") {
      throw new IdentityProviderError("invalid_credentials", "invalid");
    }
    return identity;
  }
  async updatePassword(_credentials: IdentityCredentials, _password: string) {
    this.check();
    this.passwordUpdates += 1;
  }
  async requestPasswordRecovery(_email: string, _redirectTo: string, codeVerifier: string) {
    this.lastVerifier = codeVerifier;
    this.check();
    this.recoveryRequests += 1;
  }
  async verifyPasswordRecovery(proof: import("@/auth/identity-provider").RecoveryVerificationProof) {
    this.lastProof = proof;
    this.check();
    return this.recoveryIdentity;
  }
  async signOut(_credentials: IdentityCredentials) {
    this.signOuts += 1;
  }
}

async function fixture(initialPassword = false) {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-auth-service-"));
  roots.push(root);
  const usersRoot = path.join(root, "users");
  const userRoot = path.join(usersRoot, USER_ID);
  await mkdir(userRoot, { recursive: true });
  await writeFile(path.join(userRoot, "user.json"), JSON.stringify({
    schemaVersion: 1,
    userId: USER_ID,
    email: identity.email,
    displayName: "Synthetic Employee",
    enabled: true,
    workerId: "synthetic-employee",
  }));
  if (initialPassword) await writeFile(path.join(userRoot, "password-change-required"), "1\n");
  const provider = new FakeIdentityProvider();
  const sessions = new FileLocalSessionStore({ rootDirectory: path.join(root, "sessions") });
  const users = new FileLocalUserStore(usersRoot);
  const challenges = new FileLocalAuthChallengeStore({
    rootDirectory: path.join(root, "challenges"),
  });
  const service = new LocalAuthService("example-lab-dev", provider, users, sessions, challenges,
    new FilePasswordRecoveryStore({ rootDirectory: path.join(root, "recovery") }), "https://brain.example.test");
  return { provider, sessions, users, service, root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalAuthService", () => {
  it("exchanges provider credentials for an opaque local session that survives provider outage", async () => {
    const { provider, sessions, service } = await fixture();
    const result = await service.login(identity.email, "Temporary-pass-123");
    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") throw new Error("unexpected result");
    provider.available = false;

    expect(await sessions.read(result.session.sessionId, "example-lab-dev")).toMatchObject({
      record: { userId: USER_ID },
    });
    expect(provider.signOuts).toBe(1);
  });

  it("requires a one-time initial password change before issuing the workbench session", async () => {
    const { provider, sessions, users, service, root } = await fixture(true);
    const challenge = await service.login(identity.email, "Temporary-pass-123");
    expect(challenge.kind).toBe("password_change_required");
    if (challenge.kind !== "password_change_required") throw new Error("unexpected result");

    const storedChallenge = await readFile(path.join(
      root,
      "challenges",
      "records",
      `${createHash("sha256").update(challenge.challengeId).digest("hex")}.json`,
    ), "utf8");
    expect(storedChallenge).not.toContain(identity.accessToken);
    expect(storedChallenge).not.toContain(identity.refreshToken);

    const authenticated = await service.changeInitialPassword(
      challenge.challengeId,
      "Permanent-pass-456",
    );
    expect(provider.passwordUpdates).toBe(1);
    expect(await users.hasInitialPasswordMarker(USER_ID)).toBe(false);
    expect(await sessions.read(authenticated.session.sessionId, "example-lab-dev")).not.toBeNull();
    await expect(service.changeInitialPassword(challenge.challengeId, "Permanent-pass-789"))
      .rejects.toMatchObject({ code: "challenge_invalid" });
  });

  it("supports recovery without exposing provider tokens and revokes prior local sessions", async () => {
    const { provider, service, sessions } = await fixture();
    const old = await sessions.create("example-lab-dev", USER_ID);
    const otherInstallation = await sessions.create("other-lab-dev", USER_ID);
    await service.requestPasswordRecovery(identity.email, "https://brain.example.test/auth/recovery");
    const authenticated = await service.completePasswordRecovery(
      { tokenHash: "synthetic-token-hash" },
      "Recovered-pass-789",
    );
    expect(provider.recoveryRequests).toBe(1);
    expect(provider.passwordUpdates).toBe(1);
    expect(authenticated.user.userId).toBe(USER_ID);
    expect(await sessions.read(old.sessionId, "example-lab-dev")).toBeNull();
    expect(await sessions.read(authenticated.session.sessionId, "example-lab-dev")).not.toBeNull();
    expect(await sessions.read(authenticated.session.sessionId, "other-lab-dev")).toBeNull();
    expect(await sessions.read(otherInstallation.sessionId, "other-lab-dev")).not.toBeNull();
    expect(provider.signOuts).toBe(1);
  });

  it.each(["missing", "disabled", "mismatched-email"])("blocks recovery for a %s local profile before updating the provider password", async (kind) => {
    const { root, provider, service } = await fixture();
    const profile = path.join(root, "users", USER_ID, "user.json");
    if (kind === "missing") await rm(profile);
    else {
      const record = JSON.parse(await readFile(profile, "utf8"));
      if (kind === "disabled") record.enabled = false;
      else record.email = "foreign@example.test";
      await writeFile(profile, JSON.stringify(record));
    }
    await expect(service.completePasswordRecovery({ tokenHash: "synthetic-hash" }, "Recovered-pass-123"))
      .rejects.toMatchObject({ code: kind === "disabled" ? "profile_disabled" : "profile_unavailable" });
    expect(provider.passwordUpdates).toBe(0);
    expect(provider.signOuts).toBe(1);
  });


  it("completes default-template PKCE recovery with the original browser binding and a server-only verifier", async () => {
    const { service, provider } = await fixture();
    const pending = await service.requestPasswordRecovery(identity.email, "https://brain.example.test/auth/recovery");
    expect(pending).not.toHaveProperty("codeVerifier");
    expect(provider.lastVerifier).toHaveLength(64);
    const authenticated = await service.completePasswordRecovery({ code: "synthetic-provider-code" }, "Recovered-pass-123", pending.recoveryId);
    expect(provider.lastProof).toEqual({ code: "synthetic-provider-code", codeVerifier: provider.lastVerifier });
    expect(authenticated.user.userId).toBe(USER_ID);
    expect(provider.signOuts).toBe(1);
    await expect(service.completePasswordRecovery({ code: "synthetic-provider-code" }, "Recovered-pass-123", pending.recoveryId))
      .rejects.toMatchObject({ code: "invalid_recovery" });
    expect(provider.passwordUpdates).toBe(1);
  });

  it("rejects missing browser state and validates the password before consuming the verifier", async () => {
    const { service, provider } = await fixture();
    const pending = await service.requestPasswordRecovery(identity.email, "https://brain.example.test/auth/recovery");
    await expect(service.completePasswordRecovery({ code: "synthetic-code" }, "Recovered-pass-123"))
      .rejects.toMatchObject({ code: "invalid_recovery" });
    await expect(service.completePasswordRecovery({ code: "synthetic-code" }, "short", pending.recoveryId))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(provider.lastProof).toBeNull();
    await service.completePasswordRecovery({ code: "synthetic-code" }, "Recovered-pass-123", pending.recoveryId);
    expect(provider.passwordUpdates).toBe(1);
  });

  it("rejects a provider identity differing from the requested email before password mutation", async () => {
    const { service, provider } = await fixture();
    const pending = await service.requestPasswordRecovery(identity.email, "https://brain.example.test/auth/recovery");
    provider.recoveryIdentity = { ...identity, email: "foreign@example.test" };
    await expect(service.completePasswordRecovery({ code: "synthetic-code" }, "Recovered-pass-123", pending.recoveryId))
      .rejects.toMatchObject({ code: "invalid_recovery" });
    expect(provider.passwordUpdates).toBe(0);
    expect(provider.signOuts).toBe(1);
  });

  it("returns indistinguishable browser state for provider rejection or outage", async () => {
    const { service, provider } = await fixture(); provider.available = false;
    const pending = await service.requestPasswordRecovery("unknown@example.test", "https://brain.example.test/auth/recovery");
    expect(pending.recoveryId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending).not.toHaveProperty("codeVerifier");
    await expect(service.requestPasswordRecovery(identity.email, "https://foreign.example.test/auth/recovery"))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("labels an update rejection after consuming the PKCE proof and cannot replay it", async () => {
    const { service, provider } = await fixture();
    const pending = await service.requestPasswordRecovery(identity.email, "https://brain.example.test/auth/recovery");
    const update = vi.spyOn(provider, "updatePassword").mockRejectedValue(new IdentityProviderError("provider_rejected", "UNSAFE_PROVIDER_DETAIL", { updateOutcome: "rejected", providerCode: "weak_password", providerStatus: 422 }));
    const failure = await service.completePasswordRecovery({ code: "synthetic-code" }, "Recovered-pass-123", pending.recoveryId).catch(error => error);
    expect(failure).toMatchObject({ code: "provider_rejected", phase: "password_update", changeState: "not_changed" });
    expect(JSON.stringify(failure)).not.toContain("UNSAFE_PROVIDER_DETAIL");
    await expect(service.completePasswordRecovery({ code: "synthetic-code" }, "Recovered-pass-123", pending.recoveryId)).rejects.toMatchObject({ code: "invalid_recovery" });
    expect(update).toHaveBeenCalledOnce();
  });
  it("reports a changed password when local session persistence fails without inventing authentication", async () => {
    const { service, sessions } = await fixture();
    const pending = await service.requestPasswordRecovery(identity.email, "https://brain.example.test/auth/recovery");
    vi.spyOn(sessions, "create").mockRejectedValue(Object.assign(Error("UNSAFE_PATH_AND_CREDENTIAL"), { code: "ENOSPC" }));
    const failure = await service.completePasswordRecovery({ code: "synthetic-code" }, "Recovered-pass-123", pending.recoveryId).catch(error => error);
    expect(failure).toMatchObject({ phase: "session_create", changeState: "changed", localCode: "ENOSPC" });
    expect(JSON.stringify(failure)).not.toContain("UNSAFE_PATH_AND_CREDENTIAL");
  });
  it("revokes the old local session before marker cleanup even if that cleanup fails after password update", async () => {
    const { service, sessions, users } = await fixture();
    const old = await service.login(identity.email, "Temporary-pass-123");
    if (old.kind !== "authenticated") throw Error("fixture login");
    const pending = await service.requestPasswordRecovery(identity.email, "https://brain.example.test/auth/recovery");
    vi.spyOn(users, "clearInitialPasswordMarker").mockRejectedValue(Object.assign(Error("UNSAFE_LOCAL_PATH"), { code: "EIO" }));
    const failure = await service.completePasswordRecovery({ code: "synthetic-code" }, "Recovered-pass-123", pending.recoveryId).catch(error => error);
    expect(failure).toMatchObject({ phase: "initial_marker", changeState: "changed" });
    expect(await sessions.read(old.session.sessionId, "example-lab-dev")).toBeNull();
  });

  it.each(["provider-rejected", "session-store-failed"] as const)("routes an actual encrypted PKCE completion failure (%s) without 401/replay or secret diagnostics", async scenario => {
    const { service, sessions, provider } = await fixture();
    routeFixture.service = service;
    const pending = await service.requestPasswordRecovery(identity.email, "https://brain.example.test/auth/recovery");
    routeFixture.binding = pending.recoveryId;
    const update = vi.spyOn(provider, "updatePassword");
    if (scenario === "provider-rejected") update.mockRejectedValue(new IdentityProviderError("provider_rejected", "UNSAFE_PROVIDER_DETAIL", { providerCode: "weak_password", providerStatus: 422, updateOutcome: "rejected" }));
    else vi.spyOn(sessions, "create").mockRejectedValue(Object.assign(Error("UNSAFE_LOCAL_PATH"), { code: "ENOSPC" }));
    const submit = () => completeRecoveryRoute(new Request("https://brain.example.test/api/auth/password/recovery", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "synthetic-code", password: "Recovered-pass-123", confirmation: "Recovered-pass-123" }) }));
    const first = await submit();
    expect(first.status).toBe(scenario === "provider-rejected" ? 422 : 503);
    expect(await first.json()).toMatchObject({ nextStep: scenario === "provider-rejected" ? "new_link" : "sign_in", code: scenario === "provider-rejected" ? "recovery_password_rejected" : "recovery_session_unavailable" });
    expect(routeFixture.cookie).not.toHaveBeenCalled();
    routeFixture.binding = pending.recoveryId; // even a stale browser cookie cannot replay the durable claim
    expect((await submit()).status).toBe(410); expect(update).toHaveBeenCalledOnce();
    const logs = JSON.stringify(routeFixture.logs.mock.calls);
    for (const unsafe of ["UNSAFE_", pending.recoveryId, provider.lastVerifier, identity.accessToken, identity.refreshToken, identity.email, "Recovered-pass-123", "synthetic-code"]) expect(logs).not.toContain(unsafe);
    expect(routeFixture.logs).toHaveBeenCalledWith("auth.recovery_failed", expect.objectContaining({ phase: scenario === "provider-rejected" ? "password_update" : "session_create", changeState: scenario === "provider-rejected" ? "not_changed" : "changed" }));
  });

  it("does not issue authentication when old-session revocation fails after the provider changed the password", async () => {
    const { service, sessions } = await fixture();
    const pending = await service.requestPasswordRecovery(identity.email, "https://brain.example.test/auth/recovery");
    vi.spyOn(sessions, "revokeUser").mockRejectedValue(Object.assign(Error("UNSAFE_REVOCATION_PATH"), { code: "EIO" }));
    const issue = vi.spyOn(sessions, "create");
    const failure = await service.completePasswordRecovery({ code: "synthetic-code" }, "Recovered-pass-123", pending.recoveryId).catch(error => error);
    expect(failure).toMatchObject({ phase: "session_revocation", changeState: "changed", localCode: "EIO" });
    expect(issue).not.toHaveBeenCalled();
  });

});
