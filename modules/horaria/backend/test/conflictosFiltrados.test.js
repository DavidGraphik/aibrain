import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { filtrarConflictosDeDiasCerrados, filtrarConflictosYaResueltos } from '../src/services/aiScheduler.js';
import { parseConditions } from '../src/services/conditionCheck.js';

// The panel showed: "La botiga tanca dissabte i diumenge: la cobertura de
// dissabte (7 dependentes matí…) no es pot complir perquè tots els empleats fan
// LIBRE." On a closed day everybody is LIBRE by definition, so that describes
// the closure itself and nothing a manager can act on. The prompt already
// forbade it; the model wrote it anyway.
describe('conflictes de dies tancats', () => {
  const TANCATS = ['SABADO', 'DOMINGO'];

  test('treu el que només parla d\'un dia tancat', () => {
    const fora = filtrarConflictosDeDiasCerrados([
      'La cobertura de dissabte no es pot complir perquè tots els empleats fan LIBRE.',
    ], TANCATS);
    assert.deepEqual(fora, []);
  });

  test('en castellà també', () => {
    assert.deepEqual(filtrarConflictosDeDiasCerrados([
      'El sábado faltan dependientas en turno mañana.',
    ], TANCATS), []);
  });

  test('manté els conflictes de dies oberts', () => {
    const dins = ['LUNES: faltan dependientas en turno tarde (3/4)'];
    assert.deepEqual(filtrarConflictosDeDiasCerrados(dins, TANCATS), dins);
  });

  test('manté un conflicte que barreja un dia obert i un de tancat', () => {
    // Half of it is still actionable, so dropping the whole line would hide it.
    const dins = ['Entre dijous i dissabte no s\'arriba al mínim d\'elaboració.'];
    assert.deepEqual(filtrarConflictosDeDiasCerrados(dins, TANCATS), dins);
  });

  test('manté el que no parla de cap dia', () => {
    const dins = ['No hi ha prou personal d\'elaboració aquesta setmana.'];
    assert.deepEqual(filtrarConflictosDeDiasCerrados(dins, TANCATS), dins);
  });

  test('sense dies tancats no toca res', () => {
    const tots = ['La cobertura de dissabte no es pot complir.'];
    assert.deepEqual(filtrarConflictosDeDiasCerrados(tots, []), tots);
    assert.deepEqual(filtrarConflictosDeDiasCerrados(tots, null), tots);
  });

  test('una llista buida o absent no peta', () => {
    assert.deepEqual(filtrarConflictosDeDiasCerrados([], TANCATS), []);
    assert.deepEqual(filtrarConflictosDeDiasCerrados(null, TANCATS), []);
  });

  test('distingeix dimarts de dimecres', () => {
    // The day names overlap heavily in both languages; a sloppy match would
    // treat every weekday as the same day.
    const dins = ['Dimecres falta gent a la tarda.'];
    assert.deepEqual(filtrarConflictosDeDiasCerrados(dins, ['MARTES']), dins);
    assert.deepEqual(filtrarConflictosDeDiasCerrados(dins, ['MIERCOLES']), []);
  });
});

// The model writes its conflict list about the draft it produced. The
// deterministic passes then run and fix things, and the prose stays behind:
// it reported that Albert Triano had only one split shift when by the time
// anybody read it he had two.
describe('conflictes que les passades ja han resolt', () => {
  const DIES = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'];
  const albert = {
    id: 87, nombre: 'Albert', apellidos: 'Triano',
    condicionesFijas: 'Fa 2 torns PARTIDO per setmana, que NO poden ser en dies consecutius. La resta de dies sempre MATÍ.',
  };
  albert.condParsed = parseConditions(albert.condicionesFijas);
  const setmana = (...t) => DIES.map((dia, i) => ({ dia, turno: t[i] || 'LIBRE' }));
  const QUEIXA = ['Albert Triano tiene condición fija de 2 turnos PARTIDO; solo se le ha podido asignar 1.'];

  test('el treu quan la persona compleix de debò', () => {
    const horario = [{ empleadoId: 87, dias: setmana('PARTIDO', 'MANANA', 'PARTIDO', 'MANANA', 'MANANA') }];
    assert.deepEqual(filtrarConflictosYaResueltos(QUEIXA, horario, [albert], DIES), []);
  });

  test('el manté quan el problema encara hi és', () => {
    const horario = [{ empleadoId: 87, dias: setmana('PARTIDO', 'MANANA', 'MANANA', 'MANANA', 'MANANA') }];
    assert.deepEqual(filtrarConflictosYaResueltos(QUEIXA, horario, [albert], DIES), QUEIXA);
  });

  test('no toca el que no anomena ningú', () => {
    const general = ['Falta personal d\'elaboració aquesta setmana.'];
    const horario = [{ empleadoId: 87, dias: setmana('PARTIDO', 'MANANA', 'PARTIDO', 'MANANA', 'MANANA') }];
    assert.deepEqual(filtrarConflictosYaResueltos(general, horario, [albert], DIES), general);
  });

  test('si en menciona dos i un encara falla, es manté', () => {
    const eva = {
      id: 91, nombre: 'Eva', apellidos: 'Mademont',
      condicionesFijas: 'Reparteix la seva setmana en 3 MATINS i 3 TARDES.',
    };
    eva.condParsed = parseConditions(eva.condicionesFijas);
    const queixa = ['Albert Triano i Eva Mademont no han quedat com tocava.'];
    const horario = [
      { empleadoId: 87, dias: setmana('PARTIDO', 'MANANA', 'PARTIDO', 'MANANA', 'MANANA') },
      { empleadoId: 91, dias: setmana('TARDE', 'TARDE', 'TARDE', 'MANANA', 'MANANA') },
    ];
    assert.deepEqual(filtrarConflictosYaResueltos(queixa, horario, [albert, eva], DIES), queixa);
  });

  test('una llista buida no peta', () => {
    assert.deepEqual(filtrarConflictosYaResueltos([], [], [albert], DIES), []);
    assert.deepEqual(filtrarConflictosYaResueltos(null, [], [albert], DIES), []);
  });
});
