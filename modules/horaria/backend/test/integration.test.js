import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { createVerifier, bodyHash, signEnvelope } from '../src/integration/signature.js';
import { createHorariaApp } from '../src/integration/app.js';
import { scheduleRows, previewPdf } from '../src/integration/preview.js';
import { verifyInbound } from '../src/integration/webhook.js';

const secret = 'integration-test-secret-long-enough-123';
function signed(target, overrides = {}) {
  return signEnvelope({ v: 1, kind: 'user', installationId: 'test-shop', actorId: 'user-a', employeeId: 1, timestamp: Date.now(), nonce: randomUUID(), method: 'GET', target, contentType: '', bodyHash: bodyHash(Buffer.alloc(0)), ...overrides }, secret);
}
test('signature binds tenant, actor, method, query, body and rejects replay', () => {
  const verify = createVerifier({ secret, installationId: 'test-shop' });
  const request = { method: 'GET', target: '/api/session', contentType: '', body: Buffer.alloc(0) };
  const token = signed(request.target);
  assert.equal(verify(token, request).actorId, 'user-a');
  assert.throws(() => verify(token, request));
  for (const overrides of [{ installationId: 'other' }, { timestamp: 1 }, { method: 'POST' }, { target: '/api/session?x=y' }, { bodyHash: bodyHash(Buffer.from('changed')) }, { employeeId: -1 }]) assert.throws(() => verify(signed(request.target, overrides), request));
});
test('service rejects browser bearer tokens, rechecks active manager, limits shop and hides UI/mock', async () => {
  let active = true;
  const app = createHorariaApp({ secret, installationId: 'test-shop', database: { employee: { findUnique: async () => ({ id: 1, activo: active, rol: 'MANAGER_LOCAL', nombre: 'Test' }) }, establishment: { findMany: async () => [{ id: 2 }] } } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = target => fetch(base + target, { headers: { 'x-aibrain-authorization': signed(target) } });
  try {
    assert.equal((await fetch(base + '/api/session', { headers: { authorization: 'Bearer arbitrary' } })).status, 401);
    assert.equal((await call('/api/session')).status, 200);
    assert.equal((await call('/api/integration/preview?semana=2026-W38&establecimiento=3')).status, 403);
    const draftTarget = '/api/integration/draft';
    const draftBody = JSON.stringify({ establecimientoId: 3, semana: '2026-W40' });
    assert.equal((await fetch(base + draftTarget, { method: 'POST', body: draftBody, headers: {
      'content-type': 'application/json',
      'x-aibrain-authorization': signed(draftTarget, { method: 'POST', contentType: 'application/json', bodyHash: bodyHash(Buffer.from(draftBody)) }),
    } })).status, 403, 'a draft cannot read or generate another manager’s shop');
    for (const path of ['collection-template', 'collection-export', 'readiness']) {
      assert.equal((await call(`/api/integration/${path}?semana=2026-W41&establecimiento=3`)).status, 403);
    }
    assert.equal((await call('/api/integration/readiness')).status, 403);
    const collectionTarget = '/api/integration/collection-preview';
    const collectionBody = JSON.stringify({ establecimientoId: 3, semana: '2026-W41', responses: [] });
    assert.equal((await fetch(base + collectionTarget, { method: 'POST', body: collectionBody, headers: {
      'content-type': 'application/json', 'x-aibrain-authorization': signed(collectionTarget, { method: 'POST', contentType: 'application/json', bodyHash: bodyHash(Buffer.from(collectionBody)) }),
    } })).status, 403);
    assert.equal((await call('/api/whatsapp/mock/config')).status, 403);
    assert.equal((await call('/horaris')).status, 404);
    active = false; assert.equal((await call('/api/session')).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('preview preserves reduced hours, absences, unassigned people and produces real PDF', () => {
  const employee = { id: 1, nombre: 'Persona', apellidos: 'Prova', horasPorTurno: 4 };
  const rows = scheduleRows([{ empleadoId: 1, empleado: employee, dia: 'LUNES', turno: 'MANANA', horaEntrada: '08:00', peticio: 'MANANA' }, { empleadoId: 1, empleado: employee, dia: 'MARTES', turno: 'LIBRE', ausencia: 'VACACIONES' }], {}, [employee, { id: 2, nombre: 'Sense torns' }]);
  assert.equal(rows[1][1], 'Mañana 08:00–12:00 *'); assert.equal(rows[1][2], 'Vacaciones'); assert.equal(rows[1][8], 4);
  assert.equal(rows[2][1], 'Sin asignar');
  assert.equal(previewPdf({ title: 'Prova', status: 'esborrany', note: 'Peticions', rows }).subarray(0, 5).toString(), '%PDF-');
});
test('incoming WhatsApp requires provider signature even with valid bridge identity', () => {
  const previous = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = 'meta-test-secret';
  const rawBody = Buffer.from('{ "object": "whatsapp_business_account" }');
  const hash = `sha256=${createHmac('sha256', process.env.META_APP_SECRET).update(rawBody).digest('hex')}`;
  assert.equal(verifyInbound({ body: {}, rawBody, get: () => hash }), true);
  assert.equal(verifyInbound({ body: {}, rawBody: Buffer.from('{}'), get: () => hash }), false);
  if (previous === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = previous;
});
