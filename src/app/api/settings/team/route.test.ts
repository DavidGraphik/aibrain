import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ session: null as null | { user: { id: string }; tenant: { id: string } }, isAdmin: vi.fn(), members: vi.fn() }));
vi.mock("@/auth/session", () => ({ getSession: async () => mocked.session }));
vi.mock("@/admin/server-service", () => ({ isWorkspaceAdmin: mocked.isAdmin }));
vi.mock("@/settings/team-service", () => ({ activeTeamMembers: mocked.members }));

import { GET } from "@/app/api/settings/team/route";

describe("settings team route", () => {
  beforeEach(() => {
    mocked.session = { user: { id: "00000000-0000-4000-8000-000000000001" }, tenant: { id: "arnall" } };
    mocked.isAdmin.mockReset(); mocked.members.mockReset(); mocked.isAdmin.mockResolvedValue(false);
  });

  it("fails closed for an employee and does not reveal team administration through a deep API request", async () => {
    const response = await GET();
    expect(response.status).toBe(403);
    expect(mocked.members).not.toHaveBeenCalled();
  });

  it("allows the administrative team readback only after role authorization", async () => {
    mocked.isAdmin.mockResolvedValue(true); mocked.members.mockResolvedValue([]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mocked.members).toHaveBeenCalledOnce();
  });
});
