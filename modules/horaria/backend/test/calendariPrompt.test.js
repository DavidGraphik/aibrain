import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { calendariDeLaSetmana } from '../src/utils/isoWeek.js';

// ─────────────────────────────────────────────
// EL BOT NO HA D'ENDEVINAR QUIN DIA ÉS UNA DATA
//
// A la Gemma li va dir «el diumenge 31» quan el 31 d'agost de 2026 és dilluns.
// Ella el va corregir i el bot ho va acceptar, però el següent potser no — i
// llavors queda desada una preferència per al dia equivocat.
//
// La primera versió d'aquestes proves només llegia el codi font i comprovava
// que hi hagués certs textos. Amb un `+ i + 1` en comptes d'un `+ i` haurien
// passat totes quatre: el mateix error d'un dia que va causar el problema. És
// la tercera vegada aquesta setmana que escric una prova que no protegeix el
// que diu, i per això aquestes EXECUTEN la funció.
// ─────────────────────────────────────────────
const dies = (dilluns) => calendariDeLaSetmana(dilluns).map((d) => d.text);

describe('quin dia és cada data', () => {
  test('la setmana del 31 d\'agost de 2026', () => {
    // Amb apòstrof on toca: «d'agost», no «de agost». Va al prompt i el bot el
    // pot citar tal qual a un treballador.
    assert.deepEqual(dies('2026-08-31'), [
      "LUNES = 31 d'agost", 'MARTES = 1 de setembre', 'MIERCOLES = 2 de setembre',
      'JUEVES = 3 de setembre', 'VIERNES = 4 de setembre', 'SABADO = 5 de setembre',
      'DOMINGO = 6 de setembre',
    ]);
  });

  test('el dilluns és el dilluns, no el dia següent', () => {
    // L'error d'un dia és exactament el que va passar amb la Gemma.
    assert.match(dies('2026-08-31')[0], /31 d'agost$/);
    assert.match(dies('2026-01-05')[0], /5 de gener$/);
  });

  test('passa de mes i d\'any sense despentinar-se', () => {
    assert.deepEqual(dies('2026-12-28').slice(3), [
      'JUEVES = 31 de desembre', 'VIERNES = 1 de gener', 'SABADO = 2 de gener', 'DOMINGO = 3 de gener',
    ]);
  });

  test('i pels canvis d\'hora', () => {
    // L'últim diumenge d'octubre i el de març. Amb `new Date(...)` en hora
    // local, aquestes setmanes són on es perd o es guanya un dia.
    assert.match(dies('2026-10-26')[6], /1 de novembre$/);
    assert.match(dies('2026-03-30')[6], /5 d'abril$/);
  });

  test('el resultat no depèn d\'on corri el procés', () => {
    // El Render va en UTC i un portàtil no. `new Date('2026-08-31T00:00:00')`
    // es llegeix en hora local i donaria dies diferents segons la màquina.
    //
    // Cada zona en un PROCÉS a part, i no canviant `process.env.TZ` aquí: Node
    // llegeix la zona en arrencar i tocar-la després no fa res. La primera
    // versió d'aquesta prova ho feia així i passava igual amb el codi dolent —
    // una prova que no protegeix el que diu, la quarta d'aquesta setmana.
    // Es prova la cadena SENCERA —de quina setmana és a quin dia és cada
    // data— i no només la meva funció: el forat de veritat era a
    // `weekIsoRange`, que amb `toISOString()` convertia a UTC una data feta en
    // hora local i a Madrid deia que la setmana començava el 30 d'agost, que
    // és diumenge.
    const wa = new URL('../src/services/whatsapp.js', import.meta.url).href;
    const iso = new URL('../src/utils/isoWeek.js', import.meta.url).href;
    const codi = `Promise.all([import('${wa}'), import('${iso}')]).then(([w, c]) => `
      + `console.log(c.calendariDeLaSetmana(w.weekIsoRange('2026-W36').start).map((d) => d.text).join('|')))`;
    const perZona = ['UTC', 'Europe/Madrid', 'Pacific/Kiritimati', 'Pacific/Midway']
      .map((tz) => execFileSync(process.execPath, ['--input-type=module', '-e', codi],
        { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim());
    assert.equal(new Set(perZona).size, 1,
      `dona resultats diferents segons la zona horària:\n${perZona.join('\n')}`);
    assert.match(perZona[0], /^LUNES = 31 d'agost\|/);
  });

  test('sense data, res, i sense petar', () => {
    assert.deepEqual(calendariDeLaSetmana(null), []);
    assert.deepEqual(calendariDeLaSetmana('boh'), []);
  });
});

const FONT = readFileSync(new URL('../src/services/whatsapp.js', import.meta.url), 'utf8');

describe('i arriba al prompt', () => {
  test('es calcula i s\'hi endolla', () => {
    assert.match(FONT, /calendariDeLaSetmana\(weekStart\)/);
    assert.match(FONT, /QUÉ DÍA ES CADA FECHA[\s\S]{0,200}\$\{calendari\}/);
  });

  test('i se li diu que no ho dedueixi ell', () => {
    assert.match(FONT, /Nunca digas de qué día de\s*\n?\s*la semana es una fecha sin mirarla aquí/);
  });
});
