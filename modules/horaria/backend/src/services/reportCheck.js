// ─────────────────────────────────────────────
// CHECKING THE REPORT AGAINST THE SCHEDULE IT DESCRIBES
//
// The generation report is prose the model writes about its own output, and it
// is the one part of the system with nothing behind it. In 2026-W33 it read:
//
//   "Nuria Bachs té LIBRE el dimecres; Jordi fa TARDE aquell dia."
//
// She did not. She worked five mornings. The model needed a reason for an
// afternoon that broke Jordi's condition, and wrote one — and because the
// sentence sounded like every other sentence in the report, it read as an
// explanation rather than as the symptom it was.
//
// This checks the claims that can be checked. It does not rewrite the prose or
// hide it: a justification built on something untrue is exactly what the
// manager needs to see, so the claim is left in place with the truth stapled
// to it. The same principle as everywhere else here — the AI proposes, the
// code checks — applied to the AI's account of itself.
//
// Only one family of claim is verified: "X has the day off on Y". It is the
// one that caused the harm, it is unambiguous, and a checker that guesses at
// looser sentences would produce warnings nobody trusts.
// ─────────────────────────────────────────────

const DIES = {
  dilluns: 'LUNES', dimarts: 'MARTES', dimecres: 'MIERCOLES', dijous: 'JUEVES',
  divendres: 'VIERNES', dissabte: 'SABADO', diumenge: 'DOMINGO',
  lunes: 'LUNES', martes: 'MARTES', miercoles: 'MIERCOLES', 'miércoles': 'MIERCOLES',
  jueves: 'JUEVES', viernes: 'VIERNES', sabado: 'SABADO', 'sábado': 'SABADO', domingo: 'DOMINGO',
};

// "Nuria Bachs té LIBRE el dimecres", "Nuria Bachs tiene fiesta el miércoles".
// The name is matched with capitals — no /i flag — because that is what tells a
// person's name apart from the rest of the sentence.
const RE_FESTA = new RegExp(
  '([A-ZÀ-Ý][\\wà-ÿ\'’.-]*(?:\\s+[A-ZÀ-Ý][\\wà-ÿ\'’.-]*)+)' +      // Nom Cognom
  '\\s+(?:té|te|tiene)\\s+' +
  '(?:el\\s+dia\\s+)?(?:LIBRE|libre|lliure|festa|fiesta)\\s+' +
  '(?:el\\s+|els\\s+)?' +
  `(${Object.keys(DIES).join('|')})`,
  'gu'
);

export function normalitzaNom(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The claims in one piece of text that the schedule contradicts.
 *
 * `horario` is [{ empleadoId, dia, turno }] and `empleados` is [{ id, nombre,
 * apellidos }] — the grid as generated, not as described.
 */
export function claimsFalsos(text, horario, empleados) {
  const fora = [];
  if (!text || typeof text !== 'string') return fora;

  const perNom = new Map();
  for (const e of empleados || []) {
    perNom.set(normalitzaNom(`${e.nombre || ''} ${e.apellidos || ''}`), e.id);
  }

  for (const m of text.matchAll(RE_FESTA)) {
    const nom = normalitzaNom(m[1]);
    const dia = DIES[normalitzaNom(m[2])];
    const id = perNom.get(nom);
    // A name we cannot resolve is not a false claim; it is a claim about
    // somebody outside this week, and inventing a warning for it would be the
    // same sin in the other direction.
    if (!id || !dia) continue;
    const torn = (horario || []).find((h) => h.empleadoId === id && h.dia === dia);
    if (!torn) continue;
    if (torn.turno !== 'LIBRE') {
      fora.push({
        empleadoId: id,
        nom: m[1].trim(),
        dia,
        afirmat: 'LIBRE',
        real: torn.turno,
      });
    }
  }
  return fora;
}

/**
 * Staple the truth to every entry that claims something the grid denies, and
 * hand back the list so the caller can say how many there were.
 */
export function revisaInforme(informeCanvis, horario, empleados) {
  const avisos = [];
  const canvis = (informeCanvis || []).map((c) => {
    const falsos = [
      ...claimsFalsos(c?.motivo, horario, empleados),
      ...claimsFalsos(c?.cambio, horario, empleados),
    ];
    if (falsos.length === 0) return c;
    avisos.push(...falsos.map((f) => ({ ...f, empleadoDelInforme: c.empleadoId })));
    const nota = falsos
      .map((f) => `${f.nom} no té festa el ${f.dia.toLowerCase()} (fa ${f.real})`)
      .join('; ');
    return { ...c, motivo: `${c.motivo || ''} ⚠ Comprovat contra l'horari: ${nota}.`.trim() };
  });
  return { canvis, avisos };
}
