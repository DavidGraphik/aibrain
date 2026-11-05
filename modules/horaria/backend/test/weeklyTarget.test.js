import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyHourTarget, normalOpenDays } from '../src/utils/weeklyTarget.js';
import {
  weeklyHourTarget as feWeeklyHourTarget,
  normalOpenDays as feNormalOpenDays,
} from './fixtures/upstream-ui/utils/weeklyTarget.js';
import { shiftHours as beShiftHours, salidaPara as beSalidaPara, duracionDescanso as beDuracionDescanso } from '../src/utils/shiftHours.js';
import { shiftHours as feShiftHours, salidaPara as feSalidaPara, duracionDescanso as feDuracionDescanso } from './fixtures/upstream-ui/utils/shiftHours.js';

// A contract is written for an ordinary week. The dashboard already knew that
// and pro-rated; the generator did not, and chased the full contract into weeks
// that could not hold it. The two disagreeing is what cost Nuria Bachs her day
// off in 2026-W33 while the panel reported her as perfectly fine.
describe('objectiu d\'hores setmanal', () => {
  test('setmana sencera: l\'objectiu és el contracte per la intensitat', () => {
    const r = weeklyHourTarget({ contractHours: 40, intensidad: 100, diasAbiertos: 6, diasNormales: 6 });
    assert.equal(r.objetivo, 40);
    assert.equal(r.ajustado, false);
  });

  test('la intensitat escala l\'objectiu', () => {
    assert.equal(weeklyHourTarget({ contractHours: 40, intensidad: 120, diasAbiertos: 6, diasNormales: 6 }).objetivo, 48);
    assert.equal(weeklyHourTarget({ contractHours: 40, intensidad: 85, diasAbiertos: 6, diasNormales: 6 }).objetivo, 34);
  });

  // The real case. Girona opens six days; 15 August fell on the Saturday, so the
  // week had five. The old formula asked Nuria for 42h in those five days.
  test('setmana curta per festiu: Girona 2026-W33', () => {
    const r = weeklyHourTarget({
      contractHours: 35, intensidad: 120, diasAbiertos: 5, diasNormales: 6,
    });
    assert.equal(r.ajustado, true);
    assert.equal(r.objetivo, 35, 'abans en demanava 42, que no hi cabien');
    assert.equal(r.diasDisponibles, 5);
  });

  // Aleix Puig never works Thursdays — fixed availability, every week. His 35h
  // contract is therefore written for a five-day week and he makes those hours
  // in the days he does work. Counting that Thursday as hours lost scaled him
  // to 23h and reported an entirely ordinary 33h week as a conflict.
  test('un dia que no treballa mai encongeix la seva setmana, no el seu objectiu', () => {
    const r = weeklyHourTarget({
      contractHours: 35, intensidad: 100, diasAbiertos: 6, diasNormales: 6, diasBloqueadosSiempre: 1,
    });
    assert.equal(r.objetivo, 35, 'en una setmana sencera ha de fer les seves hores senceres');
    assert.equal(r.ajustado, false);
  });

  test('el cas de l\'Aleix a W33: dissabte festiu i el seu dijous', () => {
    const r = weeklyHourTarget({
      contractHours: 35, intensidad: 100, diasAbiertos: 5, diasNormales: 6, diasBloqueadosSiempre: 1,
    });
    assert.equal(r.objetivo, 28, 'abans en sortien 23 i les seves 33h saltaven com a conflicte');
    assert.equal(r.diasDisponibles, 4);
    assert.equal(r.diasNormales, 5, 'la seva setmana normal són cinc dies, no sis');
  });

  // Nuria Bachs is owed one day off a week. In an ordinary six-day week she
  // works five mornings and makes her 35h. When 15 August falls on the Saturday
  // the shop shuts, and that closure IS her day off — so she still works five
  // days and still makes 35h. Subtracting the day twice put her on four days and
  // a 29h target, and then reported the gap as a conflict.
  describe('el dia de festa pactat', () => {
    const nuria = { contractHours: 35, intensidad: 100, diasNormales: 6, diasLibresPactados: 1 };

    test('setmana normal: cinc dies i les hores senceres', () => {
      const r = weeklyHourTarget({ ...nuria, diasAbiertos: 6 });
      assert.equal(r.objetivo, 35);
      assert.equal(r.diasDisponibles, 5);
      assert.equal(r.diasNormales, 5, 'la seva setmana són cinc dies de feina');
    });

    test('setmana amb festiu: el festiu li fa de dia de festa', () => {
      const r = weeklyHourTarget({ ...nuria, diasAbiertos: 5 });
      assert.equal(r.objetivo, 35, 'segueix fent les seves hores; no se li resta dos cops');
      assert.equal(r.diasDisponibles, 5);
    });

    test('dos festius: el segon sí que li treu feina', () => {
      const r = weeklyHourTarget({ ...nuria, diasAbiertos: 4 });
      assert.equal(r.objetivo, 28, 'només queden quatre dies de botiga oberta');
      assert.equal(r.diasDisponibles, 4);
    });

    test('una botiga que no tanca els festius no es veu afectada', () => {
      // No extra closures, so the agreed day comes off the week as always.
      const r = weeklyHourTarget({ ...nuria, diasNormales: 7, diasAbiertos: 7 });
      assert.equal(r.diasDisponibles, 6);
      assert.equal(r.diasNormales, 6);
      assert.equal(r.objetivo, 35);
    });

    test('el dia pactat i un dia que no treballa mai se sumen', () => {
      const r = weeklyHourTarget({ ...nuria, diasAbiertos: 6, diasBloqueadosSiempre: 1 });
      assert.equal(r.diasNormales, 4, 'sis dies de botiga, menys el seu fix i el pactat');
      assert.equal(r.diasDisponibles, 4);
      assert.equal(r.objetivo, 35);
    });
  });

  test('les dues menes de dia es combinen', () => {
    // Never works Thursdays, and off sick one more day this week.
    const r = weeklyHourTarget({
      contractHours: 35, intensidad: 100, diasAbiertos: 6, diasNormales: 6,
      diasBloqueadosSiempre: 1, diasNoDisponibles: 1,
    });
    assert.equal(r.objetivo, 28); // 35 × 4/5
  });

  test('algú bloquejat tots els dies no trenca el càlcul', () => {
    const r = weeklyHourTarget({
      contractHours: 40, intensidad: 100, diasAbiertos: 6, diasNormales: 6, diasBloqueadosSiempre: 6,
    });
    assert.equal(r.objetivo, 0);
    assert.ok(Number.isFinite(r.objetivo), 'no pot sortir Infinity per dividir entre zero');
  });

  test('els dies que la persona no pot treballar també redueixen', () => {
    // Two days of sick leave in an otherwise full six-day week.
    const r = weeklyHourTarget({
      contractHours: 40, intensidad: 100, diasAbiertos: 6, diasNormales: 6, diasNoDisponibles: 2,
    });
    assert.equal(r.objetivo, 27);
    assert.equal(r.diasDisponibles, 4);
  });

  test('una setmana sencera de baixa no demana hores', () => {
    const r = weeklyHourTarget({
      contractHours: 40, intensidad: 100, diasAbiertos: 6, diasNormales: 6, diasNoDisponibles: 6,
    });
    assert.equal(r.objetivo, 0);
  });

  test('mai surt un objectiu negatiu', () => {
    const r = weeklyHourTarget({
      contractHours: 40, intensidad: 100, diasAbiertos: 5, diasNormales: 6, diasNoDisponibles: 9,
    });
    assert.equal(r.diasDisponibles, 0);
    assert.equal(r.objetivo, 0);
  });
});

