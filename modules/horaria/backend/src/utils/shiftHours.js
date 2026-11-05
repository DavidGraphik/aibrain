// ─────────────────────────────────────────────
// How long a shift lasts for a given employee.
//
// The three shift types used to have one fixed length each, which broke down as
// soon as somebody worked a reduced day: a 20h contract doing 8:00–12:00 was
// counted as 7h a shift, so three days already "exceeded" the contract on paper
// while the person had actually worked twelve hours.
//
// An employee with `horasPorTurno` set works that many hours whatever the shift.
// They never get a PARTIDO — a split shift covers morning and afternoon, which
// would double a part-time day into more than a full one. The engine refuses to
// assign it; the doubling here is only a safety net for data that predates this.
// ─────────────────────────────────────────────

import { fixedAfternoonEntry } from './fixedAfternoonEntry.js';

export const STANDARD_SHIFT_HOURS = { MANANA: 7, TARDE: 6, PARTIDO: 10, LIBRE: 0 };
export const DEFAULT_ENTRADA = { MANANA: '07:30', TARDE: '14:45', PARTIDO: '07:30' };

export function shiftHours(empleado, turno) {
  if (!turno || turno === 'LIBRE') return 0;
  const reducida = empleado?.horasPorTurno;
  if (reducida && reducida > 0) {
    return turno === 'PARTIDO' ? reducida * 2 : reducida;
  }
  return STANDARD_SHIFT_HOURS[turno] ?? 0;
}

// True when this employee works a reduced fixed day and must never be given a
// split shift.
export function jornadaReducida(empleado) {
  return !!(empleado?.horasPorTurno && empleado.horasPorTurno > 0);
}

// The columns every function in this file reads. Prisma `select` clauses must
// spread this rather than list the fields by hand: a query that forgets them
// does not fail, it silently returns undefined, and each function below then
// falls back to the standard full-time shift. That is how a reduced working day
// can look perfectly applied in the code and have no effect at all in practice
// — the employee simply gets 7-hour mornings at 07:30 like everyone else.
export const REDUCED_DAY_FIELDS = {
  horasPorTurno: true,
  horaEntradaManana: true,
  horaEntradaTarde: true,
};

// When a split shift breaks, if the shop has no midday closing of its own.
export const DEFAULT_DESCANSO = '13:30';

/**
 * Break time for a shift — only split shifts have one.
 *
 * Left to the model, this came out at 13:00 for some people and 14:00 for
 * others on the same week for no stated reason, and empty for every split shift
 * the repair passes created, since setShift clears it. The shop manager prints
 * that schedule. A shop that shuts at midday breaks when it shuts; otherwise
 * everyone breaks at the same time, and the manager can still change any single
 * shift by hand.
 */
export function descansoPara(turno, establishment) {
  if (turno !== 'PARTIDO') return null;
  if (establishment?.cierraMediodia && establishment.inicioCierreMediodia) {
    return establishment.inicioCierreMediodia;
  }
  return DEFAULT_DESCANSO;
}

// Entry time for a shift, honouring the employee's own start time when set.
export function entradaPara(empleado, turno) {
  if (!turno || turno === 'LIBRE') return null;
  if (turno === 'TARDE') return empleado?.horaEntradaTarde || fixedAfternoonEntry(empleado?.condicionesFijas) || DEFAULT_ENTRADA.TARDE;
  return empleado?.horaEntradaManana || DEFAULT_ENTRADA[turno] || DEFAULT_ENTRADA.MANANA;
}

// ─────────────────────────────────────────────
// Leaving time
//
// The schedule told people when to come in and never when to go home. For a
// full day that is common knowledge; for David Castillo, who works four hours
// where everyone else works seven, the sheet said 7:30 and left the rest to
// memory.
//
// It is derived, never stored. We already know exactly how long each person's
// shift is, so the leaving time is arithmetic — and a stored copy would go
// stale the moment somebody edits an entry time by hand, on the one document
// that gets printed and pinned to the wall.
// ─────────────────────────────────────────────

// A split shift's midday break, when the shop has no midday closing of its
// own to take it from. Three hours, per the shop manager.
export const DESCANSO_HORAS = 3;

export function aMinutos(hora) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hora || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function aHora(minutos) {
  const m = ((Math.round(minutos) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// How long the break in a split shift lasts, in minutes. A shop that shuts at
// midday breaks for exactly as long as it is shut.
export function duracionDescanso(establishment) {
  if (establishment?.cierraMediodia) {
    const inicio = aMinutos(establishment.inicioCierreMediodia);
    const fin = aMinutos(establishment.finCierreMediodia);
    if (inicio !== null && fin !== null && fin > inicio) return fin - inicio;
  }
  return DESCANSO_HORAS * 60;
}

/**
 * When this person goes home.
 *
 * `horaEntrada` is the one actually stored on the shift, which the manager may
 * have edited; without it we fall back to the employee's usual start. Only a
 * split shift is interrupted, so only a split shift adds the break.
 */
export function salidaPara(empleado, turno, establishment, horaEntrada) {
  if (!turno || turno === 'LIBRE') return null;
  const entrada = aMinutos(horaEntrada || entradaPara(empleado, turno));
  if (entrada === null) return null;
  const horas = shiftHours(empleado, turno);
  if (!horas) return null;
  const descanso = turno === 'PARTIDO' ? duracionDescanso(establishment) : 0;
  return aHora(entrada + horas * 60 + descanso);
}
