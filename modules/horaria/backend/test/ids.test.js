import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { idNumeric } from '../src/utils/ids.js';

// `parseInt` és més tolerant del que sembla, i amb aquests valors no es
// rebutjava la petició: es buscava un treballador amb un id diferent del que el
// client creia enviar.
describe('llegir un id', () => {
  test('un número, com arriba per la URL', () => {
    assert.equal(idNumeric('108'), 108);
    assert.equal(idNumeric(108), 108);
    assert.equal(idNumeric(' 108 '), 108);
  });

  test('el que parseInt deixava passar, ara no', () => {
    assert.equal(idNumeric('12abc'), null, 'parseInt donava 12');
    assert.equal(idNumeric('1e3'), null, 'parseInt donava 1, no 1000');
    assert.equal(idNumeric(['12', 'x']), null, 'parseInt donava 12');
    assert.equal(idNumeric('12.9'), null);
    assert.equal(idNumeric('0x10'), null);
  });

  test('res, buit o negatiu tampoc', () => {
    for (const v of [null, undefined, '', '   ', 'abc', -3, '-3', 0, '0', {}, [], NaN, Infinity]) {
      assert.equal(idNumeric(v), null, `${JSON.stringify(v)} hauria de ser null`);
    }
  });

  test('un número massa gran per ser un id de debò, tampoc', () => {
    assert.equal(idNumeric('99999999999999999999'), null);
  });
});
