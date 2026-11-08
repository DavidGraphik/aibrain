import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.WHATSAPP_MOCK = 'true';
process.env.ANTHROPIC_API_KEY ||= 'sk-ant-fals-per-a-proves';
const { autoBroadcastHandler, autoRemindersHandler, secretOk } = await import('../src/controllers/whatsapp.js');

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}
const req = (headers = {}, query = {}) => ({ get: (h) => headers[h.toLowerCase()], query, body: {} });

const SECRET = 'secret-de-prova';
const previ = process.env.WEEKLY_REMINDER_SECRET;
after(() => {
  if (previ === undefined) delete process.env.WEEKLY_REMINDER_SECRET;
  else process.env.WEEKLY_REMINDER_SECRET = previ;
});

// Aquests dos endpoints fan sortir missatges a telèfons de debò sense que hi
// hagi ningú mirant, i el secret és tot el que els separa d'un desconegut
// engegant-los quan li vingui de gust.
//
// AQUÍ NOMÉS ES PROVEN ELS CAMINS QUE REBUTGEN, que retornen abans de tocar
// res. La primera versió d'aquest fitxer també provava el cas d'acceptar, i
// això executava l'enviament de debò contra la base de dades de producció:
// escrivia recordatoris a converses de treballadors reals i, segons quina
// setmana hi hagués desada, podia esborrar-los l'historial sencer. Cada
// `npm test` era una tirada de daus contra les dades de l'empresa.
//
// El cas d'acceptar es prova a `secretOk`, que és on viu la decisió.
describe('qui pot disparar l\'enviament automàtic', () => {
  for (const [nom, handler] of [['broadcast', autoBroadcastHandler], ['recordatoris', autoRemindersHandler]]) {
    describe(nom, () => {
      beforeEach(() => { process.env.WEEKLY_REMINDER_SECRET = SECRET; });

      test('sense secret configurat no s\'obre a tothom', async () => {
        delete process.env.WEEKLY_REMINDER_SECRET;
        const res = fakeRes();
        await handler(req(), res);
        assert.equal(res.statusCode, 503, 'un secret sense configurar no pot voler dir «endavant»');
        assert.match(res.body.error, /WEEKLY_REMINDER_SECRET/);
      });

      test('rebutja un secret incorrecte', async () => {
        const res = fakeRes();
        await handler(req({ 'x-reminder-secret': 'un-altre' }), res);
        assert.equal(res.statusCode, 403);
      });

      test('rebutja si no s\'envia cap secret', async () => {
        const res = fakeRes();
        await handler(req(), res);
        assert.equal(res.statusCode, 403);
      });
    });
  }
});

describe('la decisió de deixar entrar', () => {
  beforeEach(() => { process.env.WEEKLY_REMINDER_SECRET = SECRET; });

  test('accepta el secret per capçalera', () => {
    const res = fakeRes();
    assert.equal(secretOk(req({ 'x-reminder-secret': SECRET }), res), true);
    assert.equal(res.statusCode, 200, 'no ha de respondre res si deixa passar');
  });

  test('accepta el secret per query, com fa el cron', () => {
    assert.equal(secretOk(req({}, { secret: SECRET }), fakeRes()), true);
  });

  test('un secret buit no val, encara que coincideixi amb res', () => {
    process.env.WEEKLY_REMINDER_SECRET = '';
    const res = fakeRes();
    assert.equal(secretOk(req({}, { secret: '' }), res), false);
    assert.equal(res.statusCode, 503);
  });

  // La capçalera mana quan hi és: una capçalera dolenta NO es rescata amb una
  // query bona. És més estricte del que semblava a primera vista, i és el que
  // volem — si el cron envia la capçalera, la query no l'ha de poder salvar.
  test('la capçalera mana quan hi és, encara que sigui incorrecta', () => {
    assert.equal(secretOk(req({ 'x-reminder-secret': 'dolent' }, { secret: SECRET }), fakeRes()), false);
    assert.equal(secretOk(req({ 'x-reminder-secret': SECRET }, { secret: 'dolent' }), fakeRes()), true);
    assert.equal(secretOk(req({ 'x-reminder-secret': 'dolent' }, { secret: 'dolent' }), fakeRes()), false);
  });
});
