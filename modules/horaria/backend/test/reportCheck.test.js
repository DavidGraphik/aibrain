import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { claimsFalsos, revisaInforme } from '../src/services/reportCheck.js';

// The sentence this exists for, word for word from the 2026-W33 report:
// "Nuria Bachs té LIBRE el dimecres; Jordi fa TARDE aquell dia." She worked
// five mornings. The model needed a reason for an afternoon that broke Jordi's
// condition and wrote one, and it read like every other line in the report.
const EMPLEATS = [
  { id: 108, nombre: 'Nuria ', apellidos: 'Bachs' },
  { id: 98, nombre: 'Jordi', apellidos: 'Defaus' },
];

const setmana = (nuriaDimecres) => [
  { empleadoId: 108, dia: 'LUNES', turno: 'MANANA' },
  { empleadoId: 108, dia: 'MIERCOLES', turno: nuriaDimecres },
  { empleadoId: 98, dia: 'MIERCOLES', turno: 'TARDE' },
];

describe('comprovar l\'informe contra l\'horari', () => {
  test('el cas real: diu que té festa i fa matí', () => {
    const f = claimsFalsos('Nuria Bachs té LIBRE el dimecres; Jordi fa TARDE aquell dia.',
      setmana('MANANA'), EMPLEATS);
    assert.equal(f.length, 1);
    assert.equal(f[0].dia, 'MIERCOLES');
    assert.equal(f[0].real, 'MANANA');
    assert.equal(f[0].empleadoId, 108);
  });

  test('si de debò té festa, no hi ha res a dir', () => {
    assert.deepEqual(
      claimsFalsos('Nuria Bachs té LIBRE el dimecres.', setmana('LIBRE'), EMPLEATS),
      []
    );
  });

  test('ho enxampa en castellà i amb "festa"', () => {
    assert.equal(claimsFalsos('Nuria Bachs tiene fiesta el miércoles.', setmana('MANANA'), EMPLEATS).length, 1);
    assert.equal(claimsFalsos('Nuria Bachs té festa el dimecres.', setmana('MANANA'), EMPLEATS).length, 1);
  });

  // Inventing a warning is the same sin in the other direction.
  test('un nom que no és de la setmana no genera avís', () => {
    assert.deepEqual(claimsFalsos('Marta Puig té LIBRE el dimecres.', setmana('MANANA'), EMPLEATS), []);
  });

  test('un dia sense torn desat no s\'inventa res', () => {
    assert.deepEqual(claimsFalsos('Nuria Bachs té LIBRE el dijous.', setmana('MANANA'), EMPLEATS), []);
  });

  test('text buit o sense afirmacions', () => {
    assert.deepEqual(claimsFalsos(null, setmana('MANANA'), EMPLEATS), []);
    assert.deepEqual(claimsFalsos('S\'ha respectat la cobertura.', setmana('MANANA'), EMPLEATS), []);
  });

  test('l\'afirmació es queda, amb la veritat enganxada al costat', () => {
    const { canvis, avisos } = revisaInforme(
      [{ empleadoId: 98, cambio: 'MIERCOLES TARDE', motivo: 'Nuria Bachs té LIBRE el dimecres; Jordi fa TARDE aquell dia.' }],
      setmana('MANANA'), EMPLEATS
    );
    assert.equal(avisos.length, 1);
    assert.match(canvis[0].motivo, /Nuria Bachs té LIBRE el dimecres/);      // no s'esborra
    assert.match(canvis[0].motivo, /⚠ Comprovat contra l'horari/);
    assert.match(canvis[0].motivo, /no té festa el miercoles \(fa MANANA\)/);
  });

  test('un informe correcte passa sense tocar-lo', () => {
    const original = [{ empleadoId: 98, motivo: 'Nuria Bachs té LIBRE el dimecres.' }];
    const { canvis, avisos } = revisaInforme(original, setmana('LIBRE'), EMPLEATS);
    assert.deepEqual(avisos, []);
    assert.deepEqual(canvis, original);
  });

  test('un informe buit no peta', () => {
    assert.deepEqual(revisaInforme(null, setmana('MANANA'), EMPLEATS), { canvis: [], avisos: [] });
    assert.deepEqual(revisaInforme([], [], []), { canvis: [], avisos: [] });
  });
});
