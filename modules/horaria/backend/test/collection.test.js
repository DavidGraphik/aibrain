import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionTemplate, collectionResponsePreview, COLLECTION_DAYS } from '../src/integration/collection.js';
const people = [{ id: 4, nombre: 'Persona', apellidos: 'Prova' }, { id: 5, nombre: 'Pendent' }];
const response = (extra = {}) => ({ employeeId: 4, week: '2026-W41', days: Object.fromEntries(COLLECTION_DAYS.map(d => [d, 'MANANA'])), notes: '=HYPERLINK("unsafe")', source: 'FORMULARIO', ...extra });
test('blank collection marks all unknown, includes seven-day form and WhatsApp reply, never sends/saves', () => {
  const t = collectionTemplate('2026-W41', 3, people);
  assert.equal(t.rows[1].length, 14); assert.deepEqual(t.rows[1].slice(6, 13), Array(7).fill('SIN_INDICAR'));
  assert.deepEqual(t.formSchema.properties.days.required, COLLECTION_DAYS); assert.match(t.reply, /DOMINGO/);
  assert.equal(t.saved, false); assert.equal(t.sent, false);
});
test('preview retains notes as data, separates unknown and unverified, rejects cross-shop/week/duplicates/extra fields', () => {
  const t = collectionResponsePreview('2026-W41', 3, people, [response()]);
  assert.equal(t.rows[1][5], 'POR_REVISAR'); assert.equal(t.rows[1][13], response().notes); assert.equal(t.rows[2][5], 'PENDIENTE');
  assert.equal(t.verifiedIdentity, false);
  for (const r of [response({ employeeId: 99 }), response({ week: '2026-W42' }), response({ days: { LUNES: 'MANANA' } }), response({ admin: true }), response({ source: 'invented' })]) assert.throws(() => collectionResponsePreview('2026-W41', 3, people, [r]));
  assert.throws(() => collectionResponsePreview('2026-W41', 3, people, [response(), response()]));
  assert.throws(() => collectionTemplate('2026-W54', 3, people));
  assert.throws(() => collectionTemplate('2021-W53', 3, people));
});
