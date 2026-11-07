import { randomUUID } from "node:crypto";
import type { ServerNotification } from "../../contracts/codex/0.162.1/types/ServerNotification";
import type { InstallationConfig } from "@/config/installation-schema";
import type { AppServerEvent, JsonValue } from "@/runtime/transport";
import { WeeklyTokenBudgetStore } from "@/usage/weekly-token-budget";

type BudgetStore = Pick<WeeklyTokenBudgetStore, "assertAvailable" | "recordUsage" | "markUnavailable" | "countingStartsAt">;
type ActiveTurn = { threadId: string; turnId: string; usageObserved: boolean };
type RequestMethod = "turn/start" | "turn/steer";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function tokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function turnKey(threadId: string, turnId: string) {
  return JSON.stringify([threadId, turnId]);
}

export class WeeklyTokenBudgetRuntimeError extends Error {
  readonly code = "WEEKLY_TOKEN_BUDGET_UNAVAILABLE";
  constructor() {
    super("No se puede verificar el consumo semanal. Las solicitudes de IA se han detenido hasta recuperar la contabilización.");
    this.name = "WeeklyTokenBudgetRuntimeError";
  }
}

/**
 * Admission and metering for every inference in one employee's App Server.
 * The durable store shares accounting with all users/processes. Provider usage
 * arrives after inference, so interruption bounds further work, not overshoot.
 */
export class WeeklyTokenBudgetRuntime {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly completed = new Set<string>();
  private readonly observedUsage = new Set<string>();
  private readonly missingUsage = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly interrupts = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unavailable: Error | null = null;
  private countingStartsAt: number | null = null;
  private closed = false;

  constructor(private readonly options: {
    userId: string;
    store: BudgetStore;
    interrupt: (threadId: string, turnId: string, requestId: string) => Promise<unknown>;
    onFailure?: (error: unknown) => void;
    pollIntervalMs?: number;
    missingUsageGraceMs?: number;
    unlimitedUntil?: string;
    now?: () => number;
  }) {}

  private unlimited(at = (this.options.now ?? Date.now)()) {
    return Boolean(this.options.unlimitedUntil && at < Date.parse(this.options.unlimitedUntil));
  }

  async beforeRequest(method: RequestMethod, params: unknown, _requestId?: string) {
    if (!record(params) || !identifier(params.threadId)) throw new WeeklyTokenBudgetRuntimeError();
    if (this.unlimited()) {
      if (method === "turn/steer" && identifier(params.expectedTurnId)) this.bindTurn(params.threadId, params.expectedTurnId);
      return;
    }
    if (this.unavailable || this.missingUsage.size > 0) throw this.unavailable ?? new WeeklyTokenBudgetRuntimeError();
    try {
      await this.options.store.assertAvailable();
    } catch (error) {
      await this.interruptActive();
      throw error;
    }
    if (this.unavailable || this.missingUsage.size > 0) throw this.unavailable ?? new WeeklyTokenBudgetRuntimeError();
    if (method === "turn/steer" && identifier(params.expectedTurnId)) this.bindTurn(params.threadId, params.expectedTurnId);
  }

  accepted(method: RequestMethod, params: unknown, result: JsonValue, _requestId?: string) {
    if (method !== "turn/start" || !record(params) || !identifier(params.threadId)) return;
    if (record(result) && record(result.turn) && identifier(result.turn.id)) {
      this.bindTurn(params.threadId, result.turn.id);
    }
  }

  /** Binding includes existing turns recovered after an app/worker restart. */
  bindTurn(threadId: string, turnId: string) {
    if (this.closed || !identifier(threadId) || !identifier(turnId)) return;
    const key = turnKey(threadId, turnId);
    if (this.completed.has(key)) return;
    const previous = this.active.get(key);
    this.active.set(key, {
      threadId, turnId,
      usageObserved: previous?.usageObserved || this.observedUsage.has(key),
    });
    this.schedulePoll();
    if (this.unavailable && !this.unlimited()) void this.interruptActive();
  }

