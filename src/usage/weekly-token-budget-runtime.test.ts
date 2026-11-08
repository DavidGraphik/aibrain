import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerNotification } from "../../contracts/codex/0.162.1/types/ServerNotification";
import type { AppServerEvent } from "@/runtime/transport";
import { WeeklyTokenBudgetRuntime } from "@/usage/weekly-token-budget-runtime";

vi.mock("server-only", () => ({}));

const userId = "00000000-0000-4000-8000-000000000001";
const available = {
  weekStart: "2026-09-21T00:00:00+02:00", resetAt: "2026-09-28T00:00:00+02:00",
  usedTokens: 10, limitTokens: 100, remainingTokens: 90, percent: 10,
  threshold: 0 as const, initialized: true,
};

function fixture(options: { unlimitedUntil?: string; now?: () => number } = {}) {
  const store = {
    countingStartsAt: vi.fn().mockResolvedValue("2026-09-24T00:00:00.000Z"),
    assertAvailable: vi.fn().mockResolvedValue(available),
    recordUsage: vi.fn().mockResolvedValue(available),
    markUnavailable: vi.fn().mockResolvedValue(undefined),
  };
  const interrupt = vi.fn().mockResolvedValue({});
  const budget = new WeeklyTokenBudgetRuntime({ userId, store, interrupt, pollIntervalMs: 20, missingUsageGraceMs: 40, ...options });
  return { store, interrupt, budget };
}

function envelope(notification: ServerNotification, eventId = "event-1", occurredAt = "2026-09-24T12:00:00.000Z"): AppServerEvent {
  return {
    eventId, sequence: 1, occurredAt,
    message: { kind: "rpc-notification", rpc: notification },
  };
}

function usage(threadId = "thread", turnId = "turn", totalTokens = 80, lastTokens = 20): ServerNotification {
  const counts = { totalTokens, inputTokens: totalTokens - 10, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 };
  return { method: "thread/tokenUsage/updated", params: {
    threadId, turnId, tokenUsage: { total: counts, last: { ...counts, totalTokens: lastTokens }, modelContextWindow: null },
  } };
}

function completed(threadId = "thread", turnId = "turn"): ServerNotification {
  return { method: "turn/completed", params: { threadId, turn: {
    id: turnId, status: "completed", items: [], error: null, itemsView: "full", rootTurnId: null, startedAt: null, completedAt: null, durationMs: null,
  } } };
}

afterEach(() => vi.useRealTimers());

