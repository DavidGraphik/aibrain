import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ dashboard: vi.fn() }));
vi.mock("@/usage/operator-dashboard", () => ({ operatorUsageDashboard: mocks.dashboard }));

import { GET } from "@/app/api/operations/usage-dashboard/route";

const url = "https://arnall.example/api/operations/usage-dashboard";
const secret = "usage-dashboard-secret-with-at-least-32-bytes";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("AIBRAIN_USAGE_DASHBOARD_SECRET", secret);
  mocks.dashboard.mockReset().mockResolvedValue({ schemaVersion: 1, members: [] });
});

describe("operator usage dashboard route", () => {
  it("fails closed without its dedicated bearer secret", async () => {
    expect((await GET(new Request(url))).status).toBe(401);
    expect(mocks.dashboard).not.toHaveBeenCalled();
  });

  it("returns private usage only for the dedicated bearer", async () => {
    const response = await GET(new Request(url, { headers: { Authorization: `Bearer ${secret}` } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ schemaVersion: 1, members: [] });
  });
});
