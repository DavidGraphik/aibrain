import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dayWithinAbsence } from '../src/utils/absenceDays.js';

// Absence bounds are stored as UTC midnight while the week's days are built in
// local time. Comparing them as instants dropped the first day of every absence
// in any timezone east of UTC: someone signed off sick Monday to Friday showed
// Monday as an ordinary free day, and the engine was free to give them a shift.
describe('dies dins d\'una absència', () => {
  const inici = new Date('2026-08-03T00:00:00.000Z'); // dilluns
  const fi = new Date('2026-08-07T00:00:00.000Z');    // divendres

  // Dilluns 3 d'agost a mitjanit hora local (Espanya, UTC+2 a l'estiu)
  function diaLocal(offsetDies) {
    const d = new Date(2026, 7, 3);
    d.setDate(d.getDate() + offsetDies);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  test('el primer dia compta (el bug original)', () => {
    assert.equal(dayWithinAbsence(diaLocal(0), inici, fi), true,
      'el dilluns d\'inici es perdia per la diferència UTC/local');
  });

  test('els dies del mig compten', () => {
    for (let i = 1; i <= 3; i++) {
      assert.equal(dayWithinAbsence(diaLocal(i), inici, fi), true);
    }
  });

  test('l\'últim dia compta', () => {
    assert.equal(dayWithinAbsence(diaLocal(4), inici, fi), true);
  });

  test('el dia següent ja no', () => {
    assert.equal(dayWithinAbsence(diaLocal(5), inici, fi), false);
  });

  test('el dia anterior tampoc', () => {
    assert.equal(dayWithinAbsence(diaLocal(-1), inici, fi), false);
  });

  test('una baixa de cinc dies en marca exactament cinc', () => {
    let dies = 0;
    for (let i = 0; i < 7; i++) if (dayWithinAbsence(diaLocal(i), inici, fi)) dies++;
    assert.equal(dies, 5);
  });

  test('una absència d\'un sol dia marca aquell dia', () => {
    const d = new Date('2026-08-05T00:00:00.000Z');
    assert.equal(dayWithinAbsence(diaLocal(2), d, d), true);
    assert.equal(dayWithinAbsence(diaLocal(1), d, d), false);
    assert.equal(dayWithinAbsence(diaLocal(3), d, d), false);
  });
});

// The same trap, found again a fortnight later in another file: the conflicts
// panel asked whether Saturday fell inside the 15 August holiday by comparing
// instants, so Girona's closed Saturday looked open and the panel demanded
// seven sales staff for a shut shop. Three phantom conflicts, every week with
// a holiday in it.
test('un festiu d\'un sol dia tanca aquell dia, no el d\'abans', () => {
  const festiu = new Date('2026-08-15');            // com el desa la base de dades
  const dilluns = new Date(2026, 7, 10);            // 10 d'agost, hora local
  const diaDeLaSetmana = (i) => {
    const d = new Date(dilluns);
    d.setDate(dilluns.getDate() + i);
    return d;
  };
  assert.equal(dayWithinAbsence(diaDeLaSetmana(5), festiu, festiu), true, 'dissabte 15 és el festiu');
  assert.equal(dayWithinAbsence(diaDeLaSetmana(4), festiu, festiu), false, 'divendres 14 no ho és');
  assert.equal(dayWithinAbsence(diaDeLaSetmana(6), festiu, festiu), false, 'diumenge 16 tampoc');
});
