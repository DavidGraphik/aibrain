// ─────────────────────────────────────────────
// QUAN EL FULL DE PAPER I EL WHATSAPP NO DIUEN EL MATEIX
//
// A les botigues hi ha un full penjat on la gent apunta amb què li aniria bé
// la setmana vinent: una M o una T a la casella del dia. L'encarregada en fa
// una foto i el bot la llegeix. Però des d'aquesta setmana la mateixa gent
// també ho pot dir pel WhatsApp, i les dues coses es contradiuen sovint:
// s'apunta al full dilluns i dimecres canvia d'idea.
//
// Mana el WhatsApp. El full s'omple a la paret uns dies abans i qualsevol el
// pot escriure; el WhatsApp l'ha dit la persona mateixa, i més tard. El cas que
// ho va decidir: la Montse va apuntar matí al full i després va demanar festa
// pel WhatsApp — ha de quedar festa.
//
// Es resol dia per dia i no tota la fila de cop: si algú va apuntar tres dies
// al full i pel WhatsApp només va parlar d'un, els altres dos valen.
//
// Funció pura, sense base de dades, perquè aquesta regla es pugui provar amb
// els casos de veritat.
// ─────────────────────────────────────────────

/**
 * @param delPaper   { DIA: 'MANANA'|'TARDE' } — el que diu el full
 * @param jaDit      el que ja hi havia desat, o null si no ve de la persona:
 *                   { diasNoDisponible: [DIA], turnosPorDia: { DIA: turno } }
 * @returns { turnosPorDia, guanyats, conflictes }
 *   `guanyats` és el que aporta el full; `conflictes` el que se li ha tret i
 *   per què, perquè es pugui dir a l'encarregada en comptes de descartar-ho en
 *   silenci — que és com el full guanyava abans sense que ningú se n'adonés.
 */
export function fusionaPaperIWhatsapp(delPaper, jaDit) {
  const festes = new Set(jaDit?.diasNoDisponible || []);
  const turnsJaDits = jaDit?.turnosPorDia || {};

  const guanyats = {};
  const conflictes = [];

  for (const [dia, turno] of Object.entries(delPaper || {})) {
    if (festes.has(dia)) {
      conflictes.push({ dia, deiaElFull: turno, mana: 'FESTA' });
      continue;
    }
    if (turnsJaDits[dia]) {
      // Si diuen el mateix no és cap conflicte: no cal avisar de res.
      if (turnsJaDits[dia] !== turno) {
        conflictes.push({ dia, deiaElFull: turno, mana: turnsJaDits[dia] });
      }
      continue;
    }
    guanyats[dia] = turno;
  }

  return { turnosPorDia: { ...turnsJaDits, ...guanyats }, guanyats, conflictes };
}

/**
 * De la lletra del full al torn tal com viu a la base de dades.
 *
 * Exportat i únic a posta. N'hi va haver dues còpies quatre hores: aquesta, bona,
 * i una a whatsapp.js que deia 'MAÑANA' amb titlla. El motor només accepta
 * 'MANANA' sense (aiScheduler.js:428) i el que no hi encaixa el descarta sense
 * dir res — o sigui que totes les marques de matí d'un full pujat es desaven i
 * després s'esfumaven, que era exactament el que aquest fitxer havia d'arreglar.
 */
export const TORN_DE_LA_MARCA = { M: 'MANANA', T: 'TARDE' };
const DIES_OK = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

/**
 * Les marques que el full deia d'una persona, tal com les va llegir la IA.
 *
 * La lectura del full queda desada sencera a `paper_sheets.lectura`, i això la
 * fa la font durable del que deia el paper. Serveix per tornar-hi: quan algú
 * contesta pel WhatsApp, la IA torna a deduir les preferències de tota la
 * conversa —on el paper no hi surt, perquè no s'hi va dir mai— i el que es desa
 * reemplaça el que hi havia. Sense recuperar-les d'aquí, escriure pel WhatsApp
 * per demanar un dia esborrava els altres dies que la persona havia apuntat al
 * full, sense avisar ningú.
 *
 * @param lectura     el JSON desat de la lectura del full
 * @param empleadoId  de qui es volen les marques
 * @returns { DIA: 'MANANA'|'TARDE' } — buit si el full no en deia res
 */
export function marquesDelFull(lectura, empleadoId) {
  const fora = {};
  if (!lectura || empleadoId == null) return fora;
  for (const fila of lectura.empleados || []) {
    if (fila?.empleadoId !== empleadoId) continue;
    for (const m of fila.marcas || []) {
      if (!DIES_OK.includes(m?.dia)) continue;
      const torn = TORN_DE_LA_MARCA[m?.marca];
      if (torn) fora[m.dia] = torn;
    }
  }
  return fora;
}
