import { missatges } from '../utils/missatges.js';
// ─────────────────────────────────────────────
// READING THE FIXED CONDITIONS BACK
//
// `condicionesFijas` is prose the general manager writes for one person —
// "màxim 3 tardes, i un PARTIDO ja compta com una tarda". It is the only
// constraint in the system with no deterministic pass behind it: the AI is told
// about it, and the repair passes that run afterwards know nothing of it, so
// whatever the model got right can be undone on the way out. The 2026-W33
// generation broke five of these without anything noticing.
//
// This module only ever REPORTS. It does not move a single shift. That is
// deliberate: a regex that misreads a sentence then costs one missing warning,
// not a broken schedule — and until the manager has confirmed what a sentence
// means (the structured field that comes next), guessing is not something to
// act on. What it buys today is the ability to say how many conditions a
// generation actually honoured, which nobody could answer before.
//
// Sentences it cannot interpret are returned in `noInterpretadas`, so the gap
// between "this is enforced" and "the AI was merely asked nicely" is visible
// instead of assumed.
// ─────────────────────────────────────────────

const RE = {
  // "1 dia de festa cada setmana", "1 día libre", "1 dia més de festa entre setmana"
  diasLibres: /(\d+)\s*d[ií]a?e?s?\s+(?:m[ée]s\s+)?(?:de\s+)?(?:festa|fiesta|libre)/i,
  // "Sempre MATINS", "siempre mañanas" — never an afternoon at all
  soloMananas: /sempre\s+mat(?:ins|í)|siempre\s+ma[ñn]anas?/i,
  // Explicit whole-week afternoon-only conditions; do not interpret a weekday
  // or conditional sentence as a weekly restriction.
  soloTardes: /^(?:siempre\s+(?:hace\s+)?(?:de\s+)?tardes|sempre\s+(?:fa\s+)?(?:de\s+)?tardes|solo\s+tardes|nom[ée]s\s+tardes)\b/i,
  // "La resta de dies sempre MATÍ" — everything outside the stated split shifts
  restaMananas: /(?:la\s+)?resta\s+(?:de\s+)?d[ií]e?a?s?\s+sempre\s+mat|resto\s+(?:de\s+)?d[ií]as\s+siempre\s+ma[ñn]ana/i,
  // "Màxim 3 tardes per setmana"
  maxTardes: /m[àa]xim[o]?\s+(\d+)\s+tarde?s/i,
  // "un torn PARTIDO ja compta com una tarda"
  partidoEsTarde: /partido\s+(?:ja\s+)?(?:compta|cuenta)\s+com[o]?\s+un[a]?\s+tard/i,
  // "compta alhora com un matí i com una tarda"
  partidoEsAmbos: /compta\s+alhora|cuenta\s+(?:a\s+la\s+vez|simult[áa]neamente)/i,
  // "Fa 2 torns PARTIDO per setmana"
  partidosExactos: /(?:fa|hace)\s+(\d+)\s+torn?o?s?\s+PARTIDO/i,
  // "No fa mai torns PARTIDO"
  nuncaPartido: /(?:no\s+fa\s+mai|nunca\s+hace|no\s+hace\s+nunca)\s+torn?o?s?\s+PARTIDO/i,
  // "NO poden ser en dies consecutius"
  noConsecutivos: /no\s+poden\s+ser\s+en\s+d[ií]es\s+consecutius|no\s+pueden\s+ser\s+en\s+d[ií]as\s+consecutivos/i,
  // "3 MATINS i 3 TARDES"
  mananasYTardes: /(\d+)\s+MAT(?:INS|Í|IN)S?\s+i\s+(\d+)\s+TARDES|(\d+)\s+MA[ÑN]ANAS\s+y\s+(\d+)\s+TARDES/i,
  // "Ha de fer els mateixos MATINS que Nuria Bachs" — the name is captured with
  // no /i flag on purpose: a person's name starts with a capital, and matching
  // case-insensitively swallowed half the sentence after it.
  sincronizadoCon: /(?:mateixos?\s+MAT\w*|mismas?\s+MA[ÑN]ANAS?)\s+que\s+(?:la\s+|el\s+|l'|en\s+|na\s+|n')?([A-ZÀ-Ý][^,.;]*)/,
  // "El dia que Nuria Bachs té festa, Jordi pot fer PARTIDO o TARDE" — the
  // escape clause that comes with the sentence above, and which the sync check
  // already implements. Flagging it as unverified would be reporting the same
  // rule twice, once as done and once as not.
  sincronizadoExcepcion: /d[ií]a\s+que\s+.+\b(?:t[ée]|tiene|est[àa])\s+(?:de\s+)?(?:festa|fiesta|libre)/i,
  // "No fa festa entre setmana" — every ordinary opening day is a working day.
  senseFestaEntreSetmana: /no\s+fa\s+(?:cap\s+)?festa\s+entre\s+setmana|no\s+(?:tiene|hace)\s+fiesta\s+entre\s+semana/i,
  // "Jornada reduïda de 4h per torn, contracte de 20h/setmana"
  jornadaReduidaText: /jornada\s+redu[ïi]da\s+de\s+(\d+)\s*h/i,
  // "Sempre el mateix horari: de 8:00 a 12:00"
  horariFix: /(?:sempre\s+el\s+mateix\s+horari|siempre\s+el\s+mismo\s+horario)\s*:?\s*(?:de\s+)?(\d{1,2}[:.]\d{2})\s*(?:a|fins|hasta|-|–)\s*(\d{1,2}[:.]\d{2})/i,
  // Sentences that describe rather than rule. "És encarregada de la botiga"
  // constrains no shift, and "Exemple correcte: 1 PARTIDO + 2 TARDE" restates
  // the sentence above it. Listing them as unchecked is noise that makes the
  // real gaps harder to see.
  informativa: /^\s*(?:és|es|era)\s+encarregad|^\s*exemple\b|^\s*ejemplo\b|^\s*nota\s*:/i,
  // The family in general, for sentences where we cannot pin down who.
  sincronizado: /mateixos?\s+MAT|mismos?\s+MA[ÑN]|que\s+(?:la\s+|en\s+)?[A-Z][a-zà-ÿ]+\s+[A-Z]/,
  condicional: /^\s*si\s+/i,
  // Naming a weekday makes a sentence day-specific, not a rule about the week.
  diaConcret: /dilluns|dimarts|dimecres|dijous|divendres|dissabte|diumenge|lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo/i,
};

