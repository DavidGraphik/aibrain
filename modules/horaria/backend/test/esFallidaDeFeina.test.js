import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { esFallidaDeFeina } from '../src/services/whatsapp.js';

describe('quan un enviament automàtic ha de fer sonar l\'alarma', () => {
  test('tot bé: no', () => {
    assert.equal(esFallidaDeFeina({ enviats: 12, fallits: 0, botiguesAmbError: 0 }), false);
  });

  test('una botiga que peta sencera: sí', () => {
    // Codi trencat o base de dades caiguda. Sempre.
    assert.equal(esFallidaDeFeina({ enviats: 8, fallits: 0, botiguesAmbError: 1 }), true);
  });

  test('un telèfon mal escrit enmig de dotze que surten: no', () => {
    // El cas que motiva això: amb el batec cada hora, aquesta persona es
    // reintenta i falla cada hora. Si comptés, serien vint-i-quatre correus
    // d'alarma al dia per un número mal escrit, i el dia que caigués WhatsApp
    // de debò ningú no ho distingiria enmig de l'allau.
    assert.equal(esFallidaDeFeina({ enviats: 12, fallits: 1, botiguesAmbError: 0 }), false);
  });

  test('no n\'ha sortit cap i han fallat tots: sí', () => {
    // Això ja no és un número mal escrit: és WhatsApp caigut. I aquest era el
    // motiu pel qual els fallits individuals comptaven; es conserva.
    assert.equal(esFallidaDeFeina({ enviats: 0, fallits: 12, botiguesAmbError: 0 }), true);
  });

  test('no hi havia res a enviar i no ha fallat res: no', () => {
    // El cas normal del batec: 23 hores de cada 24.
    assert.equal(esFallidaDeFeina({ enviats: 0, fallits: 0, botiguesAmbError: 0 }), false);
  });
});
