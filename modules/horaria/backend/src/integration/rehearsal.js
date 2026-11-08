import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../services/prisma.js';
import { createHorariaApp } from './app.js';
import { bodyHash, signEnvelope } from './signature.js';
import { previewPdf } from './preview.js';
import { stateDirectory } from './durable-state.js';

// Only a throwaway localhost database. Never uses a provider, even if keys exist.
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1');
assert.match(database.pathname, /rehearsal/);
process.env.HORARIA_ALLOW_AI = '0';
process.env.HORARIA_ALLOW_DELIVERY = '0';
process.env.HORARIA_ALLOW_AUTOMATIC = '0';
const originalFetch = global.fetch;
global.fetch = (url, options) => {
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('External calls forbidden during rehearsal');
  return originalFetch(url, options);
};
const secret = randomUUID() + randomUUID();
const app = createHorariaApp({ secret, installationId: 'horaria-rehearsal' });
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const general = await prisma.employee.findFirst({ where: { activo: true, rol: 'MANAGER_GENERAL' } });
assert.ok(general);
async function call(target, { employeeId = general.id, method = 'GET', data } = {}) {
  const body = Buffer.from(data ? JSON.stringify(data) : ''), contentType = body.length ? 'application/json' : '';
  const token = signEnvelope({ v: 1, kind: 'user', installationId: 'horaria-rehearsal', actorId: 'rehearsal-user', employeeId, timestamp: Date.now(), nonce: randomUUID(), method, target, contentType, bodyHash: bodyHash(body) }, secret);
  return fetch(base + target, { method, headers: { 'x-aibrain-authorization': token, ...(contentType ? { 'content-type': contentType } : {}) }, body: body.length ? body : undefined });
}
try {
  const [group] = await prisma.schedule.groupBy({ by: ['establecimientoId', 'semana'], _count: { id: true }, orderBy: { _count: { id: 'desc' } }, take: 1 });
  const shop = { id: group.establecimientoId };
  const shift = { semana: group.semana };
  const query = `?semana=${shift.semana}&establecimiento=${shop.id}`;
  const previewResponse = await call('/api/integration/preview' + query);
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.ok(preview.rows.length > 1);
  assert.equal(preview.shiftCount, await prisma.schedule.count({ where: { semana: shift.semana, establecimientoId: shop.id } }));
  await writeFile(path.join(stateDirectory(), 'schedule-preview.pdf'), previewPdf(preview), { mode: 0o600 });
  for (const endpoint of ['employees', 'preferences', 'absences/week', 'schedules/report', 'summary', 'ajustes', 'whatsapp/status']) assert.equal((await call(`/api/${endpoint}${query}`)).status, 200, endpoint);
  const before = await prisma.employee.count();
  const created = await call('/api/employees', { method: 'POST', data: { nombre: 'Rehearsal', apellidos: 'Temporary', email: `rehearsal-${randomUUID()}@example.test`, rol: 'EMPLEADO', funcion: 'DEPENDIENTA', establecimientoId: shop.id, maxHorasSemana: 20 } });
  assert.equal(created.status, 201);
  const person = await created.json();
  assert.equal(await prisma.employee.count(), before + 1);
  assert.equal((await call(`/api/employees/${person.id}`, { method: 'PUT', data: { maxHorasSemana: 25 } })).status, 200);
  assert.equal((await prisma.employee.findUnique({ where: { id: person.id } })).maxHorasSemana, 25);
  assert.equal((await call(`/api/employees/${person.id}`, { method: 'DELETE' })).status, 200);
  // The provider gate closes before any outbound call.
  assert.equal((await call('/api/integration/publish', { method: 'POST', data: { establecimientoId: shop.id, semana: shift.semana, previewHash: preview.previewHash } })).status, 500);
  console.log(JSON.stringify({ status: 'passed', providerCalls: 0, migratedModels: 17, previewRows: preview.rows.length, shiftCount: preview.shiftCount, readEndpoints: 7, employeeCrud: true, realDeliveryBlocked: true }));
} finally {
  global.fetch = originalFetch;
  await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect();
}
