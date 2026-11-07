import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ajustarAlternancaDissabtes } from '../src/services/aiScheduler.js';

// The rotation cannot be fixed one person at a time. Girona's Saturday rule is
// exact — seven in the morning, five in the afternoon — so any single change
// breaks it and would be refused. The fixes only work in combination.
const DIES = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
const persona = (id, dissabte, extra = {}) => ({
  emp: { id, funcion: 'DEPENDIENTA', ...extra },
  sched: { empleadoId: id, dias: DIES.map((d) => ({ dia: d, turno: d === 'SABADO' ? dissabte : 'LIBRE' })) },
});
const dissabteDe = (h, id) => h.find((x) => x.empleadoId === id).dias.find((d) => d.dia === 'SABADO').turno;

// Exactly two in the morning and one in the afternoon: no slack at all.
const REGLA = [{
  diasAplica: '["SABADO"]',
  minDependientasManana: 2, maxDependientasManana: 2,
  minDependientasTarde: 1, maxDependientasTarde: 1,
  minElaboracionManana: 0, maxElaboracionManana: 9,
  minElaboracionTarde: 0, maxElaboracionTarde: 9, minPersonasDescansoPartido: 0,
}];

describe('quadrar l\'alternança dels dissabtes', () => {
  test('dos que incompleixen es creuen entre ells', () => {
    // 1 repeats a morning, 2 repeats an afternoon: swapping fixes both and the
    // counts do not move.
    const gent = [persona(1, 'MANANA'), persona(2, 'TARDE'), persona(3, 'MANANA')];
    const h = gent.map((g) => g.sched);
    ajustarAlternancaDissabtes(h, gent.map((g) => g.emp), REGLA, { 1: 'MANANA', 2: 'TARDE', 3: 'TARDE' }, ['DOMINGO']);
    assert.equal(dissabteDe(h, 1), 'TARDE');
    assert.equal(dissabteDe(h, 2), 'MANANA');
    assert.equal(dissabteDe(h, 3), 'MANANA', 'aquest ja complia i no s\'ha de moure');
  });

  test('si ja es compleix, no toca res', () => {
    const gent = [persona(1, 'MANANA'), persona(2, 'TARDE'), persona(3, 'MANANA')];
    const h = gent.map((g) => g.sched);
    const abans = h.map((x) => dissabteDe(h, x.empleadoId));
    ajustarAlternancaDissabtes(h, gent.map((g) => g.emp), REGLA, { 1: 'TARDE', 2: 'MANANA', 3: 'TARDE' }, ['DOMINGO']);
    assert.deepEqual(h.map((x) => dissabteDe(h, x.empleadoId)), abans);
  });

  // Better a rotation still broken than a Saturday the shop cannot staff.
  test('no trenca mai la cobertura per arreglar l\'alternança', () => {
    // Everybody repeats a morning; moving any of them breaks the count of two.
    const gent = [persona(1, 'MANANA'), persona(2, 'MANANA'), persona(3, 'TARDE')];
    const h = gent.map((g) => g.sched);
    ajustarAlternancaDissabtes(h, gent.map((g) => g.emp), REGLA, { 1: 'MANANA', 2: 'MANANA', 3: 'MANANA' }, ['DOMINGO']);
    assert.equal(dissabteDe(h, 1), 'MANANA');
    assert.equal(dissabteDe(h, 2), 'MANANA');
  });

  test('un dissabte tancat no es toca', () => {
    const gent = [persona(1, 'MANANA'), persona(2, 'TARDE')];
    const h = gent.map((g) => g.sched);
    ajustarAlternancaDissabtes(h, gent.map((g) => g.emp), REGLA, { 1: 'MANANA', 2: 'TARDE' }, ['DOMINGO', 'SABADO']);
    assert.equal(dissabteDe(h, 1), 'MANANA');
  });

  test('un dissabte demanat lliure no entra al joc', () => {
    const gent = [persona(1, 'MANANA', { diasPreferenciaLibre: { SABADO: true } }), persona(2, 'TARDE'), persona(3, 'MANANA')];
    const h = gent.map((g) => g.sched);
    ajustarAlternancaDissabtes(h, gent.map((g) => g.emp), REGLA, { 1: 'MANANA', 2: 'TARDE', 3: 'TARDE' }, ['DOMINGO']);
    assert.equal(dissabteDe(h, 1), 'MANANA', 'no es toca qui ha demanat alguna cosa per aquell dia');
  });

  // A split shift counts on BOTH halves at once, which is the arithmetic that
  // makes some of these solvable at all: a morning becoming a split takes
  // nobody off the morning, it only adds to the afternoon. Here the trade is
  // one morning up to a split against one split down to a morning — a move no
  // pass thinking one shift at a time would ever find.
  test('el partit compta a les dues meitats', () => {
    const REGLA_3_2 = [{ ...REGLA[0], minDependientasManana: 3, maxDependientasManana: 3,
      minDependientasTarde: 2, maxDependientasTarde: 2 }];
    const gent = [persona(1, 'MANANA'), persona(2, 'MANANA'), persona(6, 'PARTIDO'), persona(4, 'TARDE')];
    const h = gent.map((g) => g.sched);
    // Only 1 breaks the rotation: a morning after a morning.
    ajustarAlternancaDissabtes(h, gent.map((g) => g.emp), REGLA_3_2,
      { 1: 'MANANA', 2: 'TARDE', 6: 'TARDE', 4: 'MANANA' }, ['DOMINGO']);

    assert.equal(dissabteDe(h, 1), 'PARTIDO', 'el que repetia matí puja a partit');
    assert.equal(dissabteDe(h, 6), 'MANANA', 'i el que feia partit baixa a matí');
    const m = [1, 2, 6, 4].filter((i) => ['MANANA', 'PARTIDO'].includes(dissabteDe(h, i))).length;
    const t = [1, 2, 6, 4].filter((i) => ['TARDE', 'PARTIDO'].includes(dissabteDe(h, i))).length;
    assert.equal(m, 3, 'els matins no s\'han mogut');
    assert.equal(t, 2, 'ni les tardes');
  });

  test('una jornada reduïda no acaba mai en partit', () => {
    const gent = [persona(1, 'MANANA', { horasPorTurno: 4 }), persona(2, 'TARDE'), persona(3, 'MANANA')];
    const h = gent.map((g) => g.sched);
    ajustarAlternancaDissabtes(h, gent.map((g) => g.emp), REGLA, { 1: 'MANANA', 2: 'TARDE', 3: 'TARDE' }, ['DOMINGO']);
    assert.notEqual(dissabteDe(h, 1), 'PARTIDO');
  });
});
