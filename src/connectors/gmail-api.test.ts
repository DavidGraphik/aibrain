import { describe, expect, it, vi } from "vitest";
import { exchangeGmailCode, gmailAuthorizationUrl, gmailPkceChallenge, readGmailProfile, refreshGmailToken } from "@/connectors/gmail-api";
import { GMAIL_READONLY_SCOPE } from "@/connectors/gmail-contracts";

describe("Gmail OAuth and provider client", () => {
  it("builds authorization with one minimum scope, PKCE S256, offline refresh and untrusted state", () => {
    const codeVerifier = "a".repeat(64); const url = new URL(gmailAuthorizationUrl({ clientId: "client", redirectUri: "https://brain.example/api/connectors/gmail/oauth/callback", state: "opaque-state", codeVerifier }));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe(GMAIL_READONLY_SCOPE);
    expect(url.searchParams.get("code_challenge")).toBe(gmailPkceChallenge(codeVerifier));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
  });

  it("exchanges and refreshes without exposing the verifier or refresh token in URLs", async () => {
    const responses = [
      new Response(JSON.stringify({ access_token: "access-token-one", refresh_token: "refresh-token-one", expires_in: 3600, scope: GMAIL_READONLY_SCOPE }), { status: 200 }),
      new Response(JSON.stringify({ access_token: "access-token-two", expires_in: 3600 }), { status: 200 }),
    ];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => responses.shift()!);
    const first = await exchangeGmailCode(fetcher as typeof fetch, { clientId: "client", clientSecret: "secret", redirectUri: "https://brain.example/api/connectors/gmail/oauth/callback", code: "authorization-code", codeVerifier: "v".repeat(64) }, 0);
    const refreshed = await refreshGmailToken(fetcher as typeof fetch, { clientId: "client", clientSecret: "secret", token: first }, 1_000);
    expect(refreshed.refreshToken).toBe("refresh-token-one");
    for (const [url, init] of fetcher.mock.calls) { expect(String(url)).not.toContain("refresh-token"); expect(String(url)).not.toContain("authorization-code"); expect(init?.method).toBe("POST"); }
  });

  it("fails closed when Google returns any scope beyond Gmail readonly", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: "access-token-one", refresh_token: "refresh-token-one", expires_in: 3600, scope: `${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.modify` }), { status: 200 }));
    await expect(exchangeGmailCode(fetcher as typeof fetch, { clientId: "client", clientSecret: "secret", redirectUri: "https://brain.example/callback", code: "authorization-code", codeVerifier: "v".repeat(64) })).rejects.toMatchObject({ code: "GMAIL_SCOPE_MISMATCH" });
  });

  it("requires a valid Gmail profile readback", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ emailAddress: "person@example.com", messagesTotal: 4, threadsTotal: 3, historyId: "99" }), { status: 200 }));
    await expect(readGmailProfile(fetcher as typeof fetch, "access-token-value")).resolves.toMatchObject({ emailAddress: "person@example.com", historyId: "99" });
  });
});
