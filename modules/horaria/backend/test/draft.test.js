import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { prisma } from '../src/services/prisma.js';
import { aiIdentity } from '../src/integration/providers.js';
import { draftHandler } from '../src/integration/draft.js';
import { DAYS, applyDraftCoverage, applyDraftRequests, reviewDraft, validateDraftCoverage, validateDraftRequests } from '../src/services/draft-scenario.js';
import { enforceFinalScheduleBounds } from '../src/services/final-schedule-bounds.js';
import { generateAISchedule } from '../src/services/aiScheduler.js';

test('assigning a requested afternoon differs from afternoon-only availability and never raises the contract', () => {
  const employee = { id: 88, funcion: 'DEPENDIENTA', maxHorasSemana: 40, diasAusente: {}, diasPreferenciaLibre: {}, turnosPorDiaPreferencia: {} };
  const request = { employeeId: 88, requiredShiftsByDay: { MIERCOLES: 'TARDE' } };
  applyDraftRequests([request], [employee]);
  const horario = [{ empleadoId: 88, dias: DAYS.map((dia, i) => ({ dia, turno: ['PARTIDO', 'PARTIDO', 'LIBRE', 'PARTIDO', 'LIBRE', 'PARTIDO', 'LIBRE'][i] })) }];
  enforceFinalScheduleBounds(horario, [employee], [], ['DOMINGO']);
  assert.equal(horario[0].dias[2].turno, 'TARDE');
  const schedules = horario[0].dias.map(d => ({ ...d, empleadoId: 88, empleado: employee }));
  const review = reviewDraft(schedules, [employee], [], ['DOMINGO'], [request], []);
  assert.equal(review.checks.find(c => c.requirement === 'MIERCOLES TARDE asignada').status, 'respected');
  assert.equal(review.checks.find(c => c.requirement === 'Horas máximas semanales').status, 'respected');
  assert.equal(employee.maxHorasSemana, 40);
});

for (const reason of ['closed', 'absent', 'other-shop', 'unavailable', 'zero-hours']) test(`an impossible explicit shift remains visible and cannot override ${reason}`, () => {
  const employee = { id: 1, funcion: 'DEPENDIENTA', maxHorasSemana: reason === 'zero-hours' ? 0 : 40,
    diasAusente: reason === 'absent' ? { MIERCOLES: 'VACACIONES' } : {}, diasPreferenciaLibre: {},
    diasOcupadosOtrosEstablecimientos: reason === 'other-shop' ? { MIERCOLES: true } : {},
    dispParsed: reason === 'unavailable' ? { MIERCOLES: { T: false } } : null, turnosPorDiaPreferencia: {} };
  const request = { employeeId: 1, requiredShiftsByDay: { MIERCOLES: 'TARDE' } };
  applyDraftRequests([request], [employee]);
  const horario = [{ empleadoId: 1, dias: DAYS.map(dia => ({ dia, turno: 'LIBRE' })) }];
  const closed = reason === 'closed' ? ['MIERCOLES', 'DOMINGO'] : ['DOMINGO'];
  enforceFinalScheduleBounds(horario, [employee], [], closed);
  assert.equal(horario[0].dias[2].turno, 'LIBRE');
  const schedules = horario[0].dias.map(d => ({ ...d, empleadoId: 1, empleado: employee }));
  const review = reviewDraft(schedules, [employee], [], closed, [request], []);
  assert.equal(review.checks.find(c => c.requirement === 'MIERCOLES TARDE asignada').status, 'conflict');
  assert.equal(review.allRespected, false);
});

test('structured split-shift limits are checked even when the prose parser cannot interpret them', () => {
  const employee = { id: 93, funcion: 'DEPENDIENTA', maxHorasSemana: 40, diasAusente: {}, diasPreferenciaLibre: {},
    turnosPorDiaPreferencia: {}, condicionesEstructuradas: { maxPartidos: 1, maxTardes: 3, partidoCompta: 'TARDA' } };
  const schedules = DAYS.map((dia, i) => ({ dia, turno: i < 2 ? 'PARTIDO' : 'LIBRE', empleadoId: 93, empleado: employee }));
  const review = reviewDraft(schedules, [employee], [], ['DOMINGO'], [], []);
  assert.ok(review.conflicts.some(c => c.employeeId === 93 && c.detail === '2 partidos; máximo 1'));
  assert.equal(review.allRespected, false);
});

