// ─────────────────────────────────────────────
// Local (municipal) holidays
//
// Every town in Catalonia sets two holidays of its own, and they are the ones
// that actually catch a shop out: Sant Narcís shuts Girona on 29 October and
// nothing national says so. Until now the importer brought the national and
// Catalan holidays and told the manager to add the local ones by hand — which
// means remembering, for ten shops, once a year.
//
// The Generalitat publishes them as open data, so we can just ask. No key, no
// registration, and next year's calendar appears in it around December.
//
// The key is the eight-digit "codi municipal" (municipality + nucleus), not the
// name: a shop is not always in the town it is named after — S'Agaró is in
// Castell-Platja d'Aro — so the municipality is chosen once per shop and
// stored, never guessed.
// ─────────────────────────────────────────────

const DATASET = 'https://analisi.transparenciacatalunya.cat/resource/b4eh-r8up.json';

// The calendar changes once a year. Asking again on every import would be a
// slow request for an answer that cannot have moved.
const UN_DIA = 24 * 60 * 60 * 1000;
const memoria = new Map();

async function consulta(params) {
  const url = new URL(DATASET);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`El calendari oficial ha respost ${resp.status}`);
  const dades = await resp.json();
  // Socrata reports its own errors with a 200 and an object instead of a list.
  if (!Array.isArray(dades)) throw new Error(dades?.message || 'Resposta inesperada del calendari oficial');
  return dades;
}

async function recorda(clau, fn) {
  const guardat = memoria.get(clau);
  if (guardat && Date.now() - guardat.moment < UN_DIA) return guardat.dades;
  const dades = await fn();
  memoria.set(clau, { moment: Date.now(), dades });
  return dades;
}

export function buidaMemoria() {
  memoria.clear();
}

/**
 * Every municipality and nucleus in the calendar for a year, for the picker on
 * the shop's form. About 1400 entries; 909 municipalities, some of which have
 * more than one nucleus with holidays of its own.
 */
export async function llistaMunicipis(any) {
  return recorda(`municipis:${any}`, async () => {
    const files = await consulta({
      '$select': 'distinct codi_municipal,ajuntament_o_nucli_municipal',
      '$where': `any_calendari="${any}"`,
      '$limit': '5000',
    });
    return files
      .filter((f) => f.codi_municipal && f.ajuntament_o_nucli_municipal)
      .map((f) => ({ codi: f.codi_municipal, nom: f.ajuntament_o_nucli_municipal }))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'ca'));
  });
}

/**
 * The local holidays of one municipality in one year, as `YYYY-MM-DD`.
 *
 * An empty list is a real answer, not a failure: it means the Generalitat has
 * not published that year yet, which is the normal state until December.
 */
export async function festesLocals(codiMunicipal, any) {
  if (!codiMunicipal) return [];
  return recorda(`festes:${codiMunicipal}:${any}`, async () => {
    const files = await consulta({
      '$where': `codi_municipal="${codiMunicipal}" AND any_calendari="${any}"`,
      '$limit': '20',
    });
    return files
      .map((f) => ({
        fecha: String(f.data || '').slice(0, 10),
        nombre: f.festiu || 'Festa local',
        municipi: f.ajuntament_o_nucli_municipal || '',
      }))
      .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.fecha))
      .sort((a, b) => a.fecha.localeCompare(b.fecha));
  });
}
