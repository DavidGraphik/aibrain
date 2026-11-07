import type { AuthSession } from "@/auth/types";
import { loadInstallationConfig } from "@/config/installation";
import type { EmployeeWeeklyBudget } from "@/usage/employee-budget-contract";
import { usageLimitIsUnlimited } from "@/usage/usage-limit-policy";
import { WeeklyTokenBudgetStore } from "@/usage/weekly-token-budget";

export class EmployeeBudgetAccessError extends Error {
  readonly code = "BUDGET_ACCESS_DENIED";
  constructor() { super("No tienes acceso a este saldo semanal."); }
}

/** No workspace role bypasses this projection; operators use the host ledger. */
export async function employeeWeeklyBudget(session: AuthSession): Promise<EmployeeWeeklyBudget | null> {
  const installation = await loadInstallationConfig();
  if (session.provider !== "local" || session.tenant.id !== installation.installationId) {
    throw new EmployeeBudgetAccessError();
  }
  if (!installation.usageLimits) return null;
  const status = await new WeeklyTokenBudgetStore({
    installationId: installation.installationId,
    dataRoot: installation.paths.dataRoot,
    limitTokens: installation.usageLimits.weeklyTokens,
  }).status();
  if (usageLimitIsUnlimited(installation.usageLimits)) {
    return {
      initialized: status.initialized,
      weekStart: status.weekStart,
      resetAt: status.resetAt,
      remainingPercent: status.initialized ? 100 : null,
      threshold: 0,
    };
  }
  return {
    initialized: status.initialized,
    weekStart: status.weekStart,
    resetAt: status.resetAt,
    // Round up so a positive balance never appears exhausted before admission closes.
    remainingPercent: status.initialized && status.remainingTokens !== null
      ? Math.max(0, Math.min(100, Math.ceil(status.remainingTokens / status.limitTokens * 100)))
      : null,
    threshold: status.threshold,
  };
}
