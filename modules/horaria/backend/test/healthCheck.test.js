import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// Mock mode keeps the check away from Meta and Anthropic: these tests are about
// who is allowed in and what the scheduler is told, not about the network.
process.env.WHATSAPP_MOCK = 'true';
process.env.ANTHROPIC_API_KEY ||= 'sk-ant-fals-per-a-proves';
const { healthCheckHandler } = await import('../src/controllers/whatsapp.js');

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const req = (headers = {}, query = {}) => ({
  get: (h) => headers[h.toLowerCase()],
  query,
});

const SECRET = 'secret-de-prova';
const previ = process.env.WEEKLY_REMINDER_SECRET;

describe('endpoint de comprovació de salut', () => {
  beforeEach(() => { process.env.WEEKLY_REMINDER_SECRET = SECRET; });
  after(() => {
    if (previ === undefined) delete process.env.WEEKLY_REMINDER_SECRET;
    else process.env.WEEKLY_REMINDER_SECRET = previ;
  });

  test('sense secret configurat no s\'obre a tothom', () => {
    delete process.env.WEEKLY_REMINDER_SECRET;
    const res = fakeRes();
    healthCheckHandler(req(), res);
    assert.equal(res.statusCode, 503);
  });

  test('rebutja un secret incorrecte', () => {
    const res = fakeRes();
    healthCheckHandler(req({ 'x-reminder-secret': 'un-altre' }), res);
    assert.equal(res.statusCode, 403);
  });

  test('rebutja si no s\'envia cap secret', () => {
    const res = fakeRes();
    healthCheckHandler(req(), res);
    assert.equal(res.statusCode, 403);
  });

  test('accepta el secret per capçalera', async () => {
    const res = fakeRes();
    await healthCheckHandler(req({ 'x-reminder-secret': SECRET }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.estado, 'ok');
  });

  test('accepta el secret per query, com fa el cron', async () => {
    const res = fakeRes();
    await healthCheckHandler(req({}, { secret: SECRET }), res);
    assert.equal(res.statusCode, 200);
  });

  // The whole point of the second channel: the scheduler only sends its failure
  // email on a non-2xx, so answering 200 with a "problem" body would leave the
  // WhatsApp-independent alarm silent.
  test('si tot va bé respon 200 i no avisa ningú', async () => {
    const res = fakeRes();
    await healthCheckHandler(req({ 'x-reminder-secret': SECRET }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.problemas, []);
    assert.equal(res.body.avisado, false);
  });
});
