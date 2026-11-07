import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updatePreference } from '../src/controllers/preferences.js';
import { prisma } from '../src/services/prisma.js';

const general = { id: 1, rol: 'MANAGER_GENERAL', establecimientos: [] };
const employee = { id: 127, rol: 'EMPLEADO', establecimientoId: 6 };
const full = { semana: '2026-W43', turnoPreferido: null, diasNoDisponible: ['LUNES', 'SABADO', 'DOMINGO'], turnosPorDia: { MIERCOLES: 'TARDE' }, notasAdicionales: 'PROVA GUIA' };
const response = () => ({ code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
function storage(t, { target = employee, current = null } = {}) {
  const original = { employee: prisma.employee, shiftPreference: prisma.shiftPreference };
  prisma.employee = { findUnique: t.mock.fn(async () => target) };
  prisma.shiftPreference = {
    findFirst: t.mock.fn(async () => current),
    create: t.mock.fn(async ({ data }) => ({ id: 99, ...data })),
    update: t.mock.fn(async ({ data }) => ({ ...current, ...data })),
  };
  t.after(() => { Object.assign(prisma, original); });
  return prisma.shiftPreference;
}
const call = async (body, user = general, id = '127') => {
  const res = response();
  await updatePreference({ user, params: { empleadoId: id }, body }, res);
  return res;
};

test('manual availability saves day restrictions without unsupported employee fields', async (t) => {
  const db = storage(t);
  const res = await call(full);
  assert.equal(res.code, 200);
  assert.deepEqual(db.create.mock.calls[0].arguments[0].data, { empleadoId: 127, ...full, recogidoVia: 'MANUAL' });
  assert.equal(db.update.mock.callCount(), 0);
});

test('notes-only correction preserves days and shifts on the latest active preference', async (t) => {
  const db = storage(t, { current: { id: 99, ...full } });
  const res = await call({ semana: full.semana, notasAdicionales: 'corregit' });
  assert.equal(res.code, 200);
  assert.deepEqual(db.findFirst.mock.calls[0].arguments[0], { where: { empleadoId: 127, semana: full.semana, activa: true }, orderBy: { updatedAt: 'desc' } });
  assert.deepEqual(db.update.mock.calls[0].arguments[0], { where: { id: 99 }, data: { notasAdicionales: 'corregit', recogidoVia: 'MANUAL' } });
  assert.deepEqual(res.body.turnosPorDia, full.turnosPorDia);
});

test('explicit empty values clear only requested restrictions', async (t) => {
  const db = storage(t, { current: { id: 99, ...full } });
  const res = await call({ semana: full.semana, diasNoDisponible: [], turnosPorDia: {} });
  assert.equal(res.code, 200);
  assert.deepEqual(db.update.mock.calls[0].arguments[0].data, { diasNoDisponible: [], turnosPorDia: {}, recogidoVia: 'MANUAL' });
});

test('invalid or contradictory availability never writes or silently drops a restriction', async (t) => {
  const db = storage(t);
  for (const extra of [{ turnoPreferido: 'FLEXIBLE' }, { maxHorasSemana: 24 }, { flexibilidad: true },
    { diasNoDisponible: 'LUNES' }, { diasNoDisponible: ['MONDAY'] }, { turnosPorDia: { MIERCOLES: 'AMBOS' } },
    { turnosPorDia: null }, { turnosPorDia: { LUNES: 'TARDE' } }, { notasAdicionales: {} }]) {
    const res = await call({ ...full, ...extra });
    assert.equal(res.code, 400, JSON.stringify(extra));
  }
  assert.equal(db.create.mock.callCount(), 0);
  assert.equal(db.update.mock.callCount(), 0);
});

test('partial update cannot contradict a saved day restriction', async (t) => {
  const db = storage(t, { current: { id: 99, ...full } });
  const res = await call({ semana: full.semana, diasNoDisponible: ['MIERCOLES'] });
  assert.equal(res.code, 400);
  assert.equal(db.update.mock.callCount(), 0);
});

test('local manager cannot access another shop or a higher role', async (t) => {
  const db = storage(t);
  const res = await call(full, { id: 2, rol: 'MANAGER_LOCAL', establecimientos: [1] });
  assert.equal(res.code, 403);
  assert.equal(db.findFirst.mock.callCount(), 0);
  assert.equal(db.create.mock.callCount(), 0);
});

test('local manager can save availability for an explicitly shared employee', async (t) => {
  storage(t, { target: { ...employee, establecimientosPermitidos: [{ establishmentId: 1 }] } });
  const res = await call(full, { id: 2, rol: 'MANAGER_LOCAL', establecimientos: [1] });
  assert.equal(res.code, 200);
});

test('missing employee and malformed identity or week never write', async (t) => {
  const db = storage(t, { target: null });
  assert.equal((await call(full)).code, 403);
  assert.equal((await call(full, general, '127abc')).code, 400);
  assert.equal((await call({ ...full, semana: '2026-W99' })).code, 400);
  assert.equal(db.create.mock.callCount(), 0);
});
