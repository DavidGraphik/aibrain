// ─────────────────────────────────────────────
// How long a shift lasts for a given employee.
// Mirror of backend/src/utils/shiftHours.js — keep the two in step.
//
// A fixed length per shift type breaks down for reduced working days: someone
// on a 20h contract doing 8:00–12:00 was counted as 7h a shift, so three days
// already looked like an overrun while they had actually worked twelve hours.
// ─────────────────────────────────────────────

export const STANDARD_SHIFT_HOURS = { MANANA: 7, TARDE: 6, PARTIDO: 10, LIBRE: 0 };

export function shiftHours(empleado, turno) {
  if (!turno || turno === 'LIBRE') return 0;
  const reducida = empleado?.horasPorTurno;
  if (reducida && reducida > 0) {
    // A split shift would double a part-time day; the engine never assigns one,
    // and this is only here so old data still adds up.
    return turno === 'PARTIDO' ? reducida * 2 : reducida;
  }
  return STANDARD_SHIFT_HOURS[turno] ?? 0;
}

export function jornadaReducida(empleado) {
  return !!(empleado?.horasPorTurno && empleado.horasPorTurno > 0);
}

// ── Leaving time ─────────────────────────────────────────────────────────
// Mirror of the backend. Derived, never stored: the schedule used to say when
// to come in and nothing about when to go home, which is common knowledge for
// a seven-hour morning and guesswork for David Castillo's four.

export const DEFAULT_ENTRADA = { MANANA: '07:30', TARDE: '14:45', PARTIDO: '07:30' };
export const DESCANSO_HORAS = 3;

export function entradaPara(empleado, turno) {
  if (!turno || turno === 'LIBRE') return null;
  if (turno === 'TARDE') return empleado?.horaEntradaTarde || DEFAULT_ENTRADA.TARDE;
  return empleado?.horaEntradaManana || DEFAULT_ENTRADA[turno] || DEFAULT_ENTRADA.MANANA;
}

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

export function duracionDescanso(establishment) {
  if (establishment?.cierraMediodia) {
    const inicio = aMinutos(establishment.inicioCierreMediodia);
    const fin = aMinutos(establishment.finCierreMediodia);
    if (inicio !== null && fin !== null && fin > inicio) return fin - inicio;
  }
  return DESCANSO_HORAS * 60;
}

export function salidaPara(empleado, turno, establishment, horaEntrada) {
  if (!turno || turno === 'LIBRE') return null;
  const entrada = aMinutos(horaEntrada || entradaPara(empleado, turno));
  if (entrada === null) return null;
  const horas = shiftHours(empleado, turno);
  if (!horas) return null;
  const descanso = turno === 'PARTIDO' ? duracionDescanso(establishment) : 0;
  return aHora(entrada + horas * 60 + descanso);
}
