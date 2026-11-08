import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadinessHandler } from '../src/integration/readiness.js';

function fixture() {
  const approved = { posada: true, providerStatus: 'APPROVED', fieldsMatch: true };
  const config = { deliveryEnabled: true, proveidor: 'meta', providerApprovalVerified: true, automaticEnabled: false,
    credencials: { WHATSAPP_TOKEN: true, WHATSAPP_PHONE_NUMBER_ID: true, META_APP_SECRET: true },
    plantilles: { WHATSAPP_TEMPLATE_BROADCAST: { ...approved }, WHATSAPP_TEMPLATE_REMINDER: { ...approved }, WHATSAPP_TEMPLATE_HORARIO: { ...approved } } };
  const shop = { id: 3, nombre: 'Shop', activo: true, managerLocal: null };
  const employees = [{ id: 9, nombre: 'Test', apellidos: 'Employee', telefonoWhatsapp: null }];
  const settings = { enviamentAutomatic: false, whatsappObreDia: 2, whatsappObreHora: 9, whatsappTancaDia: 4, whatsappTancaHora: 13 };
  const database = {
    establishment: { findUnique: async ({ where }) => { assert.equal(where.id, 3); return shop; } },
    employee: { findMany: async ({ where }) => {
      assert.deepEqual(where, { activo: true, OR: [{ establecimientoId: 3 }, { establecimientosPermitidos: { some: { establishmentId: 3 } } }] });
      return employees;
    } },
  };
  const handler = createReadinessHandler({ database, readSettings: async id => { assert.equal(id, 3); return settings; }, readConfiguration: async () => config, now: () => new Date('2026-10-08T10:00:00Z') });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  return { config, shop, employees, settings, res, call: (id = '3') => handler({ query: { establecimiento: id } }, res) };
}

test('per-shop readiness exposes missing contacts, both automation gates and the exact window', async () => {
  const f = fixture(); await f.call();
  assert.deepEqual(f.res.body.collection.blockers, ['EMPLOYEE_PHONES_MISSING']);
  assert.deepEqual(f.res.body.automaticCollection.blockers, ['EMPLOYEE_PHONES_MISSING', 'AUTOMATIC_DISABLED', 'SHOP_AUTOMATIC_DISABLED']);
  assert.deepEqual(f.res.body.pdfDelivery.blockers, ['MANAGER_NOT_ASSIGNED']);
  assert.deepEqual(f.res.body.employees.missingPhone, [{ id: 9, name: 'Test Employee' }]);
  assert.deepEqual(f.res.body.collectionWindow, { week: '2026-W42', opensAt: '2026-10-06T07:00:00.000Z', closesAt: '2026-10-08T11:00:00.000Z', timeZone: 'Europe/Madrid' });
});
test('ready configuration never claims real delivery or Excel return acceptance and omits phone numbers', async () => {
  const f = fixture(); f.employees[0].telefonoWhatsapp = '+34600000000';
  f.shop.managerLocal = { ...f.employees[0], activo: true };
  f.settings.enviamentAutomatic = true; f.config.automaticEnabled = true;
  await f.call();
  for (const stage of ['collection', 'automaticCollection', 'pdfDelivery']) assert.equal(f.res.body[stage].configurationReady, true);
  assert.equal(f.res.body.acceptance.inboundReply, 'not_checked');
  assert.equal(f.res.body.acceptance.reviewedExcelRedistribution, 'requires_reviewed_workbook');
  assert.equal(JSON.stringify(f.res.body).includes('+34600000000'), false);
});
test('pending or mismatched templates, disabled delivery and inactive manager remain blocked', async () => {
  const f = fixture(); f.config.deliveryEnabled = false; f.config.providerApprovalVerified = false;
  f.config.plantilles.WHATSAPP_TEMPLATE_REMINDER.providerStatus = 'PENDING';
  f.config.plantilles.WHATSAPP_TEMPLATE_HORARIO.fieldsMatch = false;
  f.shop.managerLocal = { ...f.employees[0], activo: false };
  await f.call();
  assert.ok(f.res.body.collection.blockers.includes('DELIVERY_DISABLED'));
  assert.ok(f.res.body.collection.blockers.includes('PROVIDER_NOT_VERIFIED'));
  assert.ok(f.res.body.collection.blockers.includes('WHATSAPP_TEMPLATE_REMINDER_NOT_READY'));
  assert.ok(f.res.body.pdfDelivery.blockers.includes('WHATSAPP_TEMPLATE_HORARIO_NOT_READY'));
  assert.ok(f.res.body.pdfDelivery.blockers.includes('MANAGER_INACTIVE'));
  assert.ok(f.res.body.pdfDelivery.blockers.includes('MANAGER_PHONE_MISSING'));
});
test('readiness rejects missing, duplicate and malformed shop identifiers before data access', async () => {
  for (const id of ['', null, '0', '3x', ['3', '4']]) {
    const f = fixture(); await f.call(id); assert.equal(f.res.statusCode, 400);
  }
});
