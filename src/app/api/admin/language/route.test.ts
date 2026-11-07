import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ session: null as null | { tenant: { id: string }; user: { id: string } }, sameOrigin: true, admin: true, write: vi.fn() }));
vi.mock("@/auth/session", () => ({ getSession: async () => mocks.session }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: async () => mocks.sameOrigin }));
vi.mock("@/admin/server-service", () => ({ isWorkspaceAdmin: async () => mocks.admin }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => ({ installationId: "company-a", paths: { dataRoot: "/private/example-a" } }) }));
vi.mock("@/i18n/installation-language-store", () => ({ FileInstallationLanguageStore: class { write = mocks.write; } }));
import { PATCH } from "./route";
const request = (body: unknown) => new Request("https://example.test/api/admin/language", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { mocks.session = { tenant: { id: "company-a" }, user: { id: "admin-a" } }; mocks.sameOrigin = true; mocks.admin = true; mocks.write.mockReset().mockImplementation(async locale => locale); });
describe("company language administration", () => {
  it("requires same-origin, authentication, tenant and admin before any write", async () => {
    mocks.sameOrigin = false; expect((await PATCH(request({ locale: "es" }))).status).toBe(403);
    mocks.sameOrigin = true; mocks.session = null; expect((await PATCH(request({ locale: "es" }))).status).toBe(401);
    mocks.session = { tenant: { id: "company-b" }, user: { id: "admin-b" } }; expect((await PATCH(request({ locale: "es" }))).status).toBe(403);
    mocks.session.tenant.id = "company-a"; mocks.admin = false; expect((await PATCH(request({ locale: "es" }))).status).toBe(403);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("accepts only the language field and records the authenticated actor", async () => {
    for (const body of [null, [], { locale: "fr" }, { locale: "es", installationId: "company-b" }]) expect((await PATCH(request(body))).status).toBe(400);
    expect(mocks.write).not.toHaveBeenCalled();
    const response = await PATCH(request({ locale: "es" }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ locale: "es" });
    expect(mocks.write).toHaveBeenCalledWith("es", "admin-a");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("returns a safe error if durable storage fails", async () => {
    mocks.write.mockRejectedValue(new Error("private path"));
    const response = await PATCH(request({ locale: "en" }));
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("private path");
  });
});
