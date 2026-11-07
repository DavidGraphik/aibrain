import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  dataRoot: "",
  request: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/config/installation", () => ({
  loadInstallationConfig: async () => ({
    schemaVersion: 1,
    installationId: "example-qa",
    companyName: "Example",
    companySlug: "example",
    publicUrl: "https://example.test",
    branding: {
      productName: "Brain",
      logoPath: "/logo.svg",
      faviconPath: "/favicon.ico",
      accentColor: "#123456",
    },
    paths: {
      dataRoot: mocked.dataRoot,
      companyContextRoot: path.join(mocked.dataRoot, "company"),
      usersRoot: path.join(mocked.dataRoot, "users"),
      sourceReadRoot: path.join(mocked.dataRoot, "source"),
      publishWriteRoot: path.join(mocked.dataRoot, "publish"),
      backupsRoot: path.join(mocked.dataRoot, "backups"),
    },
  }),
}));
vi.mock("@/runtime/worker-runtime-service", () => ({
  workerAppServerForUser: async () => ({ client: { request: mocked.request } }),
}));

import { refreshSharedSubscriptionUsage } from "@/usage/server-service";
import { FileUsageStore } from "@/usage/file-usage-store";

const roots: string[] = [];

beforeEach(async () => {
  mocked.dataRoot = await mkdtemp(path.join(tmpdir(), "aibrain-usage-rpc-"));
  roots.push(mocked.dataRoot);
  mocked.request.mockReset();
  mocked.request.mockImplementation(async (method: string) => {
    if (method === "account/read") return { account: { type: "chatgpt", planType: "team" } };
    if (method === "account/rateLimits/read") {
      return {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1_777_000_000 },
          secondary: null,
          credits: null,
          individualLimit: null,
          spendControlReached: false,
          planType: "team",
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: null,
      };
    }
    if (method === "account/usage/read") {
      return {
        summary: {
          lifetimeTokens: 42,
          peakDailyTokens: 20,
          longestRunningTurnSec: 8,
          currentStreakDays: 1,
          longestStreakDays: 2,
        },
        dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: 12 }],
      };
    }
    throw new Error(`Unexpected method ${method}`);
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shared subscription usage RPC", () => {
  it("calls both generated account methods and persists their typed snapshot", async () => {
    const snapshot = await refreshSharedSubscriptionUsage(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(mocked.request.mock.calls.map(([method]) => method)).toEqual([
      "account/read",
      "account/rateLimits/read",
      "account/usage/read",
    ]);
    expect(snapshot).toMatchObject({
      scope: "shared_chatgpt_account",
      planType: "team",
      rateLimits: [{ primary: { usedPercent: 21 } }],
      accountTokenUsage: { lifetimeTokens: "42" },
    });
    const stored = await new FileUsageStore({
      installationId: "example-qa",
      dataRoot: mocked.dataRoot,
    }).latestSharedSubscription();
    expect(stored).toEqual(snapshot);
  });
});
