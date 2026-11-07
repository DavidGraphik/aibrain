/** Employee-visible allowance. Token counters and provider usage remain server-only. */
export type EmployeeWeeklyBudget = {
  initialized: boolean;
  weekStart: string;
  resetAt: string;
  remainingPercent: number | null;
  threshold: 0 | 25 | 50 | 75 | 100;
};

export type EmployeeWeeklyBudgetResponse = { budget: EmployeeWeeklyBudget | null };

export function isEmployeeWeeklyBudget(value: unknown): value is EmployeeWeeklyBudget {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EmployeeWeeklyBudget>;
  return Object.keys(value).length === 5 &&
    typeof candidate.weekStart === "string" && Number.isFinite(Date.parse(candidate.weekStart)) &&
    typeof candidate.resetAt === "string" && Number.isFinite(Date.parse(candidate.resetAt)) &&
    typeof candidate.initialized === "boolean" &&
    [0, 25, 50, 75, 100].includes(candidate.threshold ?? -1) &&
    (candidate.initialized
      ? typeof candidate.remainingPercent === "number" && Number.isInteger(candidate.remainingPercent) &&
        candidate.remainingPercent >= 0 && candidate.remainingPercent <= 100
      : candidate.remainingPercent === null && candidate.threshold === 0);
}

export function isEmployeeWeeklyBudgetResponse(value: unknown): value is EmployeeWeeklyBudgetResponse {
  return Boolean(value && typeof value === "object" && Object.keys(value).length === 1 &&
    "budget" in value && (value.budget === null || isEmployeeWeeklyBudget(value.budget)));
}
