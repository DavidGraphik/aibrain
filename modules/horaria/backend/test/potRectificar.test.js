import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { potRectificar } from '../src/services/whatsapp.js';

// "Si ja has registrat les teves preferències però tens un canvi o es vulgui
// afegir algo, es pugui." Mentre la finestra és oberta, sí.
describe('rectificar unes preferències ja desades', () => {
  const dg = new Date('2026-08-16T09:00:00');       // s'obre
  const dc = new Date('2026-08-19T13:00:00');       // es tanca
  const conv = (extra) => ({ fechaLimite: dc, completedAt: dg, ...extra });

  test('el mateix diumenge, dos minuts després de confirmar', () => {
    assert.equal(potRectificar(conv(), new Date('2026-08-16T09:02:00')), true);
  });

  test('el dimarts, dos dies després de confirmar', () => {
    assert.equal(potRectificar(conv(), new Date('2026-08-18T18:30:00')), true,
      'abans només es podia durant 10 minuts');
  });

  test('el dimecres a les 12:59, un minut abans de tancar', () => {
    assert.equal(potRectificar(conv(), new Date('2026-08-19T12:59:00')), true);
  });

  test('el dimecres a les 13:01, ja no', () => {
    assert.equal(potRectificar(conv(), new Date('2026-08-19T13:01:00')), false);
  });

  test('el dijous, ja no', () => {
    assert.equal(potRectificar(conv(), new Date('2026-08-20T10:00:00')), false);
  });

  // Converses d'abans que la finestra existís: es queden amb els 10 minuts.
  describe('sense data límit desada', () => {
    const sense = (completedAt) => ({ fechaLimite: null, completedAt });

    test('dins dels 10 minuts', () => {
      assert.equal(potRectificar(sense(new Date('2026-08-18T10:00:00')), new Date('2026-08-18T10:05:00')), true);
    });

    test('passats els 10 minuts', () => {
      assert.equal(potRectificar(sense(new Date('2026-08-18T10:00:00')), new Date('2026-08-18T10:20:00')), false);
    });

    test('sense cap data de res, no', () => {
      assert.equal(potRectificar({ fechaLimite: null, completedAt: null }), false);
    });
  });
});
