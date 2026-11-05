import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  session: null as null | { provider: "local"; user: { id: string; name: string; email: string }; tenant: { id: string; name: string }; expiresAt: string },
  sameOrigin: true, snapshot: vi.fn(), execute: vi.fn(),
}));
vi.mock("@/auth/session", () => ({ getSession: async () => mocks.session }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: async () => mocks.sameOrigin }));
vi.mock("@/catalog/server-service", () => ({
  CatalogAdminError: class CatalogAdminError extends Error { constructor(readonly code: string, message: string, readonly status: number) { super(message); } },
  catalogSnapshot: mocks.snapshot, executeCatalogCommand: mocks.execute,
}));

import { GET, PATCH } from "@/app/api/admin/catalog/route";

const session = { provider: "local" as const, user: { id: "00000000-0000-4000-8000-000000000001", name: "Admin", email: "admin@example.com" }, tenant: { id: "arnall-qa", name: "Arnall" }, expiresAt: "2026-08-29T00:00:00.000Z" };
const resource = { id: "mail-app", kind: "app", label: "Mail", credentialMode: "personal-oauth", managedBy: "company", sharedResource: false, appId: "mail", connectorId: null, mcp: null };

describe("catalog admin API", () => {
  beforeEach(() => { mocks.session = session; mocks.sameOrigin = true; mocks.snapshot.mockReset(); mocks.execute.mockReset(); });
  it("requires a session and same origin before a catalog mutation", async () => {
    mocks.session = null;
    expect((await GET()).status).toBe(401);
    mocks.session = session; mocks.sameOrigin = false;
    expect((await PATCH(new Request("https://brain.example/api/admin/catalog", { method: "PATCH", body: JSON.stringify({ action: "upsert-resource", resource }) }))).status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("rejects malformed commands before reaching the admin service", async () => {
    expect((await PATCH(new Request("https://brain.example/api/admin/catalog", { method: "PATCH", body: JSON.stringify({ action: "upsert-resource", resource: { ...resource, credentialMode: "shared-resource", sharedResource: false } }) }))).status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
