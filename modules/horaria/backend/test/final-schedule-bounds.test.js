import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceFinalScheduleBounds, remainingWeeklyHours } from '../src/services/final-schedule-bounds.js';
import { shiftHours } from '../src/utils/shiftHours.js';
const days = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
const employee = (id, extra = {}) => ({ id, funcion: 'DEPENDIENTA', maxHorasSemana: 40, ...extra });
const grid = (id, shifts) => ({ empleadoId: id, dias: days.map((dia, i) => ({ dia, turno: shifts[i] || 'LIBRE' })) });
const hours = (h, e) => h.dias.reduce((sum, d) => sum + shiftHours(e, d.turno), 0);

test('43/40 is corrected after the final pass, retaining the Wednesday afternoon request', () => {
  const e = employee(1, { horasObjetivoSemana: 48, turnosPorDiaPreferencia: { MIERCOLES: 'TARDE' } });
  const h = [grid(1, ['PARTIDO', 'PARTIDO', 'TARDE', 'PARTIDO', 'LIBRE', 'MANANA'])];
  assert.equal(hours(h[0], e), 43);
  enforceFinalScheduleBounds(h, [e], []);
  assert.ok(hours(h[0], e) <= 40);
  assert.equal(h[0].dias[2].turno, 'TARDE');
  assert.equal(remainingWeeklyHours(e), 40);
});

test('final coverage repair respects maxima, reduced days and hours in other shops', () => {
  const employees = [employee(1, { horasPorTurno: 4, maxHorasSemana: 20, horasYaTrabajadas: 16 }), employee(2)];
  const h = [grid(1, ['MANANA', 'MANANA']), grid(2, [])];
  const rules = [{ diasAplica: '["LUNES","MARTES"]', minDependientasManana: 1, maxDependientasManana: 1, maxDependientasTarde: 0 }];
  enforceFinalScheduleBounds(h, employees, rules, days.slice(2));
  assert.ok(hours(h[0], employees[0]) <= 4);
  for (const day of days.slice(0, 2)) assert.equal(h.filter(x => ['MANANA', 'PARTIDO'].includes(x.dias.find(d => d.dia === day).turno)).length, 1);
  assert.ok(h[0].dias.every(d => d.turno !== 'PARTIDO'));
});

test('impossible minima remain visible instead of breaching hours, absences or maximum coverage', () => {
  const e = employee(1, { maxHorasSemana: 0, diasAusente: { LUNES: 'BAJA_MEDICA' } });
  const h = [grid(1, ['MANANA'])];
  enforceFinalScheduleBounds(h, [e], [{ minDependientasManana: 2, maxDependientasManana: 1 }]);
  assert.equal(hours(h[0], e), 0);
  assert.ok(h[0].dias.every(d => d.turno === 'LIBRE'));
});

test('coverage excess is removed even after late condition passes; malformed grids fail closed', () => {
  const es = [employee(1), employee(2)];
  const h = es.map(e => grid(e.id, ['TARDE']));
  enforceFinalScheduleBounds(h, es, [{ minDependientasTarde: 1, maxDependientasTarde: 1 }], days.slice(1));
  assert.equal(h.filter(x => x.dias[0].turno === 'TARDE').length, 1);
  assert.throws(() => enforceFinalScheduleBounds([h[0], h[0]], es, []));
  assert.throws(() => remainingWeeklyHours(employee(3, { maxHorasSemana: NaN })));
});

test('weekday names on legacy rules select Saturday coverage without applying Friday defaults', async () => {
  const { ruleForDay } = await import('../src/utils/ruleForDay.js');
  const rules = [{ nombre: 'DIVENDRES', minDependientasManana: 6 }, { nombre: 'DISSABTE', minDependientasManana: 7 }];
  assert.equal(ruleForDay(rules, 'VIERNES').minDependientasManana, 6);
  assert.equal(ruleForDay(rules, 'SABADO').minDependientasManana, 7);
  assert.equal(ruleForDay(rules, 'LUNES'), null);
  assert.equal(ruleForDay([{ nombre: 'General', minDependientasManana: 1 }, { nombre: 'DISSABTE', minDependientasManana: 7 }], 'SABADO').minDependientasManana, 7);
  assert.throws(() => ruleForDay([{ diasAplica: 'broken' }], 'LUNES'));
});

