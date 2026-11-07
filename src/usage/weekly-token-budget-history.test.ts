import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWeeklyTokenBudgetHistory } from "@/usage/weekly-token-budget-history";
import { WeeklyTokenBudgetStore } from "@/usage/weekly-token-budget";
import { initializeWeeklyTokenBudget, parseWeeklyTokenBudgetArguments } from "../../scripts/initialize-weekly-token-budget";
import type { InstallationConfig } from "@/config/installation-schema";

const userId = "11111111-1111-4111-8111-111111111111";
const directories: string[] = [];
const now = new Date("2026-09-24T09:00:00Z");
const meta = (id: string, timestamp = "2026-09-20T08:00:00Z") => ({ type: "session_meta", payload: { id, timestamp } });
const usage = (timestamp: string, total: number, last: number) => ({ type: "event_msg", timestamp,
  payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: { total_tokens: last } } } });
async function fixture() {
  const usersRoot = await mkdtemp(path.join(os.tmpdir(), "budget-history-"));
  directories.push(usersRoot);
  const home = path.join(usersRoot, userId, "runtime", "codex-home");
  const sessions = path.join(home, "sessions", "2026", "09", "20");
  await mkdir(sessions, { recursive: true });
  const config = { paths: { usersRoot } } as Pick<InstallationConfig, "paths">;
  const write = (name: string, events: unknown[], root = sessions) => writeFile(path.join(root, name), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return { usersRoot, home, sessions, config, write };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("weekly token budget offline history", () => {
  it("uses Madrid Monday and the preceding counter, without duplicating snapshots or archived copies", async () => {
    const f = await fixture();
    const events = [meta("thread-a"), usage("2026-09-20T21:59:00Z", 900, 900),
      usage("2026-09-20T22:01:00Z", 1000, 100), usage("2026-09-20T22:02:00Z", 1000, 100),
      usage("2026-09-22T09:00:00Z", 1300, 300)];
    await f.write("one.jsonl", events);
    const archive = path.join(f.home, "archived_sessions");
    await mkdir(archive);
    await f.write("copy.jsonl", events, archive);
    const result = await readWeeklyTokenBudgetHistory(f.config, now);
    expect(result.files).toBe(2);
    expect(result.sessions).toBe(1);
    expect(result.seed.dailyTotals).toEqual([{ date: "2026-09-21", totalTokens: 100 }, { date: "2026-09-22", totalTokens: 300 }]);
    expect(result.seed.cursors).toEqual([{ userId, threadId: "thread-a", totalTokens: 1300, observedAt: "2026-09-22T09:00:00.000Z" }]);
  });

  it("preserves the child identity, omits inherited history, and counts a proven counter reset", async () => {
    const f = await fixture();
    await f.write("child.jsonl", [meta("child", "2026-09-22T09:00:00Z"), meta("parent"),
      usage("2026-09-21T09:00:00Z", 900, 900), usage("2026-09-22T09:01:00Z", 1000, 100),
      usage("2026-09-22T09:02:00Z", 200, 200), usage("2026-09-22T09:03:00Z", 300, 100)]);
    const result = await readWeeklyTokenBudgetHistory(f.config, now);
    expect(result.seed.dailyTotals).toEqual([{ date: "2026-09-22", totalTokens: 400 }]);
    expect(result.seed.cursors[0].threadId).toBe("child");
    expect(result.resets).toBe(1);
  });

  it("refuses an unknown current-week baseline and an ambiguous reset", async () => {
    const f = await fixture();
    await f.write("one.jsonl", [meta("a"), usage("2026-09-21T09:00:00Z", 2000, 100)]);
    await expect(readWeeklyTokenBudgetHistory(f.config, now)).rejects.toThrow("BUDGET_HISTORY_MISSING_BASELINE");
    await f.write("one.jsonl", [meta("a"), usage("2026-09-21T09:00:00Z", 2000, 2000), usage("2026-09-21T09:01:00Z", 1000, 100)]);
    await expect(readWeeklyTokenBudgetHistory(f.config, now)).rejects.toThrow("BUDGET_HISTORY_UNCERTAIN_RESET");
    await f.write("one.jsonl", [meta("a"), usage("2026-09-20T09:00:00Z", 1000, 1000), usage("2026-09-21T09:01:00Z", 1100, 500)]);
    await expect(readWeeklyTokenBudgetHistory(f.config, now)).rejects.toThrow("BUDGET_HISTORY_UNCERTAIN_RESET");
  });

  it.each([100, 150])("does not subtract inherited usage from a fresh child counter of %i", async (total) => {
    const f = await fixture();
    await f.write("child.jsonl", [meta("child", "2026-09-22T09:00:00Z"), meta("parent"),
      usage("2026-09-21T09:00:00Z", 100, 100), usage("2026-09-22T09:01:00Z", total, total)]);
    const result = await readWeeklyTokenBudgetHistory(f.config, now);
    expect(result.seed.dailyTotals).toEqual([{ date: "2026-09-22", totalTokens: total }]);
  });

  it("orders equivalent timezone representations by instant and rejects future creation", async () => {
    const f = await fixture();
    await f.write("one.jsonl", [meta("a", "2026-09-22T12:00:00+02:00"),
      usage("2026-09-22T10:01:00Z", 100, 100), usage("2026-09-22T12:02:00+02:00", 200, 100)]);
    expect((await readWeeklyTokenBudgetHistory(f.config, now)).seed.dailyTotals).toEqual([{ date: "2026-09-22", totalTokens: 200 }]);
    await f.write("one.jsonl", [meta("a", "2026-09-25T12:00:00Z"), usage("2026-09-22T10:01:00Z", 100, 100)]);
    await expect(readWeeklyTokenBudgetHistory(f.config, now)).rejects.toThrow("BUDGET_HISTORY_FUTURE_SESSION");
  });

  it("rejects symlinks instead of importing foreign worker history", async () => {
    const f = await fixture();
    await f.write("one.jsonl", [meta("a"), usage("2026-09-21T09:00:00Z", 100, 100)]);
    await symlink(path.join(f.sessions, "one.jsonl"), path.join(f.sessions, "link.jsonl"));
    await expect(readWeeklyTokenBudgetHistory(f.config, now)).rejects.toThrow("BUDGET_HISTORY_SYMLINK");
  });

  it("refuses malformed token data and future-dated events", async () => {
    const f = await fixture();
    await f.write("one.jsonl", [meta("a"), usage("2026-09-21T09:00:00Z", -1, 1)]);
    await expect(readWeeklyTokenBudgetHistory(f.config, now)).rejects.toThrow("BUDGET_HISTORY_INVALID_USAGE");
    await f.write("one.jsonl", [meta("a"), usage("2026-09-21T09:00:00Z", 100, 200)]);
    await expect(readWeeklyTokenBudgetHistory(f.config, now)).rejects.toThrow("BUDGET_HISTORY_INVALID_USAGE");
    await f.write("one.jsonl", [meta("a"), usage("2026-09-25T09:00:00Z", 100, 100)]);
    await expect(readWeeklyTokenBudgetHistory(f.config, now)).rejects.toThrow("BUDGET_HISTORY_FUTURE_EVENT");
  });

  it("requires an explicit offline start-now flag and preserves conservative history import by default", () => {
    expect(parseWeeklyTokenBudgetArguments(["--offline"])).toEqual({ apply: false, startNow: false });
    expect(parseWeeklyTokenBudgetArguments(["--offline", "--apply", "--start-now"])).toEqual({ apply: true, startNow: true });
    expect(() => parseWeeklyTokenBudgetArguments(["--start-now", "--apply"])).toThrow("Use --offline");
    expect(() => parseWeeklyTokenBudgetArguments(["--offline", "--reset"])).toThrow("Use --offline");
    expect(() => parseWeeklyTokenBudgetArguments(["--offline", "--start-now", "--start-now"])).toThrow("Use --offline");
  });

  it("starts from the capture with historical cursors intact and charges only later increments", async () => {
    const f = await fixture();
    await f.write("one.jsonl", [meta("a"), usage("2026-09-21T09:00:00Z", 1_000, 1_000),
      usage("2026-09-24T08:00:00Z", 2_000, 1_000)]);
    const config = { ...f.config, installationId: "arnall", paths: { ...f.config.paths, dataRoot: f.usersRoot },
      usageLimits: { weeklyTokens: 7_500_000, timeZone: "Europe/Madrid" as const } };
    const preview = await initializeWeeklyTokenBudget(config, parseWeeklyTokenBudgetArguments(["--offline", "--start-now"]), now);
    expect(preview).toMatchObject({ mode: "preview", recordedTokens: 0, initializationPolicy: "start-now", countingStartsAt: now.toISOString() });
    await expect(lstat(path.join(f.usersRoot, "usage", "weekly-token-budget.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const result = await initializeWeeklyTokenBudget(config, parseWeeklyTokenBudgetArguments(["--offline", "--start-now", "--apply"]), now);
    expect(result).toMatchObject({ mode: "initialized", status: { usedTokens: 0, remainingTokens: 7_500_000 } });
    const store = new WeeklyTokenBudgetStore({ installationId: "arnall", dataRoot: f.usersRoot, limitTokens: 7_500_000,
      now: () => now.getTime() + 60_000 });
    expect(JSON.parse(await readFile(store.statePath, "utf8"))).toMatchObject({ initializedAt: now.toISOString(), dailyTotals: [], cursors: [{ totalTokens: 2_000 }] });
    await store.recordUsage({ userId, threadId: "a", eventId: "old-replay", totalTokens: 1_000, lastTokens: 1_000, observedAt: "2026-09-21T09:00:00Z" });
    expect(await store.recordUsage({ userId, threadId: "a", eventId: "after-activation", totalTokens: 2_100, lastTokens: 100,
      observedAt: "2026-09-24T09:00:30Z" })).toMatchObject({ usedTokens: 100, remainingTokens: 7_499_900 });
    await expect(initializeWeeklyTokenBudget(config, { startNow: true, apply: true }, new Date(now.getTime() + 60_000)))
      .rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_ALREADY_INITIALIZED" });
    expect((await store.status()).usedTokens).toBe(100);
  });

  it("does not require reconstructing excluded legacy consumption, but still validates its cursor evidence", async () => {
    const f = await fixture();
    await f.write("one.jsonl", [meta("a"), usage("2026-09-21T09:00:00Z", 2_000, 100),
      usage("2026-09-24T08:00:00Z", 1_000, 100)]);
    await expect(readWeeklyTokenBudgetHistory(f.config, now)).rejects.toThrow("BUDGET_HISTORY_MISSING_BASELINE");
    const fresh = await readWeeklyTokenBudgetHistory(f.config, now, { startNow: true });
    expect(fresh.seed).toEqual({ capturedAt: now.toISOString(), dailyTotals: [],
      cursors: [{ userId, threadId: "a", totalTokens: 1_000, observedAt: "2026-09-24T08:00:00.000Z" }] });
    await f.write("one.jsonl", [meta("a"), usage("2026-09-24T08:00:00Z", 100, 200)]);
    await expect(readWeeklyTokenBudgetHistory(f.config, now, { startNow: true })).rejects.toThrow("BUDGET_HISTORY_INVALID_USAGE");
    await f.write("one.jsonl", [meta("a"), usage("2026-09-25T08:00:00Z", 100, 100)]);
    await expect(readWeeklyTokenBudgetHistory(f.config, now, { startNow: true })).rejects.toThrow("BUDGET_HISTORY_FUTURE_EVENT");
  });

  it("keeps incomplete legacy allowance imports blocked unless start-now is explicit", async () => {
    const f = await fixture();
    await f.write("one.jsonl", [meta("a"), usage("2026-09-24T08:00:00Z", 100, 100)]);
    const config = { ...f.config, installationId: "arnall", paths: { ...f.config.paths, dataRoot: f.usersRoot },
      usageLimits: { weeklyTokens: 7_500_000, timeZone: "Europe/Madrid" as const } };
    await expect(initializeWeeklyTokenBudget(config, { apply: true, startNow: false }, now)).rejects.toThrow("BUDGET_HISTORY_INCOMPLETE_COVERAGE");
    await expect(lstat(path.join(f.usersRoot, "usage", "weekly-token-budget.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