describe("weekly token budget runtime", () => {
  it("does not interrupt a newly bound promotional turn after an accounting failure", async () => {
    let now = Date.parse("2026-10-01T08:00:00.000Z");
    const { store, budget, interrupt } = fixture({ unlimitedUntil: "2026-10-31T23:00:00.000Z", now: () => now });
    store.recordUsage.mockRejectedValue(new Error("Accounting requires reconciliation"));
    const notification = usage();
    await budget.observe(notification, envelope(notification, "failed", new Date(now).toISOString()));
    budget.bindTurn("next-thread", "next-turn");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(interrupt).not.toHaveBeenCalled();
    now = Date.parse("2026-10-31T23:00:00.000Z");
    await expect(budget.beforeRequest("turn/start", { threadId: "after" })).rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    budget.close();
  });
  it("keeps admission open and excludes usage until the temporary unlimited period ends", async () => {
    let now = Date.parse("2026-09-28T12:00:00.000Z");
    const { store, budget, interrupt } = fixture({
      unlimitedUntil: "2026-10-31T23:00:00.000Z",
      now: () => now,
    });
    store.assertAvailable.mockRejectedValue(Object.assign(new Error("Budget exhausted"), { code: "WEEKLY_TOKEN_BUDGET_EXHAUSTED" }));
    await expect(budget.beforeRequest("turn/start", { threadId: "thread" }, "request")).resolves.toBeUndefined();
    const notification = usage();
    await budget.observe(notification, envelope(notification, "unlimited-event", "2026-09-28T12:00:00.000Z"));
    expect(store.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ eventId: "unlimited-event" }), { countTowardLimit: false });
    expect(interrupt).not.toHaveBeenCalled();

    now = Date.parse("2026-10-31T23:00:00.000Z");
    await expect(budget.beforeRequest("turn/start", { threadId: "thread" }, "request-after"))
      .rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_EXHAUSTED" });
    budget.close();
  });

  it.each(["turn/start", "turn/steer"] as const)("refuses %s when accounting is unavailable or the limit is reached", async (method) => {
    const { store, budget } = fixture();
    store.assertAvailable.mockRejectedValue(Object.assign(new Error("Budget exhausted"), { code: "WEEKLY_TOKEN_BUDGET_EXHAUSTED" }));
    await expect(budget.beforeRequest(method, { threadId: "thread", expectedTurnId: "turn" }, "request"))
      .rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_EXHAUSTED" });
    expect(store.recordUsage).not.toHaveBeenCalled();
    budget.close();
  });

  it("records cumulative usage including cache for an unregistered child and interrupts all known active turns", async () => {
    const { store, budget, interrupt } = fixture();
    budget.bindTurn("parent", "parent-turn");
    store.recordUsage.mockResolvedValue({ ...available, usedTokens: 105, percent: 105, remainingTokens: 0, threshold: 100 });
    const notification = usage("child", "child-turn");
    await budget.observe(notification, envelope(notification));
    expect(store.recordUsage).toHaveBeenCalledWith({
      userId, threadId: "child", eventId: "event-1", totalTokens: 80, lastTokens: 20,
      observedAt: "2026-09-24T12:00:00.000Z",
    });
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(2));
    expect(interrupt).toHaveBeenCalledWith("parent", "parent-turn", expect.any(String));
    expect(interrupt).toHaveBeenCalledWith("child", "child-turn", expect.any(String));
    budget.close();
  });

  it("does not await an interruption response in the successful usage observer", async () => {
    const { store, budget, interrupt } = fixture();
    store.recordUsage.mockResolvedValue({ ...available, usedTokens: 100 });
    let release!: () => void;
    interrupt.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const notification = usage();
    await budget.observe(notification, envelope(notification));
    expect(interrupt).toHaveBeenCalledOnce();
    release();
    budget.close();
  });

  it("stops a recovered active turn when another process exhausts the shared budget, and retries a failed interrupt", async () => {
    vi.useFakeTimers();
    const { store, budget, interrupt } = fixture();
    budget.bindTurn("recovered", "existing-turn");
    store.assertAvailable.mockRejectedValue(new Error("Other process reached the budget"));
    interrupt.mockRejectedValueOnce(new Error("Temporary transport failure"));
    await vi.advanceTimersByTimeAsync(20);
    expect(interrupt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(interrupt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(interrupt).toHaveBeenCalledTimes(2);
    budget.close();
  });

  it("allows a late usage event after completion and does not revive the completed turn", async () => {
    vi.useFakeTimers();
    const { store, budget, interrupt } = fixture();
    await budget.beforeRequest("turn/start", { threadId: "thread" }, "start");
    budget.accepted("turn/start", { threadId: "thread" }, { turn: { id: "turn" } }, "start");
    const terminal = completed();
    await budget.observe(terminal, envelope(terminal));
    await expect(budget.beforeRequest("turn/start", { threadId: "another" }, "next"))
      .rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    const notification = usage();
    await budget.observe(notification, envelope(notification, "late-usage"));
    await budget.beforeRequest("turn/start", { threadId: "another" }, "next");
    await vi.advanceTimersByTimeAsync(100);
    expect(store.markUnavailable).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    budget.close();
  });

  it("durably blocks accounting when a recovered turn completes successfully without usage", async () => {
    vi.useFakeTimers();
    const { store, budget } = fixture();
    budget.bindTurn("thread", "turn");
    const terminal = completed() as Extract<ServerNotification, { method: "turn/completed" }>;
    await budget.observe(terminal, envelope(terminal));
    await vi.advanceTimersByTimeAsync(40);
    expect(store.markUnavailable).toHaveBeenCalledWith("terminal_turn_missing_usage");
    await expect(budget.beforeRequest("turn/start", { threadId: "another" }, "next"))
      .rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    budget.close();
  });

  it.each(["interrupted", "failed"] as const)("keeps admission available after a zero-report %s turn and counts delayed usage", async (status) => {
    vi.useFakeTimers();
    const { store, budget, interrupt } = fixture();
    await budget.beforeRequest("turn/start", { threadId: "thread" }, "start");
    budget.accepted("turn/start", { threadId: "thread" }, { turn: { id: "turn" } }, "start");
    const terminal = completed() as Extract<ServerNotification, { method: "turn/completed" }>;
    terminal.params.turn.status = status;
    await budget.observe(terminal, envelope(terminal));
    await budget.beforeRequest("turn/start", { threadId: "next" }, "next");
    await vi.advanceTimersByTimeAsync(100);
    expect(store.markUnavailable).not.toHaveBeenCalled();
    const notification = usage();
    await budget.observe(notification, envelope(notification, "delayed-usage"));
    expect(store.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread", eventId: "delayed-usage", totalTokens: 80, lastTokens: 20,
    }));
    expect(interrupt).not.toHaveBeenCalled();
    await budget.beforeRequest("turn/start", { threadId: "next" }, "next-again");
    budget.close();
  });

  it("marks accounting unavailable and interrupts without blocking observation on a corrupt usage event", async () => {
    const { store, budget, interrupt } = fixture();
    budget.bindTurn("thread", "turn");
    const notification = usage("thread", "turn", -1);
    let release!: () => void;
    interrupt.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    await budget.observe(notification, envelope(notification));
    expect(store.markUnavailable).toHaveBeenCalledWith("invalid_usage_counters");
    expect(interrupt).toHaveBeenCalledOnce();
    await expect(budget.beforeRequest("turn/start", { threadId: "another" }, "next"))
      .rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    release();
    budget.close();
  });

  it("does not acknowledge accounting failure unless the blocked ledger is durable", async () => {
    const { store, budget } = fixture();
    store.markUnavailable.mockRejectedValue(new Error("Filesystem unavailable"));
    const notification = usage("thread", "turn", -1);
    await expect(budget.observe(notification, envelope(notification))).rejects.toThrow("Filesystem unavailable");
    budget.close();
  });

  it("requires usage from an unregistered child turn that only emitted lifecycle notifications", async () => {
    vi.useFakeTimers();
    const { store, budget } = fixture();
    const terminal = completed("child", "child-turn") as Extract<ServerNotification, { method: "turn/completed" }>;
    const started: ServerNotification = { method: "turn/started", params: { ...terminal.params, turn: { ...terminal.params.turn, status: "inProgress" } } };
    await budget.observe(started, envelope(started));
    await budget.observe(terminal, envelope(terminal));
    await vi.advanceTimersByTimeAsync(40);
    expect(store.markUnavailable).toHaveBeenCalledWith("terminal_turn_missing_usage");
    budget.close();
  });

  it("does not require usage from lifecycle replay at or before a fresh allowance", async () => {
    vi.useFakeTimers();
    const { store, budget, interrupt } = fixture();
    const terminal = completed("old-thread", "old-turn") as Extract<ServerNotification, { method: "turn/completed" }>;
    const started: ServerNotification = { method: "turn/started", params: { ...terminal.params, turn: { ...terminal.params.turn, status: "inProgress" } } };
    await budget.observe(started, envelope(started, "old-start", "2026-09-23T23:59:00.000Z"));
    // A recovery binding can arrive independently of the replayed lifecycle.
    budget.bindTurn("old-thread", "old-turn");
    await budget.observe(terminal, envelope(terminal, "old-terminal", "2026-09-24T00:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(100);
    expect(store.markUnavailable).not.toHaveBeenCalled();
    expect(store.assertAvailable).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    await budget.beforeRequest("turn/start", { threadId: "new-thread" });
    expect(store.countingStartsAt).toHaveBeenCalledOnce();
    budget.close();
  });

  it("records pre-activation usage for deduplication without reviving an old turn", async () => {
    vi.useFakeTimers();
    const { store, budget, interrupt } = fixture();
    const notification = usage();
    await budget.observe(notification, envelope(notification, "old-usage", "2026-09-23T23:59:00.000Z"));
    expect(store.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "old-usage", observedAt: "2026-09-23T23:59:00.000Z",
    }));
    await vi.advanceTimersByTimeAsync(100);
    expect(store.assertAvailable).not.toHaveBeenCalled();
    expect(store.markUnavailable).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    budget.close();
  });

  it("fails closed when the activation boundary cannot be verified", async () => {
    const { store, budget } = fixture();
    store.countingStartsAt.mockRejectedValue(new Error("Unreadable ledger"));
    const notification = usage();
    await budget.observe(notification, envelope(notification));
    expect(store.recordUsage).not.toHaveBeenCalled();
    expect(store.markUnavailable).toHaveBeenCalledWith("invalid_accounting_boundary");
    await expect(budget.beforeRequest("turn/start", { threadId: "another" }))
      .rejects.toMatchObject({ code: "WEEKLY_TOKEN_BUDGET_UNAVAILABLE" });
    budget.close();
  });
});
