import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { esComiat } from '../src/utils/comiats.js';

describe('reconèixer un comiat', () => {
  test('els de la conversa de la Núria del 18 d\'agost', () => {
    // Cinc missatges seguits, cinc crides a la IA i cinc WhatsApps de resposta.
    for (const t of ['De res. 👍👍👍', '😘😘😘', 'Oki, fins aviat', 'Igualment']) {
      assert.equal(esComiat(t), true, `«${t}» hauria de ser un comiat`);
    }
  });

  test('només emojis, o només signes', () => {
    assert.equal(esComiat('👍'), true);
    assert.equal(esComiat('!!!'), true);
    assert.equal(esComiat('   '), true);
  });

  test('amb accents i majúscules igual', () => {
    assert.equal(esComiat('GRÀCIES'), true);
    assert.equal(esComiat('Adéu!'), true);
    assert.equal(esComiat('Bona setmana!!'), true);
  });

  test('en castellà i en anglès també', () => {
    assert.equal(esComiat('muchas gracias'), true);
    assert.equal(esComiat('thank you'), true);
  });
});

describe('el que NO s\'ha de silenciar mai', () => {
  test('qui hi afegeix alguna cosa', () => {
    // El cas que fa mal: silenciar-lo és pitjor que contestar mil «gràcies».
    assert.equal(esComiat('ah espera, i el dijous no puc'), false);
    assert.equal(esComiat('gràcies! ah, i el dissabte millor tarda'), false);
    assert.equal(esComiat('ok pero el divendres no'), false);
  });

  test('una frase llarga no és mai un comiat', () => {
    assert.equal(esComiat('Perfecte, moltes gràcies per tot i fins la setmana vinent'), false);
  });

  test('un dia de la setmana sol, tampoc', () => {
    assert.equal(esComiat('dijous'), false);
    assert.equal(esComiat('el dimecres'), false);
  });
});

describe('«cap» i «tot» sempre reben resposta', () => {
  test('soles, i acompanyades del que sigui', () => {
    // Tres intents en aquesta funció. Deixant-les i tractant només el cas d'una
    // paraula, «cap dia» —que vol dir el mateix que «cap»— tornava a quedar
    // silenciat perquè «dia» també era a la llista. Ara no s'hi juga: si hi
    // surten, es contesta.
    for (const t of ['cap', 'tot', 'cap dia', 'cap setmana', 'cap i tot', 'tots els dies']) {
      assert.equal(esComiat(t), false, `«${t}» s'ha de contestar`);
    }
  });

  test('el preu, a la vista: la cortesia amb «cap» o «tot» també es contesta', () => {
    // Quatre cèntims per missatge. Silenciar algú costa la seva setmana.
    assert.equal(esComiat('cap problema'), false);
    assert.equal(esComiat('bon cap de setmana'), false);
    assert.equal(esComiat('tot bé'), false);
  });

  test('i la resta de comiats es continuen reconeixent', () => {
    assert.equal(esComiat('gràcies'), true);
    assert.equal(esComiat('oki, fins aviat'), true);
    assert.equal(esComiat('perfecte, moltes gràcies'), true);
  });
});
