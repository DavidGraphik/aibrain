import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { honrarRecuentosExactos } from '../src/services/aiScheduler.js';
import { parseConditions, contarTurnos } from '../src/services/conditionCheck.js';

// Every rule enforced so far is a prohibition: don't give this person that
// shift. Some conditions are the opposite — an obligation to reach a number.
// Albert Triano does exactly two split shifts a week; Eva Mademont splits hers
// into three mornings and three afternoons. Nothing pushed towards a total, so
// one short stayed one short, and the pass that moves people for coverage could
// undo a total that had been right — which is exactly what happened to Albert
// when the swap pass first ran.

const DIAS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

const TEXT = {
  albert: 'Fa 2 torns PARTIDO per setmana, que NO poden ser en dies consecutius. La resta de dies sempre MATÍ.',
  eva: 'Reparteix la seva setmana en 3 MATINS i 3 TARDES. Si algun dia fes PARTIDO, aquest compta alhora com un matí i com una tarda.',
  david: 'Jornada reduïda de 4h per torn. No fa mai torns PARTIDO.',
};

function empleat(id, condiciones, extra = {}) {
  return {
    id, funcion: 'DEPENDIENTA', maxHorasSemana: 40, horasObjetivoSemana: 40,
    condicionesFijas: condiciones, condParsed: parseConditions(condiciones),
    dispParsed: null, ...extra,
  };
}

/** A week from five weekday shifts; Saturday and Sunday stay LIBRE. */
function setmana(...turnos) {
  return DIAS.map((dia, i) => ({ dia, turno: i < turnos.length ? turnos[i] : 'LIBRE' }));
}

// Wide limits: these tests are about the counts, and coverage gets its own ones.
const REGLA_AMPLA = [{
  diasAplica: null,
  minDependientasManana: 0, maxDependientasManana: 99,
  minDependientasTarde: 0, maxDependientasTarde: 99,
  minElaboracionManana: 0, maxElaboracionManana: 99,
  minElaboracionTarde: 0, maxElaboracionTarde: 99,
}];

const compta = (h, id) => contarTurnos(h.find((x) => x.empleadoId === id).dias);
const dia = (h, id, d) => h.find((x) => x.empleadoId === id).dias.find((x) => x.dia === d).turno;

describe('completar els partits que toquen', () => {
  test('l\'Albert amb un partit n\'acaba amb dos', () => {
    const emps = [empleat(1, TEXT.albert)];
    const h = [{ empleadoId: 1, dias: setmana('MANANA', 'MANANA', 'PARTIDO', 'MANANA', 'MANANA') }];
    honrarRecuentosExactos(h, emps, REGLA_AMPLA);
    assert.equal(compta(h, 1).partidos, 2);
  });

  test('no els posa en dies consecutius', () => {
    const emps = [empleat(1, TEXT.albert)];
    const h = [{ empleadoId: 1, dias: setmana('MANANA', 'MANANA', 'PARTIDO', 'MANANA', 'MANANA') }];
    honrarRecuentosExactos(h, emps, REGLA_AMPLA);
    const partits = DIAS.filter((d) => dia(h, 1, d) === 'PARTIDO').map((d) => DIAS.indexOf(d));
    assert.equal(partits.length, 2);
    assert.ok(Math.abs(partits[0] - partits[1]) > 1, `dies ${partits} són consecutius`);
  });

  test('qui ja en té els que toquen no es toca', () => {
    const emps = [empleat(1, TEXT.albert)];
    const h = [{ empleadoId: 1, dias: setmana('PARTIDO', 'MANANA', 'MANANA', 'PARTIDO', 'MANANA') }];
    const abans = JSON.stringify(h);
    honrarRecuentosExactos(h, emps, REGLA_AMPLA);
    assert.equal(JSON.stringify(h), abans, 'una setmana correcta ha de quedar intacta');
  });

  test('mai a qui té jornada reduïda', () => {
    const emps = [empleat(1, TEXT.david, { horasPorTurno: 4 })];
    emps[0].condParsed.partidosExactos = 2; // even if the text said so
    const h = [{ empleadoId: 1, dias: setmana('MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA') }];
    honrarRecuentosExactos(h, emps, REGLA_AMPLA);
    assert.equal(compta(h, 1).partidos, 0, 'un contracte reduït no pot doblar la jornada');
  });
});

