import type { AutomationSchedule } from "@/automations/contracts";

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let value = formatterCache.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatterCache.set(timeZone, value);
  }
  return value;
}

export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function compareLocal(left: LocalParts, right: LocalParts) {
  return Date.UTC(left.year, left.month - 1, left.day, left.hour, left.minute) -
    Date.UTC(right.year, right.month - 1, right.day, right.hour, right.minute);
}

function sameLocal(left: LocalParts, right: LocalParts) {
  return compareLocal(left, right) === 0;
}

function offsetAt(instant: Date, timeZone: string) {
  const parts = localParts(instant, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) -
    Math.floor(instant.getTime() / 60_000) * 60_000;
}

/**
 * Resolves a wall-clock minute in an IANA zone. During an overlap the earliest
 * occurrence wins. During a spring-forward gap, the first valid minute later
 * on the same local date wins (for example 02:30 becomes 03:00 in Madrid).
 */
export function localMinuteToInstant(parts: LocalParts, timeZone: string) {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    offsets.add(offsetAt(new Date(naive + hours * 3_600_000), timeZone));
  }
  const exact = [...offsets]
    .map((offset) => new Date(naive - offset))
    .filter((candidate) => sameLocal(localParts(candidate, timeZone), parts))
    .sort((left, right) => left.getTime() - right.getTime());
  if (exact[0]) return exact[0];

  const start = naive - 6 * 3_600_000;
  const end = naive + 6 * 3_600_000;
  for (let instant = start; instant <= end; instant += 60_000) {
    const candidate = new Date(instant);
    const local = localParts(candidate, timeZone);
    if (local.year === parts.year && local.month === parts.month && local.day === parts.day &&
      compareLocal(local, parts) >= 0) return candidate;
  }
  throw new Error("No se ha podido resolver la hora local del horario.");
}

function addLocalDays(parts: LocalParts, days: number): LocalParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

