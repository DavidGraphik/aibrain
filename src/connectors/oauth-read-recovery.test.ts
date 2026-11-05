import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";

const state = vi.hoisted(() => ({ token: { accessToken: "original-access-token", refreshToken: "personal-refresh-token", expiresAt: "2099-01-01T00:00:00Z", scopes: [] as string[], tokenType: "Bearer" }, revoked: false, resolve: vi.fn(), put: vi.fn(), read: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/connectors/binding-store", () => ({ FileConnectorBindingStore: class {
  async resolve(principal: { userId: string }, connector: string, options: unknown) {
    state.resolve(principal, connector, options);
    if (state.revoked) throw Object.assign(new Error("revoked"), { code: "CONNECTOR_BINDING_REVOKED" });
    return { userId: principal.userId, status: "active", credentialRef: "personal-reference" };
  }
} }));
vi.mock("@/connectors/gmail-oauth-store", () => ({ FileGmailTokenStore: class {
  async read() { state.read(); return { token: state.token }; }
  async put(user: string, token: typeof state.token, reference: string) { state.put(user, token, reference); state.token = token; }
}, gmailOAuthEncryptionKey: () => Buffer.alloc(32), GmailOAuthStoreError: class extends Error {} }));
vi.mock("@/connectors/outlook-oauth-store", () => ({ FileOutlookTokenStore: class {
  async read() { state.read(); return { token: state.token }; }
  async put(user: string, token: typeof state.token, reference: string) { state.put(user, token, reference); state.token = token; }
}, outlookOAuthEncryptionKey: () => Buffer.alloc(32), OutlookOAuthStoreError: class extends Error {} }));
import { withGmailReadAccess } from "./gmail-server-service";
import { withOutlookReadAccess } from "./outlook-server-service";
import { GMAIL_MINIMUM_SCOPES } from "./gmail-contracts";
import { OUTLOOK_OAUTH_SCOPES } from "./outlook-contracts";

const config = { installationId: "synthetic-company", publicUrl: "https://brain.example.test", paths: { dataRoot: "/unused" }, connectors: { gmail: { enabled: true }, outlook: { enabled: true, tenantId: "synthetic-tenant" } } } as unknown as InstallationConfig;
beforeEach(() => {
  vi.clearAllMocks(); state.revoked = false;
  state.token = { accessToken: "original-access-token", refreshToken: "personal-refresh-token", expiresAt: "2099-01-01T00:00:00Z", scopes: [], tokenType: "Bearer" };
  vi.stubEnv("AIBRAIN_GOOGLE_CLIENT_ID", "synthetic-id"); vi.stubEnv("AIBRAIN_GOOGLE_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("AIBRAIN_MICROSOFT_CLIENT_ID", "synthetic-id"); vi.stubEnv("AIBRAIN_MICROSOFT_CLIENT_SECRET", "synthetic-secret");
});

for (const [provider, withAccess, scopes] of [["GMAIL", withGmailReadAccess, GMAIL_MINIMUM_SCOPES], ["OUTLOOK", withOutlookReadAccess, OUTLOOK_OAUTH_SCOPES]] as const) {
  describe(`${provider} read access recovery`, () => {
    const unauthorized = () => Object.assign(new Error("access rejected"), { code: `${provider}_REAUTH_REQUIRED`, status: 401 });
    const fetcher = () => vi.fn(async () => Response.json({ access_token: "renewed-access-token", expires_in: 3600, scope: scopes.join(" ") }));
    it("silently renews an unexpired but rejected token and retries the read once", async () => {
      const providerFetch = fetcher();
      const read = vi.fn().mockRejectedValueOnce(unauthorized()).mockResolvedValueOnce({ messages: ["synthetic"] });
      expect(await withAccess(config, "personal-user", read, providerFetch)).toEqual({ messages: ["synthetic"] });
      expect(read.mock.calls).toEqual([["original-access-token"], ["renewed-access-token"]]);
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(state.put).toHaveBeenCalledWith("personal-user", expect.objectContaining({ refreshToken: "personal-refresh-token" }), "personal-reference");
      expect(state.resolve).toHaveBeenCalledTimes(2);
      for (const [principal, , options] of state.resolve.mock.calls) { expect(principal.userId).toBe("personal-user"); expect(options).toEqual({ allowShared: false }); }
    });
    it("does not loop when the renewed token is also rejected", async () => {
      const providerFetch = fetcher(); const read = vi.fn().mockRejectedValue(unauthorized());
      await expect(withAccess(config, "personal-user", read, providerFetch)).rejects.toMatchObject({ status: 401 });
      expect(read).toHaveBeenCalledTimes(2); expect(providerFetch).toHaveBeenCalledTimes(1);
    });
    it("never refreshes or retries forbidden permissions and other failures", async () => {
      for (const status of [403, 429, 500]) {
        const providerFetch = fetcher(); const read = vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { code: `${provider}_PROVIDER_ERROR`, status }));
        await expect(withAccess(config, "personal-user", read, providerFetch)).rejects.toMatchObject({ status });
        expect(providerFetch).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(1);
      }
    });
    it("rechecks revocation before renewal and never retries with a revoked binding", async () => {
      const providerFetch = fetcher(); const read = vi.fn(async () => { state.revoked = true; throw unauthorized(); });
      await expect(withAccess(config, "personal-user", read, providerFetch)).rejects.toMatchObject({ code: "CONNECTOR_BINDING_REVOKED" });
      expect(providerFetch).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(1);
    });
    it("reuses a concurrently renewed token without overwriting it", async () => {
      const providerFetch = fetcher(); let calls = 0;
      const read = vi.fn(async () => { if (++calls === 1) { state.token = { ...state.token, accessToken: "concurrently-renewed-token" }; throw unauthorized(); } return "ok"; });
      expect(await withAccess(config, "personal-user", read, providerFetch)).toBe("ok");
      expect(read.mock.calls).toEqual([["original-access-token"], ["concurrently-renewed-token"]]);
      expect(providerFetch).not.toHaveBeenCalled(); expect(state.put).not.toHaveBeenCalled();
    });
    it("reports a revoked refresh grant as reconnection required and preserves stored tokens", async () => {
      const providerFetch = vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
      const read = vi.fn().mockRejectedValue(unauthorized());
      await expect(withAccess(config, "personal-user", read, providerFetch)).rejects.toMatchObject({ code: `${provider}_REAUTH_REQUIRED` });
      expect(state.put).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(1);
    });
  });
}
