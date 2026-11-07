import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyMetaSignature } from '../src/utils/verifyMetaSignature.js';

// Without this check the webhook accepts anything posted to it: the URL is not
// a secret and the path is conventional, so a stranger could impersonate the
// manager and file absences, or burn Anthropic credits one fake message at a
// time.
describe('signatura dels webhooks de Meta', () => {
  const SECRET = 'secret-de-prova';
  const cos = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));
  const firmaBona = 'sha256=' + crypto.createHmac('sha256', SECRET).update(cos).digest('hex');

  const req = (firma, raw = cos) => ({
    get: (h) => (h.toLowerCase() === 'x-hub-signature-256' ? firma : undefined),
    rawBody: raw,
  });

  before(() => { process.env.META_APP_SECRET = SECRET; });
  after(() => { delete process.env.META_APP_SECRET; });

  test('accepta una signatura vàlida', () => {
    assert.equal(verifyMetaSignature(req(firmaBona)).ok, true);
  });

  test('rebutja una signatura incorrecta', () => {
    const r = verifyMetaSignature(req('sha256=' + 'a'.repeat(64)));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_signature');
  });

  test('rebutja si no hi ha signatura', () => {
    assert.equal(verifyMetaSignature(req(undefined)).reason, 'missing_signature');
  });

  test('rebutja una signatura mal formada', () => {
    assert.equal(verifyMetaSignature(req('escombraries')).ok, false);
  });

  test('rebutja si el cos s\'ha manipulat', () => {
    const manipulat = Buffer.from(JSON.stringify({ object: 'fals' }));
    assert.equal(verifyMetaSignature(req(firmaBona, manipulat)).ok, false);
  });

  test('rebutja si falta el cos cru', () => {
    // Es construeix a mà: passar `undefined` activaria el valor per defecte del
    // paràmetre i el cos hi tornaria a ser.
    const sensecos = { get: () => firmaBona, rawBody: null };
    assert.equal(verifyMetaSignature(sensecos).reason, 'no_raw_body');
  });
});

describe('sense secret configurat', () => {
  test('no bloqueja, per no deixar mut un desplegament existent', () => {
    delete process.env.META_APP_SECRET;
    const r = verifyMetaSignature({ get: () => undefined, rawBody: Buffer.from('{}') });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'not_configured');
  });
});
