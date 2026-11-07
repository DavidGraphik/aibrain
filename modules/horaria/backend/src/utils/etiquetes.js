// ─────────────────────────────────────────────
// WHAT A SHIFT AND A DAY ARE CALLED, TO A PERSON
//
// The database stores MANANA, TARDE, PARTIDO, LIBRE and LUNES…DOMINGO, and
// those names leaked straight into the warnings: "Si el sabado fa MANANA, el
// viernes ha de fer PARTIDO". Two things wrong with that. The shop has never
// called a split shift a "partido" — on the sheet it is a DIA, and has been for
// years. And the days came out in Spanish whatever language the app was set to.
//
// So every message that names a shift or a day goes through here, and the
// language comes from whoever is reading rather than from the column.
//
// Catalan and Spanish only: those are the two the shop uses. Anything else
// falls back to Catalan rather than half-translating, because a Catalan
// sentence with English words inside it reads worse than one plain language.
// ─────────────────────────────────────────────

const TORNS = {
  ca: { MANANA: 'MATÍ', TARDE: 'TARDA', PARTIDO: 'DIA', LIBRE: 'FESTA' },
  es: { MANANA: 'MAÑANA', TARDE: 'TARDE', PARTIDO: 'DÍA', LIBRE: 'LIBRE' },
};

const DIES = {
  ca: {
    LUNES: 'dilluns', MARTES: 'dimarts', MIERCOLES: 'dimecres', JUEVES: 'dijous',
    VIERNES: 'divendres', SABADO: 'dissabte', DOMINGO: 'diumenge',
  },
  es: {
    LUNES: 'lunes', MARTES: 'martes', MIERCOLES: 'miércoles', JUEVES: 'jueves',
    VIERNES: 'viernes', SABADO: 'sábado', DOMINGO: 'domingo',
  },
};

export const IDIOMA_PER_DEFECTE = 'ca';

export function idiomaValid(lang) {
  const l = String(lang || '').slice(0, 2).toLowerCase();
  return TORNS[l] ? l : IDIOMA_PER_DEFECTE;
}

/** MANANA → "MATÍ". An unknown value comes back as it is, rather than empty. */
export function etiquetaTorn(turno, lang) {
  return TORNS[idiomaValid(lang)][turno] || turno || '';
}

/** LUNES → "dilluns". */
export function etiquetaDia(dia, lang) {
  return DIES[idiomaValid(lang)][dia] || String(dia || '').toLowerCase();
}

/** "dilluns, dimarts i dijous" — the list as somebody would say it aloud. */
export function llistaDies(dies, lang) {
  const noms = (dies || []).map((d) => etiquetaDia(d, lang));
  if (noms.length <= 1) return noms.join('');
  const i = { ca: ' i ', es: ' y ' }[idiomaValid(lang)];
  return `${noms.slice(0, -1).join(', ')}${i}${noms[noms.length - 1]}`;
}
