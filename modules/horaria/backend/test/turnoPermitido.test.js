import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseConditions, contarTurnos, turnoPermitido, turnoRestringido } from '../src/services/conditionCheck.js';

// The repair passes checked absences, other shops and requested days off before
// handing somebody a shift, and never once looked at their fixed conditions. So
// when Tuesday afternoon was short, Albert Triano — "two split shifts, the rest
// always mornings" — was as eligible as anybody with no restriction at all.
//
// Girona has the room to do better: the dependientas with no afternoon limit can
// supply 30 afternoons a week against the 25 the rules ask for. Using Albert was
// never necessary.
const COND = {
  albert: parseConditions('Fa 2 torns PARTIDO per setmana, que NO poden ser en dies consecutius. La resta de dies sempre MATÍ.'),
  nuria: parseConditions('Ha de tenir 1 dia de festa (LIBRE) cada setmana. Sempre MATINS'),
  gemma: parseConditions('Màxim 3 tardes per setmana. IMPORTANT: un torn PARTIDO ja compta com una tarda, no se suma a part.'),
  eva: parseConditions('Reparteix la seva setmana en 3 MATINS i 3 TARDES.'),
  david: parseConditions('No fa mai torns PARTIDO.'),
  cap: parseConditions('És encarregada de la botiga.'),
};

const buit = { mananas: 0, tardes: 0, partidos: 0 };

describe('qui pot fer una tarda', () => {
  test('qui no té cap restricció, sempre', () => {
    assert.equal(turnoPermitido(COND.cap, 'TARDE', buit), true);
    assert.equal(turnoPermitido(null, 'TARDE', buit), true);
  });

  test('la Núria mai — només matins', () => {
    assert.equal(turnoPermitido(COND.nuria, 'TARDE', buit), false);
    assert.equal(turnoPermitido(COND.nuria, 'PARTIDO', buit), false);
    assert.equal(turnoPermitido(COND.nuria, 'MANANA', buit), true);
  });

  test('l\'Albert mai una tarda solta, però sí els seus partits', () => {
    assert.equal(turnoPermitido(COND.albert, 'TARDE', buit), false, 'aquest és el cas que va fallar');
    assert.equal(turnoPermitido(COND.albert, 'PARTIDO', buit), true);
  });

  test('l\'Albert, un cop fets els dos partits, ja no en fa més', () => {
    assert.equal(turnoPermitido(COND.albert, 'PARTIDO', { ...buit, partidos: 2 }), false);
  });
});

describe('els límits es gasten', () => {
  test('la Gemma pot fer tardes fins al seu màxim', () => {
    assert.equal(turnoPermitido(COND.gemma, 'TARDE', { ...buit, tardes: 2 }), true);
    assert.equal(turnoPermitido(COND.gemma, 'TARDE', { ...buit, tardes: 3 }), false);
  });

  test('a la Gemma, un partit li gasta una tarda', () => {
    // Two afternoons and one split shift is already her three.
    assert.equal(turnoPermitido(COND.gemma, 'TARDE', { ...buit, tardes: 2, partidos: 1 }), false);
    assert.equal(turnoPermitido(COND.gemma, 'PARTIDO', { ...buit, tardes: 3 }), false);
  });

  test('l\'Eva s\'atura a les tres tardes i als tres matins', () => {
    assert.equal(turnoPermitido(COND.eva, 'TARDE', { ...buit, tardes: 3 }), false);
    assert.equal(turnoPermitido(COND.eva, 'MANANA', { ...buit, mananas: 3 }), false);
    assert.equal(turnoPermitido(COND.eva, 'MANANA', { ...buit, mananas: 2 }), true);
  });

  test('el David no fa mai partits', () => {
    assert.equal(turnoPermitido(COND.david, 'PARTIDO', buit), false);
    assert.equal(turnoPermitido(COND.david, 'MANANA', buit), true);
  });
});

describe('a qui s\'agafa primer', () => {
  // Somebody allowed three afternoons a week should not spend that allowance on
  // Monday when a colleague with no limit is equally free.
  test('els que no tenen límit van davant', () => {
    assert.equal(turnoRestringido(COND.cap, 'TARDE'), false);
    assert.equal(turnoRestringido(COND.gemma, 'TARDE'), true);
    assert.equal(turnoRestringido(COND.albert, 'TARDE'), true);
  });

  test('ordena els candidats deixant els restringits al final', () => {
    const gent = [
      { nom: 'gemma', cond: COND.gemma }, { nom: 'neus', cond: COND.cap },
      { nom: 'albert', cond: COND.albert }, { nom: 'manuel', cond: COND.cap },
    ];
    const ordre = [...gent].sort((a, b) =>
      (turnoRestringido(a.cond, 'TARDE') ? 1 : 0) - (turnoRestringido(b.cond, 'TARDE') ? 1 : 0));
    assert.deepEqual(ordre.slice(0, 2).map((x) => x.nom).sort(), ['manuel', 'neus']);
  });
});

describe('comptar el que ja té', () => {
  test('compta cada tipus de torn', () => {
    const c = contarTurnos([
      { turno: 'MANANA' }, { turno: 'MANANA' }, { turno: 'TARDE' },
      { turno: 'PARTIDO' }, { turno: 'LIBRE' },
    ]);
    assert.deepEqual(c, { mananas: 2, tardes: 1, partidos: 1 });
  });

  test('una setmana buida no compta res', () => {
    assert.deepEqual(contarTurnos([]), buit);
    assert.deepEqual(contarTurnos(null), buit);
  });
});
