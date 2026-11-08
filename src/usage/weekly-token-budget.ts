import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  defineVersionedSchema,
  expectArray,
  expectInteger,
  expectIsoDate,
  expectStrictRecord,
  expectString,
  readValidatedJson,
  ResourceLockManager,
  ValidationContext,
} from "@/storage";

export const WEEKLY_TOKEN_BUDGET_TIME_ZONE = "Europe/Madrid";
export type WeeklyTokenBudgetThreshold = 0 | 25 | 50 | 75 | 100;
export type WeeklyTokenBudgetStatus = {
  initialized: boolean;
  weekStart: string;
  resetAt: string;
  usedTokens: number | null;
  limitTokens: number;
  remainingTokens: number | null;
  percent: number | null;
  threshold: WeeklyTokenBudgetThreshold;
};
export type WeeklyTokenBudgetUsage = {
  userId: string;
  threadId: string;
  eventId: string;
  /** Cumulative input + output; cached input is already included, not added again. */
  totalTokens: number;
  /** The provider's latest response input + output, used only for a verified reset. */
  lastTokens: number;
  observedAt?: string;
};
export type WeeklyTokenBudgetSeed = {
  dailyTotals: Array<{ date: string; totalTokens: number }>;
  cursors: Array<{ userId: string; threadId: string; totalTokens: number; observedAt?: string }>;
  capturedAt: string;
  seenEvents?: WeeklyTokenBudgetUsage[];
};

export class WeeklyTokenBudgetError extends Error {
  constructor(readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WeeklyTokenBudgetError";
  }
}