/**
 * Prose → the parts of it this code can check. Everything is optional; a
 * sentence that matches nothing simply contributes nothing.
 */
export function parseConditions(texto) {
  const out = { noInterpretadas: [] };
  if (!texto || typeof texto !== 'string') return out;

  const frases = texto.split(/[.\n]+/).map((f) => f.trim()).filter(Boolean);

  for (const frase of frases) {
    let entesa = false;

    const libres = RE.diasLibres.exec(frase);
    if (libres) { out.minDiasLibres = Math.max(out.minDiasLibres || 0, parseInt(libres[1], 10)); entesa = true; }

    // "Sempre matins" is only a rule about the whole week when nothing narrows
    // it. "La resta de dies sempre MATÍ" excludes the split shifts stated
    // alongside it, and "El dilluns sempre MATÍ" is about Monday — reading
    // either as "mornings only" flagged Victor Sanchez for the two split shifts
    // his conditions explicitly grant him.
    const esResta = RE.restaMananas.test(frase);
    const esDiaConcret = RE.diaConcret.test(frase);
    if (esResta) { out.restaMananas = true; entesa = true; }
    if (RE.soloMananas.test(frase)) {
      if (!esResta && !esDiaConcret) out.soloMananas = true;
      entesa = true;
    }

    if (RE.soloTardes.test(frase) && !esDiaConcret) {
      out.soloTardes = true; entesa = true;
      // A recognised shift family does not certify all trailing time prose.
      // Preserve it for review, including closing-time/duration requirements.
      const remainder = frase.replace(RE.soloTardes, '').replace(/^\s*[,;:]?\s*/, '');
      if (remainder) out.noInterpretadas.push(remainder);
    }

    const maxT = RE.maxTardes.exec(frase);
    if (maxT) { out.maxTardes = parseInt(maxT[1], 10); entesa = true; }

    if (RE.partidoEsTarde.test(frase)) { out.partidoCuentaComoTarde = true; entesa = true; }
    if (RE.partidoEsAmbos.test(frase)) { out.partidoCuentaComoAmbos = true; entesa = true; }

    const pex = RE.partidosExactos.exec(frase);
    if (pex) { out.partidosExactos = parseInt(pex[1], 10); entesa = true; }
    if (RE.nuncaPartido.test(frase)) { out.partidosMax = 0; entesa = true; }
    if (RE.noConsecutivos.test(frase)) { out.partidosNoConsecutivos = true; entesa = true; }

    const myt = RE.mananasYTardes.exec(frase);
    if (myt) {
      out.mananasExactas = parseInt(myt[1] ?? myt[3], 10);
      out.tardesExactas = parseInt(myt[2] ?? myt[4], 10);
      entesa = true;
    }

    // "Els mateixos MATINS que Nuria Bachs". Whether we can actually check it
    // depends on finding that person in the same week — resolved later, by
    // whoever holds the rest of the team's schedule.
    const sinc = RE.sincronizadoCon.exec(frase);
    if (sinc) { out.sincronizadoCon = sinc[1].trim(); entesa = true; }
    if (RE.sincronizadoExcepcion.test(frase)) { out.sincronizadoExcepcionLibre = true; entesa = true; }

    if (RE.senseFestaEntreSetmana.test(frase)) { out.senseFestaEntreSetmana = true; entesa = true; }

    // What the prose says about a reduced day, so it can be held against what
    // the record actually stores. The two drifting apart is invisible
    // otherwise: the sentence is what the manager reads and the columns are
    // what the engine obeys.
    const jr = RE.jornadaReduidaText.exec(frase);
    if (jr) { out.horasPorTurnoDeclarades = parseInt(jr[1], 10); entesa = true; }
    const hf = RE.horariFix.exec(frase);
    if (hf) {
      out.horariFix = { de: hf[1].replace('.', ':'), a: hf[2].replace('.', ':') };
      entesa = true;
    }

    // Describes, does not rule.
    if (!entesa && RE.informativa.test(frase)) { out.informatives = [...(out.informatives || []), frase]; entesa = true; }

    const cond = parseCondicional(frase);
    if (cond) { out.condicionals = [...(out.condicionals || []), cond]; entesa = true; }

    // A family we can recognise but not yet verify. Saying so is the point:
    // otherwise "no violations" would quietly mean "not looked at".
    if (!entesa && (RE.sincronizado.test(frase) || RE.condicional.test(frase))) {
      out.noInterpretadas.push(frase);
      entesa = true;
    }
    if (!entesa) out.noInterpretadas.push(frase);
  }
  return out;
}

