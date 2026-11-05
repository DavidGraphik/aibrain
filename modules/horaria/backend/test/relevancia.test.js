import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { esSobreLHorari } from '../src/services/whatsapp.js';

// The first real test run locked Neus Sala out of her own rota. Two off-topic
// messages had gone into the history, and the model — reading back its own
// verdicts — called the next one a third strike. It was "perdon, necesito
// también que el miercoles solo puedo trabajar por la tarde".
//
// The lock is silent by design, so she got no reply and no explanation, and
// there was no way to undo it before the following week's broadcast.
describe('és sobre l\'horari?', () => {
  test('el missatge que la va bloquejar', () => {
    assert.equal(esSobreLHorari('perdon, necesito también que el miercoles solo puedo trabajar por la tarde', {}), true);
  });

  test('els despropòsits de veritat segueixen sent-ho', () => {
    for (const t of ['no me interesas', 'y que pasa con el coronavirus?', 'cuéntame un chiste',
      'asdfgh', 'hola guapa', 'qué tiempo hace', '😂😂😂']) {
      assert.equal(esSobreLHorari(t, {}), false, t);
    }
  });

  test('parlar de dies o de torns ja compta, en qualsevol dels tres idiomes', () => {
    for (const t of ['el dijous tinc metge', 'no puedo el martes', 'I can\'t work on Friday',
      'necessito fer tarda', 'estic de vacances']) {
      assert.equal(esSobreLHorari(t, {}), true, t);
    }
  });

  // You cannot both report a preference and be off-topic.
  test('el que la IA ha extret ja ho resol', () => {
    assert.equal(esSobreLHorari('xxxx', { diasNoDisponible: ['MARTES'] }), true);
    assert.equal(esSobreLHorari('xxxx', { turnosPorDia: { MIERCOLES: 'TARDE' } }), true);
    assert.equal(esSobreLHorari('xxxx', { turnoPreferido: 'MANANA' }), true);
    assert.equal(esSobreLHorari('xxxx', { notasAdicionales: 'res a dir' }), true);
    assert.equal(esSobreLHorari('xxxx', { diasNoDisponible: [], turnosPorDia: {} }), false);
  });

  test('accents i majúscules no hi fan res', () => {
    assert.equal(esSobreLHorari('EL DIMECRES NO PUC', {}), true);
    assert.equal(esSobreLHorari('el miércoles no puedo', {}), true);
  });

  test('buit no peta', () => {
    assert.equal(esSobreLHorari('', {}), false);
    assert.equal(esSobreLHorari(null, null), false);
  });
});
