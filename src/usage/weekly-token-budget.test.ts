import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WeeklyTokenBudgetStore,
  weeklyTokenBudgetWindow,
  type WeeklyTokenBudgetSeed,
  type WeeklyTokenBudgetUsage,
} from "@/usage/weekly-token-budget";

const roots: string[] = [];
const USER = "00000000-0000-4000-8000-000000000001";
const OTHER_USER = "00000000-0000-4000-8000-000000000002";
const THREAD = "thread-1";
const DEFAULT_NOW = Date.parse("2026-09-24T12:00:00.000Z");

async function fixture(limitTokens = 7_500_000, initialNow = DEFAULT_NOW) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "aibrain-weekly-budget-"));
  roots.push(dataRoot);
  let now = initialNow;
  const options = { installationId: "arnall", dataRoot, limitTokens, now: () => now };
  const store = new WeeklyTokenBudgetStore(options);
  return { dataRoot, store, options, setNow: (value: number | string) => { now = typeof value === "string" ? Date.parse(value) : value; },
    seed: (overrides: Partial<WeeklyTokenBudgetSeed> = {}) => store.initializeFromHistory({
      capturedAt: new Date(now - 60_000).toISOString(), dailyTotals: [],
      cursors: [{ userId: USER, threadId: THREAD, totalTokens: 0 }], ...overrides,
    }) };
}

