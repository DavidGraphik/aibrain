import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  session: null as null | { provider: "local"; user: { id: string; name: string; email: string }; tenant: { id: string; name: string }; expiresAt: string },
  sameOrigin: true,
  snapshot: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/auth/session", () => ({ getSession: async () => mocks.session }));
vi.mock("@/auth/request-security", () => ({ isSameOriginMutation: async () => mocks.sameOrigin }));
vi.mock("@/admin/server-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/admin/server-service")>();
  return { ...actual, workspaceAdminSnapshot: mocks.snapshot, executeWorkspaceAdminCommand: mocks.execute };
});

import { GET, PATCH } from "@/app/api/admin/route";
import { WorkspaceAdminError } from "@/admin/server-service";

const session = {
  provider: "local" as const,
  user: { id: "00000000-0000-4000-8000-000000000001", name: "Admin", email: "admin@example.com" },
  tenant: { id: "example-qa", name: "Example" },
  expiresAt: "2026-08-29T00:00:00.000Z",
};

function request(body: unknown) {
  return new Request("https://brain.example/api/admin", {
    method: "PATCH",
    headers: { Origin: "https://brain.example", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("workspace admin route", () => {
  beforeEach(() => {
    mocks.session = session;
    mocks.sameOrigin = true;
    mocks.snapshot.mockReset();
    mocks.execute.mockReset();
  });

  it("requires authentication and an authorized workspace role", async () => {
    mocks.session = null;
    expect((await GET()).status).toBe(401);
    mocks.session = session;
    mocks.snapshot.mockRejectedValue(new WorkspaceAdminError("ADMIN_ROLE_REQUIRED", "Admin required.", 403));
    const denied = await GET();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "ADMIN_ROLE_REQUIRED" });
  });

  it("fails closed on tenant mismatch and cross-origin mutations", async () => {
    mocks.snapshot.mockRejectedValue(new WorkspaceAdminError("ADMIN_TENANT_MISMATCH", "Wrong tenant.", 403));
    expect((await GET()).status).toBe(403);
    mocks.sameOrigin = false;
    const response = await PATCH(request({ action: "delete-group", groupId: "00000000-0000-4000-8000-000000000003" }));
    expect(response.status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("validates commands before executing them", async () => {
    const invalid = await PATCH(request({ action: "set-member-role", userId: "bad", roleId: "workspace-admin" }));
    expect(invalid.status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
