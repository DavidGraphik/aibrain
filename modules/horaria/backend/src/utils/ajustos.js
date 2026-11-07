import { prisma } from '../services/prisma.js';

// ─────────────────────────────────────────────
// SETTINGS
//
// What could be changed about how this app behaves lived in two places neither
// of which the manager can reach: environment variables on Render, and
// constants written into the code. Changing the WhatsApp deadline meant
// editing a variable on a hosting dashboard and waiting for a redeploy.
//
// The catalogue below is the whole truth about what a setting is: its type,
// its default and where it applies. The table stores only what has been
// changed away from the default, so a setting that gets deleted from here
// stops existing rather than lingering as a value nobody reads.
//
// ÀMBIT — 'global' is one value for the company, 'establiment' is one per shop.
// The request window is global on purpose: there is a single generation cycle
// each week, and shops closing on different days would mean the manager has to
// remember which deadline belongs to which shop.
// ─────────────────────────────────────────────

export const CATALEG = {
  demanarMotiuCanvis: {
    ambit: 'establiment',
    tipus: 'bool',
    defecte: true,
  },
  // Qui rep el broadcast i els recordatoris sols, sense que ningú cliqui res.
  // Per botiga i apagat de sèrie: encendre'l vol dir que cada diumenge surten
  // missatges de debò als telèfons d'aquella gent, i les botigues que encara
  // tenen números de prova no hi han de ser fins que estiguin a punt.
  enviamentAutomatic: { ambit: 'establiment', tipus: 'bool', defecte: false },
  whatsappObreDia: { ambit: 'global', tipus: 'dia', defecte: 0 },   // diumenge
  whatsappObreHora: { ambit: 'global', tipus: 'hora', defecte: 9 },
  whatsappTancaDia: { ambit: 'global', tipus: 'dia', defecte: 3 },  // dimecres
  whatsappTancaHora: { ambit: 'global', tipus: 'hora', defecte: 13 },
};

/** null when the value is acceptable, a sentence when it is not. */
export function validaAjust(clau, valor) {
  const def = CATALEG[clau];
  if (!def) return `l'ajust "${clau}" no existeix`;
  if (def.tipus === 'bool') {
    return typeof valor === 'boolean' ? null : `"${clau}" ha de ser cert o fals`;
  }
  if (def.tipus === 'dia') {
    return Number.isInteger(valor) && valor >= 0 && valor <= 6 ? null : `"${clau}" ha de ser un dia de la setmana (0–6)`;
  }
  if (def.tipus === 'hora') {
    return Number.isInteger(valor) && valor >= 0 && valor <= 23 ? null : `"${clau}" ha de ser una hora (0–23)`;
  }
  return `tipus desconegut per a "${clau}"`;
}

// Read on every generation, every incoming WhatsApp message and every page
// load of the schedules screen. Neon is in London and this app is in Frankfurt,
// so a settings lookup that crosses the Atlantic on each of those is not free.
let memoria = null;
let memoriaFins = 0;
const TTL_MS = 60 * 1000;

export function buidaMemoriaAjustos() {
  memoria = null;
  memoriaFins = 0;
}

async function totsElsValors() {
  if (memoria && Date.now() < memoriaFins) return memoria;
  const files = await prisma.ajuste.findMany();
  memoria = files;
  memoriaFins = Date.now() + TTL_MS;
  return files;
}

/**
 * One setting's value: what was saved, or the default.
 *
 * A stored value that no longer passes validation — a setting whose type
 * changed, a hand-edited row — falls back to the default rather than being
 * handed to code that trusts it.
 */
export async function ajust(clau, establecimientoId = null) {
  const def = CATALEG[clau];
  if (!def) throw new Error(`ajust desconegut: ${clau}`);
  const files = await totsElsValors();
  const fila = files.find((f) => f.clave === clau
    && (def.ambit === 'global' ? f.establecimientoId === null : f.establecimientoId === establecimientoId));
  if (!fila) return def.defecte;
  try {
    const valor = JSON.parse(fila.valor);
    return validaAjust(clau, valor) === null ? valor : def.defecte;
  } catch {
    return def.defecte;
  }
}

/** Every setting that applies to one shop, defaults included. */
export async function ajustos(establecimientoId = null) {
  const fora = {};
  for (const clau of Object.keys(CATALEG)) {
    fora[clau] = await ajust(clau, establecimientoId);
  }
  return fora;
}

export async function desaAjust(clau, valor, establecimientoId = null) {
  const problema = validaAjust(clau, valor);
  if (problema) throw new Error(problema);
  const def = CATALEG[clau];
  const estId = def.ambit === 'global' ? null : establecimientoId;
  if (def.ambit === 'establiment' && !estId) throw new Error(`"${clau}" necessita un establiment`);

  const existent = await prisma.ajuste.findFirst({ where: { clave: clau, establecimientoId: estId } });
  if (existent) {
    await prisma.ajuste.update({ where: { id: existent.id }, data: { valor: JSON.stringify(valor) } });
  } else {
    await prisma.ajuste.create({ data: { clave: clau, valor: JSON.stringify(valor), establecimientoId: estId } });
  }
  buidaMemoriaAjustos();
  return valor;
}
