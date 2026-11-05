import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ session: null as null | { user: { id: string } }, isAdmin: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, redirect: () => { throw new Error("REDIRECT"); } }));
vi.mock("@/auth/session", () => ({ getSession: async () => mocked.session }));
vi.mock("@/admin/server-service", () => ({ isWorkspaceAdmin: mocked.isAdmin }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: async () => ({ branding: { productName: "Arnall AI" } }) }));
vi.mock("@/components/admin-center", () => ({ AdminCenter: () => null }));

import AdminPage from "@/app/admin/page";

describe("admin page", () => {
  beforeEach(() => { mocked.session = { user: { id: "00000000-0000-4000-8000-000000000002" } }; mocked.isAdmin.mockReset(); });

  it("rejects an employee deep link before rendering the administration surface", async () => {
    mocked.isAdmin.mockResolvedValue(false);
    await expect(AdminPage()).rejects.toThrow("NOT_FOUND");
  });

  it("allows an authorized owner to reach the separate administrative surface", async () => {
    mocked.isAdmin.mockResolvedValue(true);
    await expect(AdminPage()).resolves.toBeTruthy();
  });
});
