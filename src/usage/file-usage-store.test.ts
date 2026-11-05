import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateTurnUsage,
  FileUsageStore,
  UsageStoreError,
} from "@/usage/file-usage-store";
import type {
  SharedSubscriptionSnapshot,
  TurnUsageRecord,
} from "@/usage/contracts";

const USER_ONE = "00000000-0000-4000-8000-000000000001";
const USER_TWO = "00000000-0000-4000-8000-000000000002";
const PROJECT = "10000000-0000-4000-8000-000000000001";
const THREAD = "20000000-0000-4000-8000-000000000001";
const roots: string[] = [];

async function fixture(now = Date.parse("2026-08-27T10:00:00.000Z")) {
  const root = await mkdtemp(path.join(tmpdir(), "aibrain-usage-"));
  roots.push(root);
  return {
    root,
    store: new FileUsageStore({
      installationId: "example-qa",
      dataRoot: root,
      now: () => now,
    }),
  };
}

function turn(overrides: Partial<TurnUsageRecord> = {}): TurnUsageRecord {
  return {
    schemaVersion: 1,
    installationId: "example-qa",
    userId: USER_ONE,
    projectId: PROJECT,
    threadId: THREAD,
    turnId: "30000000-0000-4000-8000-000000000001",
    status: "completed",
    startedAt: "2026-08-27T09:59:55.000Z",
    completedAt: "2026-08-27T10:00:00.000Z",
    durationMs: 5_000,
    firstTextMs: 900,
    tokenUsage: {
      totalTokens: 100,
      inputTokens: 70,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 0,
      outputTokens: 30,
      reasoningOutputTokens: 10,
    },
    tokenAttribution: "app_server_turn_event",
    ...overrides,
  };
}

