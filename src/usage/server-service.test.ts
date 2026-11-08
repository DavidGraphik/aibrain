import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  parseProviderAccountUsage,
  parseProviderRateLimits,
} from "@/usage/server-service";

describe("usage provider parsers", () => {
  it("normalizes the generated App Server rate-limit shape", () => {
    expect(parseProviderRateLimits({
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 32.5, windowDurationMins: 300, resetsAt: 1_777_000_000 },
        secondary: null,
        credits: { hasCredits: true, unlimited: false, balance: "10.50" },
        individualLimit: null,
        spendControlReached: false,
        planType: "team",
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
    })).toEqual([expect.objectContaining({
      limitId: "codex",
      planType: "team",
      primary: expect.objectContaining({ usedPercent: 32.5 }),
      credits: { hasCredits: true, unlimited: false, balance: "10.50" },
    })]);
  });

  it("keeps provider account totals separate as decimal strings", () => {
    expect(parseProviderAccountUsage({
      summary: {
        lifetimeTokens: 1_234,
        peakDailyTokens: 500,
        longestRunningTurnSec: 42,
        currentStreakDays: 3,
        longestStreakDays: 8,
      },
      dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: 200 }],
    })).toEqual({
      lifetimeTokens: "1234",
      peakDailyTokens: "500",
      longestRunningTurnSec: "42",
      currentStreakDays: "3",
      longestStreakDays: "8",
      dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: "200" }],
    });
  });

  it("does not accept unsafe or malformed global totals", () => {
    expect(parseProviderAccountUsage({
      summary: {
        lifetimeTokens: Number.MAX_SAFE_INTEGER + 10,
        peakDailyTokens: -1,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      dailyUsageBuckets: [{ startDate: "not-a-date", tokens: 3 }],
    })).toMatchObject({
      lifetimeTokens: null,
      peakDailyTokens: null,
      dailyUsageBuckets: [],
    });
  });
});