const ORDEN = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

// ── Reading a conditional sentence ───────────────────────────────────────
//
// Four of Girona's people carry a rule of the shape "si el dissabte fa MATÍ,
// el divendres fa PARTIDO", and none of them was checked. One regex for the
// whole sentence was the obvious approach and the wrong one: the same rule is
// written three ways in the records — day before shift, shift before day, and
// once as "i a l'inversa" — and a pattern loose enough for all three matches
// things that are not rules at all.
//
// So it is read in pieces: split at the comma and find a day and a shift on
// each side.
//
// "Pot fer" and "ha de fer" are the same rule. The records use both wordings
// for what the general manager confirmed is one norm — that day the person is
// on the afternoon side — so the consequent always obliges, whichever verb the
// sentence happens to use.
const DIES_TEXT = {
  dilluns: 'LUNES', dimarts: 'MARTES', dimecres: 'MIERCOLES', dijous: 'JUEVES',
  divendres: 'VIERNES', dissabte: 'SABADO', diumenge: 'DOMINGO',
  lunes: 'LUNES', martes: 'MARTES', miercoles: 'MIERCOLES', jueves: 'JUEVES',
  viernes: 'VIERNES', sabado: 'SABADO', domingo: 'DOMINGO',
};

const TORNS_TEXT = {
  mati: 'MANANA', matins: 'MANANA', mana: 'MANANA', manana: 'MANANA', mananas: 'MANANA',
  tarda: 'TARDE', tardes: 'TARDE', tarde: 'TARDE',
  partido: 'PARTIDO', partit: 'PARTIDO', partits: 'PARTIDO',
  festa: 'LIBRE', fiesta: 'LIBRE', libre: 'LIBRE', lliure: 'LIBRE',
};