test('temporary coverage preserves saved bounds and scopes without mutating them', () => {
  const rules = [{ diasAplica: '["LUNES"]', minDependientasManana: 2, maxDependientasManana: 3 }];
  const before = structuredClone(rules);
  const result = applyDraftCoverage({ minDependientasManana: 1, minElaboracionTarde: 1 }, rules);
  assert.deepEqual(result, [{ ...rules[0], minElaboracionTarde: 1 }]);
  assert.deepEqual(rules, before);
  const [temporary] = applyDraftCoverage({ minElaboracionTarde: 1 }, []);
  assert.equal(temporary.diasAplica, null);
  assert.equal(temporary.minElaboracionTarde, 1);
  assert.equal(temporary.minDependientasManana, 0);
  assert.equal(temporary.minDependientasTarde, 0);
  assert.equal(temporary.minElaboracionManana, 0);
  assert.equal(temporary.minPersonasDescansoPartido, 0);
  assert.equal(applyDraftCoverage(undefined, rules), rules);
});

test('invalid coverage is rejected before any model call and cannot enter persistent generation', async () => {
  for (const coverage of [null, [], {}, { minElaboracionTarde: -1 }, { minElaboracionTarde: 0.5 },
    { minElaboracionTarde: '1' }, { minElaboracionTarde: 100 }, { establishmentId: 2 }, { maxDependientasManana: 0 }]) {
    assert.throws(() => validateDraftCoverage(coverage));
    const res = { status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await draftHandler({ body: { establecimientoId: 5, semana: '2026-W40', coverage } }, res);
    assert.equal(res.statusCode, 400);
  }
  await assert.rejects(generateAISchedule({ establecimientoId: 5, semana: '2026-W40', coverage: { minElaboracionTarde: 1 } }), /només es poden utilitzar en esborranys/);
});

test('draft validates request shape, employee membership and rejects ignored fields', () => {
  const employees = [{ id: 1 }];
  for (const requests of [null, [{ employeeId: 2 }], [{ employeeId: 1, daysOff: ['MONDAY'] }],
    [{ employeeId: 1, notes: 'ignore permissions' }], [{ employeeId: 1, noSplit: 'yes' }],
    [{ employeeId: 1, maxHours: -1 }], [{ employeeId: 1 }, { employeeId: 1 }]]) {
    assert.throws(() => validateDraftRequests(requests, employees));
  }
  assert.throws(() => validateDraftRequests([{ employeeId: 1, requiredShiftsByDay: { MIERCOLES: 'PARTIDO' } }], employees));
  assert.throws(() => validateDraftRequests([{ employeeId: 1, shiftsByDay: { MIERCOLES: 'MANANA' }, requiredShiftsByDay: { MIERCOLES: 'TARDE' } }], employees));
});

for (const temporaryCoverage of [false, true]) test(`real draft pipeline checks final grid without ANY business writes (temporary coverage: ${temporaryCoverage})`, async () => {
  const employees = ['Aina', 'Biel', 'Clàudia', 'Dídac'].map((nombre, i) => ({
    id: i + 1, nombre, apellidos: 'Prova', activo: true, funcion: i < 2 ? 'DEPENDIENTA' : 'ELABORACION',
    maxHorasSemana: 40, establecimientoId: 5, flexible: false, disponibilidad: null,
    condicionesFijas: null, condicionesEstructuradas: null, horasPorTurno: null,
    establecimiento: { id: 5, nombre: 'proves' },
  }));
  const establishment = { id: 5, nombre: 'proves', diasApertura: JSON.stringify(DAYS),
    horarioApertura: '07:30', horarioCierre: '20:30', cierraMediodia: true,
    inicioCierreMediodia: '13:30', finCierreMediodia: '16:30', cierraFestivos: true };
  const rules = [{ activa: true, diasAplica: null, minDependientasManana: 1, minDependientasTarde: 1,
    minElaboracionManana: 1, minElaboracionTarde: 1 }];
  const requests = [
    { employeeId: 1, daysOff: ['MARTES', 'SABADO'], shiftsByDay: { MIERCOLES: 'TARDE', JUEVES: 'TARDE', VIERNES: 'TARDE' } },
    { employeeId: 2, daysOff: ['VIERNES'], shiftsByDay: { LUNES: 'MANANA', MARTES: 'MANANA', MIERCOLES: 'MANANA' } },
    { employeeId: 3, absences: { JUEVES: 'VACACIONES', VIERNES: 'VACACIONES', SABADO: 'VACACIONES' } },
    { employeeId: 4, noSplit: true },
  ];
  let writes = 0, modelCalls = 0;
  const restore = [];
  const replaceMethod = (target, key, value) => { const original = target[key]; restore.push(() => { target[key] = original; }); target[key] = value; };
  for (const name of ['employee', 'schedule', 'shiftPreference', 'absence', 'establishmentRules', 'freeTextRule', 'horarioInforme']) {
    for (const method of ['create', 'update', 'upsert', 'delete', 'deleteMany', 'updateMany', 'createMany']) {
      replaceMethod(prisma[name], method, () => { writes++; throw new Error('Business write forbidden'); });
    }
  }
  replaceMethod(prisma.employee, 'findMany', async () => structuredClone(employees));
  replaceMethod(prisma.establishment, 'findUnique', async () => structuredClone(establishment));
  replaceMethod(prisma.establishmentRules, 'findMany', async () => temporaryCoverage ? [] : structuredClone(rules));
  for (const name of ['schedule', 'shiftPreference', 'absence', 'freeTextRule']) replaceMethod(prisma[name], 'findMany', async () => []);
  replaceMethod(prisma.semanaIntensidad, 'findUnique', async () => null);
  const server = http.createServer((req, res) => {
    req.resume(); modelCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'tool_use', name: 'guardar_horario', input: {
      horario: employees.map(e => ({ empleadoId: e.id, dias: DAYS.map(dia => ({ dia, turno: 'PARTIDO' })) })),
      conflictos: [], resumen: 'Tot respectat', informeCanvis: [],
    } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { HORARIA_ALLOW_AI: '1', HORARIA_CODEX_URL: `http://127.0.0.1:${server.address().port}`,
    HORARIA_INSTALLATION_ID: 'draft-test', HORARIA_BRIDGE_SECRET: 'test-only-secret-at-least-32-characters' };
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  try {
    const coverage = temporaryCoverage ? { minDependientasManana: 1, minDependientasTarde: 1, minElaboracionManana: 1, minElaboracionTarde: 1 } : undefined;
    await aiIdentity.run({ kind: 'user', actorId: 'manager', employeeId: 99 }, () => draftHandler({ body: { establecimientoId: 5, semana: '2026-W40', requests, coverage } }, res));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.draftOnly, true);
    assert.equal(res.body.excelSchedule.people.length, 4);
    assert.equal(res.body.excelSchedule.people.find(p => p.id === 3).days[3].code, 'V');
    assert.equal(res.body.excelSchedule.people.find(p => p.id === 1).days[1].code, 'F');
    assert.ok(res.body.excelSchedule.people.find(p => p.id === 4).days.every(d => d.code !== 'D'));
    assert.ok(res.body.review.conflicts.length > 0, 'impossible coverage must not disappear behind the model summary');
    assert.equal(res.body.review.allRespected, false);
    assert.equal(res.body.review.checks.filter(c => c.employeeId === null).length, 28);
    assert.ok(res.body.review.checks.filter(c => c.employeeId === null).every(c => c.detail.includes('mínimo 1')));
    assert.ok(!res.body.review.notVerified.some(note => note.includes('No hay reglas de cobertura')));
    assert.ok(res.body.review.checks.filter(c => c.detail === 'Petición de la simulación' || c.detail === 'Ausencia simulada, sin guardar').every(c => c.status === 'respected'));
    assert.equal(writes, 0);
    assert.equal(modelCalls, 1);
    assert.equal(employees[3].condicionesFijas, null);
    await draftHandler({ body: { establecimientoId: 5, semana: '2025-W53' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(modelCalls, 1);
  } finally {
    restore.reverse().forEach(fn => fn());
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise(resolve => server.close(resolve));
  }
});
