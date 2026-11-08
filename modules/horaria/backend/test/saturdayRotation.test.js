import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tornsPermesos, alternancaCompleix, ultimDissabteTreballat, revisaAlternanca } from '../src/services/saturdayRotation.js';

// The rule lived only in the prompt: nothing checked it, nothing enforced it,
// and the repair passes move Saturdays around knowing nothing about it. Across
// the four weeks on record it held five times in thirteen — Roger spotted it
// before any code did.
describe('alternança dels dissabtes', () => {
  test('la regla, tal com és', () => {
    assert.deepEqual(tornsPermesos('MANANA'), ['TARDE', 'PARTIDO']);
    assert.deepEqual(tornsPermesos('PARTIDO'), ['MANANA']);
  });

  test('després d\'una TARDA només hi ha MATÍ', () => {
    // Aquesta meitat estava mal escrita a la norma de la botiga i el codi la
    // copiava: deixava fer un DIA després d'una tarda. Corregida el 20 d'agost,
    // i el que en surt és més estricte que abans.
    assert.deepEqual(tornsPermesos('TARDE'), ['MANANA']);
    assert.equal(alternancaCompleix('TARDE', 'PARTIDO'), false);
    assert.equal(alternancaCompleix('TARDE', 'MANANA'), true);
  });

  test('repetir el mateix torn la trenca', () => {
    assert.equal(alternancaCompleix('MANANA', 'MANANA'), false);
    assert.equal(alternancaCompleix('TARDE', 'TARDE'), false);
    assert.equal(alternancaCompleix('PARTIDO', 'TARDE'), false);
  });

  test('alternar-lo la compleix', () => {
    assert.equal(alternancaCompleix('MANANA', 'TARDE'), true);
    assert.equal(alternancaCompleix('MANANA', 'PARTIDO'), true);
    assert.equal(alternancaCompleix('TARDE', 'MANANA'), true);
    assert.equal(alternancaCompleix('PARTIDO', 'MANANA'), true);
  });

  // Not working is not a breach: it is simply a Saturday that does not count.
  test('un dissabte de festa no incompleix res', () => {
    assert.equal(alternancaCompleix('MANANA', 'LIBRE'), true);
    assert.equal(alternancaCompleix('MANANA', null), true);
  });

  test('sense historial, qualsevol torn val', () => {
    assert.equal(alternancaCompleix(null, 'MANANA'), true);
    assert.equal(tornsPermesos(null), null);
  });

  // The 15th of August 2026 fell on a Saturday and Girona shut: the turn is
  // carried over to the next Saturday worked, not lost.
  test('un dissabte tancat no trenca la cadena', () => {
    const historial = [
      { semana: '2026-W31', dia: 'SABADO', turno: 'TARDE' },
      { semana: '2026-W32', dia: 'SABADO', turno: 'MANANA' },
      { semana: '2026-W33', dia: 'SABADO', turno: 'LIBRE' },
    ];
    const ultim = ultimDissabteTreballat(historial, '2026-W34');
    assert.equal(ultim.semana, '2026-W32');
    assert.equal(ultim.turno, 'MANANA');
  });

  test('només mira enrere, mai endavant', () => {
    const historial = [
      { semana: '2026-W32', dia: 'SABADO', turno: 'MANANA' },
      { semana: '2026-W35', dia: 'SABADO', turno: 'TARDE' },
    ];
    assert.equal(ultimDissabteTreballat(historial, '2026-W34').semana, '2026-W32');
  });

  test('els altres dies de la setmana no hi pinten res', () => {
    const historial = [
      { semana: '2026-W33', dia: 'VIERNES', turno: 'PARTIDO' },
      { semana: '2026-W32', dia: 'SABADO', turno: 'MANANA' },
    ];
    assert.equal(ultimDissabteTreballat(historial, '2026-W34').semana, '2026-W32');
  });

  test('sense cap dissabte treballat, no hi ha res a comparar', () => {
    assert.equal(ultimDissabteTreballat([], '2026-W34'), null);
    assert.equal(ultimDissabteTreballat([{ semana: '2026-W32', dia: 'SABADO', turno: 'LIBRE' }], '2026-W34'), null);
  });

  // The five real breaches of 2026-W34, in the words the panel shows.
  test('el missatge diu d\'on ve i què tocava', () => {
    const p = revisaAlternanca({
      turnActual: 'MANANA',
      ultim: { semana: '2026-W32', turno: 'MANANA' },
    });
    assert.match(p, /2026-W32 va fer MATÍ/);
    assert.match(p, /li toca TARDA o DIA/);
    assert.match(p, /fa MATÍ/);
  });

  test('quan es compleix, no diu res', () => {
    assert.equal(revisaAlternanca({ turnActual: 'TARDE', ultim: { semana: '2026-W32', turno: 'MANANA' } }), null);
    assert.equal(revisaAlternanca({ turnActual: 'MANANA', ultim: null }), null);
  });
});