test('moves capped hours between days to spread unavoidable shortages without leaving a shift empty', () => {
  const es = [employee(1, { maxHorasSemana: 7 }), employee(2, { maxHorasSemana: 7 })];
  const h = es.map(e => grid(e.id, ['MANANA']));
  const rules = [{ minDependientasManana: 2, maxDependientasManana: 2, maxDependientasTarde: 0 }];
  enforceFinalScheduleBounds(h, es, rules, days.slice(2));
  for (const day of days.slice(0, 2)) assert.equal(h.filter(x => x.dias.find(d => d.dia === day).turno === 'MANANA').length, 1);
  for (const e of es) assert.equal(hours(h.find(x => x.empleadoId === e.id), e), 7);
});


test('recovers an exact afternoon count with an atomic same-role exchange, without losing coverage', () => {
  const es = [employee(1, { condicionesEstructuradas: { matinsExactes: 3, tardesExactes: 3, partidoCompta: 'MATI_I_TARDA' } }), employee(2)];
  const h = [grid(1, ['PARTIDO', 'PARTIDO', 'TARDE', 'TARDE', 'MANANA']), grid(2, ['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA'])];
  const rules = [{ diasAplica: JSON.stringify(days.slice(0, 2)), minDependientasManana: 2, minDependientasTarde: 1, maxDependientasManana: 2, maxDependientasTarde: 1 }, { diasAplica: JSON.stringify(days.slice(2, 5)), minDependientasManana: 1, minDependientasTarde: 0, maxDependientasManana: 2, maxDependientasTarde: 1 }];
  const oldCounts = days.slice(0, 5).map(day => ['MANANA', 'TARDE'].map(t => h.filter(x => [t, 'PARTIDO'].includes(x.dias.find(d => d.dia === day).turno)).length));
  enforceFinalScheduleBounds(h, es, rules, days.slice(5), (e, _day, shift) => {
    if (e.id !== 1 || shift !== 'MANANA') return true;
    return h[0].dias.filter(d => ['MANANA', 'PARTIDO'].includes(d.turno)).length < 3;
  });
  assert.equal(h[0].dias.filter(d => ['TARDE', 'PARTIDO'].includes(d.turno)).length, 3);
  assert.equal(h[0].dias.filter(d => ['MANANA', 'PARTIDO'].includes(d.turno)).length, 3);
  assert.deepEqual(days.slice(0, 5).map(day => ['MANANA', 'TARDE'].map(t => h.filter(x => [t, 'PARTIDO'].includes(x.dias.find(d => d.dia === day).turno)).length)), oldCounts);
  for (const e of es) assert.ok(hours(h.find(x => x.empleadoId === e.id), e) <= e.maxHorasSemana);
});

test('does not buy a fixed condition by exceeding a partner contract or changing requested shifts', () => {
  for (const protection of [{ maxHorasSemana: 35 }, { condicionesEstructuradas: { maxPartidos: 0 } }, { turnosPorDiaPreferencia: Object.fromEntries(days.slice(0, 5).map(d => [d, 'MANANA'])) }]) {
    const es = [employee(1, { condicionesEstructuradas: { matinsExactes: 3, tardesExactes: 3, partidoCompta: 'MATI_I_TARDA' } }), employee(2, protection)];
    const h = [grid(1, ['PARTIDO', 'PARTIDO', 'TARDE', 'TARDE', 'MANANA']), grid(2, ['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA'])];
    const before = structuredClone(h);
    enforceFinalScheduleBounds(h, es, [{ diasAplica: JSON.stringify(days.slice(0, 2)), minDependientasManana: 2, minDependientasTarde: 1, maxDependientasManana: 2, maxDependientasTarde: 1 }, { diasAplica: JSON.stringify(days.slice(2, 5)), minDependientasManana: 1, minDependientasTarde: 0, maxDependientasManana: 2, maxDependientasTarde: 1 }], days.slice(5));
    assert.deepEqual(h, before);
  }
});
