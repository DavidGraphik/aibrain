import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMetaTemplates, requireApprovedTemplate, selectedRecipients, verifySelectedRecipients } from '../src/integration/meta-templates.js';
import { deadlineParts, informaLaResponsable, sendWeeklyBroadcastReminder } from '../src/services/whatsapp.js';

test('only the approved exact language and matching document/body fields admit delivery', () => {
  const templates = [
    { name: 'initial', language: 'ca', status: 'APPROVED', bodyParameters: 3, headerFormat: null },
    { name: 'reminder', language: 'ca', status: 'PENDING', bodyParameters: 4, headerFormat: null },
    { name: 'schedule', language: 'ca', status: 'APPROVED', bodyParameters: 3, headerFormat: null },
  ];
  assert.equal(requireApprovedTemplate(templates, 'initial', 'ca', [3, 4]).bodyParameters, 3);
  assert.throws(() => requireApprovedTemplate(templates, 'initial', 'es', [3]), /aprovada/);
  assert.throws(() => requireApprovedTemplate(templates, 'reminder', 'ca', [2, 4]), /aprovada/);
  assert.throws(() => requireApprovedTemplate(templates, 'initial', 'ca', [2]), /camps/);
  assert.throws(() => requireApprovedTemplate(templates, 'schedule', 'ca', [3], true), /DOCUMENT/);
  templates[2].headerFormat = 'DOCUMENT';
  assert.equal(requireApprovedTemplate(templates, 'schedule', 'ca', [3], true).name, 'schedule');
});

test('limited test recipients keep the shop/active/phone predicate and fail closed on any unmatched ID', () => {
  const eligible = { activo: true, telefonoWhatsapp: { not: null }, OR: [{ establecimientoId: 1 }] };
  assert.deepEqual(selectedRecipients(eligible, [9]), { AND: [eligible, { id: { in: [9] } }] });
  assert.equal(selectedRecipients(eligible, undefined), eligible);
  for (const ids of [[], [9, 9], [0], ['9']]) assert.throws(() => selectedRecipients(eligible, ids));
  assert.doesNotThrow(() => verifySelectedRecipients([{ id: 9 }], [9]));
  assert.throws(() => verifySelectedRecipients([{ id: 9 }], [9, 10]), /No s’ha enviat/);
  assert.throws(() => verifySelectedRecipients([{ id: 10 }], [9]), /No s’ha enviat/);
});

test('reads provider schemas without returning credentials or unverified partial catalogues', async () => {
  const originalFetch = globalThis.fetch, before = { id: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID, token: process.env.WHATSAPP_TOKEN };
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = '1234'; process.env.WHATSAPP_TOKEN = 'test-only';
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ name: 'reminder', language: 'ca', status: 'PENDING', components: [{ type: 'BODY', text: '{{1}} {{2}} {{3}} {{4}}' }] }] }));
    assert.deepEqual(await readMetaTemplates(), [{ name: 'reminder', language: 'ca', status: 'PENDING', bodyParameters: 4, headerFormat: null }]);
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [], paging: { next: 'https://example.test/?access_token=secret' } }));
    await assert.rejects(readMetaTemplates(), /completament/);
    globalThis.fetch = async () => new Response('secret', { status: 403 });
    await assert.rejects(readMetaTemplates(), /\(403\)/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [['WHATSAPP_BUSINESS_ACCOUNT_ID', before.id], ['WHATSAPP_TOKEN', before.token]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('deadline variables retain Madrid local date/time through winter and summer', () => {
  assert.equal(deadlineParts('2026-10-08T11:00:00Z').time, '13:00');
  assert.equal(deadlineParts('2026-12-03T12:00:00Z').time, '13:00');
  assert.throws(() => deadlineParts('invalid'));
});

test('explicitly disabled manager notifications perform no database or outbound action', async () => {
  const before = process.env.HORARIA_MANAGER_NOTIFICATIONS;
  process.env.HORARIA_MANAGER_NOTIFICATIONS = '0';
  try {
    assert.equal(await informaLaResponsable('Do not send'), false);
    assert.deepEqual(await sendWeeklyBroadcastReminder(), { avisado: false, motivo: 'desactivado' });
  } finally { if (before === undefined) delete process.env.HORARIA_MANAGER_NOTIFICATIONS; else process.env.HORARIA_MANAGER_NOTIFICATIONS = before; }
});