function weekday(parts: LocalParts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

export function nextScheduledInstant(
  schedule: AutomationSchedule,
  timeZone: string,
  after: Date,
): string | null {
  if (schedule.kind === "external") return null;
  // Inclusive lower bound for recurring work. Move the search floor, rather
  // than creating earlier no-op occurrences or moving an interval's phase.
  const searchAfter = "startAt" in schedule && schedule.startAt
    ? new Date(Math.max(after.getTime(), Date.parse(schedule.startAt) - 1)) : after;
  if (schedule.kind === "interval") {
    const anchor = Date.parse(schedule.anchorAt);
    const duration = schedule.minutes * 60_000;
    const occurrence = Math.max(0, Math.floor((searchAfter.getTime() - anchor) / duration) + 1);
    const limit = Math.ceil(366 * 86_400_000 / duration);
    for (let step = 0; step <= limit; step += 1) {
      const candidate = new Date(anchor + (occurrence + step) * duration);
      if (!schedule.window) return candidate.toISOString();
      const local = localParts(candidate, timeZone);
      if (schedule.window.weekdays.includes(weekday(local)) && local.hour >= schedule.window.startHour && local.hour < schedule.window.endHour) return candidate.toISOString();
    }
    throw new Error("El intervalo no coincide con la ventana de trabajo indicada.");
  }
  if (schedule.kind === "once") {
    return new Date(schedule.runAt).getTime() > after.getTime() ? schedule.runAt : null;
  }

  const calendarAfter = searchAfter;
  const afterLocal = localParts(calendarAfter, timeZone);
  if (schedule.kind === "monthly") {
    for (let offset = 0; offset < 24; offset += 1) {
      const month = new Date(Date.UTC(afterLocal.year, afterLocal.month - 1 + offset, 1));
      if (!schedule.months.includes(month.getUTCMonth() + 1)) continue;
      const lastDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
      if (schedule.day > lastDay) continue; // A day 31 request never silently moves to day 30.
      const target = { year: month.getUTCFullYear(), month: month.getUTCMonth() + 1, day: schedule.day, hour: schedule.hour, minute: schedule.minute };
      const instant = localMinuteToInstant(target, timeZone);
      if (instant.getTime() > calendarAfter.getTime()) return instant.toISOString();
    }
    throw new Error("No se ha podido calcular la siguiente ejecución mensual.");
  }
  for (let add = 0; add <= 15; add += 1) {
    const target = addLocalDays({ ...afterLocal, hour: schedule.hour, minute: schedule.minute }, add);
    if (schedule.kind === "weekly" && !schedule.weekdays.includes(weekday(target))) continue;
    if (schedule.kind === "weekly" && schedule.intervalWeeks === 2 && schedule.anchorDate) {
      const anchor = new Date(schedule.anchorDate + "T00:00:00Z");
      const anchorMonday = anchor.getTime() - ((anchor.getUTCDay() + 6) % 7) * 86_400_000;
      const targetDay = Date.UTC(target.year,target.month-1,target.day);
      if (Math.floor((targetDay-anchorMonday)/(7*86_400_000)) % 2 !== 0) continue;
    }
    const instant = localMinuteToInstant(target, timeZone);
    if (instant.getTime() > calendarAfter.getTime()) return instant.toISOString();
  }
  throw new Error("No se ha podido calcular la siguiente ejecución.");
}

export function nextAfterOccurrence(
  schedule: AutomationSchedule,
  timeZone: string,
  scheduledFor: string,
) {
  if (schedule.kind === "external" || schedule.kind === "once") return null;
  return nextScheduledInstant(schedule, timeZone, new Date(scheduledFor));
}

function describeCadence(schedule: AutomationSchedule, timeZone: string, locale: "en" | "es" | "ca" = "es") {
  if (schedule.kind === "external") return locale === "en" ? "From the authorized scheduler" : locale === "ca" ? "Des del planificador autoritzat" : "Desde el scheduler autorizado";
  if (schedule.kind === "interval") {
    const cadence = schedule.minutes % 60 === 0 ? `Cada ${schedule.minutes / 60} horas` : `Cada ${schedule.minutes} minutos`;
    const labels = locale === "en" ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] : locale === "ca" ? ["dg.", "dl.", "dt.", "dc.", "dj.", "dv.", "ds."] : ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
    return schedule.window ? `${cadence} · ${schedule.window.weekdays.map(day => labels[day]).join(", ")} · ${String(schedule.window.startHour).padStart(2,"0")}:00–${String(schedule.window.endHour).padStart(2,"0")}:00` : cadence;
  }
  if (schedule.kind === "once") {
    return `${locale === "ca" ? "Una vegada" : locale === "en" ? "Once" : "Una vez"} · ${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(schedule.runAt))}`;
  }
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  if (schedule.kind === "monthly") return `${locale === "en" ? "Day" : locale === "ca" ? "Dia" : "Día"} ${schedule.day} · ${schedule.months.length === 12 ? (locale === "en" ? "every month" : locale === "ca" ? "cada mes" : "cada mes") : schedule.months.join(", ")} · ${time}${schedule.startAt ? ` · ${locale === "en" ? "From" : locale === "ca" ? "Des de" : "Desde"} ${new Intl.DateTimeFormat(locale,{dateStyle:"medium",timeStyle:"short",timeZone}).format(new Date(schedule.startAt))}` : ""}`;
  if (schedule.kind === "daily") return `${locale === "ca" ? "Cada dia" : locale === "en" ? "Daily" : "Cada día"} · ${time}`;
  const labels = locale === "ca" ? ["dg.", "dl.", "dt.", "dc.", "dj.", "dv.", "ds."] : locale === "en" ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] : ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  return `${schedule.intervalWeeks === 2 ? (locale === "ca" ? "Cada dues setmanes · " : locale === "en" ? "Every two weeks · " : "Cada dos semanas · ") : ""}${schedule.weekdays.map((day) => labels[day]).join(", ")} · ${time}`;
}

export function describeSchedule(schedule: AutomationSchedule, timeZone: string, locale: "en" | "es" | "ca" = "es") {
  const cadence = describeCadence(schedule, timeZone, locale);
  if (schedule.kind === "monthly" || !("startAt" in schedule) || !schedule.startAt) return cadence;
  const from = locale === "en" ? "From" : locale === "ca" ? "Des de" : "Desde";
  return `${cadence} · ${from} ${new Intl.DateTimeFormat(locale, {dateStyle: "medium", timeStyle: "short", timeZone}).format(new Date(schedule.startAt))}`;
}
