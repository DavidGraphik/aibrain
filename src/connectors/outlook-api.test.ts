import { describe, expect, it, vi } from "vitest";
import {
  exchangeOutlookCode,
  outlookAuthorizationUrl,
  outlookPkceChallenge,
  readOutlookProfile,
  refreshOutlookToken,
} from "@/connectors/outlook-api";
import { OUTLOOK_OAUTH_SCOPES } from "@/connectors/outlook-contracts";

const TENANT = "11111111-1111-4111-8111-111111111111";
function accessToken(tenantId = TENANT) {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ tid: tenantId })).toString("base64url")}.signature-value`;
}

describe("Outlook OAuth and Microsoft Graph client", () => {
  it("uses the exact company tenant, minimum delegated scopes and PKCE S256", () => {
    const verifier = "a".repeat(64);
    const url = new URL(outlookAuthorizationUrl({ tenantId: TENANT, clientId: "client", redirectUri: "https://brain.example/api/connectors/outlook/oauth/callback", state: "opaque-state", codeVerifier: verifier }));
    expect(url.pathname).toContain(`/${TENANT}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(OUTLOOK_OAUTH_SCOPES);
    expect(url.searchParams.get("code_challenge")).toBe(outlookPkceChallenge(verifier));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.pathname).not.toContain("/common/");
  });

  it("exchanges and refreshes without putting secrets in URLs", async () => {
    const responses = [
      new Response(JSON.stringify({ access_token: accessToken(), refresh_token: "refresh-token-one", expires_in: 3600, scope: OUTLOOK_OAUTH_SCOPES.join(" ") }), { status: 200 }),
      new Response(JSON.stringify({ access_token: accessToken(), expires_in: 3600, scope: OUTLOOK_OAUTH_SCOPES.join(" ") }), { status: 200 }),
    ];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => responses.shift()!);
    const first = await exchangeOutlookCode(fetcher as typeof fetch, { tenantId: TENANT, clientId: "client", clientSecret: "secret", redirectUri: "https://brain.example/api/connectors/outlook/oauth/callback", code: "authorization-code", codeVerifier: "v".repeat(64) }, 0);
    const refreshed = await refreshOutlookToken(fetcher as typeof fetch, { tenantId: TENANT, clientId: "client", clientSecret: "secret", token: first }, 1_000);
    expect(refreshed.refreshToken).toBe("refresh-token-one");
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).not.toContain("refresh-token");
      expect(String(url)).not.toContain("authorization-code");
      expect(String(init?.body)).toContain("scope=offline_access");
    }
  });

  it("fails closed on excessive scopes", async () => {
    const excessive = vi.fn(async () => new Response(JSON.stringify({ access_token: accessToken(), refresh_token: "refresh-token-one", expires_in: 3600, scope: `${OUTLOOK_OAUTH_SCOPES.join(" ")} Mail.Send` }), { status: 200 }));
    await expect(exchangeOutlookCode(excessive as typeof fetch, { tenantId: TENANT, clientId: "client", clientSecret: "secret", redirectUri: "https://brain.example/callback", code: "authorization-code", codeVerifier: "v".repeat(64) })).rejects.toMatchObject({ code: "OUTLOOK_SCOPE_MISMATCH" });
  });

  it("requires provider readback before treating the account as connected", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "profile", displayName: "Ada", mail: "ada@example.com" }), { status: 200 }));
    await expect(readOutlookProfile(fetcher as typeof fetch, accessToken(), TENANT)).resolves.toMatchObject({ emailAddress: "ada@example.com", tenantId: TENANT });
  });
});