  async observe(notification: ServerNotification, event: AppServerEvent) {
    const { method } = notification;
    if (method !== "thread/tokenUsage/updated" && method !== "turn/started" && method !== "turn/completed") return;
    let historical: boolean;
    try {
      const occurredAt = Date.parse(event.occurredAt);
      if (!Number.isFinite(occurredAt)) throw new WeeklyTokenBudgetRuntimeError();
      if (this.countingStartsAt === null) {
        const boundary = await this.options.store.countingStartsAt();
        if (!boundary || !Number.isFinite(Date.parse(boundary))) throw new WeeklyTokenBudgetRuntimeError();
        this.countingStartsAt = Date.parse(boundary);
      }
      historical = occurredAt <= this.countingStartsAt;
    } catch {
      await this.accountingFailed("invalid_accounting_boundary");
      return;
    }
    const params: unknown = notification.params;
    if (!record(params) || !identifier(params.threadId)) {
      await this.accountingFailed("invalid_usage_scope");
      return;
    }
    const turnId = method === "thread/tokenUsage/updated"
      ? params.turnId
      : record(params.turn) ? params.turn.id : null;
    if (!identifier(turnId)) {
      await this.accountingFailed("invalid_usage_scope");
      return;
    }
    const key = turnKey(params.threadId, turnId);
    if (method === "turn/started") {
      if (!historical) this.bindTurn(params.threadId, turnId);
      return;
    }
    if (method === "turn/completed") {
      const active = this.active.get(key);
      this.active.delete(key);
      this.interrupts.delete(key);
      this.remember(this.completed, key);
      if (!historical && active && !active.usageObserved && record(params.turn) && params.turn.status === "completed") {
        // Usage can legitimately be delivered after the terminal event. New
        // inference is refused during this grace period; no spend is guessed.
        const timer = setTimeout(() => {
          this.missingUsage.delete(key);
          void this.accountingFailed("terminal_turn_missing_usage").catch((error) => this.options.onFailure?.(error));
        }, this.options.missingUsageGraceMs ?? 2_000);
        timer.unref?.();
        this.missingUsage.set(key, timer);
      }
      // A cancellation or provider failure can precede its first usage report.
      // It must not disable the whole installation. A delayed cumulative
      // report is still durably charged below, even after this turn ended.
      if (this.active.size === 0 && this.timer) { clearTimeout(this.timer); this.timer = null; }
      return;
    }
    const usage = params.tokenUsage;
    if (!record(usage) || !record(usage.total) || !record(usage.last) ||
        !tokens(usage.total.totalTokens) || !tokens(usage.last.totalTokens)) {
      await this.accountingFailed("invalid_usage_counters");
      return;
    }
    // Durable transport replays can predate a fresh allowance. Their usage
    // still reaches the store for deduplication, but cannot revive old turns
    // or require new usage evidence from work completed before activation.
    if (!historical) this.bindTurn(params.threadId, turnId);
    try {
      const promotional = this.unlimited(Date.parse(event.occurredAt));
      const meteredUsage = {
        userId: this.options.userId,
        threadId: params.threadId,
        eventId: event.eventId,
        totalTokens: usage.total.totalTokens,
        lastTokens: usage.last.totalTokens,
        observedAt: event.occurredAt,
      };
      const status = promotional
        ? await this.options.store.recordUsage(meteredUsage, { countTowardLimit: false })
        : await this.options.store.recordUsage(meteredUsage);
      this.remember(this.observedUsage, key);
      const active = this.active.get(key);
      if (active) active.usageObserved = true;
      const missing = this.missingUsage.get(key);
      if (missing) { clearTimeout(missing); this.missingUsage.delete(key); }
      if (!status.initialized || status.usedTokens === null) throw new WeeklyTokenBudgetRuntimeError();
      if (!promotional && status.usedTokens >= status.limitTokens) void this.interruptActive();
    } catch {
      await this.accountingFailed("usage_persistence_failed");
    }
  }

  private remember(target: Set<string>, key: string) {
    target.add(key);
    if (target.size > 2_048) target.delete(target.values().next().value!);
  }

  private schedulePoll() {
    if (this.closed || this.timer || this.active.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().finally(() => this.schedulePoll());
    }, this.options.pollIntervalMs ?? 2_000);
    this.timer.unref?.();
  }

  private async poll() {
    if (this.closed) return;
    if (this.unlimited()) return;
    try {
      if (this.unavailable) throw this.unavailable;
      await this.options.store.assertAvailable();
    } catch {
      await this.interruptActive();
    }
  }

  private async accountingFailed(reason: string) {
    this.unavailable ??= new WeeklyTokenBudgetRuntimeError();
    try { await this.options.store.markUnavailable(reason); }
    catch (error) {
      void this.interruptActive();
      this.options.onFailure?.(error);
      // No durable account of either the usage or its failure exists. Leave
      // the event unacknowledged for recovery instead of discarding it.
      throw error;
    }
    // The durable blocked ledger is now authoritative across all processes.
    // Do not await an RPC reply from the notification observation lane: a
    // long queued stream can hit transport backpressure before that reply.
    // Keeping the router alive also preserves reads and explicit stop.
    if (!this.unlimited()) void this.interruptActive();
  }

  private async interruptActive() {
    if (this.closed) return;
    await Promise.all([...this.active].map(([key, turn]) => {
      const pending = this.interrupts.get(key);
      if (pending) return pending;
      const stopping = Promise.resolve().then(() => this.options.interrupt(
        turn.threadId, turn.turnId, `weekly-budget-stop:${randomUUID()}`,
      )).then(() => undefined).catch((error) => {
        this.interrupts.delete(key);
        this.options.onFailure?.(error);
      });
      // Successful interrupts remain deduplicated until the terminal event.
      // Failed interrupts are retried by the cross-process budget poll.
      this.interrupts.set(key, stopping);
      return stopping;
    }));
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const timer of this.missingUsage.values()) clearTimeout(timer);
    this.missingUsage.clear();
  }
}

export function createWeeklyTokenBudgetRuntime(
  config: Readonly<InstallationConfig> | null,
  userId: string,
  interrupt: (threadId: string, turnId: string, requestId: string) => Promise<unknown>,
  onFailure?: (error: unknown) => void,
) {
  if (!config?.usageLimits) return null;
  return new WeeklyTokenBudgetRuntime({
    userId,
    store: new WeeklyTokenBudgetStore({
      installationId: config.installationId,
      dataRoot: config.paths.dataRoot,
      limitTokens: config.usageLimits.weeklyTokens,
    }),
    interrupt,
    onFailure,
    ...(config.usageLimits.unlimitedUntil ? { unlimitedUntil: config.usageLimits.unlimitedUntil } : {}),
  });
}
