import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupabaseAuthIdentityProvider } from "@/auth/supabase-identity-provider";

vi.mock("server-only", () => ({}));

const provider = () => new SupabaseAuthIdentityProvider({
  url: "http://127.0.0.1:54321",
  publishableKey: "synthetic-publishable-key",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SupabaseAuthIdentityProvider failures", () => {
  it("classifies a network outage as provider unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("connection refused")));
    await expect(provider().verifyPassword("employee@example.test", "Temporary-pass-123"))
      .rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("keeps a provider credential rejection distinct from an outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "invalid credentials",
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })));
    await expect(provider().verifyPassword("employee@example.test", "wrong-password"))
      .rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("updates a password with the challenge access token without rotating its refresh token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "00000000-0000-4000-8000-000000000001",
      email: "employee@example.test",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await provider().updatePassword({
      accessToken: "challenge-access-token",
      refreshToken: "challenge-refresh-token",
    }, "Permanent-pass-789");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:54321/auth/v1/user");
    expect(request.method).toBe("PUT");
    expect(request.headers).toMatchObject({
      apikey: "synthetic-publishable-key",
      Authorization: "Bearer challenge-access-token",
    });
    expect(JSON.parse(String(request.body))).toEqual({ password: "Permanent-pass-789" });
    expect(JSON.stringify(request)).not.toContain("challenge-refresh-token");
  });

  it("keeps password rejections distinct from provider outages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "weak_password",
      message: "Password is too weak",
    }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    })));
    await expect(provider().updatePassword({
      accessToken: "challenge-access-token",
      refreshToken: "challenge-refresh-token",
    }, "Permanent-pass-789")).rejects.toMatchObject({ code: "provider_rejected" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await expect(provider().updatePassword({
      accessToken: "challenge-access-token",
      refreshToken: "challenge-refresh-token",
    }, "Permanent-pass-789")).rejects.toMatchObject({ code: "provider_unavailable" });
  });
  it("retains only allowlisted provider diagnostics for an explicit password rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "same_password", message: "UNSAFE_PROVIDER_DETAIL", password: "UNSAFE_PASSWORD" }, { status: 422 })));
    const failure = await provider().updatePassword({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh" }, "New-synthetic-pass-123").catch(error => error);
    expect(failure).toMatchObject({ code: "provider_rejected", providerCode: "same_password", providerStatus: 422, updateOutcome: "rejected" });
    expect(JSON.stringify(failure)).not.toContain("UNSAFE_");
  });

  it.each([500, 429, 401, 200])("distinguishes uncertain update outcome from explicit HTTP rejection (%s)", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "UNSAFE_UNKNOWN_CODE", message: "UNSAFE_PROVIDER_DETAIL" }, { status })));
    const failure = await provider().updatePassword({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh" }, "New-synthetic-pass-123").catch(error => error);
    expect(failure).toMatchObject({ providerStatus: status, providerCode: status === 200 ? "invalid_response" : "other", updateOutcome: status === 401 || status === 429 ? "rejected" : "unknown" });
    expect(JSON.stringify(failure)).not.toContain("UNSAFE_");
  });
  it("caps diagnostic response bytes and does not keep unknown provider code prose", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "weak_password", detail: "UNSAFE_".repeat(3000) }), { status: 422 })));
    const failure = await provider().updatePassword({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh" }, "New-synthetic-pass-123").catch(error => error);
    expect(failure).toMatchObject({ providerCode: "other", providerStatus: 422, updateOutcome: "rejected" });
    expect(JSON.stringify(failure)).not.toContain("UNSAFE_");
  });

  it("accepts the wrapped user update response supported by the pinned provider SDK", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ user: { id: "00000000-0000-4000-8000-000000000001" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().updatePassword({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh" }, "New-synthetic-pass-123")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

});


describe("Supabase recovery exchange", () => {
  it("exchanges a token hash server-side as recovery and rejects its reuse", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "synthetic-access-token",
        refresh_token: "synthetic-refresh-token",
        token_type: "bearer", expires_in: 3600,
        user: { id: "00000000-0000-4000-8000-000000000001", email: "employee@example.test" },
      }), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "otp_expired", msg: "expired" }),
        { status: 403, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await provider().verifyPasswordRecovery({ tokenHash: "synthetic-recovery-hash" }))
      .toMatchObject({ userId: "00000000-0000-4000-8000-000000000001", email: "employee@example.test" });
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:54321/auth/v1/verify");
    expect(request.method).toBe("POST");
    expect(JSON.parse(String(request.body))).toMatchObject({ token_hash: "synthetic-recovery-hash", type: "recovery" });
    await expect(provider().verifyPasswordRecovery({ tokenHash: "synthetic-recovery-hash" }))
      .rejects.toMatchObject({ code: "invalid_recovery" });
  });

  it("rejects expired proof and distinguishes provider outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "otp_expired", msg: "expired",
    }), { status: 403, headers: { "Content-Type": "application/json" } })));
    await expect(provider().verifyPasswordRecovery({ tokenHash: "synthetic-expired-hash" }))
      .rejects.toMatchObject({ code: "invalid_recovery" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(provider().verifyPasswordRecovery({ tokenHash: "synthetic-hash" }))
      .rejects.toMatchObject({ code: "provider_unavailable" });
  });
});


describe("default-template PKCE protocol", () => {
  it("sends a S256 challenge to recovery but the verifier only to the code exchange", async () => {
    const verifier = "a".repeat(64);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: "synthetic-user", email: "employee@example.test" },
        access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token" }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await provider().requestPasswordRecovery("employee@example.test", "https://brain.example.test/auth/recovery", verifier);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).searchParams.get("redirect_to")).toBe("https://brain.example.test/auth/recovery");
    expect(JSON.parse(String(request.body))).toMatchObject({ code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "s256" });
    expect(String(request.body)).not.toContain(verifier);
    await provider().verifyPasswordRecovery({ code: "synthetic-code", codeVerifier: verifier });
    const [tokenUrl, tokenRequest] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(tokenUrl).toBe("http://127.0.0.1:54321/auth/v1/token?grant_type=pkce");
    expect(JSON.parse(String(tokenRequest.body))).toEqual({ auth_code: "synthetic-code", code_verifier: verifier });
  });

  it("does not exchange a code when no server verifier is available", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(provider().verifyPasswordRecovery({ code: "synthetic-code", codeVerifier: "" })).rejects.toMatchObject({ code: "invalid_recovery" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
