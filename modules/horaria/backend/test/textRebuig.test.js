import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { textRebuig } from '../src/services/whatsapp.js';

// Els «no» del xat són text fix, no els escriu el model. Anaven sempre en
// català mentre que el model sí que contesta en l'idioma de qui escriu, o sigui
// que la conversa canviava d'idioma justament al missatge que diu que no.
describe('el rebuig quan es demanen massa dies', () => {
  const dolors = 'Dolors (+34600000000)';

  test('en català', () => {
    const t = textRebuig('massaDies', 'ca', 2, dolors);
    assert.match(t, /màxim són 2 dies lliures/);
    assert.match(t, /causa major/);
    assert.ok(t.includes(dolors));
  });

  test('en castellà', () => {
    const t = textRebuig('massaDies', 'es', 2, dolors);
    assert.match(t, /máximo son 2 días libres/);
    assert.match(t, /causa mayor/);
    assert.ok(!/màxim|dies/.test(t), 'no pot barrejar les dues llengües');
  });

  test('en anglès', () => {
    assert.match(textRebuig('massaDies', 'en', 2, dolors), /maximum is 2 days off/);
  });

  test('un idioma que no tenim cau al català, no a res', () => {
    const t = textRebuig('massaDies', 'fr', 2, dolors);
    assert.match(t, /màxim són 2 dies/);
  });

  // El text ha de dir QUÈ es pot fer, no només què no.
  test('sempre diu el màxim permès i a qui acudir', () => {
    for (const idioma of ['ca', 'es', 'en']) {
      const t = textRebuig('massaDies', idioma, 2, dolors);
      assert.ok(t.includes('2'), `${idioma}: no diu quants dies`);
      assert.ok(t.includes(dolors), `${idioma}: no diu amb qui parlar`);
    }
  });

  // El motiu del canvi: mai el contracte ni les hores.
  test('cap versió parla del contracte ni de les hores', () => {
    for (const quin of ['massaDies', 'massaPocsDies']) {
      for (const idioma of ['ca', 'es', 'en']) {
        const t = quin === 'massaDies'
          ? textRebuig(quin, idioma, 2, dolors)
          : textRebuig(quin, idioma, dolors);
        assert.doesNotMatch(t, /contracte|contrato|contract|40h|hores setmanals|horas semanales/i,
          `${quin}/${idioma} torna a explicar l'aritmètica`);
      }
    }
  });
});

describe('el rebuig quan queden massa pocs dies disponibles', () => {
  const dolors = 'Dolors (+34600000000)';

  test('les tres llengües, i cap barrejada', () => {
    assert.match(textRebuig('massaPocsDies', 'ca', dolors), /no els puc registrar/);
    assert.match(textRebuig('massaPocsDies', 'es', dolors), /no los puedo registrar/);
    assert.match(textRebuig('massaPocsDies', 'en', dolors), /cannot register/);
  });
});
