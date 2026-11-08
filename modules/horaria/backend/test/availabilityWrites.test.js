import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, update, normalizeDisponibilidad } from '../src/controllers/employees.js';
import { prisma } from '../src/services/prisma.js';

const manager = { id: 1, rol: 'MANAGER_GENERAL', establecimientos: [] };
const mockEmployee = (t, methods) => {
  const original = prisma.employee;
  prisma.employee = Object.fromEntries(Object.entries(methods).map(([key, fn]) => [key, t.mock.fn(fn)]));
  t.after(() => { prisma.employee = original; });
  return prisma.employee;
};
const response = () => ({ code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });

test('availability preserves explicit restrictions and supports legacy JSON grids', () => {
  const grid = { SABADO: { M: false, T: false }, DOMINGO: { M: false, T: false } };
  const result = normalizeDisponibilidad(grid);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.value).SABADO, grid.SABADO);
  assert.deepEqual(JSON.parse(result.value).LUNES, { M: true, T: true });
  assert.deepEqual(normalizeDisponibilidad(JSON.stringify(grid)), result);
  assert.deepEqual(normalizeDisponibilidad(undefined), { ok: true, value: undefined });
  assert.deepEqual(normalizeDisponibilidad(null), { ok: true, value: null });
  assert.deepEqual(normalizeDisponibilidad({}), { ok: true, value: null });
});

test('unsupported availability is never silently converted to full availability', () => {
  for (const input of ['Dilluns a divendres matí i tarda; dissabte i diumenge no.', [], 'null', 0,
    { SATURDAY: { M: false, T: false } }, { SABADO: false }, { SABADO: { MANANA: false } }, { SABADO: { M: 'false' } }]) {
    const result = normalizeDisponibilidad(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.match(result.error, /M\/T/);
  }
});

test('creating an employee rejects prose before any record is created', async (t) => {
  const { create: write } = mockEmployee(t, { create: async () => { throw new Error('unexpected write'); } });
  const res = response();
  await create({ user: manager, body: { nombre: 'Aina', apellidos: 'QA', establecimientoId: 6, disponibilidad: 'Dissabte no' } }, res);
  assert.equal(res.code, 400);
  assert.equal(write.mock.callCount(), 0);
});

test('updating with malformed availability cannot clear the saved restriction', async (t) => {
  const { update: write } = mockEmployee(t, {
    findUnique: async () => ({ id: 127, rol: 'EMPLEADO', establecimientoId: 6 }),
    update: async () => { throw new Error('unexpected write'); },
  });
  const res = response();
  await update({ user: manager, params: { id: '127' }, body: { disponibilidad: 'Dissabte no', maxHorasSemana: 24 } }, res);
  assert.equal(res.code, 400);
  assert.equal(write.mock.callCount(), 0);
});

test('updating an unrelated employee field leaves availability untouched', async (t) => {
  const { update: write } = mockEmployee(t, {
    findUnique: async () => ({ id: 127, rol: 'EMPLEADO', establecimientoId: 6 }),
    update: async ({ data }) => ({ id: 127, ...data }),
  });
  const res = response();
  await update({ user: manager, params: { id: '127' }, body: { maxHorasSemana: 24 } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(write.mock.calls[0].arguments[0].data, { maxHorasSemana: 24 });
});
