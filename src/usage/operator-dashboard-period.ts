const MADRID_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function operatorDashboardCountingStart(weekStart: string, countingStartsAt: string | null) {
  return Math.max(Date.parse(weekStart), countingStartsAt ? Date.parse(countingStartsAt) : 0);
}

export function operatorDashboardLocalDay(completedAt: string) {
  return MADRID_DAY.format(new Date(completedAt));
}
