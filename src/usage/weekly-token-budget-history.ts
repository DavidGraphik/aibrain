import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { InstallationConfig } from "@/config/installation-schema";
import type { WeeklyTokenBudgetStore } from "@/usage/weekly-token-budget";

type HistorySeed = Parameters<WeeklyTokenBudgetStore["initializeFromHistory"]>[0];
type UsageEvent = { timestamp: string; ordinal: number; total: number; last: number };
type History = { userId: string; threadId: string; createdAt: string; events: UsageEvent[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });

function dateAt(value: string | Date) {
  const parts = dateFormatter.formatToParts(new Date(value));
  return ["year", "month", "day"].map((name) => parts.find((part) => part.type === name)?.value).join("-");
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function regularFiles(directory: string, depth = 0): Promise<string[]> {
  if (depth > 5) throw new Error("BUDGET_HISTORY_DIRECTORY_DEPTH");
  let metadata;
  try { metadata = await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("BUDGET_HISTORY_UNSAFE_DIRECTORY");
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("BUDGET_HISTORY_SYMLINK");
    if (entry.isDirectory()) result.push(...await regularFiles(candidate, depth + 1));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(candidate);
    if (result.length > 50_000) throw new Error("BUDGET_HISTORY_TOO_MANY_FILES");
  }
  return result;
}

/** Read-only bootstrap. Run offline: a changing log is rejected, never counted as zero. */
export async function readWeeklyTokenBudgetHistory(
  config: Pick<InstallationConfig, "paths">,
  now = new Date(),
  options: { startNow?: boolean } = {},
): Promise<{ seed: HistorySeed; files: number; sessions: number; resets: number }> {
  const capturedAt = now.toISOString();
  const monday = new Date(`${dateAt(now)}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const mondayDate = monday.toISOString().slice(0, 10);
  const histories = new Map<string, History>();
  let files = 0;
  for (const user of await readdir(config.paths.usersRoot, { withFileTypes: true })) {
    if (!UUID.test(user.name)) continue;
    if (!user.isDirectory() || user.isSymbolicLink()) throw new Error("BUDGET_HISTORY_UNSAFE_USER");
    const home = path.join(config.paths.usersRoot, user.name, "runtime", "codex-home");
    // Validate intermediate paths as well as the final session directory.
    for (const parent of [path.dirname(home), home]) {
      try {
        const stat = await lstat(parent);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("BUDGET_HISTORY_UNSAFE_HOME");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const filename of [...await regularFiles(path.join(home, "sessions")), ...await regularFiles(path.join(home, "archived_sessions"))]) {
      files += 1;
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      let meta: { threadId: string; createdAt: string } | null = null;
      const events: UsageEvent[] = [];
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > 512 * 1024 * 1024) throw new Error("BUDGET_HISTORY_UNSAFE_FILE");
        const stream = handle.createReadStream({ autoClose: false });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            if (!line.includes('"token_count"') && !line.includes('"session_meta"')) continue;
            const row: unknown = JSON.parse(line);
            if (!record(row) || !record(row.payload)) throw new Error("BUDGET_HISTORY_INVALID_RECORD");
            if (row.type === "session_meta" && !meta) {
              if (typeof row.payload.id !== "string" || !timestamp(row.payload.timestamp)) throw new Error("BUDGET_HISTORY_INVALID_SESSION");
              // Fork files may contain the parent's metadata after their own.
              meta = { threadId: row.payload.id, createdAt: new Date(row.payload.timestamp).toISOString() };
              if (meta.createdAt > capturedAt) throw new Error("BUDGET_HISTORY_FUTURE_SESSION");
            } else if (row.type === "event_msg" && row.payload.type === "token_count") {
              const info = row.payload.info;
              if (info == null) continue;
              if (!record(info) || !record(info.total_token_usage) || !record(info.last_token_usage) ||
                  !integer(info.total_token_usage.total_tokens) || !integer(info.last_token_usage.total_tokens) ||
                  info.last_token_usage.total_tokens > info.total_token_usage.total_tokens || !timestamp(row.timestamp)) {
                throw new Error("BUDGET_HISTORY_INVALID_USAGE");
              }
              events.push({ timestamp: new Date(row.timestamp).toISOString(), ordinal: integer(row.ordinal) ? row.ordinal : -1,
                total: info.total_token_usage.total_tokens, last: info.last_token_usage.total_tokens });
            }
          }
          const after = await handle.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("BUDGET_HISTORY_ACTIVE_WRITER");
        } finally { lines.close(); stream.destroy(); }
      } finally { await handle.close(); }
      if (!meta) throw new Error("BUDGET_HISTORY_MISSING_SESSION");
      const key = `${user.name}:${meta.threadId}`;
      const history = histories.get(key);
      if (history) history.events.push(...events);
      else histories.set(key, { userId: user.name, ...meta, events });
    }
  }

  const daily = new Map<string, number>();
  const cursors: HistorySeed["cursors"] = [];
  let resets = 0;
  for (const history of histories.values()) {
    let previous: number | null = null;
    let latestAt = history.createdAt;
    let inheritedPrefix = false;
    let ownedUsageSeen = false;
    const seen = new Set<string>();
    for (const event of history.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.ordinal - b.ordinal)) {
      if (event.timestamp > capturedAt) throw new Error("BUDGET_HISTORY_FUTURE_EVENT");
      const signature = JSON.stringify([event.timestamp, event.total, event.last]);
      if (seen.has(signature)) continue;
      seen.add(signature);
      let delta = previous === null ? event.total : event.total - previous;
      const uncertainInitial = previous === null && event.total !== event.last;
      previous = event.total;
      latestAt = event.timestamp;
      // An explicit fresh allowance excludes all pre-activation consumption.
      // Keep the measured cursor even when older consumption cannot be
      // reconstructed (for example, truncated or ephemeral legacy history).
      // Structural validation, timestamps and file-safety checks still apply.
      if (options.startNow) continue;
      const date = dateAt(event.timestamp);
      if (event.timestamp < history.createdAt) { inheritedPrefix = true; continue; }
      // A fork can start a fresh counter even when its value happens to be
      // equal to or larger than the inherited parent's counter.
      if (!ownedUsageSeen && inheritedPrefix && event.total === event.last) {
        delta = event.last;
        resets += 1;
      }
      ownedUsageSeen = true;
      if (date < mondayDate) continue;
      if (uncertainInitial) throw new Error("BUDGET_HISTORY_MISSING_BASELINE");
      if (delta < 0) {
        if (event.total !== event.last) throw new Error("BUDGET_HISTORY_UNCERTAIN_RESET");
        delta = event.last;
        resets += 1;
      }
      if (delta > 0 && delta < event.last) throw new Error("BUDGET_HISTORY_UNCERTAIN_RESET");
      const sum = (daily.get(date) ?? 0) + delta;
      if (!Number.isSafeInteger(sum)) throw new Error("BUDGET_HISTORY_OVERFLOW");
      daily.set(date, sum);
    }
    if (previous !== null) cursors.push({ userId: history.userId, threadId: history.threadId, totalTokens: previous, observedAt: latestAt });
  }
  return { files, sessions: histories.size, resets, seed: { capturedAt, cursors,
    dailyTotals: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([date, totalTokens]) => ({ date, totalTokens })) } };
}
