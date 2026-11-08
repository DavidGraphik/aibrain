// ─────────────────────────────────────────────
// HOW MANY HOURS SOMEBODY SHOULD WORK THIS WEEK
//
// A contract is written for an ordinary week. A week with a public holiday is
// shorter, and the contracted hours were never achievable in it — Girona shut
// on the Saturday leaves five days, so a 48h target would need a split shift
// almost every day.
//
// This mattered in two places that disagreed with each other. The dashboard
// pro-rated and reported honestly; the generator did not, and chased the full
// contract regardless. In 2026-W33 that gap cost Nuria Bachs her weekly day
// off: her target was computed as 35h × 120% = 42h in a five-day week, so the
// repair pass kept filling days trying to reach a number that did not exist,
// and the one day she is contractually owed was the only thing left to take.
//
// Mirrored at frontend/src/utils/weeklyTarget.js. A test compares the two by
// behaviour rather than by text, because the copies have drifted before.
// ─────────────────────────────────────────────

export const DIAS_SEMANA = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

/**
 * How many days this shop opens in an ordinary week, from the stored
 * `diasApertura` JSON. Unset means it never closes weekly, so seven.
 */
export function normalOpenDays(diasApertura) {
  if (!diasApertura) return 7;
  try {
    const abiertos = typeof diasApertura === 'string' ? JSON.parse(diasApertura) : diasApertura;
    if (Array.isArray(abiertos) && abiertos.length > 0) return abiertos.length;
  } catch {
    // Not valid JSON — treat as unconfigured rather than failing a generation.
  }
  return 7;
}

/**
 * Target hours for one employee for one week.
 *
 * Two kinds of non-working day, and they do not behave the same way:
 *
 * `diasBloqueadosSiempre` — days this person never works, every week, by their
 * fixed availability. These belong in the DENOMINATOR. Aleix Puig never works
 * Thursdays, so his 35h contract is written for a five-day week and he makes
 * those hours in the days he does work. Treating his Thursday as an hour loss
 * scaled him to 23h and then reported his perfectly ordinary 33h week as a
 * conflict.
 *
 * `diasNoDisponibles` — days lost in THIS week only: an approved absence or a
 * day asked off in the weekly preferences. These reduce the numerator, because
 * the hours really are gone. Someone off sick Monday to Wednesday is not "under
 * target"; there were never enough days.
 *
 * Scaling is against a NORMAL week — for the shop, minus the days this person
 * never works — rather than against the days the shop happened to open this
 * one, so a bank holiday reduces the target too.
 */
export function weeklyHourTarget({
  contractHours,
  intensidad = 100,
  diasAbiertos,
  diasNormales = 7,
  diasNoDisponibles = 0,
  diasBloqueadosSiempre = 0,
  diasLibresPactados = 0,
}) {
  const objetivoSinAjustar = Math.round((contractHours || 40) * intensidad / 100);
  const abiertos = Number.isFinite(diasAbiertos) ? diasAbiertos : diasNormales;
  // The agreed day off is part of the ordinary week too, so it comes off the
  // denominator like a permanently blocked day. What it does NOT do is come off
  // twice: where the shop shuts for a public holiday, that closure already gave
  // the person their day, so they work every remaining open day and make their
  // full contract. Nuria Bachs does five mornings and 35h whether the sixth day
  // is her own day off or 15 August.
  //
  // A shop that stays open on holidays has no extra closures, so nothing is
  // subtracted here and the agreed day comes off the week as usual.
  const cierresExcepcionales = Math.max(0, diasNormales - abiertos);
  const libresPendientes = Math.max(0, diasLibresPactados - cierresExcepcionales);
  // Never zero: somebody blocked every single day has no meaningful ratio, and
  // dividing by it would produce Infinity rather than a target of nothing.
  const semanaPersona = Math.max(1, diasNormales - diasBloqueadosSiempre - diasLibresPactados);
  const diasDisponibles = Math.max(0, abiertos - diasBloqueadosSiempre - libresPendientes - diasNoDisponibles);
  const ajustado = diasDisponibles < semanaPersona;
  const objetivo = ajustado
    ? Math.round(objetivoSinAjustar * diasDisponibles / semanaPersona)
    : objetivoSinAjustar;
  return {
    objetivo, objetivoSinAjustar, diasDisponibles, ajustado,
    diasNormales: semanaPersona,
  };
}
