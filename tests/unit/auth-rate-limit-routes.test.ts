import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  check: vi.fn(),
  sameOrigin: vi.fn(),
  login: vi.fn(),
  requestPasswordRecovery: vi.fn(),
  completePasswordRecovery: vi.fn(),
  changeInitialPassword: vi.fn(),
  clearAuthChallengeCookie: vi.fn(),
  setRecoveryCookie: vi.fn(),
  clearRecoveryCookie: vi.fn(),
  setSessionCookie: vi.fn(),
  logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(),
  challengeId: "initial-password-challenge-secret",
}));

vi.mock("server-only", () => ({}));
vi.mock("@/operations/server-logger", () => ({ operationalLogger: { info: (...args: unknown[]) => mocked.logInfo(...args), warn: (...args: unknown[]) => mocked.logWarn(...args), error: (...args: unknown[]) => mocked.logError(...args) } }));
vi.mock("@/auth/request-security", () => ({
  isSameOriginMutation: (...args: unknown[]) => mocked.sameOrigin(...args),
}));
vi.mock("@/auth/rate-limit-context", () => ({
  checkAuthRateLimit: (...args: unknown[]) => mocked.check(...args),
}));
vi.mock("@/auth/auth-context", () => ({
  createLocalAuthService: async () => ({
    login: mocked.login,
    requestPasswordRecovery: mocked.requestPasswordRecovery,
    completePasswordRecovery: mocked.completePasswordRecovery,
    changeInitialPassword: mocked.changeInitialPassword,
  }),
}));
vi.mock("@/auth/public-url", () => ({
  getPublicOrigin: async () => "https://brain.example.test",
}));
vi.mock("@/auth/session", () => ({
  getAuthMode: () => "supabase",
  createDemoSession: async () => null,
}));
vi.mock("@/auth/session-cookie", () => ({
  LOCAL_AUTH_CHALLENGE_COOKIE: "aibrain_auth_challenge",
  clearAuthChallengeCookie: (...args: unknown[]) => mocked.clearAuthChallengeCookie(...args),
  setAuthChallengeCookie: async () => undefined,
  setLocalSessionCookie: (...args: unknown[]) => mocked.setSessionCookie(...args),
  PASSWORD_RECOVERY_COOKIE: "__Host-aibrain-password-recovery",
  setPasswordRecoveryCookie: (...args: unknown[]) => mocked.setRecoveryCookie(...args),
  clearPasswordRecoveryCookie: (...args: unknown[]) => mocked.clearRecoveryCookie(...args),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => ({ value: mocked.challengeId }),
  }),
}));

import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as recoveryPost } from "@/app/api/auth/password/recovery/route";
import { POST as resetRequestPost } from "@/app/api/auth/password/reset/request/route";
import { POST as initialChangePost } from "@/app/api/auth/password/change-initial/route";
import { RecoveryCompletionError } from "@/auth/recovery-outcome";
import { LocalAuthError } from "@/auth/auth-service";
import { IdentityProviderError } from "@/auth/identity-provider";