describe('equilibrar matins i tardes', () => {
  test('l\'Eva amb 2 matins i 4 tardes acaba amb 3 i 3', () => {
    // Her real week after the swap pass: TAR MAT TAR PAR TAR.
    const emps = [empleat(1, TEXT.eva)];
    const h = [{ empleadoId: 1, dias: setmana('TARDE', 'MANANA', 'TARDE', 'PARTIDO', 'TARDE') }];
    honrarRecuentosExactos(h, emps, REGLA_AMPLA);
    const c = compta(h, 1);
    assert.equal(c.mananas + c.partidos, 3, 'matins, comptant el partit');
    assert.equal(c.tardes + c.partidos, 3, 'tardes, comptant el partit');
  });

  // Three mornings and three afternoons is six shifts, and a week with a public
  // holiday has five days. Converting an afternoon into a morning would only
  // move the shortage; exactly one split shift is the only arrangement that
  // fits, which is what her own condition describes.
  test('quan no hi caben els torns, li dona un partit', () => {
    const emps = [empleat(1, TEXT.eva)];
    const h = [{ empleadoId: 1, dias: setmana('TARDE', 'MANANA', 'MANANA', 'TARDE', 'TARDE') }];
    honrarRecuentosExactos(h, emps, REGLA_AMPLA);
    const c = compta(h, 1);
    assert.equal(c.partidos, 1, 'necessita exactament un partit perquè quadri');
    assert.equal(c.mananas + c.partidos, 3);
    assert.equal(c.tardes + c.partidos, 3);
  });

  test('no dona un partit a qui no el compta a les dues bandes', () => {
    // Without "counts on both sides" a split shift does not add the missing
    // morning, so it would be a change for nothing.
    const emps = [empleat(1, 'Reparteix la seva setmana en 3 MATINS i 3 TARDES.')];
    const h = [{ empleadoId: 1, dias: setmana('TARDE', 'MANANA', 'MANANA', 'TARDE', 'TARDE') }];
    honrarRecuentosExactos(h, emps, REGLA_AMPLA);
    assert.equal(compta(h, 1).partidos, 0);
  });

  test('també funciona al revés, amb massa matins', () => {
    const emps = [empleat(1, TEXT.eva)];
    const h = [{ empleadoId: 1, dias: setmana('MANANA', 'MANANA', 'MANANA', 'PARTIDO', 'TARDE') }];
    honrarRecuentosExactos(h, emps, REGLA_AMPLA);
    const c = compta(h, 1);
    assert.equal(c.mananas + c.partidos, 3);
    assert.equal(c.tardes + c.partidos, 3);
  });

  test('no canvia un dia que la persona va demanar d\'una manera concreta', () => {
    const emps = [empleat(1, TEXT.eva, { turnosPorDiaPreferencia: { LUNES: 'TARDE' } })];
    const h = [{ empleadoId: 1, dias: setmana('TARDE', 'MANANA', 'TARDE', 'PARTIDO', 'TARDE') }];
    honrarRecuentosExactos(h, emps, REGLA_AMPLA);
    assert.equal(dia(h, 1, 'LUNES'), 'TARDE', 'va demanar tarda el dilluns');
  });

  test('no toca un dia que no té disponible', () => {
    const emps = [empleat(1, TEXT.eva, { dispParsed: { MARTES: { M: false, T: true } } })];
    const h = [{ empleadoId: 1, dias: setmana('TARDE', 'TARDE', 'TARDE', 'PARTIDO', 'MANANA') }];
    honrarRecuentosExactos(h, emps, REGLA_AMPLA);
    assert.notEqual(dia(h, 1, 'MARTES'), 'MANANA', 'el dimarts al matí no pot treballar');
  });
});

// The whole point of running last: it must never buy one condition by breaking
// the coverage the earlier passes worked to satisfy.
describe('mai a canvi de trencar la cobertura', () => {
  const REGLA_JUSTA = [{
    diasAplica: null,
    minDependientasManana: 1, maxDependientasManana: 1,
    minDependientasTarde: 1, maxDependientasTarde: 1,
    minElaboracionManana: 0, maxElaboracionManana: 99,
    minElaboracionTarde: 0, maxElaboracionTarde: 99,
  }];

  test('no puja a partit si el màxim de la tarda ja està ple', () => {
    const emps = [empleat(1, TEXT.albert), empleat(2, null)];
    const h = [
      { empleadoId: 1, dias: setmana('MANANA', 'MANANA', 'PARTIDO', 'MANANA', 'MANANA') },
      { empleadoId: 2, dias: setmana('TARDE', 'TARDE', 'TARDE', 'TARDE', 'TARDE') },
    ];
    honrarRecuentosExactos(h, emps, REGLA_JUSTA);
    assert.equal(compta(h, 1).partidos, 1, 'la tarda ja té el seu màxim; el partit queda pendent i s\'informa');
  });

  test('no deixa un torn per sota del seu mínim', () => {
    const emps = [empleat(1, TEXT.eva)];
    const h = [{ empleadoId: 1, dias: setmana('TARDE', 'TARDE', 'TARDE', 'TARDE', 'TARDE') }];
    honrarRecuentosExactos(h, emps, REGLA_JUSTA);
    for (const d of ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES']) {
      assert.equal(dia(h, 1, d), 'TARDE', 'és l\'únic a la tarda cada dia');
    }
  });
});

describe('robustesa', () => {
  test('qui no té condicions de recompte no es toca', () => {
    const emps = [empleat(1, 'És encarregada de la botiga.')];
    const h = [{ empleadoId: 1, dias: setmana('MANANA', 'TARDE', 'MANANA', 'TARDE', 'MANANA') }];
    const abans = JSON.stringify(h);
    honrarRecuentosExactos(h, emps, REGLA_AMPLA);
    assert.equal(JSON.stringify(h), abans);
  });

  test('no s\'encalla quan la condició és impossible', () => {
    // Four mornings and four afternoons is eight shifts in a five-day week.
    const emps = [empleat(1, 'Reparteix la seva setmana en 4 MATINS i 4 TARDES.')];
    const h = [{ empleadoId: 1, dias: setmana('MANANA', 'TARDE', 'MANANA', 'TARDE', 'MANANA') }];
    honrarRecuentosExactos(h, emps, REGLA_AMPLA); // must simply return
    assert.ok(true);
  });

  test('una setmana sense torns no peta', () => {
    const emps = [empleat(1, TEXT.eva)];
    const h = [{ empleadoId: 1, dias: setmana() }];
    honrarRecuentosExactos(h, emps, REGLA_AMPLA);
    assert.equal(compta(h, 1).mananas, 0);
  });
});
