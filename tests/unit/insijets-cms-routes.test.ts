import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), installation: vi.fn() }));
vi.mock("@/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: mocks.installation }));
import { GET, POST } from "@/app/api/insijets/cms/[...path]/route";
const session = { provider: "local", user: { id: "fixture", email: "operator@example.invalid" }, tenant: { id: "insijets-demo" }, expiresAt: new Date(Date.now() + 60000).toISOString() };
beforeEach(() => { mocks.session.mockResolvedValue(session); mocks.installation.mockResolvedValue({ installationId: "insijets-demo", publicUrl: "https://brain.example.test" }); vi.stubEnv("AIBRAIN_INSIJETS_CMS_ENABLED", "true"); vi.stubEnv("AIBRAIN_INSIJETS_CMS_ORIGIN", "https://site.example.test"); vi.stubEnv("AIBRAIN_INSIJETS_CMS_SIGNING_KEY", "x".repeat(32)); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("actual route denies missing session, wrong tenant, foreign admin and forbidden paths before upstream", async () => {
 const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
 const request = new Request("https://brain.example.test/api/insijets/cms/admin");
 const params = { params: Promise.resolve({ path: ["admin"] }) };
 mocks.session.mockResolvedValue(null); expect((await GET(request, params)).status).toBe(401);
 for (const denied of [{ ...session, tenant: { id: "arnall" } }, { ...session, user: { id: "x", email: "third-admin@example.test" } }, { ...session, expiresAt: "2020-01-01" }, { ...session, provider: "demo" }]) { mocks.session.mockResolvedValue(denied); expect((await GET(request, params)).status).toBe(403); }
 mocks.session.mockResolvedValue(session); mocks.installation.mockResolvedValue({ installationId: "g03", publicUrl: "https://brain.example.test" }); expect((await GET(request, params)).status).toBe(403);
 expect(fetch).not.toHaveBeenCalled();
});
it("actual route authorizes both owners, strips secrets and rejects cross-site writes", async () => {
 const fetch = vi.fn().mockResolvedValue(new Response('{"user":{"email":"fixture"}}', { headers: { "Content-Type": "application/json", "Set-Cookie": "must-not-escape=secret" } })); vi.stubGlobal("fetch", fetch);
 for (const email of ["operator@example.invalid", "cms-owner@example.invalid"]) { mocks.session.mockResolvedValue({ ...session, user: { id: "fixture", email } }); const result = await GET(new Request("https://brain.example.test/api/insijets/cms/api/auth/session"), { params: Promise.resolve({ path: ["api", "auth", "session"] }) }); expect(result.status).toBe(200); expect(result.headers.get("set-cookie")).toBeNull(); }
 const denied = await POST(new Request("https://brain.example.test/api/insijets/cms/api/admin/content", { method: "POST", headers: { origin: "https://evil.test", "Content-Type": "application/json" }, body: "{}" }), { params: Promise.resolve({ path: ["api", "admin", "content"] }) }); expect(denied.status).toBe(403); expect(fetch).toHaveBeenCalledTimes(2);
});
