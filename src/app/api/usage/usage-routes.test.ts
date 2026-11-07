import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  session: null as null | {
    provider: "local";
    user: { id: string; name: string; email: string };
    tenant: { id: string; name: string };
    expiresAt: string;
  },
  personal: vi.fn(),
  company: vi.fn(),
  isAdmin: vi.fn(),
  employeeBudget: vi.fn(),
}));

vi.mock("@/auth/session", () => ({ getSession: async () => mocked.session }));
vi.mock("@/admin/server-service", () => ({ isWorkspaceAdmin: mocked.isAdmin }));
vi.mock("@/usage/employee-budget", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/usage/employee-budget")>(),
  employeeWeeklyBudget: mocked.employeeBudget,
}));
vi.mock("@/usage/server-service", () => ({
  personalUsageForUser: mocked.personal,
  companyUsageForUser: mocked.company,
}));

import { GET as personalGet } from "@/app/api/usage/me/route";
import { GET as companyGet } from "@/app/api/usage/company/route";

const USER_ID = "00000000-0000-4000-8000-000000000001";
describe("usage routes", () => {
  beforeEach(() => {
    mocked.session = {
      provider: "local",
      user: { id: USER_ID, name: "Alex", email: "alex@example.test" },
      tenant: { id: "example-qa", name: "Example" },
      expiresAt: "2026-08-28T00:00:00.000Z",
    };
    mocked.personal.mockReset();
    mocked.company.mockReset();
    mocked.isAdmin.mockReset();
    mocked.employeeBudget.mockReset();
    mocked.employeeBudget.mockResolvedValue(null);
    mocked.personal.mockResolvedValue({ schemaVersion: 1, scope: "personal" });
    mocked.company.mockResolvedValue({ schemaVersion: 1, scope: "company" });
    mocked.isAdmin.mockResolvedValue(false);
  });

  it("requires an authenticated session for personal usage", async () => {
    mocked.session = null;
    const response = await personalGet();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocked.personal).not.toHaveBeenCalled();
  });

  it("returns only the authenticated employee personal usage", async () => {
    const response = await personalGet();
    expect(response.status).toBe(200);
    expect(mocked.personal).toHaveBeenCalledWith(USER_ID);
  });

  it("fails closed for company usage until the durable workspace role is administrative", async () => {
    expect((await companyGet()).status).toBe(403);
    expect(mocked.company).not.toHaveBeenCalled();
    mocked.isAdmin.mockResolvedValue(true);
    const response = await companyGet();
    expect(response.status).toBe(200);
    expect(mocked.isAdmin).toHaveBeenCalledWith(mocked.session);
    expect(mocked.company).toHaveBeenCalledWith(USER_ID);
  });

  it.each([personalGet, companyGet])("redacts the installation percentage when budgeted, including workspace administrators", async (get) => {
    mocked.isAdmin.mockResolvedValue(true);
    const budget = { initialized: true, weekStart: "2026-09-20T22:00:00.000Z", resetAt: "2026-09-27T22:00:00.000Z", remainingPercent: 75, threshold: 25 };
    mocked.employeeBudget.mockResolvedValue(budget);
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ budget: null });
    expect(mocked.personal).not.toHaveBeenCalled();
    expect(mocked.company).not.toHaveBeenCalled();
  });

  it.each([personalGet, companyGet])("never falls back to provider or employee token counts if the budget cannot be read", async (get) => {
    mocked.isAdmin.mockResolvedValue(true);
    mocked.employeeBudget.mockRejectedValue(new Error("unavailable"));
    const response = await get();
    expect(response.status).toBe(503);
    expect(mocked.personal).not.toHaveBeenCalled();
    expect(mocked.company).not.toHaveBeenCalled();
  });
});
