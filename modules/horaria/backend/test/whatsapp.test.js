import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// El mòdul construeix clients de Prisma i Anthropic en carregar-se; amb valors
// falsos n'hi ha prou, perquè aquestes proves no toquen ni base de dades ni IA.
process.env.WHATSAPP_MOCK = 'true';
process.env.ANTHROPIC_API_KEY ||= 'sk-ant-fals-per-a-proves';
const { detectIdioma, extractPreferences } = await import('../src/services/whatsapp.js');

// Asking the model to infer the language did not work: the broadcast that opens
// every conversation is Catalan and sits in the history as an assistant turn,
// which anchored every reply to Catalan even when the employee wrote Spanish.
describe('detecció d\'idioma', () => {
  const casos = [
    ['ca', 'No podria treballar el dimarts i necessito dimecres tarda'],
    ['ca', 'el dijous només puc al matí'],
    ['ca', 'pots apuntar que la rosa estarà de baixa tota la setmana que ve'],
    ['es', 'hola, puedes apuntar que rosa rivera estara de baja toda la semana que viene'],
    ['es', 'No puedo trabajar el martes, y el miércoles solo por la tarde'],
    ['es', 'el jueves solo puedo por la mañana'],
    ['en', "I can't work on Tuesday, Wednesday afternoon only please"],
  ];

  for (const [esperat, text] of casos) {
    test(`${esperat} · "${text.slice(0, 42)}…"`, () => {
      assert.equal(detectIdioma(text), esperat);
    });
  }

  test('sense text distintiu, per defecte català', () => {
    assert.equal(detectIdioma(''), 'ca');
    assert.equal(detectIdioma('Si'), 'ca');
  });

  test('mira el conjunt de missatges de l\'empleat', () => {
    assert.equal(detectIdioma(['hola', 'no puedo el lunes ni el viernes, gracias']), 'es');
    assert.equal(detectIdioma(['hola', 'no puc dilluns ni divendres, gràcies']), 'ca');
  });
});

// The marker is a literal label the model appends after its message. Matching
// the exact Spanish string was too brittle: told firmly to answer in Catalan it
// translated the label too, so the preferences were lost AND the raw JSON went
// out to the employee as part of the WhatsApp message.
describe('extracció de preferències', () => {
  test('recupera el JSON encara que l\'etiqueta estigui traduïda', () => {
    const missatge = 'Perfecte. Gràcies.\n\nPREFERÈNCIES_JSON:{"diasNoDisponible":["MARTES"],"turnosPorDia":{"LUNES":"MANANA"},"completo":true}';
    const { prefs, reply } = extractPreferences(missatge);
    assert.deepEqual(prefs.diasNoDisponible, ['MARTES']);
    assert.deepEqual(prefs.turnosPorDia, { LUNES: 'MANANA' });
    assert.ok(!reply.includes('_JSON'), 'mai s\'ha d\'enviar el JSON a l\'empleat');
    assert.ok(!reply.includes('{'), 'mai s\'ha d\'enviar el JSON a l\'empleat');
  });

  test('funciona amb l\'etiqueta en castellà', () => {
    const { prefs, reply } = extractPreferences('Listo.\n\nPREFERENCIAS_JSON:{"completo":true}');
    assert.equal(prefs.completo, true);
    assert.equal(reply, 'Listo.');
  });

  test('funciona amb l\'etiqueta en anglès', () => {
    const { prefs } = extractPreferences('Done.\n\nPREFERENCES_JSON:{"completo":true}');
    assert.equal(prefs.completo, true);
  });

  test('troba l\'objecte encara que no hi hagi etiqueta', () => {
    const { prefs, reply } = extractPreferences('Fet.\n{"diasNoDisponible":["LUNES"],"completo":true}');
    assert.deepEqual(prefs.diasNoDisponible, ['LUNES']);
    assert.ok(!reply.includes('{'));
  });

  test('un missatge normal es deixa intacte', () => {
    const text = 'Quins dies no pots treballar?';
    const { prefs, reply } = extractPreferences(text);
    assert.deepEqual(prefs, {});
    assert.equal(reply, text);
  });

  test('text després del JSON no trenca l\'anàlisi', () => {
    const { prefs, reply } = extractPreferences('Hola.\nPREFERENCIAS_JSON:{"completo":true}\nGràcies!');
    assert.equal(prefs.completo, true);
    assert.ok(!reply.includes('completo'));
  });
});
