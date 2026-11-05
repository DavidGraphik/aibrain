import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shiftHours, jornadaReducida, entradaPara, descansoPara, salidaPara, duracionDescanso, DESCANSO_HORAS, REDUCED_DAY_FIELDS } from '../src/utils/shiftHours.js';

test('honours an explicit whole-week afternoon start without assuming conditional or conflicting starts', () => {
  const condicionesFijas = 'Siempre hace de tardes, de 16h hasta el cierre. Nunca días ni mañanas';
  assert.equal(entradaPara({ condicionesFijas }, 'TARDE'), '16:00');
  assert.equal(salidaPara({ condicionesFijas }, 'TARDE', {}), '22:00');
  assert.equal(entradaPara({ condicionesFijas, horaEntradaTarde: '15:00' }, 'TARDE'), '15:00');
  for (const text of ['El lunes siempre hace de tardes, de 16h hasta el cierre', 'Siempre tardes, si trabaja de 16h hasta el cierre', 'Siempre tardes, de 25h hasta el cierre', 'Siempre tardes, de 16h hasta el cierre. Siempre tardes, de 17h hasta el cierre']) {
    assert.equal(entradaPara({ condicionesFijas: text }, 'TARDE'), '14:45');
  }
});

// A shift used to have one fixed length for everyone. That silently inflated
// every part-timer's week: David Castillo works 8:00–12:00 on a 20h contract
// and each morning counted as 7h, so his five days added up to 35h.
describe('hores per torn', () => {
  const reduida = { horasPorTurno: 4, horaEntradaManana: '08:00' };
  const normal = { horasPorTurno: null };

  test('jornada estàndard manté 7/6/10', () => {
    assert.equal(shiftHours(normal, 'MANANA'), 7);
    assert.equal(shiftHours(normal, 'TARDE'), 6);
    assert.equal(shiftHours(normal, 'PARTIDO'), 10);
  });

  test('jornada reduïda: tots els torns duren igual', () => {
    assert.equal(shiftHours(reduida, 'MANANA'), 4);
    assert.equal(shiftHours(reduida, 'TARDE'), 4);
  });

  test('LIBRE no suma mai', () => {
    assert.equal(shiftHours(normal, 'LIBRE'), 0);
    assert.equal(shiftHours(reduida, 'LIBRE'), 0);
    assert.equal(shiftHours(reduida, null), 0);
  });

  test('la setmana d\'un contracte de 20h quadra exactament', () => {
    const setmana = ['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA'];
    const total = setmana.reduce((suma, t) => suma + shiftHours(reduida, t), 0);
    assert.equal(total, 20, 'cinc matins de 4h han de ser 20h, no 35h');
  });

  test('sense empleat torna als valors estàndard', () => {
    assert.equal(shiftHours(null, 'MANANA'), 7);
    assert.equal(shiftHours(undefined, 'TARDE'), 6);
  });
});

describe('detecció de jornada reduïda', () => {
  test('només amb hores per torn positives', () => {
    assert.equal(jornadaReducida({ horasPorTurno: 4 }), true);
    assert.equal(jornadaReducida({ horasPorTurno: null }), false);
    assert.equal(jornadaReducida({ horasPorTurno: 0 }), false);
    assert.equal(jornadaReducida(null), false);
  });
});

describe('hores d\'entrada', () => {
  test('l\'entrada pròpia guanya la per defecte', () => {
    assert.equal(entradaPara({ horaEntradaManana: '08:00' }, 'MANANA'), '08:00');
    assert.equal(entradaPara({ horaEntradaTarde: '16:00' }, 'TARDE'), '16:00');
  });

  test('sense entrada pròpia, els valors de sempre', () => {
    assert.equal(entradaPara({}, 'MANANA'), '07:30');
    assert.equal(entradaPara({}, 'TARDE'), '14:45');
    assert.equal(entradaPara({}, 'LIBRE'), null);
  });
});

