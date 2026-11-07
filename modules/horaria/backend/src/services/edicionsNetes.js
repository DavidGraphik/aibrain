// ─────────────────────────────────────────────
// WHAT THE MANAGER ACTUALLY CHANGED
//
// The old answer came from a log of every click on the grid. Across five weeks
// it held eighteen entries, and twelve of them cancelled each other out: a
// shift changed and changed straight back, seven to twenty-three seconds
// apart. Somebody trying something and thinking better of it. We were feeding
// those to the model as lessons — and contradictory ones, since the same
// person's history said both "changes MANANA to TARDE" and the reverse.
//
// A correction is now the difference between the shift the generator wrote
// (`turnoIa`, frozen) and the shift that is there now. Undo something and
// there is nothing left to see, because there is no difference. No timestamps,
// no session windows, nothing to tune.
//
// The second thing the log could not express: the unit of a decision is not a
// cell. When Núria's Thursday went from LIBRE to MANANA and her Monday from
// MANANA to LIBRE, that is not two corrections — it is one, "move her day off
// from Thursday to Monday", and split in half neither piece means anything.
// ─────────────────────────────────────────────

const NOMS_DIA = {
  LUNES: 'dilluns', MARTES: 'dimarts', MIERCOLES: 'dimecres', JUEVES: 'dijous',
  VIERNES: 'divendres', SABADO: 'dissabte', DOMINGO: 'diumenge',
};

/** The corrections in a set of schedule rows: what we wrote vs what is there. */
export function edicionsNetes(schedules) {
  return (schedules || [])
    .filter((s) => s.generadoPorIa && s.turnoIa && s.turno !== s.turnoIa)
    .map((s) => ({
      empleadoId: s.empleadoId,
      semana: s.semana,
      dia: s.dia,
      deIa: s.turnoIa,
      aManager: s.turno,
    }));
}

/**
 * Group the corrections into what the manager was actually doing.
 *
 * Losing a shift on one day and gaining one on another, same person, same
 * week, is one decision: the day off moved. What is left over after pairing is
 * a genuine change of shift on a single day.
 */
export function moviments(edicions) {
  const fora = [];
  const perPersonaSetmana = {};
  for (const e of edicions || []) {
    (perPersonaSetmana[`${e.empleadoId}|${e.semana}`] ||= []).push(e);
  }

  for (const [clau, lot] of Object.entries(perPersonaSetmana)) {
    const [empleadoId, semana] = clau.split('|');
    // Gained a day off here / lost one there.
    const guanyaFesta = lot.filter((e) => e.aManager === 'LIBRE' && e.deIa !== 'LIBRE');
    const perdFesta = lot.filter((e) => e.deIa === 'LIBRE' && e.aManager !== 'LIBRE');
    const solts = lot.filter((e) => !guanyaFesta.includes(e) && !perdFesta.includes(e));

    const parells = Math.min(guanyaFesta.length, perdFesta.length);
    for (let i = 0; i < parells; i++) {
      fora.push({
        tipus: 'MOU_FESTA',
        empleadoId: Number(empleadoId),
        semana,
        de: perdFesta[i].dia,
        a: guanyaFesta[i].dia,
        descripcio: `li va moure el dia de festa de ${NOMS_DIA[perdFesta[i].dia]} a ${NOMS_DIA[guanyaFesta[i].dia]}`,
      });
    }
    // Anything that did not pair up stands on its own.
    for (const e of [...guanyaFesta.slice(parells), ...perdFesta.slice(parells), ...solts]) {
      fora.push({
        tipus: 'CANVIA_TORN',
        empleadoId: Number(empleadoId),
        semana,
        dia: e.dia,
        deIa: e.deIa,
        aManager: e.aManager,
        descripcio: `el ${NOMS_DIA[e.dia]} li va canviar ${e.deIa} per ${e.aManager}`,
      });
    }
  }
  return fora;
}

export { NOMS_DIA };
