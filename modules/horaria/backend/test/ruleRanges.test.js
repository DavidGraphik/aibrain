import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateRuleRanges } from '../src/controllers/rules.js';

// Girona's weekday rule asked for at least 6 dependientas in the morning and at
// most 5. Nothing rejected it. The repair passes then spent five iterations
// adding people to reach the minimum and removing them to respect the maximum,
// and the schedule settled wherever that fight left it — which is why Eva
// Mademont could not be given the third morning her conditions grant her: six
// were already on, and the maximum said five.
describe('rangs de cobertura', () => {
  const ok = {
    minDependientasManana: 6, maxDependientasManana: 8,
    minDependientasTarde: 4, maxDependientasTarde: 6,
    minElaboracionManana: 3, maxElaboracionManana: 4,
    minElaboracionTarde: 1, maxElaboracionTarde: 2,
  };

  test('una regla coherent passa', () => {
    assert.equal(validateRuleRanges(ok), null);
  });

  test('mínim igual que màxim és vàlid', () => {
    // The Saturday rule is exactly this: 7-7, meaning "exactly seven".
    assert.equal(validateRuleRanges({ ...ok, minDependientasManana: 7, maxDependientasManana: 7 }), null);
  });

  test('el cas real de Girona: 6 de mínim i 5 de màxim', () => {
    const msg = validateRuleRanges({ ...ok, minDependientasManana: 6, maxDependientasManana: 5 });
    assert.ok(msg, 'ha de rebutjar-ho');
    assert.match(msg, /dependientas por la mañana/);
    assert.match(msg, /6/);
    assert.match(msg, /5/);
  });

  test('comprova les quatre parelles, no només la primera', () => {
    assert.ok(validateRuleRanges({ ...ok, minDependientasTarde: 9 }));
    assert.ok(validateRuleRanges({ ...ok, minElaboracionManana: 9 }));
    assert.ok(validateRuleRanges({ ...ok, minElaboracionTarde: 9 }));
  });

  test('un valor absent no inventa un error', () => {
    // Updates send only what changed; the caller merges with what is stored
    // before validating, and a genuinely missing pair is simply not checked.
    assert.equal(validateRuleRanges({ minDependientasManana: 6 }), null);
    assert.equal(validateRuleRanges({}), null);
  });

  test('els zeros compten com a valor, no com a absència', () => {
    // Saturday allows 0 elaboración in the afternoon; 0 must not be read as
    // "unset" or that rule stops being checked at all.
    assert.equal(validateRuleRanges({ minElaboracionTarde: 0, maxElaboracionTarde: 4 }), null);
    assert.ok(validateRuleRanges({ minElaboracionTarde: 1, maxElaboracionTarde: 0 }));
  });
});