function senseAccents(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function buscaDia(tros) {
  for (const [text, dia] of Object.entries(DIES_TEXT)) {
    if (new RegExp(`\\b${text}\\b`).test(tros)) return dia;
  }
  return null;
}

function buscaTurno(tros) {
  for (const [text, turno] of Object.entries(TORNS_TEXT)) {
    if (new RegExp(`\\b${text}\\b`).test(tros)) return turno;
  }
  return null;
}

export function parseCondicional(frase) {
  // "I a l'inversa: si fa MATÍ el divendres…" — the preamble is prose.
  const net = senseAccents(frase).replace(/^\s*i\s+a\s+l'?\s*inversa\s*[:,]?\s*/, '').trim();
  if (!/^si\b/.test(net)) return null;

  const coma = net.indexOf(',');
  if (coma < 0) return null;
  const si = net.slice(0, coma);
  const llavors = net.slice(coma + 1);

  const siDia = buscaDia(si);
  const siTurno = buscaTurno(si);
  const entoncesDia = buscaDia(llavors);
  const entoncesTurno = buscaTurno(llavors);
  if (!siDia || !siTurno || !entoncesDia || !entoncesTurno) return null;
  if (siDia === entoncesDia) return null;

  return { siDia, siTurno, entoncesDia, entoncesTurno };
}

/** How many of each shift somebody already has this week. */
export function contarTurnos(dias) {
  const c = { mananas: 0, tardes: 0, partidos: 0 };
  for (const d of dias || []) {
    if (d.turno === 'MANANA') c.mananas++;
    else if (d.turno === 'TARDE') c.tardes++;
    else if (d.turno === 'PARTIDO') c.partidos++;
  }
  return c;
}

/**
 * Whether one more shift of this type would break the person's fixed
 * conditions, given what they already have.
 *
 * Somebody has to work the afternoon when there is nobody else — but it should
 * not be the person whose conditions say they cannot. The repair passes sorted
 * candidates by fewest hours and checked absences, other shops and requested
 * days off; fixed conditions were the one thing they never consulted, so Albert
 * Triano, whose rule is "two split shifts, the rest always mornings", was as
 * likely to be picked for an afternoon as anybody else.
 *
 * Girona has room for this: the dependientas with no afternoon restriction can
 * supply 30 afternoon shifts a week against the 25 the coverage rules ask for.
 * Using Albert was never necessary, only easier.
 */
export function turnoPermitido(cond, turno, actual) {
  if (!cond) return true;
  const c = actual || { mananas: 0, tardes: 0, partidos: 0 };
  if (cond.soloTardes && ['MANANA', 'PARTIDO'].includes(turno)) return false;

  if (turno === 'TARDE') {
    if (cond.soloMananas) return false;
    // "Two split shifts, the rest always mornings" leaves no room for a plain
    // afternoon: the split shifts already are this person's afternoons.
    if (cond.restaMananas) return false;
    if (cond.tardesExactas != null && c.tardes >= cond.tardesExactas) return false;
    if (cond.maxTardes != null) {
      const cuentan = c.tardes + (cond.partidoCuentaComoTarde ? c.partidos : 0);
      if (cuentan >= cond.maxTardes) return false;
    }
  }

  if (turno === 'PARTIDO') {
    if (cond.soloMananas) return false;
    if (cond.partidosMax != null && c.partidos >= cond.partidosMax) return false;
    if (cond.partidosExactos != null && c.partidos >= cond.partidosExactos) return false;
    // A split shift covers the afternoon too, so it spends the afternoon budget.
    if (cond.maxTardes != null && cond.partidoCuentaComoTarde) {
      if (c.tardes + c.partidos >= cond.maxTardes) return false;
    }
  }

  if (turno === 'MANANA') {
    if (cond.mananasExactas != null && c.mananas >= cond.mananasExactas) return false;
  }

  return true;
}

/**
 * True when this person's conditions constrain the shift at all — used to order
 * candidates, so the people with no restriction absorb the work first and the
 * limited allowances of the others are kept for when they are actually needed.
 */
export function turnoRestringido(cond, turno) {
  if (!cond) return false;
  if (turno === 'TARDE') {
    return !!(cond.soloMananas || cond.restaMananas || cond.maxTardes != null || cond.tardesExactas != null);
  }
  if (turno === 'PARTIDO') {
    return !!(cond.soloTardes || cond.soloMananas || cond.partidosMax != null || cond.partidosExactos != null || cond.maxTardes != null);
  }
  if (turno === 'MANANA') return !!cond.soloTardes || cond.mananasExactas != null;
  return false;
}

/** Names are compared without accents, case or stray spacing. */
export function normalitzaNom(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Find the person a condition points at, among the rest of the week's team.
 *
 * The sentence names them the way a human would — "Nuria Bachs" — and the
 * record has the surname in its own column, sometimes with a trailing space.
 */
export function trobaCompany(referencia, companys) {
  const ref = normalitzaNom(referencia);
  if (!ref) return null;
  const nomDe = (c) => normalitzaNom(`${c.empleado?.nombre || ''} ${c.empleado?.apellidos || ''}`);
  return (companys || []).find((c) => nomDe(c) === ref)
    || (companys || []).find((c) => nomDe(c) && ref.startsWith(nomDe(c)))
    || null;
}

/**
 * Which of this person's fixed conditions the week breaks.
 *
 * `dias` is [{ dia, turno }]. `diasHabituales` lists the days this shop opens in
 * an ORDINARY week — Sunday is excluded because the shop never opens then, so
 * it was never anybody's day off to begin with.
 *
 * `companys` is the same shape for everybody else that week, needed only by the
 * conditions that talk about another person.
 *
 * A day lost to an exceptional public holiday stays in the count and does serve
 * as the day off. Nuria Bachs worked five mornings in the week 15 August fell on
 * the Saturday: 35h and two days of rest, which is exactly what an ordinary
 * week gives her. Insisting on a sixth non-working day would have cut her to 28h
 * to solve a problem she did not have.
 */
/**
 * `diesDemanats` — els dies que aquella persona va demanar aquella setmana.
 *
 * Les peticions de WhatsApp manen per damunt de les condicions fixes: és la
 * norma de la casa. Però el revisor no ho sabia, i quan una condició cedia
 * davant d'una petició concedida ho comptava com un incompliment — el sistema
 * feia exactament el que tocava i tot seguit s'acusava a si mateix. A en Jordi
 * Defaus li marcava dues condicions incomplertes, i totes dues eren el dimecres
 * de festa que ell havia demanat i que li van donar.
 *
 * No es callen: van a `informatius`, perquè saber que ha passat és útil. El
 * que deixen de fer és comptar com a error.
 */
export function checkEmployeeConditions({ empleado, dias, diasHabituales, companys, idioma, diesDemanats = [] }) {
  const M = missatges(idioma);
  const { T, D } = M;
  const cond = parseConditions(empleado?.condicionesFijas);
  const problemas = [];
  const informatius = [];
  const demanats = new Set(diesDemanats);
  if (!dias || dias.length === 0) return { problemas, informatius, cond };

  const habituales = new Set(diasHabituales && diasHabituales.length > 0 ? diasHabituales : ORDEN);
  const enAbiertos = dias.filter((d) => habituales.has(d.dia));
  const turno = (d) => d.turno || 'LIBRE';

  const nMananas = enAbiertos.filter((d) => turno(d) === 'MANANA').length;
  const nTardes = enAbiertos.filter((d) => turno(d) === 'TARDE').length;
  const nPartidos = enAbiertos.filter((d) => turno(d) === 'PARTIDO').length;
  const nLibres = enAbiertos.filter((d) => turno(d) === 'LIBRE').length;

  if (cond.minDiasLibres != null && nLibres < cond.minDiasLibres) {
    problemas.push(M.diesFesta(cond.minDiasLibres, nLibres));
  }

  if (cond.soloTardes && (nMananas > 0 || nPartidos > 0)) problemas.push(M.nomesTardes(nMananas, nPartidos, T));

  if (cond.soloMananas && (nTardes > 0 || nPartidos > 0)) {
    problemas.push(M.nomesMatins(nTardes, nPartidos, T));
  }

  // "2 split shifts, the rest always mornings" — the rest is what is left once
  // the split shifts are accounted for, so only afternoons break it.
  if (cond.restaMananas && !cond.soloMananas && nTardes > 0) {
    problemas.push(M.restaMatins(nTardes, T));
  }

  if (cond.maxTardes != null) {
    const compten = nTardes + (cond.partidoCuentaComoTarde ? nPartidos : 0);
    if (compten > cond.maxTardes) {
      const detall = cond.partidoCuentaComoTarde ? M.detallTardes(nTardes, nPartidos, T) : '';
      problemas.push(M.maxTardes(cond.maxTardes, compten, detall));
    }
  }

  if (cond.partidosMax != null && nPartidos > cond.partidosMax) {
    problemas.push(M.capPartit(nPartidos, T));
  }

  if (cond.partidosExactos != null && nPartidos !== cond.partidosExactos) {
    problemas.push(M.partitsExactes(cond.partidosExactos, nPartidos, T));
  }

  if (cond.partidosNoConsecutivos && nPartidos > 1) {
    const idx = enAbiertos
      .filter((d) => turno(d) === 'PARTIDO')
      .map((d) => ORDEN.indexOf(d.dia))
      .sort((a, b) => a - b);
    for (let i = 1; i < idx.length; i++) {
      if (idx[i] - idx[i - 1] === 1) {
        problemas.push(M.partitsConsecutius(T));
        break;
      }
    }
  }

  if (cond.mananasExactas != null) {
    const compten = nMananas + (cond.partidoCuentaComoAmbos ? nPartidos : 0);
    if (compten !== cond.mananasExactas) {
      problemas.push(M.matinsExactes(cond.mananasExactas, compten));
    }
  }
  if (cond.tardesExactas != null) {
    const compten = nTardes + (cond.partidoCuentaComoAmbos ? nPartidos : 0);
    if (compten !== cond.tardesExactas) {
      problemas.push(M.tardesExactes(cond.tardesExactas, compten));
    }
  }

  // ── "Els mateixos MATINS que Nuria Bachs" ──────────────────────────────
  //
  // This is the condition that produced the worst kind of failure: the panel
  // said the week was perfect, and the generation report explained Jordi
  // Defaus's Wednesday afternoon with "Nuria Bachs té LIBRE el dimecres" — a
  // day off she did not have. The sentence was recognised, filed as
  // unverifiable, and the list of unverifiable ones was read by nobody.
  //
  // The rule: on every open day the other person works a morning, this person
  // must be there in the morning too. A split shift covers the morning, so it
  // counts. A day the other person is off, or works an afternoon, says nothing
  // about mornings and constrains nothing — which is exactly the escape clause
  // the prose spells out.
  if (cond.sincronizadoCon) {
    const company = trobaCompany(cond.sincronizadoCon, companys);
    if (!company) {
      // Recognised, but we cannot say whether it holds. Better admitted than
      // counted as a pass.
      cond.noInterpretadas.push(M.sincronitzatSensePersona(cond.sincronizadoCon));
    } else {
      const seus = new Map((company.dias || []).map((d) => [d.dia, d.turno || 'LIBRE']));
      const fora = enAbiertos.filter((d) => seus.get(d.dia) === 'MANANA' && turno(d) !== 'MANANA' && turno(d) !== 'PARTIDO');
      const etiqueta = (d) => `${D(d.dia)} (${T(turno(d))})`;
      const desquadrats = fora.filter((d) => !demanats.has(d.dia)).map(etiqueta);
      const perPeticio = fora.filter((d) => demanats.has(d.dia)).map(etiqueta);
      const qui = `${company.empleado?.nombre || ''} ${company.empleado?.apellidos || ''}`.replace(/\s+/g, ' ').trim();
      if (desquadrats.length > 0) problemas.push(M.sincronitzat(qui, desquadrats.join(', ')));
      if (perPeticio.length > 0) informatius.push(M.perPeticio(M.sincronitzat(qui, perPeticio.join(', '))));
    }
  }

  // A day nobody in the shop works is a day the shop was shut — a public
  // holiday, almost always. It is not anybody's day off and not their doing,
  // so the rules below step over it. Without this, "no fa festa entre setmana"
  // accuses Jordi Defaus of taking the 15th of August off.
  const tancats = new Set(
    ORDEN.filter((d) => {
      const ningu = (companys || []).every((c) => (c.dias || []).every((x) => x.dia !== d || (x.turno || 'LIBRE') === 'LIBRE'));
      const joTampoc = enAbiertos.every((x) => x.dia !== d || turno(x) === 'LIBRE');
      return ningu && joTampoc;
    })
  );
  const oberts = enAbiertos.filter((d) => !tancats.has(d.dia));

  if (cond.senseFestaEntreSetmana) {
    const totes = oberts.filter((d) => turno(d) === 'LIBRE').map((d) => d.dia);
    const festes = totes.filter((d) => !demanats.has(d));
    const demanades = totes.filter((d) => demanats.has(d));
    if (festes.length > 0) problemas.push(M.senseFesta(festes.length, M.dies(festes)));
    if (demanades.length > 0) informatius.push(M.perPeticio(M.senseFesta(demanades.length, M.dies(demanades))));
  }

  // "Si el dissabte fa MATÍ, el divendres fa PARTIDO."
  //
  // What the rule is really asking for is that the person is on the afternoon
  // side that day, and a split shift and a plain afternoon both put them there
  // — so either satisfies the other. A morning obligation stays exact: "el
  // divendres ha de fer MATÍ" exists precisely to keep them off the afternoon.
  const EQUIVALENTS = { PARTIDO: ['PARTIDO', 'TARDE'], TARDE: ['TARDE', 'PARTIDO'] };
  for (const c of cond.condicionals || []) {
    if (tancats.has(c.siDia) || tancats.has(c.entoncesDia)) continue;
    const elDia = oberts.find((d) => d.dia === c.siDia);
    const laltre = oberts.find((d) => d.dia === c.entoncesDia);
    if (!elDia || !laltre) continue;
    if (turno(elDia) !== c.siTurno) continue;          // the condition never fires
    const accepta = EQUIVALENTS[c.entoncesTurno] || [c.entoncesTurno];
    if (!accepta.includes(turno(laltre))) {
      problemas.push(
        M.condicional(D(c.siDia), T(c.siTurno), D(c.entoncesDia), accepta.map(T).join(' o '), T(turno(laltre)))
      );
    }
  }

  // The prose and the columns describing the same reduced day, held against
  // each other. The engine obeys `horasPorTurno`; the manager reads the
  // sentence. Nothing has ever compared them.
  if (cond.horasPorTurnoDeclarades != null) {
    const real = empleado?.horasPorTurno;
    if (real == null) {
      problemas.push(M.jornadaSenseFitxa(cond.horasPorTurnoDeclarades));
    } else if (real !== cond.horasPorTurnoDeclarades) {
      problemas.push(M.jornadaDiferent(cond.horasPorTurnoDeclarades, real));
    }
  }
  if (cond.horariFix) {
    // "8:00" and "08:00" are the same time written two ways: the prose is typed
    // by a person and the column by a time picker.
    const hhmm = (h) => String(h || '').replace(/^(\d):/, '0$1:');
    const inici = empleado?.horaEntradaManana;
    if (inici && hhmm(inici) !== hhmm(cond.horariFix.de)) {
      problemas.push(M.horaDiferent(cond.horariFix.de, inici));
    }
  }

  return { problemas, informatius, cond };
}
