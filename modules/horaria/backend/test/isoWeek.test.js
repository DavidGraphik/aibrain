import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { weekBounds, weekDay , weekLabel } from '../src/utils/isoWeek.js';

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// This conversion was written out by hand four times in one controller. The
// fourth copy read variables belonging to a different function — which imports
// cleanly and only breaks when somebody opens a schedule.
describe('límits d\'una setmana ISO', () => {
  test('2026-W33 va del 10 al 16 d\'agost', () => {
    const { monday, sunday } = weekBounds('2026-W33');
    assert.equal(ymd(monday), '2026-08-10');
    assert.equal(ymd(sunday), '2026-08-16');
  });

  test('el dissabte de W33 és el festiu del 15 d\'agost', () => {
    // The real reason the week was short, and the check that the day indices
    // line up with the days the shop is open.
    assert.equal(ymd(weekDay(weekBounds('2026-W33').monday, 5)), '2026-08-15');
  });

  test('la setmana 1 pot començar l\'any anterior', () => {
    // ISO weeks hang off 4 January, which is always in week 1 — so week 1 of
    // 2026 starts in December 2025.
    assert.equal(ymd(weekBounds('2026-W01').monday), '2025-12-29');
    assert.equal(ymd(weekBounds('2025-W01').monday), '2024-12-30');
  });

  test('setmanes consecutives van de set en set', () => {
    const a = weekBounds('2026-W32').monday;
    const b = weekBounds('2026-W33').monday;
    assert.equal((b - a) / 86400000, 7);
  });

  test('el dilluns comença a mitjanit', () => {
    const { monday } = weekBounds('2026-W33');
    assert.equal(monday.getHours(), 0);
    assert.equal(monday.getMinutes(), 0);
  });

  test('els set dies de la setmana', () => {
    const { monday } = weekBounds('2026-W33');
    const dies = [0, 1, 2, 3, 4, 5, 6].map((i) => ymd(weekDay(monday, i)));
    assert.deepEqual(dies, [
      '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
      '2026-08-14', '2026-08-15', '2026-08-16',
    ]);
  });
});

// The week fills a variable in an approved WhatsApp template, so this string is
// the sentence the shop manager actually reads on her phone. It used to say
// "la setmana 2026-W33", which is how the database talks.
describe('la setmana dita com la diria una persona', () => {
  test('dins d\'un mateix mes', () => {
    assert.equal(weekLabel('2026-W33'), 'del 10 al 16 d\'agost');
  });

  test('a cavall de dos mesos', () => {
    assert.equal(weekLabel('2026-W05'), 'del 26 de gener al 1 de febrer');
    assert.equal(weekLabel('2026-W40'), 'del 28 de setembre al 4 d\'octubre');
  });

  test('a cavall de dos anys', () => {
    assert.equal(weekLabel('2026-W01'), 'del 29 de desembre al 4 de gener');
  });

  // "d'agost", "d'octubre" — but "de gener", "de març".
  test('l\'apòstrof només davant de vocal', () => {
    assert.match(weekLabel('2026-W33'), /d'agost/);
    assert.match(weekLabel('2026-W09'), /de març/);
  });
});
