import { pathToFileURL } from "node:url";
import { loadInstallationConfig } from "../src/config/installation";
import type { InstallationConfig } from "../src/config/installation-schema";
import { WeeklyTokenBudgetStore } from "../src/usage/weekly-token-budget";
import { readWeeklyTokenBudgetHistory } from "../src/usage/weekly-token-budget-history";

export function parseWeeklyTokenBudgetArguments(args: readonly string[]) {
  if (!args.includes("--offline") || new Set(args).size !== args.length ||
      args.some((arg) => !["--offline", "--apply", "--start-now", "--reconcile-unlimited"].includes(arg)) ||
      (args.includes("--start-now") && args.includes("--reconcile-unlimited"))) {
    throw new Error("Use --offline [--apply] [--start-now] after stopping all installation model workers. Default: read-only history preview. --start-now grants the explicitly authorized initial allowance without charging prior usage.");
  }
  return { apply: args.includes("--apply"), startNow: args.includes("--start-now"),
    ...(args.includes("--reconcile-unlimited") ? { reconcileUnlimited: true } : {}) };
}

export async function initializeWeeklyTokenBudget(
  config: Readonly<Pick<InstallationConfig, "installationId" | "paths" | "usageLimits">>,
  options: ReturnType<typeof parseWeeklyTokenBudgetArguments>,
  now = new Date(),
) {
  if (!config.usageLimits) throw new Error("The installation has no weekly token policy.");
  if (options.reconcileUnlimited && (!config.usageLimits.unlimitedUntil ||
      now.getTime() >= Date.parse(config.usageLimits.unlimitedUntil))) {
    throw new Error("Recovery requires an active configured unlimited period.");
  }
  const history = await readWeeklyTokenBudgetHistory(config, now, { startNow: options.startNow || options.reconcileUnlimited });
  const summary = { installationId: config.installationId, files: history.files, sessions: history.sessions,
    resets: history.resets, weeklyTokens: config.usageLimits.weeklyTokens,
    recordedTokens: history.seed.dailyTotals.reduce((sum, day) => sum + day.totalTokens, 0),
    historicalCoverage: options.startNow ? "pre-activation-usage-excluded" : "session-logs-only",
    initializationPolicy: options.reconcileUnlimited ? "reconcile-unlimited" : options.startNow ? "start-now" : "include-history",
    ...(options.reconcileUnlimited ? { snapshotCapturedAt: history.seed.capturedAt, measuredCursors: history.seed.cursors.length,
      activationAndChargesPreserved: true } : { countingStartsAt: history.seed.capturedAt }) };
  if (!options.apply) return { ...summary, mode: "preview" };
  // Legacy ephemeral horarIA/knowledge calls may not have session logs. A
  // measured lower bound is sufficient only when it already exhausts this
  // week; otherwise importing it could silently grant unearned allowance.
  if (!options.startNow && !options.reconcileUnlimited && summary.recordedTokens < summary.weeklyTokens) {
    throw new Error("BUDGET_HISTORY_INCOMPLETE_COVERAGE: legacy session logs are below the limit; reconcile ephemeral usage before initializing.");
  }
  const store = new WeeklyTokenBudgetStore({ installationId: config.installationId,
    dataRoot: config.paths.dataRoot, limitTokens: config.usageLimits.weeklyTokens, now: () => now.getTime() });
  const status = options.reconcileUnlimited
    ? await store.reconcileUnlimitedHistory(history.seed, config.usageLimits.unlimitedUntil!)
    : await store.initializeFromHistory(history.seed);
  return { ...summary, mode: options.reconcileUnlimited ? "reconciled" : "initialized", status };
}

async function main() {
  const options = parseWeeklyTokenBudgetArguments(process.argv.slice(2));
  const config = await loadInstallationConfig();
  const result = await initializeWeeklyTokenBudget(config, options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "BUDGET_INITIALIZATION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