describe('dies d\'obertura habituals', () => {
  test('llegeix la configuració de la botiga', () => {
    assert.equal(normalOpenDays('["LUNES","MARTES","MIERCOLES","JUEVES","VIERNES","SABADO"]'), 6);
  });

  test('sense configurar són set', () => {
    assert.equal(normalOpenDays(null), 7);
    assert.equal(normalOpenDays(''), 7);
    assert.equal(normalOpenDays('[]'), 7);
  });

  test('un valor corrupte no atura una generació', () => {
    assert.equal(normalOpenDays('{no és json'), 7);
  });

  test('accepta també una llista ja analitzada', () => {
    assert.equal(normalOpenDays(['LUNES', 'MARTES']), 2);
  });
});

// The backend and frontend copies of these helpers have already drifted once —
// the frontend lost entradaPara and DEFAULT_ENTRADA without anything noticing.
// Comparing the text would fail on comments; comparing behaviour is what
// actually matters, and it is what the panel and the engine agreeing depends on.
describe('el backend i el frontend calculen igual', () => {
  test('objectiu setmanal, a través de moltes combinacions', () => {
    for (const contractHours of [20, 30, 35, 40]) {
      for (const intensidad of [60, 85, 100, 120, 130]) {
        for (const diasNormales of [5, 6, 7]) {
          for (let diasAbiertos = 0; diasAbiertos <= diasNormales; diasAbiertos++) {
            for (let diasNoDisponibles = 0; diasNoDisponibles <= 3; diasNoDisponibles++) {
              for (let diasBloqueadosSiempre = 0; diasBloqueadosSiempre <= 2; diasBloqueadosSiempre++) {
                for (let diasLibresPactados = 0; diasLibresPactados <= 2; diasLibresPactados++) {
                  const args = {
                    contractHours, intensidad, diasAbiertos, diasNormales,
                    diasNoDisponibles, diasBloqueadosSiempre, diasLibresPactados,
                  };
                  assert.deepEqual(weeklyHourTarget(args), feWeeklyHourTarget(args),
                    `divergeixen amb ${JSON.stringify(args)}`);
                }
              }
            }
          }
        }
      }
    }
  });

  test('dies d\'obertura habituals', () => {
    for (const v of [null, '', '[]', '["LUNES"]', '["LUNES","MARTES","MIERCOLES"]', 'brossa']) {
      assert.equal(normalOpenDays(v), feNormalOpenDays(v), `divergeixen amb ${JSON.stringify(v)}`);
    }
  });

  test('hora de sortida, a través de botigues i jornades', () => {
    const botigues = [
      undefined,
      { cierraMediodia: false },
      { cierraMediodia: true, inicioCierreMediodia: '13:30', finCierreMediodia: '16:30' },
      { cierraMediodia: true, inicioCierreMediodia: '14:00', finCierreMediodia: '17:00' },
      { cierraMediodia: true },                                     // mal configurada
      { cierraMediodia: true, inicioCierreMediodia: '17:00', finCierreMediodia: '14:00' },
    ];
    const persones = [{}, { horasPorTurno: 4, horaEntradaManana: '07:30' }, { horasPorTurno: 6 },
      { horaEntradaManana: '09:00', horaEntradaTarde: '16:00' }];
    for (const est of botigues) {
      assert.equal(beDuracionDescanso(est), feDuracionDescanso(est), `descans divergeix amb ${JSON.stringify(est)}`);
      for (const emp of persones) {
        for (const turno of ['MANANA', 'TARDE', 'PARTIDO', 'LIBRE', null]) {
          for (const entrada of [undefined, '07:30', '09:15', '23:00', 'brossa']) {
            assert.equal(beSalidaPara(emp, turno, est, entrada), feSalidaPara(emp, turno, est, entrada),
              `divergeixen amb ${JSON.stringify({ emp, turno, est, entrada })}`);
          }
        }
      }
    }
  });

  test('hores per torn, jornada completa i reduïda', () => {
    const persones = [{}, { horasPorTurno: 4 }, { horasPorTurno: 6 }, { horasPorTurno: null }];
    for (const emp of persones) {
      for (const turno of ['MANANA', 'TARDE', 'PARTIDO', 'LIBRE', null]) {
        assert.equal(beShiftHours(emp, turno), feShiftHours(emp, turno),
          `divergeixen amb ${JSON.stringify(emp)} / ${turno}`);
      }
    }
  });
});
