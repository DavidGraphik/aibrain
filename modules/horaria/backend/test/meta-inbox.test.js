import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MetaInbox, metaMessages } from '../src/integration/meta-inbox.js';
const identity = { installationId: 'arnall-test', actorId: 'owner', employeeId: 7 };
const message = id => ({ id, from: '34600000000', type: 'text', text: { body: 'test' } });
const payload = messages => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'phone-1' }, messages } }] }] });
const binding = { wabaId: 'waba-1', phoneId: 'phone-1' };
const setup = options => {
  const root = mkdtempSync(path.join(tmpdir(), 'meta-inbox-'));
  return { root, create: overrides => new MetaInbox({ root, installationId: identity.installationId, authorize: async () => {}, processMessage: async () => {}, ...options, ...overrides }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
};
test('validates all batch entries against the expected WABA and phone before admission', () => {
  const body = payload([message('one'), message('two')]);
  body.entry[0].changes.push({ field: 'message_template_status_update', value: { event: 'APPROVED' } });
  body.entry[0].changes.push({ field: 'messages', value: { metadata: { phone_number_id: 'phone-1' }, statuses: [{ id: 'outgoing', status: 'delivered' }] } });
  assert.equal(metaMessages(body, binding).length, 2);
  assert.throws(() => metaMessages(body, { ...binding, wabaId: 'other' }));
  assert.throws(() => metaMessages(body, { ...binding, phoneId: 'other' }));
  assert.throws(() => metaMessages(body, { phoneId: 'phone-1' }));
  body.entry.push({ id: 'foreign', changes: [] }); assert.throws(() => metaMessages(body, binding));
});
test('persists before effects, preserves order and deduplicates across restart', async () => {
  const processed = [], t = setup({ processMessage: async m => { processed.push(m.id); } });
  try {
    const inbox = t.create(); inbox.enqueue([message('z'), message('a'), message('z')], identity);
    assert.equal(inbox.names().length, 2); assert.equal(inbox.read(inbox.names()[0]).status, 'queued');
    assert.equal(statSync(path.join(inbox.root, inbox.names()[0])).mode & 0o777, 0o600);
    await inbox.kick(); assert.deepEqual(processed, ['z', 'a']);
    for (const name of inbox.names()) assert.equal(inbox.read(name).message, undefined);
    await inbox.stop(); const resumed = t.create(); resumed.enqueue([message('a')], identity); await resumed.kick();
    assert.deepEqual(processed, ['z', 'a']); assert.deepEqual(resumed.summary(), { completed: 2 });
  } finally { t.cleanup(); }
});
test('resumes queued work but fences interrupted or failed effects as uncertain', async () => {
  const processed = [], t = setup({ processMessage: async m => { processed.push(m.id); if (m.id === 'fails') throw new Error('unavailable'); } });
  try {
    const inbox = t.create(); inbox.enqueue([message('interrupted'), message('pending')], identity);
    inbox.stopped = true; await inbox.kick();
    const name = createHash('sha256').update('interrupted').digest('hex') + '.json';
    inbox.write(name, { ...inbox.read(name), status: 'processing' });
    const resumed = t.create(); await resumed.kick(); assert.deepEqual(processed, ['pending']);
    resumed.enqueue([message('interrupted'), message('fails')], identity); await resumed.kick();
    assert.deepEqual(processed, ['pending', 'fails']); assert.deepEqual(resumed.summary(), { uncertain: 2, completed: 1 });
  } finally { t.cleanup(); }
});
test('rechecks revoked authority and rejects foreign identities and capacity overflow', async () => {
  let processed = 0; const t = setup({ authorize: async () => { throw new Error('revoked'); }, processMessage: async () => { processed++; }, maxRecords: 1 });
  try {
    const inbox = t.create();
    assert.throws(() => inbox.enqueue([message('foreign')], { ...identity, installationId: 'other' }));
    assert.throws(() => inbox.enqueue([message('a'), message('b')], identity)); assert.equal(inbox.names().length, 0);
    inbox.enqueue([message('blocked')], identity); await inbox.kick(); assert.equal(processed, 0); assert.deepEqual(inbox.summary(), { blocked: 1 });
  } finally { t.cleanup(); }
});
test('refuses foreign persistent state', async () => {
  const t = setup();
  try {
    const inbox = t.create(); inbox.enqueue([message('saved')], identity); inbox.stopped = true; await inbox.kick();
    const file = path.join(inbox.root, inbox.names()[0]), record = JSON.parse(readFileSync(file, 'utf8'));
    record.installationId = 'other'; writeFileSync(file, JSON.stringify(record)); assert.throws(() => t.create());
  } finally { t.cleanup(); }
});