function request(pathname: string, body: Record<string, unknown>) {
  return new Request(`https://brain.example.test${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": "192.0.2.50",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.completePasswordRecovery.mockReset();
  mocked.setSessionCookie.mockReset(); mocked.clearRecoveryCookie.mockReset();
  mocked.sameOrigin.mockResolvedValue(true);
  mocked.check.mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });
});

describe("auth route rate limits", () => {
  it("returns 429 with retry metadata before calling the login provider", async () => {
    mocked.check.mockResolvedValue({ allowed: false, retryAfterSeconds: 321 });
    const response = await loginPost(request("/api/auth/login", {
      email: "Person@Example.test",
      password: "wrong-password",
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("321");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocked.login).not.toHaveBeenCalled();
    expect(mocked.check).toHaveBeenCalledWith(
      expect.any(Request),
      "login",
      "email:person@example.test",
    );
  });

  it("keeps password-reset requests indistinguishable and never calls the provider when limited", async () => {
    mocked.check.mockResolvedValue({ allowed: false, retryAfterSeconds: 1_800 });
    const response = await resetRequestPost(request("/api/auth/password/reset/request", {
      email: "person@example.test",
    }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocked.requestPasswordRecovery).not.toHaveBeenCalled();

    mocked.check.mockRejectedValue(new Error("corrupt bucket"));
    const unavailable = await resetRequestPost(request("/api/auth/password/reset/request", {
      email: "other@example.test",
    }));
    expect(unavailable.status).toBe(202);
    expect(await unavailable.json()).toEqual({ accepted: true });
    expect(mocked.requestPasswordRecovery).not.toHaveBeenCalled();
  });

  it("limits recovery proof completion before verifying the code or token", async () => {
    mocked.check.mockResolvedValue({ allowed: false, retryAfterSeconds: 900 });
    const response = await recoveryPost(request("/api/auth/password/recovery", {
      code: "provider-recovery-code",
      password: "Permanent-pass-123",
      confirmation: "Permanent-pass-123",
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("900");
    expect(mocked.completePasswordRecovery).not.toHaveBeenCalled();
    expect(mocked.check).toHaveBeenCalledWith(
      expect.any(Request),
      "password-recovery-complete",
      "code:provider-recovery-code",
    );
  });

  it("limits initial password changes by client and opaque challenge subject", async () => {
    mocked.check.mockResolvedValue({ allowed: false, retryAfterSeconds: 600 });
    const response = await initialChangePost(request("/api/auth/password/change-initial", {
      password: "Permanent-pass-123",
      confirmation: "Permanent-pass-123",
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("600");
    expect(mocked.changeInitialPassword).not.toHaveBeenCalled();
    expect(mocked.check).toHaveBeenCalledWith(
      expect.any(Request),
      "initial-password-change",
      `challenge:${mocked.challengeId}`,
    );
  });

  it("keeps a provider password rejection retryable instead of expiring the challenge", async () => {
    mocked.changeInitialPassword.mockRejectedValue(new IdentityProviderError(
      "provider_rejected",
      "provider rejected password",
    ));
    const response = await initialChangePost(request("/api/auth/password/change-initial", {
      password: "Permanent-pass-123",
      confirmation: "Permanent-pass-123",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "El proveïdor ha rebutjat la contrasenya. Tria una contrasenya diferent i torna-ho a provar.",
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocked.clearAuthChallengeCookie).not.toHaveBeenCalled();
  });
});


describe("password recovery route", () => {
  const valid = { tokenHash: "synthetic-hash", password: "Recovered-pass-123", confirmation: "Recovered-pass-123" };

  it("rejects a foreign origin before checking proof or touching the provider", async () => {
    mocked.sameOrigin.mockResolvedValue(false);
    expect((await recoveryPost(request("/api/auth/password/recovery", valid))).status).toBe(403);
    expect(mocked.check).not.toHaveBeenCalled();
    expect(mocked.completePasswordRecovery).not.toHaveBeenCalled();
  });

  it("returns expired status for expired or previously consumed proofs without leaking details", async () => {
    mocked.completePasswordRecovery.mockRejectedValue(new IdentityProviderError("invalid_recovery", "synthetic-provider-detail"));
    const response = await recoveryPost(request("/api/auth/password/recovery", valid));
    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).not.toContain("synthetic-provider-detail");
  });

  it("does not turn a password update rejection into authentication failure or invite replay", async () => {
    mocked.completePasswordRecovery.mockRejectedValue(new IdentityProviderError("provider_rejected", "UNSAFE_PROVIDER_DETAIL", { providerCode: "weak_password", providerStatus: 422, updateOutcome: "rejected" }));
    const response = await recoveryPost(request("/api/auth/password/recovery", valid));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "recovery_password_rejected", nextStep: "new_link" });
    expect(mocked.clearRecoveryCookie).toHaveBeenCalledOnce();
  });

  it.each([
    ["password_update", "not_changed", "provider_rejected", "weak_password", 422, "recovery_password_rejected", "new_link"],
    ["password_update", "not_changed", "provider_rejected", "reauthentication_needed", 403, "recovery_verification_required", "sign_in"],
    ["password_update", "not_changed", "provider_rejected", "other", 422, "recovery_provider_rejected", "new_link"],
    ["proof_exchange", "not_changed", "provider_unavailable", "other", 503, "recovery_unavailable", "new_link"],
    ["password_update", "unknown", "provider_unavailable", "transport_error", 503, "recovery_change_unconfirmed", "sign_in"],
    ["session_create", "changed", "provider_unavailable", "other", 503, "recovery_session_unavailable", "sign_in"],
    ["local_profile", "not_changed", "profile_disabled", "other", 403, "recovery_account_unavailable", "sign_in"],
  ] as const)("classifies phase %s, outcome %s safely (%s / %s)", async (phase, state, causeCode, providerCode, status, code, nextStep) => {
    const cause = causeCode === "profile_disabled" ? new LocalAuthError(causeCode, "UNSAFE_IDENTITY") : new IdentityProviderError(causeCode, "UNSAFE_PROVIDER_DETAIL", { providerCode, providerStatus: 422 });
    mocked.completePasswordRecovery.mockRejectedValue(new RecoveryCompletionError(cause, phase, state, causeCode));
    const response = await recoveryPost(request("/api/auth/password/recovery", valid));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code, nextStep });
    expect(response.headers.get("x-recovery-request-id")).toMatch(/^[a-f0-9-]{36}$/);
    expect(mocked.setSessionCookie).not.toHaveBeenCalled();
    expect(mocked.clearRecoveryCookie).toHaveBeenCalledOnce();
    const logs = [...mocked.logWarn.mock.calls, ...mocked.logError.mock.calls];
    expect(logs).toContainEqual(["auth.recovery_failed", expect.objectContaining({ phase, changeState: state, requestId: response.headers.get("x-recovery-request-id") })]);
    const serialized = JSON.stringify(logs);
    for (const unsafe of ["UNSAFE_", valid.password, valid.tokenHash, mocked.challengeId]) expect(serialized).not.toContain(unsafe);
  });
  it("keeps a local input rejection retryable without clearing proof state", async () => {
    mocked.completePasswordRecovery.mockRejectedValue(new LocalAuthError("invalid_input", "Password policy"));
    const response = await recoveryPost(request("/api/auth/password/recovery", valid));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ nextStep: "retry" });
    expect(mocked.clearRecoveryCookie).not.toHaveBeenCalled(); expect(mocked.setSessionCookie).not.toHaveBeenCalled();
  });
  it("does not pretend the password failed if cookie delivery fails after a completed service", async () => {
    mocked.completePasswordRecovery.mockResolvedValue({ session: { sessionId: "synthetic-local-session" } });
    mocked.setSessionCookie.mockRejectedValue(Error("UNSAFE_COOKIE_VALUE"));
    const response = await recoveryPost(request("/api/auth/password/recovery", valid));
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: "recovery_session_unavailable", nextStep: "sign_in" });
    expect(JSON.stringify(mocked.logError.mock.calls)).not.toContain("UNSAFE_COOKIE_VALUE");
  });
  it("does not mask an authenticated result if the spent recovery cookie cannot be cleared", async () => {
    mocked.completePasswordRecovery.mockResolvedValue({ session: { sessionId: "synthetic-local-session" } });
    mocked.clearRecoveryCookie.mockRejectedValue(Error("UNSAFE_COOKIE_VALUE"));
    const response = await recoveryPost(request("/api/auth/password/recovery", valid));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ authenticated: true });
    expect(mocked.logWarn).toHaveBeenCalledWith("auth.recovery_cookie_cleanup_failed", expect.objectContaining({ requestId: expect.any(String) }));
  });

  it("keeps committed authentication successful if diagnostic output itself fails", async () => {
    mocked.completePasswordRecovery.mockResolvedValue({ session: { sessionId: "synthetic-local-session" } });
    mocked.logInfo.mockImplementationOnce(() => { throw Error("UNSAFE_LOGGING_ERROR"); });
    const response = await recoveryPost(request("/api/auth/password/recovery", valid));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ authenticated: true });
  });

  it("returns only authentication success, never provider credentials", async () => {
    mocked.completePasswordRecovery.mockResolvedValue({ session: { sessionId: "local-synthetic-session" }, accessToken: "synthetic-secret" });
    const response = await recoveryPost(request("/api/auth/password/recovery", valid));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true });
  });

  it.each([
    { ...valid, code: "synthetic-code" }, { ...valid, code: ["wrong"] },
    { ...valid, tokenHash: "" }, { ...valid, tokenHash: "a".repeat(2049) },
    { ...valid, confirmation: "different-pass-123" },
    { password: valid.password, confirmation: valid.password, accessToken: "synthetic-access" },
  ])("rejects malformed or ambiguous recovery input", async (body) => {
    expect((await recoveryPost(request("/api/auth/password/recovery", body))).status).toBe(400);
    expect(mocked.completePasswordRecovery).not.toHaveBeenCalled();
  });

  it("uses the configured installation origin for reset emails and hides provider failure", async () => {
    mocked.requestPasswordRecovery.mockRejectedValue(new Error("unknown address"));
    const response = await resetRequestPost(request("/api/auth/password/reset/request", { email: "employee@example.test" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(mocked.requestPasswordRecovery).toHaveBeenCalledWith("employee@example.test", "https://brain.example.test/auth/recovery");
  });
});


describe("recovery browser cookie", () => {
  it("sets an opaque cookie while returning only generic acceptance", async () => {
    mocked.requestPasswordRecovery.mockResolvedValue({ recoveryId: "a".repeat(43), expiresAt: 2_000_000 });
    const response = await resetRequestPost(request("/api/auth/password/reset/request", { email: "employee@example.test" }));
    expect(await response.json()).toEqual({ accepted: true });
    expect(mocked.setRecoveryCookie).toHaveBeenCalledWith("a".repeat(43));
  });
  it("passes only the HttpOnly cookie binding, never a submitted verifier, to recovery", async () => {
    mocked.completePasswordRecovery.mockResolvedValue({ session: { sessionId: "synthetic-session" } });
    const response = await recoveryPost(request("/api/auth/password/recovery", {
      code: "synthetic-code", password: "Recovered-pass-123", confirmation: "Recovered-pass-123",
      codeVerifier: "client-controlled-verifier", recoveryId: "client-controlled-id",
    }));
    expect(response.status).toBe(200);
    expect(mocked.completePasswordRecovery).toHaveBeenCalledWith({ code: "synthetic-code" }, "Recovered-pass-123", mocked.challengeId);
    expect(mocked.clearRecoveryCookie).toHaveBeenCalledTimes(1);
  });
});


describe("indistinguishable recovery request cookies", () => {
  it("does not reveal rate-limit or store failures through a missing cookie", async () => {
    mocked.check.mockResolvedValue({ allowed: false, retryAfterSeconds: 900 });
    expect((await resetRequestPost(request("/api/auth/password/reset/request", { email: "employee@example.test" }))).status).toBe(202);
    expect(mocked.requestPasswordRecovery).not.toHaveBeenCalled();
    expect(mocked.setRecoveryCookie).toHaveBeenCalledWith(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/));
    mocked.setRecoveryCookie.mockClear();
    mocked.check.mockRejectedValue(new Error("store offline"));
    expect((await resetRequestPost(request("/api/auth/password/reset/request", { email: "other@example.test" }))).status).toBe(202);
    expect(mocked.setRecoveryCookie).toHaveBeenCalledWith(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/));
  });
});
