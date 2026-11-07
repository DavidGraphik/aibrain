/** Admission has a bounded queue window. Work includes PDF
 * preparation and analysis; durable terminal/journal has a separate reserve. */
export const HOST_QUEUE_MS = 90_000;
export const HOST_WORK_MS = 360_000;
export const HOST_TERMINAL_MS = 15_000;
export const HOST_TOTAL_MS = HOST_QUEUE_MS + HOST_WORK_MS + HOST_TERMINAL_MS;
export type HostBudget = { submittedAt: number; queueUntil: number; terminalUntil: number; workUntil?: number };
export function createHostBudget(now: number, requestedDeadline?: number): HostBudget {
  const terminalUntil = Math.min(now + HOST_TOTAL_MS, requestedDeadline ?? Infinity);
  const queueUntil = terminalUntil - HOST_WORK_MS - HOST_TERMINAL_MS;
  if (!Number.isSafeInteger(terminalUntil) || queueUntil <= now) throw Error("HOST_ADMISSION_BUDGET_EXHAUSTED");
  return { submittedAt: now, queueUntil, terminalUntil };
}
export function admitHostBudget(budget: HostBudget | undefined, now: number): HostBudget {
  if (!budget) throw Error("HOST_BUDGET_MISSING"); // no invented lease for pre-upgrade pending work
  if (budget.workUntil !== undefined) {
    if (now >= budget.workUntil) throw Error("HOST_EXECUTION_TIMEOUT");
    return budget; // recovery never resets the clock
  }
  if (now >= budget.queueUntil) throw Error("HOST_QUEUE_TIMEOUT");
  return { ...budget, workUntil: now + HOST_WORK_MS, terminalUntil: now + HOST_WORK_MS + HOST_TERMINAL_MS };
}
export function hostWaitDeadline(budget: HostBudget | undefined) {
  if (!budget) throw Error("HOST_BUDGET_MISSING");
  return budget.workUntil === undefined ? budget.queueUntil : budget.terminalUntil;
}
export function hostWorkTimer(budget: HostBudget, now: () => number = Date.now) {
  if (!budget.workUntil || now() >= budget.workUntil) throw Error("HOST_EXECUTION_TIMEOUT");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error("HOST_EXECUTION_TIMEOUT")), budget.workUntil - now());
  timer.unref?.();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}
