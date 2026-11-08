import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { repairSchedule } from '../src/services/aiScheduler.js';
import { parseConditions } from '../src/services/conditionCheck.js';

// Girona's Monday came out with eight dependientas in the morning — its maximum
// — and three in the afternoon, one below its minimum. Nothing could fix it:
// Pass A only trims what is above a maximum, Pass B only adds people who are
// free, and everybody was already at work. The one person needed was there all
// along, on the wrong half of the day, and no pass could move anybody.

const DIAS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

function empleat(id, { funcion = 'DEPENDIENTA', condiciones = null, disponibilidad = null } = {}) {
  return {
    id,
    funcion,
    maxHorasSemana: 40,
    horasObjetivoSemana: 40,
    condicionesFijas: condiciones,
    condParsed: parseConditions(condiciones),
    dispParsed: disponibilidad,
  };
}

// Only Monday is scheduled; the other days stay LIBRE so nothing else moves.
function setmana(turnoLunes) {
  return DIAS.map((dia) => ({ dia, turno: dia === 'LUNES' ? turnoLunes : 'LIBRE' }));
}

const regla = (over) => [{
  diasAplica: '["LUNES"]',
  minDependientasManana: 3, maxDependientasManana: 4,
  minDependientasTarde: 2, maxDependientasTarde: 4,
  minElaboracionManana: 0, maxElaboracionManana: 99,
  minElaboracionTarde: 0, maxElaboracionTarde: 99,
  ...over,
}];

const turnoDe = (horario, id) =>
  horario.find((h) => h.empleadoId === id).dias.find((d) => d.dia === 'LUNES').turno;
const compta = (horario, employees, turno) => horario.filter((h) => {
  const t = h.dias.find((d) => d.dia === 'LUNES').turno;
  return t === turno || t === 'PARTIDO';
}).length;

// "No fa mai torns PARTIDO" keeps Pass B from filling the gap by upgrading
// somebody to a split shift, which is a perfectly good fix but not the one
// under test here.
const SENSE_PARTIT = 'No fa mai torns PARTIDO.';

describe('moure algú del torn que va sobrat al que va curt', () => {
  test('el cas del dilluns: matí per sobre del mínim, tarda per sota', () => {
    const employees = [1, 2, 3, 4].map((id) => empleat(id, { condiciones: SENSE_PARTIT }))
      .concat(empleat(5, { condiciones: SENSE_PARTIT }));
    const horario = [
      { empleadoId: 1, dias: setmana('MANANA') },
      { empleadoId: 2, dias: setmana('MANANA') },
      { empleadoId: 3, dias: setmana('MANANA') },
      { empleadoId: 4, dias: setmana('MANANA') },
      { empleadoId: 5, dias: setmana('TARDE') },
    ];

    repairSchedule(horario, employees, regla());

    assert.equal(compta(horario, employees, 'TARDE'), 2, 'la tarda ha d\'arribar al seu mínim');
    assert.equal(compta(horario, employees, 'MANANA'), 3, 'el matí es queda al seu mínim');
  });

  test('no baixa el torn d\'origen per sota del seu mínim', () => {
    // Three in the morning is already the minimum; taking one would only move
    // the problem.
    const employees = [1, 2, 3, 4].map((id) => empleat(id, { condiciones: SENSE_PARTIT }));
    const horario = [
      { empleadoId: 1, dias: setmana('MANANA') },
      { empleadoId: 2, dias: setmana('MANANA') },
      { empleadoId: 3, dias: setmana('MANANA') },
      { empleadoId: 4, dias: setmana('TARDE') },
    ];

    repairSchedule(horario, employees, regla());

    assert.equal(compta(horario, employees, 'MANANA'), 3, 'el matí no pot quedar per sota de 3');
  });

  test('no mou qui té prohibit el torn de destí', () => {
    // Nuria Bachs only ever works mornings. The afternoon stays short, which is
    // the honest outcome — the coverage check reports it.
    const nuria = 'Ha de tenir 1 dia de festa (LIBRE) cada setmana. Sempre MATINS';
    const employees = [
      empleat(1, { condiciones: nuria }), empleat(2, { condiciones: nuria }),
      empleat(3, { condiciones: nuria }), empleat(4, { condiciones: nuria }),
      empleat(5, { condiciones: nuria }),
    ];
    const horario = [1, 2, 3, 4].map((id) => ({ empleadoId: id, dias: setmana('MANANA') }))
      .concat({ empleadoId: 5, dias: setmana('TARDE') });

    repairSchedule(horario, employees, regla());

    for (const id of [1, 2, 3, 4]) {
      assert.equal(turnoDe(horario, id), 'MANANA', `l'empleat ${id} no hauria de fer tarda`);
    }
  });

  test('no mou qui no té disponible aquell mig dia', () => {
    const bloquejat = { LUNES: { M: true, T: false } };
    const employees = [
      empleat(1, { condiciones: SENSE_PARTIT, disponibilidad: bloquejat }),
      empleat(2, { condiciones: SENSE_PARTIT, disponibilidad: bloquejat }),
      empleat(3, { condiciones: SENSE_PARTIT, disponibilidad: bloquejat }),
      empleat(4, { condiciones: SENSE_PARTIT, disponibilidad: bloquejat }),
      empleat(5, { condiciones: SENSE_PARTIT }),
    ];
    const horario = [1, 2, 3, 4].map((id) => ({ empleadoId: id, dias: setmana('MANANA') }))
      .concat({ empleadoId: 5, dias: setmana('TARDE') });

    repairSchedule(horario, employees, regla());

    for (const id of [1, 2, 3, 4]) assert.equal(turnoDe(horario, id), 'MANANA');
  });

  test('no toca un torn partit, que ja cobreix les dues meitats', () => {
    // Moving a split shift out of the morning takes it out of the afternoon
    // too, leaving the day exactly as short as before.
    const employees = [1, 2, 3, 4, 5].map((id) => empleat(id, { condiciones: SENSE_PARTIT }));
    const horario = [
      { empleadoId: 1, dias: setmana('PARTIDO') },
      { empleadoId: 2, dias: setmana('PARTIDO') },
      { empleadoId: 3, dias: setmana('PARTIDO') },
      { empleadoId: 4, dias: setmana('MANANA') },
      { empleadoId: 5, dias: setmana('LIBRE') },
    ];

    repairSchedule(horario, employees, regla({ minDependientasTarde: 4, maxDependientasTarde: 4 }));

    for (const id of [1, 2, 3]) {
      assert.equal(turnoDe(horario, id), 'PARTIDO', 'un partit no s\'ha de convertir en tarda');
    }
  });

  test('una jornada ja equilibrada no es toca', () => {
    const employees = [1, 2, 3, 4, 5].map((id) => empleat(id, { condiciones: SENSE_PARTIT }));
    const horario = [
      { empleadoId: 1, dias: setmana('MANANA') },
      { empleadoId: 2, dias: setmana('MANANA') },
      { empleadoId: 3, dias: setmana('MANANA') },
      { empleadoId: 4, dias: setmana('TARDE') },
      { empleadoId: 5, dias: setmana('TARDE') },
    ];

    repairSchedule(horario, employees, regla());

    assert.equal(compta(horario, employees, 'MANANA'), 3);
    assert.equal(compta(horario, employees, 'TARDE'), 2);
  });
});
