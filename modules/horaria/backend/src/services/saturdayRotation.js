import { missatges } from '../utils/missatges.js';
// ─────────────────────────────────────────────
// THE SATURDAY ROTATION
//
// "Els dissabtes els treballadors alternen el torn cada setmana: qui va fer
// dissabte MATÍ, el dissabte següent fa TARDA o DIA (partit); qui va fer
// dissabte TARDA o DIA (partit), el dissabte següent fa MATÍ."
//
// La segona meitat estava mal escrita i deixava fer un DIA després d'una
// TARDA. El Roger la va corregir a les normes de la botiga el 20 d'agost, però
// la regla viu aquí i no llegeix aquell text: la correcció no arribava enlloc.
// Ara diuen el mateix, i el que en surt és MÉS estricte, no menys.
//
// It lived only in the prompt. Nothing checked it and nothing enforced it, and
// the repair passes run after the model and move Saturdays around knowing
// nothing about it — so even a week the model got right could be undone on the
// way out. Across the four weeks on record it held five times in thirteen.
//
// "The next Saturday" is the next one actually WORKED. A Saturday the shop was
// shut for a holiday, or that the employee had off, carries no shift to
// alternate from: the turn is carried over rather than lost. Girona's 15th of
// August is exactly that case — the chain runs from W32 straight to W34.
// ─────────────────────────────────────────────

export const SEGUENT_PERMES = {
  MANANA: ['TARDE', 'PARTIDO'],
  TARDE: ['MANANA'],
  PARTIDO: ['MANANA'],
};

/** Which shifts this Saturday may take, given the last one actually worked. */
export function tornsPermesos(turnAnterior) {
  return SEGUENT_PERMES[turnAnterior] || null;   // null = no history, anything goes
}

export function alternancaCompleix(turnAnterior, turnActual) {
  if (!turnActual || turnActual === 'LIBRE') return true;   // not working is never a breach
  const permesos = tornsPermesos(turnAnterior);
  if (!permesos) return true;                               // nothing to alternate from
  return permesos.includes(turnActual);
}

/**
 * The last Saturday this person actually worked, from their history.
 *
 * `historial` is [{ semana, dia, turno }]. Week strings are zero-padded, so
 * they sort correctly as text.
 */
export function ultimDissabteTreballat(historial, abansDe) {
  return (historial || [])
    .filter((h) => h.dia === 'SABADO' && h.turno && h.turno !== 'LIBRE')
    .filter((h) => !abansDe || h.semana < abansDe)
    .sort((a, b) => b.semana.localeCompare(a.semana))[0] || null;
}

/**
 * The breach, in words, or null when the rotation holds.
 */
export function revisaAlternanca({ turnActual, ultim, idioma }) {
  if (!ultim) return null;
  if (alternancaCompleix(ultim.turno, turnActual)) return null;
  const M = missatges(idioma);
  const toca = tornsPermesos(ultim.turno).map(M.T).join(' o ');
  return M.alternanca(ultim.semana, M.T(ultim.turno), toca, M.T(turnActual));
}

// ─────────────────────────────────────────────
// EL MATEIX, PERÒ PARLANT AMB EL TREBALLADOR
//
// Els textos de dalt són per al panell de l'encarregada: parlen en tercera
// persona i citen la setmana ISO. A qui ho demana pel WhatsApp se li ha de dir
// en segona persona, i «la setmana 2026-W33» no li diu res — «l'últim dissabte
// que vas treballar» sí, i a més és exactament el que calcula
// `ultimDissabteTreballat`, que se salta els festius i els dies que va lliurar.
//
// Aquí i no a missatges.js perquè aquell fitxer només té català i castellà, i
// el bot també contesta en anglès: un treballador que escriu en anglès rebria
// una frase en català enmig de la conversa.
// ─────────────────────────────────────────────

const TORN_TU = {
  ca: { MANANA: 'matí', TARDE: 'tarda', PARTIDO: 'dia (partit)' },
  es: { MANANA: 'mañana', TARDE: 'tarde', PARTIDO: 'día (partido)' },
  en: { MANANA: 'morning', TARDE: 'afternoon', PARTIDO: 'split day' },
};

const AVIS = {
  ca: (ant, toca) => `L'últim dissabte que vas treballar vas fer ${ant}, i els dissabtes s'alternen: aquest et tocaria ${toca}.\n\nVols que ho demani igualment i que ho decideixi l'encarregada? Contesta «sí» o «no».`,
  es: (ant, toca) => `El último sábado que trabajaste hiciste ${ant}, y los sábados se alternan: este te tocaría ${toca}.\n\n¿Quieres que lo pida igualmente y que lo decida la encargada? Contesta «sí» o «no».`,
  en: (ant, toca) => `The last Saturday you worked you did ${ant}, and Saturdays alternate: this one would be your ${toca}.\n\nShall I ask for it anyway and let the manager decide? Reply "yes" or "no".`,
};

const idiomaValid = (i) => (TORN_TU[i] ? i : 'ca');

/**
 * L'avís per al treballador quan el dissabte que demana trenca l'alternança,
 * o `null` quan no la trenca i no hi ha res a dir.
 *
 * No decideix res: només posa en paraules el que ja diu `alternancaCompleix`.
 */
export function avisAlDemanar({ demanat, ultim, idioma = 'ca' }) {
  if (!demanat || demanat === 'LIBRE') return null;
  // Sense cap dissabte treballat abans no hi ha res del que alternar: a qui
  // acaba d'entrar no se li pot dir que li «toca» res.
  if (!ultim) return null;
  if (alternancaCompleix(ultim.turno, demanat)) return null;

  const i = idiomaValid(idioma);
  const noms = TORN_TU[i];
  const toca = tornsPermesos(ultim.turno).map((t) => noms[t]).join(i === 'en' ? ' or ' : ' o ');
  return AVIS[i](noms[ultim.turno], toca);
}

const RESPOSTA = {
  ca: {
    si: (torn) => `Fet: he apuntat que demanes ${torn} el dissabte i que ho decideixi l'encarregada. Et pot dir que no, així que no ho donis per fet.`,
    no: 'D\'acord, doncs el dissabte no el demano. La resta de coses que m\'has dit queden apuntades.',
  },
  es: {
    si: (torn) => `Hecho: he apuntado que pides ${torn} el sábado y que lo decida la encargada. Puede decirte que no, así que no lo des por hecho.`,
    no: 'De acuerdo, entonces el sábado no lo pido. El resto de cosas que me has dicho quedan apuntadas.',
  },
  en: {
    si: (torn) => `Done: I have noted that you are asking for the ${torn} on Saturday, for the manager to decide. She may say no, so do not count on it.`,
    no: 'All right, I will not ask for the Saturday then. Everything else you told me is saved.',
  },
};

/** Què se li contesta quan insisteix. `torn` és el que havia demanat. */
export function textAlternancaSi(torn, idioma = 'ca') {
  const i = idiomaValid(idioma);
  return RESPOSTA[i].si(TORN_TU[i][torn] || TORN_TU[i].MANANA);
}

/** Què se li contesta quan es fa enrere. */
export function textAlternancaNo(idioma = 'ca') {
  return RESPOSTA[idiomaValid(idioma)].no;
}
