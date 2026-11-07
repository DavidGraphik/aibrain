// Mirror of backend/src/utils/weeklyTarget.js — keep the two in step.
//
// A contract is written for an ordinary week. A week with a public holiday is
// shorter, and the contracted hours were never achievable in it: with the shop
// shut on the Saturday there are five days, so a 48h target would need a split
// shift almost every day. Comparing against the full-week figure once flagged
// fourteen of fifteen people as "under target" for a week nobody could fill.
//
// The generator uses the same function, so the panel and the engine cannot
// disagree about what a week is worth. A test compares the two copies by
// behaviour rather than by text.

export const DIAS_SEMANA = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

// How many days this shop opens in an ordinary week. Unset means seven.
export function normalOpenDays(diasApertura) {
  if (!diasApertura) return 7;
  try {
    const abiertos = typeof diasApertura === 'string' ? JSON.parse(diasApertura) : diasApertura;
    if (Array.isArray(abiertos) && abiertos.length > 0) return abiertos.length;
  } catch {
    // Not valid JSON — treat as unconfigured.
  }
  return 7;
}

// Target hours for one employee for one week.
//
// `diasBloqueadosSiempre` — days this person never works, every week, by their
// fixed availability. They belong in the DENOMINATOR: Aleix Puig never works
// Thursdays, so his 35h contract is written for a five-day week and he makes
// those hours in the days he does work. Counting his Thursday as an hour loss
// scaled him to 23h and reported an ordinary 33h week as a conflict.
//
// `diasNoDisponibles` — days lost in THIS week only (an approved absence, a day
// asked off in the weekly preferences). Those hours really are gone, so they
// reduce the numerator.
// `diasLibresPactados` — the weekly day off a fixed condition grants. It comes
// off the denominator like a permanently blocked day, but not twice: where the
// shop shuts for a public holiday, that closure already gave the person their
// day, so they work every remaining open day and make their full contract.
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
  const cierresExcepcionales = Math.max(0, diasNormales - abiertos);
  const libresPendientes = Math.max(0, diasLibresPactados - cierresExcepcionales);
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
