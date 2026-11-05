import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ─────────────────────────────────────────────
// LA TRADUCCIÓ HA D'ARRIBAR FINS A LA PANTALLA
//
// Les dotze condicions estaven traduïdes i desades, i la fitxa les ensenyava
// TOTES com a «sense traduir»: el `select` que serveix la llista d'empleats no
// portava el camp. El camp existia, es desava, i pel camí no el carregava
// ningú.
//
// És el tercer cop aquesta setmana: la titlla de MAÑANA que el motor
// descartava, l'hora del descans que es perdia entre el desplegable i el
// servidor, i ara això. Cap prova mirava la cadena sencera, i un camp que es
// perd entre dues capes no el veu ni la prova del davant ni la del darrere.
// ─────────────────────────────────────────────
const llegeix = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const CONTROLADOR = llegeix('../src/controllers/employees.js');
const PANTALLA = llegeix('./fixtures/upstream-ui/pages/Employees.jsx');
const ESQUEMA = llegeix('../prisma/schema.prisma');

const tros = (font, nom) => {
  const i = font.indexOf(`export async function ${nom}(`);
  assert.ok(i > 0, `no trobo ${nom}`);
  const f = font.indexOf('\n}\n', i);
  assert.ok(f > i, `no trobo el final de ${nom}`);
  return font.slice(i, f);
};

describe('la traducció va de la base de dades a la pantalla', () => {
  test('1. el camp existeix', () => {
    assert.match(ESQUEMA, /condicionesEstructuradas Json\?/);
  });

  test('2. la llista d\'empleats el porta', () => {
    // Aquest era el forat: la pantalla llegeix la fitxa d'aquesta llista.
    assert.match(tros(CONTROLADOR, 'getAll'), /condicionesEstructuradas: true/);
  });

  test('3. i la fitxa d\'un de sol també', () => {
    assert.match(tros(CONTROLADOR, 'getOne'), /condicionesEstructuradas: true/);
  });

  test('4. la pantalla el llegeix al formulari', () => {
    assert.match(PANTALLA, /condicionesEstructuradas: emp\.condicionesEstructuradas \|\| null/);
  });

  test('5. i el torna a enviar en desar', () => {
    assert.match(tros(CONTROLADOR, 'update'), /condicionesEstructuradas !== undefined/);
  });

  test('6. validat al servidor, no només a la pantalla', () => {
    // El fa complir el motor: una forma que no entengui seria una condició que
    // el responsable creu posada i que no aplica ningú.
    assert.match(tros(CONTROLADOR, 'update'), /validaCondicions\(condicionesEstructuradas\)/);
  });

  test('l\'avís de «sense traduir» només surt quan de veritat no ho està', () => {
    assert.match(PANTALLA, /!form\.condicionesEstructuradas && !traduccio/);
  });
});