function usage(totalTokens: number, overrides: Partial<WeeklyTokenBudgetUsage> = {}): WeeklyTokenBudgetUsage {
  return { userId: USER, threadId: THREAD, eventId: `event-${totalTokens}`, totalTokens, lastTokens: totalTokens, ...overrides };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("weeklyTokenBudgetWindow", () => {
  it.each([
    ["2026-09-20T21:59:59.999Z", "2026-09-13T22:00:00.000Z", "2026-09-20T22:00:00.000Z", 168],
    ["2026-09-20T22:00:00.000Z", "2026-09-20T22:00:00.000Z", "2026-09-27T22:00:00.000Z", 168],
    ["2026-03-25T12:00:00.000Z", "2026-03-22T23:00:00.000Z", "2026-03-29T22:00:00.000Z", 167],
    ["2026-10-21T12:00:00.000Z", "2026-10-18T22:00:00.000Z", "2026-10-25T23:00:00.000Z", 169],
    ["2027-01-01T12:00:00.000Z", "2026-12-27T23:00:00.000Z", "2027-01-03T23:00:00.000Z", 168],
  ])("uses Madrid calendar boundaries at %s", (at, weekStart, resetAt, hours) => {
    expect(weeklyTokenBudgetWindow(at)).toEqual({ weekStart, resetAt });
    expect((Date.parse(resetAt) - Date.parse(weekStart)) / 3_600_000).toBe(hours);
  });
  it("rejects invalid clocks", () => {
    expect(() => weeklyTokenBudgetWindow(Number.NaN)).toThrow(/clock/);
    expect(() => weeklyTokenBudgetWindow(-1)).toThrow(/clock/);
  });
});

describe("WeeklyTokenBudgetStore", () => {
  it("requires an explicit baseline and does not present missing measurements as zero", async () => {
    const { store } = await fixture();
    expect(await store.countingStartsAt()).toBeNull();
    expect(await store.status()).toMatchObject({ initialized: false, usedTokens: null, remainingTokens: null, percent: null });
    await expect(store.assertAvailable()).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNINITIALIZED" });
    await expect(store.recordUsage(usage(12))).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNINITIALIZED" });
    await expect(lstat(store.statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("imports daily totals, counts cached-inclusive totals once and preserves the verified cursor", async () => {
    const { store, seed } = await fixture(1_000);
    expect(await seed({
      dailyTotals: [{ date: "2026-09-20", totalTokens: 900 }, { date: "2026-09-21", totalTokens: 100 }, { date: "2026-09-24", totalTokens: 150 }],
      cursors: [{ userId: USER, threadId: THREAD, totalTokens: 8_000 }],
    })).toMatchObject({ initialized: true, usedTokens: 250, percent: 25, threshold: 25 });
    expect(await store.recordUsage(usage(8_100, { lastTokens: 100 }))).toMatchObject({ usedTokens: 350, remainingTokens: 650 });
    expect((await lstat(store.statePath)).mode & 0o777).toBe(0o600);
  });

  it("cannot replace the seed or clear a prior exhaustion", async () => {
    const { store, seed } = await fixture(100);
    await seed({ dailyTotals: [{ date: "2026-09-24", totalTokens: 100 }] });
    expect(await store.countingStartsAt()).toBe(new Date(DEFAULT_NOW - 60_000).toISOString());
    const before = await readFile(store.statePath, "utf8");
    await expect(seed()).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_ALREADY_INITIALIZED" });
    expect(await readFile(store.statePath, "utf8")).toBe(before);
    await expect(store.assertAvailable()).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_EXHAUSTED" });
  });

  it("rejects malformed or contradictory imports without creating a baseline", async () => {
    const { store, seed } = await fixture();
    await expect(seed({ dailyTotals: [{ date: "2026-02-30", totalTokens: 4 }] })).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    await expect(seed({ dailyTotals: [{ date: "2026-09-24", totalTokens: 4 }, { date: "2026-09-24", totalTokens: 4 }] })).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    await expect(seed({ dailyTotals: [{ date: "2026-09-25", totalTokens: 4 }] })).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    expect((await store.status()).initialized).toBe(false);
  });

  it("warns at each boundary, blocks admission at the limit and still accounts overshoot", async () => {
    const { store, seed } = await fixture(400);
    await seed();
    let previous = 0;
    for (const [total, threshold] of [[99, 0], [100, 25], [200, 50], [300, 75], [399, 75]] as const) {
      expect(await store.recordUsage(usage(total, { lastTokens: total - previous }))).toMatchObject({ usedTokens: total, threshold });
      await expect(store.assertAvailable()).resolves.toMatchObject({ initialized: true });
      previous = total;
    }
    expect(await store.recordUsage(usage(400, { lastTokens: 1 }))).toMatchObject({ remainingTokens: 0, percent: 100, threshold: 100 });
    await expect(store.assertAvailable()).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_EXHAUSTED" });
    expect(await store.recordUsage(usage(450, { lastTokens: 50 }))).toMatchObject({ usedTokens: 450, remainingTokens: 0, percent: 112.5, threshold: 100 });
  });

  it("deduplicates repeated events and cumulative snapshots across restarts", async () => {
    const { store, seed, options, setNow } = await fixture(1_000);
    await seed();
    await store.recordUsage(usage(100));
    setNow(DEFAULT_NOW + 10_000);
    const restarted = new WeeklyTokenBudgetStore(options);
    await restarted.recordUsage(usage(100));
    await restarted.recordUsage(usage(100, { eventId: "repeated-snapshot" }));
    expect(await restarted.recordUsage(usage(175, { lastTokens: 75 }))).toMatchObject({ usedTokens: 175 });
  });

  it("advances durable cursors without charging usage from a temporary unlimited period", async () => {
    const { store, seed } = await fixture(1_000);
    await seed();
    await store.recordUsage(usage(400), { countTowardLimit: false });
    expect(await store.status()).toMatchObject({ usedTokens: 0, remainingTokens: 1_000, threshold: 0 });
    expect(await store.recordUsage(usage(450, { eventId: "after-unlimited", lastTokens: 50 })))
      .toMatchObject({ usedTokens: 50, remainingTokens: 950 });
  });

  it("serializes concurrent updates across store instances and deduplicates the same event", async () => {
    const { store, seed, options } = await fixture(1_000);
    await seed();
    await Promise.all(Array.from({ length: 20 }, (_, index) => new WeeklyTokenBudgetStore(options).recordUsage(
      usage(10, { threadId: `parallel-${index}`, eventId: "same-id-different-thread" }),
    )));
    await Promise.all(Array.from({ length: 10 }, () => new WeeklyTokenBudgetStore(options).recordUsage(
      usage(30, { eventId: "one-shared-event" }),
    )));
    expect(await store.status()).toMatchObject({ usedTokens: 230 });
  });

  it("isolates cumulative cursors and event identities by user", async () => {
    const { store, seed } = await fixture();
    await seed();
    await store.recordUsage(usage(100, { eventId: "identical" }));
    expect(await store.recordUsage(usage(70, { eventId: "identical", userId: OTHER_USER }))).toMatchObject({ usedTokens: 170 });
  });

  it("serializes conflicting installation imports into the same data root", async () => {
    const { store, options } = await fixture();
    const seed = { capturedAt: new Date(DEFAULT_NOW - 1_000).toISOString(), dailyTotals: [], cursors: [] };
    const other = new WeeklyTokenBudgetStore({ ...options, installationId: "other" });
    const outcomes = await Promise.allSettled([store.initializeFromHistory(seed), other.initializeFromHistory(seed)]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    const state = JSON.parse(await readFile(store.statePath, "utf8"));
    expect(["arnall", "other"]).toContain(state.installationId);
  });

  it("imports prior event evidence so a later duplicate cannot be recharged", async () => {
    const { store, seed } = await fixture();
    await seed({
      dailyTotals: [{ date: "2026-09-24", totalTokens: 100 }],
      cursors: [{ userId: USER, threadId: THREAD, totalTokens: 100 }],
      seenEvents: [usage(100, { observedAt: new Date(DEFAULT_NOW - 60_000).toISOString() })],
    });
    expect(await store.recordUsage(usage(100))).toMatchObject({ usedTokens: 100 });
    expect(await store.recordUsage(usage(160, { lastTokens: 60 }))).toMatchObject({ usedTokens: 160 });
  });

  it("accepts ordered increases with equal event timestamps", async () => {
    const { store, seed } = await fixture();
    await seed();
    await store.recordUsage(usage(100));
    expect(await store.recordUsage(usage(150, { lastTokens: 50 }))).toMatchObject({ usedTokens: 150 });
  });

  it("handles explicit later resets and never rewinds a cursor for old replay", async () => {
    const { store, seed, setNow } = await fixture();
    await seed();
    await store.recordUsage(usage(100, { observedAt: new Date(DEFAULT_NOW).toISOString() }));
    setNow(DEFAULT_NOW + 1_000);
    await store.recordUsage(usage(20, { eventId: "reset", observedAt: new Date(DEFAULT_NOW + 1_000).toISOString() }));
    await store.recordUsage(usage(90, { eventId: "old-replay", observedAt: new Date(DEFAULT_NOW - 1_000).toISOString() }));
    expect(await store.recordUsage(usage(45, { lastTokens: 25 }))).toMatchObject({ usedTokens: 145 });
  });

  it("ignores replay already covered by the imported baseline without charging it again", async () => {
    const { store, seed } = await fixture();
    await seed({ dailyTotals: [{ date: "2026-09-24", totalTokens: 500 }], cursors: [{ userId: USER, threadId: THREAD, totalTokens: 3_000 }] });
    expect(await store.recordUsage(usage(2_000, { lastTokens: 100, observedAt: new Date(DEFAULT_NOW - 120_000).toISOString() }))).toMatchObject({ usedTokens: 500 });
    expect(await store.recordUsage(usage(3_070, { lastTokens: 70 }))).toMatchObject({ usedTokens: 570 });
  });

  it("charges a verified resume reset even when its first response exceeds the old cumulative total", async () => {
    const { store, seed, setNow } = await fixture();
    await seed({ cursors: [{ userId: USER, threadId: THREAD, totalTokens: 155_863 }] });
    setNow(DEFAULT_NOW + 1_000);
    const at = new Date(DEFAULT_NOW + 1_000).toISOString();
    expect(await store.recordUsage(usage(175_735, { observedAt: at }))).toMatchObject({ usedTokens: 175_735 });
    expect(await store.recordUsage(usage(351_607, { lastTokens: 175_872, observedAt: at })))
      .toMatchObject({ usedTokens: 351_607 });
    expect(await store.recordUsage(usage(351_607, { eventId: "same-snapshot", lastTokens: 175_872, observedAt: at })))
      .toMatchObject({ usedTokens: 351_607 });
  });

  it("recovers promotional cursors without replacing activation, charges or replay evidence", async () => {
    const { store, seed, setNow } = await fixture();
    await seed();
    await store.recordUsage(usage(100));
    await store.markUnavailable("usage_evidence_invalid");
    const before = JSON.parse(await readFile(store.statePath, "utf8"));
    setNow(DEFAULT_NOW + 1_000);
    const capturedAt = new Date(DEFAULT_NOW + 1_000).toISOString();
    await store.reconcileUnlimitedHistory({ capturedAt, dailyTotals: [], cursors: [
      { userId: USER, threadId: THREAD, totalTokens: 351_607, observedAt: capturedAt },
    ] }, "2026-10-31T23:00:00.000Z");
    const after = JSON.parse(await readFile(store.statePath, "utf8"));
    expect(after).toMatchObject({ initializedAt: before.initializedAt, dailyTotals: before.dailyTotals,
      seenEvents: before.seenEvents, blockedReason: null });
    expect(await store.recordUsage(usage(351_707, { lastTokens: 100 }))).toMatchObject({ usedTokens: 200 });
  });

  it.each(["expired", "future", "charges", "other-block"])("leaves the ledger untouched on invalid recovery: %s", async (kind) => {
    const { store, seed } = await fixture();
    await seed();
    await store.markUnavailable(kind === "other-block" ? "terminal_turn_missing_usage" : "usage_evidence_invalid");
    const before = await readFile(store.statePath, "utf8");
    await expect(store.reconcileUnlimitedHistory({
      capturedAt: new Date(DEFAULT_NOW + (kind === "future" ? 1_000 : 0)).toISOString(),
      dailyTotals: kind === "charges" ? [{ date: "2026-09-24", totalTokens: 1 }] : [], cursors: [],
    }, kind === "expired" ? new Date(DEFAULT_NOW).toISOString() : "2026-10-31T23:00:00.000Z"))
      .rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    expect(await readFile(store.statePath, "utf8")).toBe(before);
  });

  it.each([
    ["unknown thread without baseline", usage(200, { threadId: "unknown", lastTokens: 20 })],
    ["invalid response count", usage(10, { lastTokens: 20 })],
    ["future event", usage(10, { observedAt: "2026-09-25T12:00:00.000Z" })],
  ])("persistently blocks %s", async (_, input) => {
    const { store, seed, options } = await fixture();
    await seed();
    await expect(store.recordUsage(input)).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    await expect(new WeeklyTokenBudgetStore(options).assertAvailable()).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
  });

  it("persistently blocks ambiguous resets and conflicting event identities", async () => {
    const first = await fixture();
    await first.seed();
    await first.store.recordUsage(usage(100));
    first.setNow(DEFAULT_NOW + 1_000);
    await expect(first.store.recordUsage(usage(30, { lastTokens: 20 }))).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    await expect(first.store.assertAvailable()).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    const second = await fixture();
    await second.seed();
    await second.store.recordUsage(usage(100));
    await expect(second.store.recordUsage(usage(120, { eventId: "event-100" }))).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
  });

  it("persistently blocks a positive cumulative increase smaller than the last response", async () => {
    const { store, seed, options } = await fixture();
    await seed();
    await store.recordUsage(usage(100));
    await expect(store.recordUsage(usage(150, { lastTokens: 120 }))).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    await expect(new WeeklyTokenBudgetStore(options).assertAvailable()).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    expect(JSON.parse(await readFile(store.statePath, "utf8")).dailyTotals).toEqual([{ date: "2026-09-24", totalTokens: 100 }]);
  });

  it("accounts larger cumulative increases when intermediate notifications were missed", async () => {
    const { store, seed } = await fixture();
    await seed();
    await store.recordUsage(usage(100));
    expect(await store.recordUsage(usage(250, { lastTokens: 50 }))).toMatchObject({ usedTokens: 250 });
  });

  it("persists externally reported accounting failures across restarts and weeks", async () => {
    const { store, seed, options, setNow } = await fixture();
    await seed();
    await store.markUnavailable("missing_usage_event");
    setNow("2026-09-28T12:00:00.000Z");
    await expect(new WeeklyTokenBudgetStore(options).assertAvailable()).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
  });

  it("rolls over at Madrid midnight while retaining old cursor and replay evidence", async () => {
    const { store, seed, setNow } = await fixture(100, Date.parse("2026-09-27T21:59:59.000Z"));
    await seed();
    await store.recordUsage(usage(100, { observedAt: "2026-09-27T21:59:59.000Z" }));
    setNow("2026-09-27T22:00:00.000Z");
    expect(await store.assertAvailable()).toMatchObject({ usedTokens: 0, weekStart: "2026-09-27T22:00:00.000Z" });
    await store.recordUsage(usage(100, { observedAt: "2026-09-27T21:59:59.000Z" }));
    expect(await store.recordUsage(usage(120, { lastTokens: 20 }))).toMatchObject({ usedTokens: 20 });
    setNow("2026-09-27T21:59:59.000Z");
    await expect(store.assertAvailable()).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
  });

  it("rejects corrupt, foreign and symlinked state instead of resetting usage", async () => {
    const corrupt = await fixture();
    await corrupt.seed();
    await writeFile(corrupt.store.statePath, "{truncated", { mode: 0o600 });
    await expect(corrupt.store.status()).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    await expect(corrupt.seed()).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    const foreign = await fixture();
    await foreign.seed();
    await expect(new WeeklyTokenBudgetStore({ ...foreign.options, installationId: "other" }).assertAvailable()).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    const unsafe = await fixture();
    await symlink(corrupt.dataRoot, path.join(unsafe.dataRoot, "usage"));
    await expect(unsafe.store.status()).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
  });
});
