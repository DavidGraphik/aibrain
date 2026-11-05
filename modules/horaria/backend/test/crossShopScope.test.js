import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/services/prisma.js';
import { getOtherEstablishmentHours } from '../src/controllers/schedules.js';

test('local managers only receive cross-shop hours for their own or shared staff', async () => {
  const original = prisma.schedule.findMany;
  let query;
  prisma.schedule.findMany = async (value) => { query = value; return []; };
  try {
    await getOtherEstablishmentHours({ query: { semana: '2026-W38', establecimiento: '4' }, user: { rol: 'MANAGER_LOCAL' } }, { json() {} });
    assert.deepEqual(query.where.empleado, { OR: [{ establecimientoId: 4 }, { establecimientosPermitidos: { some: { establishmentId: 4 } } }] });
  } finally { prisma.schedule.findMany = original; }
});
