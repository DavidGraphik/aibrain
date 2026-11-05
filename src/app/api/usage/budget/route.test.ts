import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  session: null as null | { provider: "local" | "demo"; tenant: { id: string }; user: { id: string } },
  installation: { installationId: "arnall", paths: { dataRoot: "/private/arnall" }, usageLimits: undefined as undefined | { weeklyTokens: number; timeZone: "Europe/Madrid"; unlimitedUntil?: string } },
  status: vi.fn(),
  constructed: vi.fn(),
  loadInstallation: vi.fn(),
}));

vi.mock("@/auth/session", () => ({ getSession: async () => mocked.session }));
vi.mock("@/config/installation", () => ({ loadInstallationConfig: mocked.loadInstallation }));
vi.mock("@/usage/weekly-token-budget", () => ({
  WeeklyTokenBudgetStore: class {
    constructor(options: unknown) { mocked.constructed(options); }
    status = mocked.status;
  },
}));

import { GET } from "@/app/api/usage/budget/route";

const PUBLIC_STATUS = {
  weekStart: "2026-09-20T22:00:00.000Z",
  resetAt: "2026-09-27T22:00:00.000Z",
  remainingPercent: 75,
  threshold: 25,
  initialized: true,
};

const STATUS = {
  weekStart: "2026-09-20T22:00:00.000Z",
  resetAt: "2026-09-27T22:00:00.000Z",
  usedTokens: 1_875_000,
  limitTokens: 7_500_000,
  remainingTokens: 5_625_000,
  percent: 25,
  threshold: 25,
  initialized: true,
};

describe("installation weekly budget route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.session = { provider: "local", tenant: { id: "arnall" }, user: { id: "authenticated-user" } };
    mocked.installation.usageLimits = { weeklyTokens: 7_500_000, timeZone: "Europe/Madrid" };
    mocked.loadInstallation.mockResolvedValue(mocked.installation);
    mocked.status.mockResolvedValue(STATUS);
  });

  it("requires authentication before loading an installation or reading its budget", async () => {
    mocked.session = null;
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocked.loadInstallation).not.toHaveBeenCalled();
    expect(mocked.status).not.toHaveBeenCalled();
  });

  it.each(["foreign-installation", "demo"])("denies %s before opening the budget store", async (kind) => {
    if (kind === "demo") mocked.session!.provider = "demo";
    else mocked.session!.tenant.id = kind;
    const response = await GET();
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocked.constructed).not.toHaveBeenCalled();
  });

  it("returns null without creating a store when the limit is disabled", async () => {
    mocked.installation.usageLimits = undefined;
    const response = await GET();
    expect(await response.json()).toEqual({ budget: null });
    expect(mocked.constructed).not.toHaveBeenCalled();
  });

  it("redacts the shared allowance from every authenticated employee", async () => {
    mocked.status.mockResolvedValue({ ...STATUS, users: [{ id: "another-user", tokens: 3 }], source: "/secret/path" });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocked.constructed).toHaveBeenCalledWith({ installationId: "arnall", dataRoot: "/private/arnall", limitTokens: 7_500_000 });
    expect(await response.json()).toEqual({ budget: null });
  });

  it("preserves unknown initial usage as null rather than showing an empty allowance", async () => {
    const unknown = { ...STATUS, initialized: false, usedTokens: null, remainingTokens: null, percent: null, threshold: 0 };
    mocked.status.mockResolvedValue(unknown);
    const response = await GET();
    expect(await response.json()).toEqual({ budget: null });
  });

  it("shows a full balance throughout a configured unlimited period", async () => {
    mocked.installation.usageLimits = {
      weeklyTokens: 7_500_000,
      timeZone: "Europe/Madrid",
      unlimitedUntil: "2099-10-31T23:00:00.000Z",
    };
    mocked.status.mockResolvedValue({ ...STATUS, remainingTokens: 0, percent: 100, threshold: 100 });
    const response = await GET();
    expect(await response.json()).toEqual({ budget: null });
  });

  it.each([
    { remainingTokens: 1, expected: 1 },
    { remainingTokens: 0, expected: 0 },
    { remainingTokens: 7_500_000, expected: 100 },
  ])("reports only a bounded remaining percentage for $remainingTokens private tokens", async ({ remainingTokens, expected }) => {
    mocked.status.mockResolvedValue({ ...STATUS, remainingTokens });
    const response = await GET();
    expect(expected).toBeGreaterThanOrEqual(0);
    expect(await response.json()).toEqual({ budget: null });
  });

  it("fails closed without leaking a corrupt store path or reporting zero usage", async () => {
    mocked.status.mockRejectedValue(new Error("corrupt /private/arnall/secret-file"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "No se puede comprobar el saldo semanal.", code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
  });
});
