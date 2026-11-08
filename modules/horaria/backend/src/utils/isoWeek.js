// Weeks are stored as ISO strings ("2026-W33") and constantly need to become
// real dates, to compare a schedule against absences that are stored as dates.
// The conversion was written out by hand in four places in the schedules
// controller alone; the fourth copy referenced variables that belonged to a
// different function, which loads fine and only fails when the code runs.
//
// ISO weeks are anchored on 4 January, which always falls in week 1.

/** Monday and Sunday of an ISO week string, in local time. */
export function weekBounds(semana) {
  const [year, week] = String(semana).split('-W').map(Number);
  const jan4 = new Date(year, 0, 4);
  const dow = (jan4.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dow + (week - 1) * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { monday, sunday };
}

/** The nth day of that week, 0 = Monday. */
export function weekDay(monday, index) {
  const d = new Date(monday);
  d.setDate(monday.getDate() + index);
  return d;
}

const MESOS = ['gener', 'febrer', 'març', 'abril', 'maig', 'juny',
  'juliol', 'agost', 'setembre', 'octubre', 'novembre', 'desembre'];

/**
 * An ISO week as a person would say it: "del 10 al 16 d'agost".
 *
 * The published schedule went out to the shop manager saying "la setmana
 * 2026-W33", which is how the database talks, not how anybody reads a message
 * on their phone. It matters more than it looks: this string fills a variable
 * in an approved WhatsApp template, so it is the sentence she actually sees.
 */
/** «d'agost», «de març». Va a part perquè la fa servir més d'un. */
const apostrof = (m) => (/^[aeiou]/.test(m) ? `d'${m}` : `de ${m}`);

export function weekLabel(semana) {
  const { monday, sunday } = weekBounds(semana);
  const mesA = MESOS[monday.getMonth()];
  const mesB = MESOS[sunday.getMonth()];
  return mesA === mesB
    ? `del ${monday.getDate()} al ${sunday.getDate()} ${apostrof(mesB)}`
    : `del ${monday.getDate()} ${apostrof(mesA)} al ${sunday.getDate()} ${apostrof(mesB)}`;
}

/**
 * Quin dia de la setmana és cada data, per dir-l'hi al xatbot.
 *
 * El bot va dir a la Gemma «el diumenge 31» quan el 31 d'agost de 2026 és
 * dilluns: el prompt li donava el rang de la setmana i cap relació entre data i
 * dia, i ho havia de deduir. Ella el va corregir; el següent potser no.
 *
 * Els números es fan a mà i no amb `new Date(...)`: passar una data per
 * `Date` la llegeix en l'hora local del procés, i el mateix codi donaria un dia
 * diferent segons on corri. El Render va en UTC i en local no, o sigui que el
 * primer arreglo hauria funcionat a producció i hauria mentit depurant-lo — el
 * mateix error de la Gemma amagat dins de la seva pròpia solució.
 *
 * @param dilluns  'YYYY-MM-DD', el dilluns de la setmana
 * @returns [{ dia, text }] — el text ja llest per posar al prompt
 */
export function calendariDeLaSetmana(dilluns) {
  const NOMS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
  const MESOS = ['gener', 'febrer', 'març', 'abril', 'maig', 'juny',
    'juliol', 'agost', 'setembre', 'octubre', 'novembre', 'desembre'];
  const [any, mes, dia] = String(dilluns).split('-').map(Number);
  if (!any || !mes || !dia) return [];

  // Aritmètica en UTC, que no té ni hora local ni canvis d'hora.
  const base = Date.UTC(any, mes - 1, dia);
  return NOMS.map((nom, i) => {
    const d = new Date(base + i * 86400000);
    // `apostrof` i no «de» fix: en català és «d'agost», no «de agost». Aquest
    // text va al prompt i el bot el pot citar tal qual.
    return { dia: nom, text: `${nom} = ${d.getUTCDate()} ${apostrof(MESOS[d.getUTCMonth()])}` };
  });
}
