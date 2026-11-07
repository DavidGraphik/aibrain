import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ocupacioAltresBotigues } from '../src/services/altresBotigues.js';

// El mapa desava TOTS els dies que la persona té en una altra botiga, festes
// incloses, i qui el consulta ho fa amb `if (mapa[dia])` — un objecte sempre és
// cert. Algú lliure allà constava com a ocupat aquí, i a més se li encongia
// l'objectiu d'hores, perquè `diasNoDisponibles` compta aquests dies.
const palamos = { id: 2, nombre: 'Palamós' };
const torn = (dia, turno) => ({
  empleadoId: 55, dia, turno,
  empleado: { horasPorTurno: null },
  establecimiento: palamos,
});

describe('els dies que ocupa una altra botiga', () => {
  test('un torn de matí l\'ocupa', () => {
    const m = ocupacioAltresBotigues([torn('LUNES', 'MANANA')]);
    assert.deepEqual(Object.keys(m[55].days), ['LUNES']);
    assert.equal(m[55].days.LUNES.establecimiento, 'Palamós');
  });

  // El cor de l'arreglament.
  test('una FESTA no l\'ocupa: aquell dia pot treballar aquí', () => {
    const m = ocupacioAltresBotigues([torn('MIERCOLES', 'LIBRE')]);
    assert.deepEqual(Object.keys(m[55].days), [], 'abans hi constava com a ocupada');
  });

  test('una setmana sencera: només els dies que treballa allà', () => {
    const m = ocupacioAltresBotigues([
      torn('LUNES', 'MANANA'), torn('MARTES', 'LIBRE'), torn('MIERCOLES', 'TARDE'),
      torn('JUEVES', 'LIBRE'), torn('VIERNES', 'PARTIDO'), torn('SABADO', 'LIBRE'),
    ]);
    assert.deepEqual(Object.keys(m[55].days).sort(), ['LUNES', 'MIERCOLES', 'VIERNES']);
  });

  test('les hores sí que es compten totes, i una FESTA en suma zero', () => {
    const m = ocupacioAltresBotigues([
      torn('LUNES', 'MANANA'),      // 7h
      torn('MARTES', 'LIBRE'),      // 0h
      torn('MIERCOLES', 'TARDE'),   // 6h
    ]);
    assert.equal(m[55].hours, 13);
  });

  test('la jornada reduïda es paga al seu preu', () => {
    const reduida = { ...torn('LUNES', 'MANANA'), empleado: { horasPorTurno: 4 } };
    assert.equal(ocupacioAltresBotigues([reduida])[55].hours, 4);
  });

  test('dues persones no es barregen', () => {
    const m = ocupacioAltresBotigues([
      torn('LUNES', 'MANANA'),
      { ...torn('LUNES', 'TARDE'), empleadoId: 66 },
    ]);
    assert.deepEqual(Object.keys(m[55].days), ['LUNES']);
    assert.deepEqual(Object.keys(m[66].days), ['LUNES']);
    assert.equal(m[55].days.LUNES.turno, 'MANANA');
    assert.equal(m[66].days.LUNES.turno, 'TARDE');
  });

  test('sense res, un mapa buit i no peta', () => {
    assert.deepEqual(ocupacioAltresBotigues([]), {});
    assert.deepEqual(ocupacioAltresBotigues(null), {});
  });

  // Una persona que a l'altra botiga només té festes ha d'existir al mapa amb
  // zero dies: qui el consulta fa `mapa[id]?.days`, i el que importa és que cap
  // dia hi consti.
  test('qui allà només té festes, no queda ocupat cap dia', () => {
    const m = ocupacioAltresBotigues([torn('LUNES', 'LIBRE'), torn('MARTES', 'LIBRE')]);
    assert.deepEqual(Object.keys(m[55].days), []);
    assert.equal(m[55].hours, 0);
  });
});
