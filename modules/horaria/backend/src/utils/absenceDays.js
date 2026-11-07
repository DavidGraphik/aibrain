// ─────────────────────────────────────────────
// Does a day of the week fall inside an absence?
//
// This looks trivial and is not. Absence bounds are stored as UTC midnight
// (`new Date('2026-08-03')` → 2026-08-03T00:00:00Z) while the days of the week
// are built in local time, so comparing the two as timestamps silently drops
// the first day of every absence in any timezone east of UTC: in Spain the
// week's Monday is 00:00 local = 22:00 UTC the previous day, which sorts before
// an absence starting that same Monday.
//
// The effect was an employee on sick leave Monday–Friday showing Monday as an
// ordinary free day — and, worse, the scheduler being free to give them a shift
// on it. Compare calendar dates, never instants.
// ─────────────────────────────────────────────

// A Date built in local time → "YYYY-MM-DD" as the user would read it.
function localYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A Date stored as UTC midnight → the calendar day it was meant to represent.
function utcYmd(d) {
  return new Date(d).toISOString().slice(0, 10);
}

export function dayWithinAbsence(day, fechaInicio, fechaFin) {
  const d = localYmd(day);
  return d >= utcYmd(fechaInicio) && d <= utcYmd(fechaFin);
}