function snapshot(observedAt = "2026-08-27T10:00:00.000Z"): SharedSubscriptionSnapshot {
  return {
    schemaVersion: 1,
    installationId: "example-qa",
    observedAt,
    scope: "shared_chatgpt_account",
    planType: "team",
    rateLimitsAvailable: true,
    accountTokenUsageAvailable: true,
    rateLimits: [{
      limitId: "codex",
      limitName: "Codex",
      planType: "team",
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_777_000_000 },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: false,
      rateLimitReachedType: null,
    }],
    accountTokenUsage: {
      lifetimeTokens: "1234",
      peakDailyTokens: "400",
      longestRunningTurnSec: "90",
      currentStreakDays: "2",
      longestStreakDays: "5",
      dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: "200" }],
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileUsageStore", () => {
  it.each([1, 19, 20, 21, 99, 100, 101, 100_000])("keeps exact percentile ranks for %i records", (count) => {
    const records = Array.from({ length: count }, (_, index) => turn({
      durationMs: count - index,
      firstTextMs: null,
      tokenUsage: null,
    }));
    expect(aggregateTurnUsage(records)).toEqual({
      turns: count, completedTurns: count, errorTurns: 0, stoppedTurns: 0,
      activeDays: 1, totalDurationMs: count * (count + 1) / 2,
      averageDurationMs: Math.round((count + 1) / 2), p95DurationMs: Math.ceil(count * 0.95),
      averageFirstTextMs: null, p95FirstTextMs: null, turnsWithTokenData: 0,
      tokens: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
        cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    });
  });

  it("keeps empty and missing measurements distinct from measured zero", () => {
    expect(aggregateTurnUsage([])).toMatchObject({
      turns: 0, activeDays: 0, totalDurationMs: 0,
      averageDurationMs: null, p95DurationMs: null,
      averageFirstTextMs: null, p95FirstTextMs: null, turnsWithTokenData: 0,
      tokens: { totalTokens: 0 },
    });
    expect(aggregateTurnUsage([turn({ durationMs: 0, firstTextMs: 0 })])).toMatchObject({
      averageDurationMs: 0, p95DurationMs: 0,
      averageFirstTextMs: 0, p95FirstTextMs: 0,
    });
    expect(aggregateTurnUsage([turn({ firstTextMs: null })])).toMatchObject({
      averageFirstTextMs: null, p95FirstTextMs: null,
    });
  });

  it("preserves nearest-rank percentiles, status counts and input order", () => {
    const records = Object.freeze(Array.from({ length: 20 }, (_, index) => Object.freeze(turn({
      durationMs: 20 - index,
      firstTextMs: index % 2 === 0 ? index : null,
      status: index < 7 ? "completed" : index < 13 ? "error" : "stopped",
      startedAt: index < 10 ? "2026-08-27T09:59:55.000Z" : "2026-08-28T09:59:55.000Z",
      tokenUsage: index % 2 === 0 ? turn().tokenUsage : null,
    }))));
    const before = JSON.stringify(records);
    expect(aggregateTurnUsage(records)).toEqual({
      turns: 20, completedTurns: 7, errorTurns: 6, stoppedTurns: 7,
      activeDays: 2, totalDurationMs: 210, averageDurationMs: 11, p95DurationMs: 19,
      averageFirstTextMs: 9, p95FirstTextMs: 18, turnsWithTokenData: 10,
      tokens: { totalTokens: 1000, inputTokens: 700, cachedInputTokens: 200,
        cacheWriteInputTokens: 0, outputTokens: 300, reasoningOutputTokens: 100 },
    });
    expect(JSON.stringify(records)).toBe(before);
  });

  it("records each turn exactly once and isolates personal reads", async () => {
    const { store } = await fixture();
    expect(await store.recordTurn(turn())).not.toBeNull();
    expect(await store.recordTurn(turn())).toBeNull();
    await store.recordTurn(turn({
      userId: USER_TWO,
      turnId: "30000000-0000-4000-8000-000000000002",
      tokenUsage: null,
      tokenAttribution: null,
      status: "error",
    }));

    expect(await store.listTurns(USER_ONE)).toHaveLength(1);
    expect(await store.listTurns(USER_TWO)).toHaveLength(1);
    expect(await store.listTurns()).toHaveLength(2);
    expect(aggregateTurnUsage(await store.listTurns(USER_ONE))).toEqual(aggregateTurnUsage([turn()]));
    expect(aggregateTurnUsage(await store.listTurns(USER_TWO))).toMatchObject({
      turns: 1, completedTurns: 0, errorTurns: 1, turnsWithTokenData: 0,
    });
    expect(aggregateTurnUsage(await store.listTurns("00000000-0000-4000-8000-000000000003")))
      .toEqual(aggregateTurnUsage([]));
    expect((await readFile(store.turnJournalPath, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("aggregates employee metrics without assigning account-wide tokens", async () => {
    const usage = aggregateTurnUsage([
      turn(),
      turn({
        turnId: "30000000-0000-4000-8000-000000000002",
        status: "error",
        durationMs: 10_000,
        firstTextMs: null,
        tokenUsage: null,
        tokenAttribution: null,
      }),
    ]);
    expect(usage).toMatchObject({
      turns: 2,
      completedTurns: 1,
      errorTurns: 1,
      totalDurationMs: 15_000,
      averageDurationMs: 7_500,
      p95DurationMs: 10_000,
      averageFirstTextMs: 900,
      turnsWithTokenData: 1,
      tokens: { totalTokens: 100, outputTokens: 30 },
    });
  });

  it("deduplicates unchanged provider snapshots but keeps changed observations", async () => {
    const { store } = await fixture();
    expect(await store.recordSharedSubscription(snapshot())).not.toBeNull();
    expect(await store.recordSharedSubscription(snapshot("2026-08-27T10:01:00.000Z"))).toBeNull();
    expect(await store.recordSharedSubscription({
      ...snapshot("2026-08-27T10:02:00.000Z"),
      rateLimits: [{ ...snapshot().rateLimits[0], primary: { usedPercent: 13, windowDurationMins: 300, resetsAt: 1_777_000_000 } }],
    })).not.toBeNull();
    expect((await store.latestSharedSubscription())?.rateLimits[0]?.primary?.usedPercent).toBe(13);
    expect((await store.verifyAndRepair()).snapshots.count).toBe(2);
  });

  it("rejects a symlinked usage root", async () => {
    const { root, store } = await fixture();
    const target = path.join(root, "other");
    await symlink(target, path.join(root, "usage"));
    await expect(store.listTurns()).rejects.toBeInstanceOf(UsageStoreError);
  });
});
