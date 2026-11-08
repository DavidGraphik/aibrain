import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nomIIdioma } from '../src/services/whatsapp.js';

// The first real broadcast failed three times over with "template name
// (recordatori_broadcast) does not exist in es". The name was right; the
// language was not, and there was one language setting for every template — so
// a single one approved in Catalan blocked the lot, one send at a time.
describe('idioma per plantilla', () => {
  test('sense sufix, l\'idioma general', () => {
    assert.deepEqual(nomIIdioma('recordatori_broadcast'), { name: 'recordatori_broadcast', language: 'es' });
  });

  test('amb sufix, el seu', () => {
    assert.deepEqual(nomIIdioma('recordatori_broadcast:ca'), { name: 'recordatori_broadcast', language: 'ca' });
    assert.deepEqual(nomIIdioma('horari_setmanal:pt_BR'), { name: 'horari_setmanal', language: 'pt_BR' });
  });

  // A Twilio Content SID is a name, never a name plus a language.
  test('un SID de Twilio no es parteix', () => {
    assert.deepEqual(nomIIdioma('HX0123456789abcdef'), { name: 'HX0123456789abcdef', language: 'es' });
  });

  // Only something shaped like a language code counts as one; a colon in the
  // name itself must not silently eat half of it.
  test('el que no té forma d\'idioma no ho és', () => {
    assert.deepEqual(nomIIdioma('nom:massallarg'), { name: 'nom:massallarg', language: 'es' });
    assert.deepEqual(nomIIdioma('nom:'), { name: 'nom:', language: 'es' });
  });

  test('buit o brossa no peta', () => {
    assert.deepEqual(nomIIdioma(''), { name: '', language: 'es' });
    assert.deepEqual(nomIIdioma(null), { name: '', language: 'es' });
    assert.deepEqual(nomIIdioma('  nom:ca  '), { name: 'nom', language: 'ca' });
  });
});