describe('hora de descans', () => {
  test('només en tenen els torns partits', () => {
    assert.equal(descansoPara('MANANA', null), null);
    assert.equal(descansoPara('TARDE', null), null);
    assert.equal(descansoPara('LIBRE', null), null);
    assert.ok(descansoPara('PARTIDO', null));
  });

  test('una botiga que tanca al migdia descansa quan tanca', () => {
    const est = { cierraMediodia: true, inicioCierreMediodia: '14:00' };
    assert.equal(descansoPara('PARTIDO', est), '14:00');
  });

  test('si no tanca, tothom descansa a la mateixa hora', () => {
    // Girona does not close at midday; the model was giving 13:00 to some and
    // 14:00 to others in the same week for no stated reason.
    assert.equal(descansoPara('PARTIDO', { cierraMediodia: false }), '13:30');
    assert.equal(descansoPara('PARTIDO', {}), '13:30');
  });

  test('tanca al migdia però sense hora configurada: el valor de sempre', () => {
    assert.equal(descansoPara('PARTIDO', { cierraMediodia: true, inicioCierreMediodia: null }), '13:30');
  });
});

// The reduced working day shipped complete and correct, and did nothing at all
// in production: the generator's Prisma `select` never asked for these three
// columns, so every function here received undefined and fell back to the
// standard full-time shift. Nothing threw — David Castillo simply got 7-hour
// mornings at 07:30, and the engine stopped him a day early because it thought
// he had already passed his contract. A missing column reads exactly like a
// part-timer who isn't one.
describe('columnes que la jornada reduïda necessita', () => {
  const complet = { horasPorTurno: 4, horaEntradaManana: '08:00', horaEntradaTarde: '16:00' };
  const REQUERIDES = ['horasPorTurno', 'horaEntradaManana', 'horaEntradaTarde'];

  test('la constant les declara totes', () => {
    assert.deepEqual(Object.keys(REDUCED_DAY_FIELDS).sort(), [...REQUERIDES].sort());
    for (const camp of REQUERIDES) assert.equal(REDUCED_DAY_FIELDS[camp], true);
  });

  test('sense les columnes, un contracte reduït passa per jornada completa', () => {
    // The exact silent failure seen in the 2026-W33 generation.
    assert.equal(shiftHours(complet, 'MANANA'), 4);
    assert.equal(shiftHours({}, 'MANANA'), 7, 'el fallback existeix, i és per això que no peta');
    assert.equal(entradaPara(complet, 'MANANA'), '08:00');
    assert.equal(entradaPara({}, 'MANANA'), '07:30');
    assert.equal(jornadaReducida(complet), true);
    assert.equal(jornadaReducida({}), false, 'i per tant tampoc el protegeix dels PARTIDO');
  });

  // Asserting on the source is crude, but the alternative is a live database:
  // the bug was never in the logic, it was in what the query asked for.
  for (const fitxer of ['src/services/aiScheduler.js', 'src/controllers/schedules.js']) {
    test(`${fitxer} demana les columnes a la consulta`, () => {
      const codi = fs.readFileSync(new URL(`../${fitxer}`, import.meta.url), 'utf8');
      assert.ok(codi.includes('REDUCED_DAY_FIELDS'),
        `${fitxer} calcula hores però no escampa REDUCED_DAY_FIELDS al select`);
    });
  }

  // The reduced working day was lost twice in one day, in two different places.
  // The second: the insert stamped defaultEntrada for everybody, throwing away
  // what applyCustomEntryTimes had just computed. Fixing the query corrected
  // David Castillo's hours and left his start time exactly as wrong as before.
  test('el desat a la base de dades no fa servir el descans de la IA', () => {
    // The model gave 13:00 to some people and 14:00 to others in the same week,
    // and nothing at all to the split shifts the repair passes created — the
    // shop manager prints that.
    const codi = fs.readFileSync(new URL('../src/services/aiScheduler.js', import.meta.url), 'utf8');
    const insert = codi.slice(codi.indexOf('prisma.schedule.create'));
    const linia = insert.split('\n').find((l) => l.includes('horaDescanso:'));
    assert.ok(linia, 'no trobo on s\'escriu horaDescanso');
    assert.match(linia, /descansoPara\(/, 'l\'hora de descans l\'ha de decidir el codi');
  });

  test('el desat a la base de dades fa servir l\'hora d\'entrada de la persona', () => {
    const codi = fs.readFileSync(new URL('../src/services/aiScheduler.js', import.meta.url), 'utf8');
    const insert = codi.slice(codi.indexOf('prisma.schedule.create'));
    const linia = insert.split('\n').find((l) => l.includes('horaEntrada:'));
    assert.ok(linia, 'no trobo on s\'escriu horaEntrada');
    assert.match(linia, /entradaPara\(/,
      'el desat ha de fer servir entradaPara(employee, turno), no defaultEntrada');
  });
});

// ── When people go home ──────────────────────────────────────────────────
// The schedule said when to come in and nothing about when to leave. Nobody
// missed it for a seven-hour morning; David Castillo works four, and the sheet
// on the wall said 7:30 and stopped there.
describe('hora de sortida', () => {
  const girona = { cierraMediodia: false };                                    // no midday closing
  const palamos = { cierraMediodia: true, inicioCierreMediodia: '13:30', finCierreMediodia: '16:30' };
  const complet = { horasPorTurno: null };
  const david = { horasPorTurno: 4, horaEntradaManana: '07:30' };

  test('matí i tarda: entrada més la durada del torn', () => {
    assert.equal(salidaPara(complet, 'MANANA', girona), '14:30');   // 07:30 + 7h
    assert.equal(salidaPara(complet, 'TARDE', girona), '20:45');    // 14:45 + 6h
  });

  test('jornada reduïda: quatre hores són quatre hores', () => {
    assert.equal(salidaPara(david, 'MANANA', girona), '11:30');
  });

  test('el partit hi suma el descans', () => {
    // 07:30 + 10h de feina + 3h de descans
    assert.equal(salidaPara(complet, 'PARTIDO', girona), '20:30');
  });

  test('si la botiga tanca al migdia, el descans dura el que dura el tancament', () => {
    assert.equal(duracionDescanso(palamos), 180);          // 13:30–16:30
    assert.equal(duracionDescanso(girona), DESCANSO_HORAS * 60);
    assert.equal(duracionDescanso(undefined), DESCANSO_HORAS * 60);
  });

  test('un tancament mal configurat no trenca el càlcul', () => {
    const alrevés = { cierraMediodia: true, inicioCierreMediodia: '16:30', finCierreMediodia: '13:30' };
    assert.equal(duracionDescanso(alrevés), DESCANSO_HORAS * 60);
    assert.equal(duracionDescanso({ cierraMediodia: true }), DESCANSO_HORAS * 60);
  });

  // The whole reason it is calculated and not stored: a manager who moves the
  // entry time by hand must see the leaving time move with it.
  test('mana l\'hora d\'entrada realment desada al torn', () => {
    assert.equal(salidaPara(complet, 'MANANA', girona, '09:00'), '16:00');
    assert.equal(salidaPara(david, 'MANANA', girona, '10:15'), '14:15');
  });

  // If the stored entry time cannot be read, we say nothing rather than invent
  // a leaving time from a start we are not sure of.
  test('LIBRE i les hores impossibles no en tenen', () => {
    assert.equal(salidaPara(complet, 'LIBRE', girona), null);
    assert.equal(salidaPara(complet, null, girona), null);
    assert.equal(salidaPara(complet, 'MANANA', girona, '25:00'), null);
    assert.equal(salidaPara(complet, 'MANANA', girona, 'quinze'), null);
  });

  test('passar de mitjanit no dona una hora impossible', () => {
    assert.equal(salidaPara(complet, 'TARDE', girona, '23:00'), '05:00');
  });
});
