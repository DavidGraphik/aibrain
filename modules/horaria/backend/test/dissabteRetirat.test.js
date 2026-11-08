import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ─────────────────────────────────────────────
// QUI RETIRA UN DISSABTE DEIXA RASTRE
//
// `pendentAlternanca` només guarda el torn MENTRE s'espera la resposta. Quan
// contesta es buida, i si diu que no, el fet que ho havia demanat es perd:
// només queda dins del text de la conversa.
//
// I la setmana de referència encara es pot tocar després. A l'Antònia López li
// vam dir que no li tocava dissabte matí a les 09:04 —cert amb l'horari
// d'aleshores— i a les 09:36 aquell dissabte va canviar i sí que li tocava.
// Recuperar-lo va demanar llegir-se la conversa a mà.
// ─────────────────────────────────────────────
const FONT = readFileSync(new URL('../src/services/whatsapp.js', import.meta.url), 'utf8');
const ESQUEMA = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const SCRIPT = readFileSync(new URL('./fixtures/revisaDissabtes.mjs', import.meta.url), 'utf8');

describe('el dissabte retirat es desa', () => {
  test('el camp existeix a la base de dades', () => {
    assert.match(ESQUEMA, /dissabteRetirat\s+String\?/);
  });

  test('s\'hi escriu quan diu que NO, i no quan diu que sí', () => {
    assert.match(FONT, /dissabteRetirat: esSi \? null : demanat/);
  });

  test('i es buida quan es recupera', () => {
    assert.match(SCRIPT, /pendentAlternanca: null, dissabteRetirat: null/);
  });

  test('el script el troba sol, sense haver de dir qui és', () => {
    assert.match(SCRIPT, /dissabteRetirat: \{ not: null \}/);
    assert.match(SCRIPT, /conv\?\.pendentAlternanca \|\| conv\?\.dissabteRetirat/);
  });
});

describe('«avui» no depèn de la zona horària', () => {
  test('no es fa amb toISOString', () => {
    // A Madrid, entre mitjanit i les dues, `toISOString()` diu el dia d'ahir. I
    // aquesta data va al prompt de l'assistent de l'encarregada.
    const bloc = FONT.slice(FONT.indexOf('const ara = new Date();'), FONT.indexOf('const idiomaManager'));
    assert.doesNotMatch(bloc, /toISOString/);
    assert.match(bloc, /ara\.getFullYear\(\)/);
    assert.match(bloc, /String\(ara\.getMonth\(\) \+ 1\)\.padStart\(2, '0'\)/);
  });
});
