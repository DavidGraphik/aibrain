import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { edicionsNetes, moviments } from '../src/services/edicionsNetes.js';

const fila = (o) => ({ generadoPorIa: true, empleadoId: 1, semana: '2026-W34', ...o });

describe('què va canviar de debò el responsable', () => {
  test('provar una cosa i tornar-la a deixar igual no compta', () => {
    // El cas real de la Núria a la W33: MATÍ→TARDA i TARDA→MATÍ, 7 segons.
    // Al registre de clics hi constaven dues correccions; a la graella, cap.
    const files = [fila({ dia: 'MIERCOLES', turnoIa: 'MANANA', turno: 'MANANA' })];
    assert.deepEqual(edicionsNetes(files), []);
  });

  test('un canvi que es queda, sí', () => {
    const files = [fila({ dia: 'MIERCOLES', turnoIa: 'TARDE', turno: 'MANANA' })];
    assert.equal(edicionsNetes(files).length, 1);
  });

  test('el que no ha generat la IA no és cap correcció seva', () => {
    const files = [{ generadoPorIa: false, empleadoId: 1, semana: '2026-W34', dia: 'LUNES', turnoIa: null, turno: 'MANANA' }];
    assert.deepEqual(edicionsNetes(files), []);
  });

  test('els horaris antics, sense turnoIa desat, no inventen correccions', () => {
    const files = [fila({ dia: 'LUNES', turnoIa: null, turno: 'MANANA' })];
    assert.deepEqual(edicionsNetes(files), []);
  });
});

describe('agrupar les correccions en decisions', () => {
  // El cas real de la Núria a la W34.
  test('perdre feina un dia i guanyar-ne un altre és moure la festa', () => {
    const m = moviments(edicionsNetes([
      fila({ dia: 'LUNES', turnoIa: 'MANANA', turno: 'LIBRE' }),
      fila({ dia: 'JUEVES', turnoIa: 'LIBRE', turno: 'MANANA' }),
    ]));
    assert.equal(m.length, 1, 'són una decisió, no dues');
    assert.equal(m[0].tipus, 'MOU_FESTA');
    assert.equal(m[0].de, 'JUEVES');
    assert.equal(m[0].a, 'LUNES');
    assert.equal(m[0].descripcio, 'li va moure el dia de festa de dijous a dilluns');
  });

  test('un canvi de torn sol es queda sol', () => {
    const m = moviments(edicionsNetes([fila({ dia: 'SABADO', turnoIa: 'PARTIDO', turno: 'MANANA' })]));
    assert.equal(m.length, 1);
    assert.equal(m[0].tipus, 'CANVIA_TORN');
    assert.equal(m[0].descripcio, 'el dissabte li va canviar PARTIDO per MANANA');
  });

  test('no aparella persones diferents', () => {
    const m = moviments(edicionsNetes([
      fila({ empleadoId: 1, dia: 'LUNES', turnoIa: 'MANANA', turno: 'LIBRE' }),
      fila({ empleadoId: 2, dia: 'JUEVES', turnoIa: 'LIBRE', turno: 'MANANA' }),
    ]));
    assert.equal(m.length, 2);
    assert.ok(m.every((x) => x.tipus === 'CANVIA_TORN'), 'dues persones, dues coses separades');
  });

  test('ni setmanes diferents', () => {
    const m = moviments(edicionsNetes([
      fila({ semana: '2026-W34', dia: 'LUNES', turnoIa: 'MANANA', turno: 'LIBRE' }),
      fila({ semana: '2026-W35', dia: 'JUEVES', turnoIa: 'LIBRE', turno: 'MANANA' }),
    ]));
    assert.equal(m.length, 2);
    assert.ok(m.every((x) => x.tipus === 'CANVIA_TORN'));
  });

  test('guanyar una festa sense perdre'+"'"+'n cap no és un moviment', () => {
    const m = moviments(edicionsNetes([fila({ dia: 'LUNES', turnoIa: 'MANANA', turno: 'LIBRE' })]));
    assert.equal(m[0].tipus, 'CANVIA_TORN');
  });
});