type Cursor = { key: string; totalTokens: number; observedAt: string };
type SeenEvent = { key: string; fingerprint: string };
type BudgetState = {
  schemaVersion: 1;
  installationId: string;
  initializedAt: string;
  checkedWeekStart: string;
  blockedReason: string | null;
  dailyTotals: Array<{ date: string; totalTokens: number }>;
  cursors: Cursor[];
  seenEvents: SeenEvent[];
};
const DAY_MS = 86_400_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
// Evidence is never pruned silently: reaching capacity blocks admission until
// an operator migrates the ledger with its replay/cursor guarantees intact.
const MAX_EVIDENCE = 1_000_000;
const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: WEEKLY_TOKEN_BUDGET_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function parts(at: number) {
  const values = Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
}
function dateInMadrid(at: number) {
  const value = parts(at);
  return `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}
function localMidnight(calendarDate: number) {
  let result = calendarDate;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const p = parts(result);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    result += calendarDate - wall;
  }
  return new Date(result).toISOString();
}

/** Calendar weeks, not fixed 168-hour intervals: DST weeks have 167/169 hours. */
export function weeklyTokenBudgetWindow(at: number | Date | string = Date.now()) {
  const timestamp = at instanceof Date ? at.getTime() : typeof at === "string" ? Date.parse(at) : at;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new WeeklyTokenBudgetError("WEEKLY_TOKEN_BUDGET_UNAVAILABLE", "Weekly token budget clock is invalid.");
  }
  const p = parts(timestamp);
  const date = Date.UTC(p.year, p.month - 1, p.day);
  const monday = date - ((new Date(date).getUTCDay() + 6) % 7) * DAY_MS;
  return { weekStart: localMidnight(monday), resetAt: localMidnight(monday + 7 * DAY_MS) };
}

function hash(...values: Array<string | number>) {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
function integer(value: unknown, context: ValidationContext) {
  return expectInteger(value, context, { minimum: 0 });
}
function iso(value: unknown, context: ValidationContext) {
  return new Date(expectIsoDate(value, context)).toISOString();
}
function dateOnly(value: unknown, context: ValidationContext) {
  const date = expectString(value, context, { pattern: /^\d{4}-\d{2}-\d{2}$/ });
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    context.fail("must be a valid calendar date");
  }
  return date;
}
function parseDaily(value: unknown, context: ValidationContext) {
  const record = expectStrictRecord(value, ["date", "totalTokens"], context);
  return { date: dateOnly(record.date, context.at("date")), totalTokens: integer(record.totalTokens, context.at("totalTokens")) };
}
function unique(values: readonly string[], context: ValidationContext) {
  if (new Set(values).size !== values.length) context.fail("must contain unique keys");
}
const stateSchema = defineVersionedSchema<BudgetState>({
  name: "WeeklyTokenBudgetState", schemaVersion: 1,
  keys: ["installationId", "initializedAt", "checkedWeekStart", "blockedReason", "dailyTotals", "cursors", "seenEvents"],
  parse(record, context) {
    const dailyTotals = expectArray(record.dailyTotals, context.at("dailyTotals"), parseDaily, { maxLength: 36_600 });
    const cursors = expectArray(record.cursors, context.at("cursors"), (value, c) => {
      const item = expectStrictRecord(value, ["key", "totalTokens", "observedAt"], c);
      return { key: expectString(item.key, c.at("key"), { pattern: HASH_PATTERN }),
        totalTokens: integer(item.totalTokens, c.at("totalTokens")), observedAt: iso(item.observedAt, c.at("observedAt")) };
    }, { maxLength: MAX_EVIDENCE });
    const seenEvents = expectArray(record.seenEvents, context.at("seenEvents"), (value, c) => {
      const item = expectStrictRecord(value, ["key", "fingerprint"], c);
      return { key: expectString(item.key, c.at("key"), { pattern: HASH_PATTERN }),
        fingerprint: expectString(item.fingerprint, c.at("fingerprint"), { pattern: HASH_PATTERN }) };
    }, { maxLength: MAX_EVIDENCE });
    unique(dailyTotals.map((d) => d.date), context.at("dailyTotals"));
    unique(cursors.map((c) => c.key), context.at("cursors"));
    unique(seenEvents.map((e) => e.key), context.at("seenEvents"));
    const initializedAt = iso(record.initializedAt, context.at("initializedAt"));
    const checkedWeekStart = iso(record.checkedWeekStart, context.at("checkedWeekStart"));
    if (weeklyTokenBudgetWindow(checkedWeekStart).weekStart !== checkedWeekStart || checkedWeekStart < weeklyTokenBudgetWindow(initializedAt).weekStart) {
      context.at("checkedWeekStart").fail("must be a valid week at or after initialization");
    }
    return { schemaVersion: 1,
      installationId: expectString(record.installationId, context.at("installationId"), { pattern: /^[a-z0-9][a-z0-9-]{0,62}$/ }),
      initializedAt, checkedWeekStart,
      blockedReason: record.blockedReason === null ? null : expectString(record.blockedReason, context.at("blockedReason"), { pattern: REASON_PATTERN }),
      dailyTotals, cursors, seenEvents };
  },
});

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
function unavailable(message: string, cause?: unknown) {
  return new WeeklyTokenBudgetError("WEEKLY_TOKEN_BUDGET_UNAVAILABLE", message, { cause });
}
function validateIdentity(value: string) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw unavailable("Weekly token budget identity is invalid.");
}
function checkedCount(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw unavailable("Weekly token budget count is invalid.");
  return value;
}
function checkedIso(value: string) {
  const timestamp = Date.parse(value);
  if (typeof value !== "string" || !Number.isSafeInteger(timestamp) || timestamp < 0) throw unavailable("Weekly token budget timestamp is invalid.");
  return new Date(timestamp).toISOString();
}

export class WeeklyTokenBudgetStore {
  readonly statePath: string;
  private readonly dataRoot: string;
  private readonly root: string;
  private readonly installationId: string;
  private readonly limitTokens: number;
  private readonly now: () => number;
  private readonly locks: ResourceLockManager;

  constructor(options: { installationId: string; dataRoot: string; limitTokens: number; now?: () => number }) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.installationId) || !path.isAbsolute(options.dataRoot) || checkedCount(options.limitTokens) === 0) {
      throw unavailable("Weekly token budget configuration is invalid.");
    }
    this.installationId = options.installationId;
    this.dataRoot = path.resolve(options.dataRoot);
    this.root = path.join(this.dataRoot, "usage");
    this.statePath = path.join(this.root, "weekly-token-budget.json");
    this.limitTokens = options.limitTokens;
    this.now = options.now ?? Date.now;
    this.locks = new ResourceLockManager({ rootDirectory: path.join(this.root, "locks") });
  }

  private async prepare() {
    const data = await lstat(this.dataRoot);
    if (!data.isDirectory() || data.isSymbolicLink()) throw unavailable("Weekly token budget data root is unsafe.");
    for (const directory of [this.root, path.join(this.root, "locks")]) {
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
        throw unavailable("Weekly token budget storage is unsafe.");
      }
    }
  }

  private async locked<T>(action: () => Promise<T>): Promise<T> {
    try {
      await this.prepare();
      // The filename is shared within dataRoot. A misconfigured second
      // installation must serialize here too, then fail the identity check.
      return await this.locks.withLock("weekly-token-budget", action);
    } catch (error) {
      if (error instanceof WeeklyTokenBudgetError) throw error;
      throw unavailable("Weekly token budget state could not be verified or persisted.", error);
    }
  }

  private async read(): Promise<BudgetState | null> {
    try {
      const metadata = await lstat(this.statePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
        throw unavailable("Weekly token budget file is unsafe.");
      }
      const state = await readValidatedJson(this.statePath, stateSchema);
      if (state.installationId !== this.installationId) throw unavailable("Weekly token budget belongs to another installation.");
      return state;
    } catch (error) { if (isMissing(error)) return null; throw error; }
  }

  private write(state: BudgetState) { return atomicWriteJson(this.statePath, state, stateSchema, { mode: 0o600 }); }

  private async current(state: BudgetState | null): Promise<WeeklyTokenBudgetStatus> {
    const window = weeklyTokenBudgetWindow(this.now());
    if (!state) return { initialized: false, ...window, usedTokens: null, limitTokens: this.limitTokens,
      remainingTokens: null, percent: null, threshold: 0 };
    if (state.blockedReason !== null) throw unavailable("Weekly token budget accounting requires reconciliation.");
    if (window.weekStart < state.checkedWeekStart) throw unavailable("Weekly token budget clock moved to an earlier week.");
    if (window.weekStart > state.checkedWeekStart) {
      state.checkedWeekStart = window.weekStart;
      await this.write(state);
    }
    const startDate = dateInMadrid(Date.parse(window.weekStart));
    const endDate = dateInMadrid(Date.parse(window.resetAt));
    const usedTokens = checkedCount(state.dailyTotals.reduce((sum, day) =>
      day.date >= startDate && day.date < endDate ? sum + day.totalTokens : sum, 0));
    const percent = usedTokens / this.limitTokens * 100;
    const threshold: WeeklyTokenBudgetThreshold = percent >= 100 ? 100 : percent >= 75 ? 75 : percent >= 50 ? 50 : percent >= 25 ? 25 : 0;
    return { initialized: true, ...window, usedTokens, limitTokens: this.limitTokens,
      remainingTokens: Math.max(0, this.limitTokens - usedTokens), percent, threshold };
  }

  status() { return this.locked(async () => this.current(await this.read())); }

  /** Private runtime boundary; never included in the employee-facing status. */
  countingStartsAt() { return this.locked(async () => (await this.read())?.initializedAt ?? null); }

  async assertAvailable() {
    const status = await this.status();
    if (!status.initialized) throw new WeeklyTokenBudgetError("WEEKLY_TOKEN_BUDGET_UNINITIALIZED", "Weekly token budget requires a verified historical baseline.");
    if (status.threshold === 100) throw new WeeklyTokenBudgetError("WEEKLY_TOKEN_BUDGET_EXHAUSTED", "Weekly token budget is exhausted.");
    return status;
  }

  async markUnavailable(reason = "accounting_unavailable") {
    if (!REASON_PATTERN.test(reason)) throw unavailable("Weekly token budget accounting reason is invalid.");
    return this.locked(async () => {
      const state = await this.read();
      if (!state || state.blockedReason) return;
      state.blockedReason = reason;
      await this.write(state);
    });
  }

  /** Operator-only, quiesced import; never overwrites a prior budget or unblocks it. */
  async initializeFromHistory(seed: WeeklyTokenBudgetSeed) {
    return this.locked(async () => {
      if (await this.read()) throw new WeeklyTokenBudgetError("WEEKLY_TOKEN_BUDGET_ALREADY_INITIALIZED", "Weekly token budget is already initialized.");
      const capturedAt = checkedIso(seed.capturedAt);
      if (Date.parse(capturedAt) > this.now()) throw unavailable("Weekly token budget baseline is in the future.");
      const dailyTotals = seed.dailyTotals.map((item) => parseDaily(item, new ValidationContext("WeeklyTokenBudgetSeed", "seed")));
      if (dailyTotals.some((day) => day.date > dateInMadrid(Date.parse(capturedAt)))) throw unavailable("Weekly token budget baseline includes future usage.");
      const cursors = seed.cursors.map((cursor) => {
        validateIdentity(cursor.userId); validateIdentity(cursor.threadId);
        const observedAt = checkedIso(cursor.observedAt ?? capturedAt);
        if (observedAt > capturedAt) throw unavailable("Weekly token budget cursor is after the baseline.");
        return { key: hash(cursor.userId, cursor.threadId), totalTokens: checkedCount(cursor.totalTokens), observedAt };
      });
      const seenEvents = (seed.seenEvents ?? []).map((event) => {
        const normalized = this.normalize(event, capturedAt);
        if (normalized.observedAt > capturedAt) throw unavailable("Weekly token budget evidence is after the baseline.");
        return normalized.evidence;
      });
      const state: BudgetState = { schemaVersion: 1, installationId: this.installationId,
        initializedAt: capturedAt, checkedWeekStart: weeklyTokenBudgetWindow(this.now()).weekStart,
        blockedReason: null, dailyTotals, cursors, seenEvents };
      await this.write(state);
      return this.current(state);
    });
  }

  /** Operator-only, offline recovery during an explicitly configured free period.
   * Preserve activation, charged totals and replay evidence; advance only measured
   * session cursors. This cannot grant a new allowance or recover a metered period.
   */
  async reconcileUnlimitedHistory(seed: WeeklyTokenBudgetSeed, unlimitedUntil: string) {
    return this.locked(async () => {
      const until = checkedIso(unlimitedUntil);
      const capturedAt = checkedIso(seed.capturedAt);
      if (Date.parse(until) <= this.now() || Date.parse(capturedAt) > this.now() || capturedAt >= until ||
          seed.dailyTotals.length !== 0 || (seed.seenEvents?.length ?? 0) !== 0) {
        throw unavailable("Recovery requires an active unlimited period and an uncharged offline snapshot.");
      }
      const existing = await this.read();
      if (!existing || existing.blockedReason !== "usage_evidence_invalid" || capturedAt < existing.initializedAt) {
        throw unavailable("Recovery requires the existing invalid-evidence ledger.");
      }
      const state = structuredClone(existing);
      const keys = new Set<string>();
      let advanced = 0;
      for (const input of seed.cursors) {
        validateIdentity(input.userId); validateIdentity(input.threadId);
        const observedAt = checkedIso(input.observedAt ?? capturedAt);
        if (observedAt > capturedAt) throw unavailable("Recovery cursor is after its offline snapshot.");
        const key = hash(input.userId, input.threadId);
        if (keys.has(key)) throw unavailable("Recovery cursor identity is duplicated.");
        keys.add(key);
        const totalTokens = checkedCount(input.totalTokens);
        const cursor = state.cursors.find((item) => item.key === key);
        if (cursor && observedAt < cursor.observedAt) {
          // Retained transport evidence can be newer than the session file.
          // Never rewind it from a stale history snapshot.
          continue;
        }
        if (cursor && observedAt === cursor.observedAt && totalTokens !== cursor.totalTokens) {
          throw unavailable("Recovery cursor conflicts with retained evidence.");
        }
        if (!cursor || observedAt > cursor.observedAt) advanced += 1;
        if (cursor) Object.assign(cursor, { totalTokens, observedAt });
        else state.cursors.push({ key, totalTokens, observedAt });
      }
      if (advanced === 0) throw unavailable("Recovery has no newer measured cursor evidence.");
      state.blockedReason = null;
      await this.write(state);
      return this.current(state);
    });
  }

  private normalize(input: WeeklyTokenBudgetUsage, fallbackAt: string) {
    validateIdentity(input.userId); validateIdentity(input.threadId); validateIdentity(input.eventId);
    checkedCount(input.totalTokens); checkedCount(input.lastTokens);
    if (input.lastTokens > input.totalTokens) throw unavailable("Weekly token budget response exceeds its cumulative usage.");
    const observedAt = checkedIso(input.observedAt ?? fallbackAt);
    return { ...input, observedAt, cursorKey: hash(input.userId, input.threadId), evidence: {
      key: hash(input.userId, input.threadId, input.eventId),
      // An omitted timestamp may legitimately resolve later on a replay. The
      // event id and counters are the durable evidence, not receipt time.
      fingerprint: hash(input.totalTokens, input.lastTokens),
    } };
  }

  async recordUsage(input: WeeklyTokenBudgetUsage, options?: { countTowardLimit?: boolean }) {
    return this.locked(async () => {
      const state = await this.read();
      if (!state) throw new WeeklyTokenBudgetError("WEEKLY_TOKEN_BUDGET_UNINITIALIZED", "Weekly token budget requires a verified historical baseline.");
      await this.current(state);
      try {
        const event = this.normalize(input, new Date(this.now()).toISOString());
        if (Date.parse(event.observedAt) > this.now()) throw unavailable("Weekly token budget event is in the future.");
        const seen = state.seenEvents.find((item) => item.key === event.evidence.key);
        if (seen) {
          if (seen.fingerprint !== event.evidence.fingerprint) throw unavailable("Weekly token budget event identity conflicts with prior evidence.");
          return this.current(state);
        }
        if (state.seenEvents.length >= MAX_EVIDENCE) throw unavailable("Weekly token budget evidence capacity is exhausted.");
        let cursor = state.cursors.find((item) => item.key === event.cursorKey);
        let delta = 0;
        // The operator attests that all consumption up to capturedAt is either
        // imported or explicitly excluded by a fresh initial allowance. Such
        // replay never rewinds a cursor or charges the activation baseline.
        if (event.observedAt > state.initializedAt && (!cursor || event.observedAt >= cursor.observedAt)) {
          if (!cursor) {
            if (event.totalTokens !== event.lastTokens) throw unavailable("Weekly token budget thread has no cumulative baseline.");
            if (state.cursors.length >= MAX_EVIDENCE) throw unavailable("Weekly token budget cursor capacity is exhausted.");
            cursor = { key: event.cursorKey, totalTokens: 0, observedAt: event.observedAt };
            state.cursors.push(cursor);
            delta = event.totalTokens;
          } else if (event.totalTokens !== cursor.totalTokens && event.totalTokens === event.lastTokens &&
              event.observedAt > cursor.observedAt) {
            // App Server resets cumulative usage on resume. The first response
            // can exceed the previous process's entire counter. Equality of
            // total and last proves a fresh counter regardless of its size.
            delta = event.lastTokens;
          } else if (event.totalTokens >= cursor.totalTokens) {
            delta = event.totalTokens - cursor.totalTokens;
            // A fresh response cannot consume more than the positive change
            // in its cumulative counter. That would hide a reset or a missing
            // historical boundary. Identical snapshots remain harmless replay;
            // a larger delta can legitimately include missed notifications.
            if (delta > 0 && delta < event.lastTokens) {
              throw unavailable("Weekly token budget cumulative increase is smaller than its latest response.");
            }
          } else {
            if (event.totalTokens !== event.lastTokens || event.observedAt <= cursor.observedAt) {
              throw unavailable("Weekly token budget cumulative usage reset is ambiguous.");
            }
            delta = event.lastTokens;
          }
          cursor.totalTokens = event.totalTokens;
          cursor.observedAt = event.observedAt;
          if (options?.countTowardLimit !== false) {
            const date = dateInMadrid(Date.parse(event.observedAt));
            const daily = state.dailyTotals.find((item) => item.date === date);
            if (daily) daily.totalTokens = checkedCount(daily.totalTokens + delta);
            else state.dailyTotals.push({ date, totalTokens: delta });
          }
        }
        state.seenEvents.push(event.evidence);
        await this.write(state);
        return this.current(state);
      } catch (error) {
        state.blockedReason = "usage_evidence_invalid";
        await this.write(state);
        throw error;
      }
    });
  }
}
