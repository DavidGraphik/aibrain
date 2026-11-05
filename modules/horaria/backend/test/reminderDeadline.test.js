import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { templateDeadlineMatches } from '../src/integration/meta-templates.js';

process.env.WHATSAPP_MOCK = 'false';
process.env.WHATSAPP_PROVIDER = 'meta';
process.env.WHATSAPP_TOKEN = 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-number';
process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = '1234';
process.env.WHATSAPP_TEMPLATE_REMINDER = 'reminder:ca';
process.env.HORARIA_ALLOW_DELIVERY = '1';
const { prisma } = await import('../src/services/prisma.js');
const { sendReminders } = await import('../src/services/whatsapp.js');

let deadline, sent, written, templateBody;
const restorers = [];
function stub(target, key, fn) {
  const previous = target[key]; target[key] = fn;
  restorers.push(() => { target[key] = previous; });
}
beforeEach(() => {
  deadline = '2026-10-09T11:00:00Z'; sent = []; written = [];
  templateBody = 'Hola {{1}}, setmana {{2}}. El termini finalitza demà, {{3}}, a les {{4}}.';
  stub(prisma.employee, 'findMany', async ({ where }) => {
    assert.deepEqual(where.AND[1], { id: { in: [9] } });
    assert.equal(where.AND[0].OR[0].establecimientoId, 3);
    return [{ id: 9, nombre: 'Test', telefonoWhatsapp: '+34600000000' }];
  });
  stub(prisma.whatsappConversation, 'findMany', async () => [{ id: 20, telefono: '+34600000000', estado: 'EN_PROGRESO', fechaLimite: deadline }]);
  stub(prisma.whatsappMessage, 'create', async data => { written.push(data); });
  stub(prisma.whatsappConversation, 'update', async data => { written.push(data); });
  mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('/message_templates?')) return new Response(JSON.stringify({ data: [{ name: 'reminder', language: 'ca', status: 'APPROVED', components: [{ type: 'BODY', text: templateBody }] }] }));
    assert.equal(String(url), 'https://graph.facebook.com/v23.0/test-number/messages');
    sent.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ messages: [{ id: 'test-only' }] }));
  });
});
afterEach(() => { restorers.splice(0).reverse().forEach(restore => restore()); mock.restoreAll(); });

test('tomorrow reminder sends the actual date/time only to the selected employee', async () => {
  const result = await sendReminders(3, '2026-W42', { employeeIds: [9], ara: new Date('2026-10-08T10:00:00Z') });
  assert.equal(result.recordatoriosEnviados, 1);
  assert.equal(sent.length, 1); assert.equal(written.length, 2);
  assert.equal(sent[0].template.language.code, 'ca');
  assert.equal(sent[0].template.components[0].parameters[3].text, '13:00');
});
test('today and day-after-tomorrow deadlines never send a false tomorrow reminder or mark it sent', async () => {
  for (const value of ['2026-10-08T11:00:00Z', '2026-10-10T11:00:00Z']) {
    deadline = value;
    const result = await sendReminders(3, '2026-W42', { employeeIds: [9], ara: new Date('2026-10-08T10:00:00Z') });
    assert.equal(result.recordatoriosEnviados, 0);
    assert.deepEqual(result.saltats, [{ empleadoId: 9, nombre: 'Test', motiu: 'termini_no_es_dema' }]);
  }
  assert.equal(sent.length, 0); assert.equal(written.length, 0);
});
test('a date-only reminder can still be sent on deadline day', async () => {
  templateBody = 'Hola {{1}}, setmana {{2}}. El termini finalitza el {{3}} a les {{4}}.';
  deadline = '2026-10-08T11:00:00Z';
  const result = await sendReminders(3, '2026-W42', { employeeIds: [9], ara: new Date('2026-10-08T10:00:00Z') });
  assert.equal(result.recordatoriosEnviados, 1);
});
test('Madrid calendar comparison handles midnight, both DST changes and invalid deadlines', () => {
  const template = { relativeDeadline: 'tomorrow' };
  assert.equal(templateDeadlineMatches(template, '2026-03-29T11:00:00Z', '2026-03-28T12:00:00Z'), true);
  assert.equal(templateDeadlineMatches(template, '2026-10-25T12:00:00Z', '2026-10-24T11:00:00Z'), true);
  assert.equal(templateDeadlineMatches(template, '2026-10-09T11:00:00Z', '2026-10-08T22:30:00Z'), false);
  assert.equal(templateDeadlineMatches(template, 'invalid'), false);
});
test('relative deadline follows the installation timezone instead of a fixed source timezone', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal(templateDeadlineMatches({ relativeDeadline: 'tomorrow' }, '2026-10-09T12:00:00Z', '2026-10-09T01:00:00Z'), true);
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});
