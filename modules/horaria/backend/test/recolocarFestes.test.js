import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { recolocarFestes, cobrirAmbPartits } from '../src/services/aiScheduler.js';
import { parseConditions } from '../src/services/conditionCheck.js';

// Friday and Saturday are the busiest days in a butcher's, and a day off that
// lands on one of them costs the shop far more than the same day off on a
// Tuesday. Nothing was steering them: a day off the engine chose fell wherever
// the hour arithmetic left it.
const DIES = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

const setmana = (turnos) => ({
  empleadoId: 1,
  dias: DIES.map((d, i) => ({ dia: d, turno: turnos[i] || 'LIBRE' })),
});
const torns = (sched) => sched.dias.map((d) => d.turno);

// Coverage wide enough that nothing here is blocked by it, unless a test says so.
const REGLES_AMPLES = [{
  diasAplica: null,
  minDependientasManana: 0, maxDependientasManana: 99,
  minDependientasTarde: 0, maxDependientasTarde: 99,
  minElaboracionManana: 0, maxElaboracionManana: 99,
  minElaboracionTarde: 0, maxElaboracionTarde: 99,
  minPersonasDescansoPartido: 0,
}];

const persona = (extra = {}) => ({ id: 1, funcion: 'DEPENDIENTA', ...extra });
const TANCAT_DIUMENGE = ['DOMINGO'];

describe('les festes no demanades no cauen en divendres ni dissabte', () => {
  test('un divendres lliure es canvia per un dimarts treballat', () => {
    const h = [setmana(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'LIBRE', 'MANANA'])];
    recolocarFestes(h, [persona()], REGLES_AMPLES, TANCAT_DIUMENGE);
    assert.equal(torns(h[0])[4], 'MANANA', 'divendres ha de passar a treballar');
    assert.ok(torns(h[0]).slice(0, 4).includes('LIBRE'), 'la festa ha d\'anar a dilluns–dijous');
  });

  test('el torn viatja sencer: els recomptes no es mouen', () => {
    const h = [setmana(['MANANA', 'PARTIDO', 'TARDE', 'MANANA', 'LIBRE', 'TARDE'])];
    const abans = torns(h[0]).filter((t) => t !== 'LIBRE').sort();
    recolocarFestes(h, [persona()], REGLES_AMPLES, TANCAT_DIUMENGE);
    const despres = torns(h[0]).filter((t) => t !== 'LIBRE').sort();
    assert.deepEqual(despres, abans, 'mateixos matins, tardes i partits que abans');
  });

  test('un dissabte lliure també es mou', () => {
    const h = [setmana(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'LIBRE'])];
    recolocarFestes(h, [persona()], REGLES_AMPLES, TANCAT_DIUMENGE);
    assert.equal(torns(h[0])[5], 'MANANA');
  });

  // The whole point of the exception: somebody who asked for Friday keeps it.
  test('una festa demanada no es toca', () => {
    const h = [setmana(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'LIBRE', 'MANANA'])];
    recolocarFestes(h, [persona({ diasPreferenciaLibre: { VIERNES: true } })], REGLES_AMPLES, TANCAT_DIUMENGE);
    assert.equal(torns(h[0])[4], 'LIBRE');
  });

  test('una absència no és una festa', () => {
    const h = [setmana(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'LIBRE', 'MANANA'])];
    recolocarFestes(h, [persona({ diasAusente: { VIERNES: true } })], REGLES_AMPLES, TANCAT_DIUMENGE);
    assert.equal(torns(h[0])[4], 'LIBRE');
  });

  test('un dia treballant a una altra botiga tampoc', () => {
    const h = [setmana(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'LIBRE', 'MANANA'])];
    recolocarFestes(h, [persona({ diasOcupadosOtrosEstablecimientos: { VIERNES: true } })], REGLES_AMPLES, TANCAT_DIUMENGE);
    assert.equal(torns(h[0])[4], 'LIBRE');
  });

  // The shop is shut: nobody works, and that is not anybody's day off.
  test('un dissabte festiu no es mou', () => {
    const h = [setmana(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'LIBRE'])];
    recolocarFestes(h, [persona()], REGLES_AMPLES, ['DOMINGO', 'SABADO']);
    assert.equal(torns(h[0])[5], 'LIBRE');
  });

  test('el diumenge tancat no compta com a festa a moure', () => {
    const h = [setmana(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'LIBRE'])];
    recolocarFestes(h, [persona()], REGLES_AMPLES, TANCAT_DIUMENGE);
    assert.equal(torns(h[0])[6], 'LIBRE');
  });

  test('sense cap dia entre setmana treballat, no hi ha res a canviar', () => {
    const h = [setmana(['LIBRE', 'LIBRE', 'LIBRE', 'LIBRE', 'LIBRE', 'MANANA'])];
    recolocarFestes(h, [persona()], REGLES_AMPLES, TANCAT_DIUMENGE);
    assert.deepEqual(torns(h[0]).slice(0, 5), ['LIBRE', 'LIBRE', 'LIBRE', 'LIBRE', 'LIBRE']);
  });

  // Better a day off on a Friday than a Tuesday the shop cannot cover.
  test('si buidar el dia entre setmana trenca el mínim, no es fa', () => {
    const estrictes = [{
      ...REGLES_AMPLES[0],
      minDependientasManana: 1, maxDependientasManana: 99,
    }];
    // Only one person works Tuesday morning: taking them off breaks the minimum.
    const h = [setmana(['LIBRE', 'MANANA', 'LIBRE', 'LIBRE', 'LIBRE', 'LIBRE'])];
    recolocarFestes(h, [persona()], estrictes, TANCAT_DIUMENGE);
    assert.equal(torns(h[0])[1], 'MANANA', 'el dimarts s\'ha de quedar cobert');
    assert.equal(torns(h[0])[4], 'LIBRE', 'i el divendres es queda com estava');
  });

  test('un torn demanat per a un dia concret no es mou', () => {
    const h = [setmana(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'LIBRE', 'MANANA'])];
    const emp = persona({ turnosPorDiaPreferencia: { LUNES: 'MANANA', MARTES: 'MANANA', MIERCOLES: 'MANANA', JUEVES: 'MANANA' } });
    recolocarFestes(h, [emp], REGLES_AMPLES, TANCAT_DIUMENGE);
    assert.equal(torns(h[0])[4], 'LIBRE', 'cap dia entre setmana era lliure de moure');
  });
});

// ── Reason 1: the day off sits on a day the shop is short ────────────────
//
// Nuria Bachs, 2026-W34. Thursday wanted six sales staff and had five; Monday
// allows six to eight and had seven. Her day off moved from Thursday to
// Monday: both days inside their rule, and her hours, her five mornings and
// her single day off all unchanged.
describe('la festa surt del dia on falta gent', () => {
  const DIES_S = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
  const persona = (id, turnos, extra = {}) => ({
    emp: { id, funcion: 'DEPENDIENTA', ...extra },
    sched: { empleadoId: id, dias: DIES_S.map((d, i) => ({ dia: d, turno: turnos[i] || 'LIBRE' })) },
  });
  // Monday 6–8 in the morning, Thursday exactly 6: Girona's real shape.
  const REGLES = [
    { diasAplica: '["LUNES","VIERNES"]', minDependientasManana: 2, maxDependientasManana: 4,
      minDependientasTarde: 0, maxDependientasTarde: 9, minElaboracionManana: 0, maxElaboracionManana: 9,
      minElaboracionTarde: 0, maxElaboracionTarde: 9, minPersonasDescansoPartido: 0 },
    { diasAplica: '["MARTES","MIERCOLES","JUEVES"]', minDependientasManana: 3, maxDependientasManana: 3,
      minDependientasTarde: 0, maxDependientasTarde: 9, minElaboracionManana: 0, maxElaboracionManana: 9,
      minElaboracionTarde: 0, maxElaboracionTarde: 9, minPersonasDescansoPartido: 0 },
  ];

  test('el cas de la Núria: dijous curt, dilluns amb marge', () => {
    // Three people work Monday morning (limit 4) and only two work Thursday (needs 3).
    const gent = [
      persona(1, ['MANANA', 'MANANA', 'MANANA', 'LIBRE', 'MANANA', 'MANANA']),
      persona(2, ['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA']),
      persona(3, ['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA']),
    ];
    const horario = gent.map((g) => g.sched);
    const employees = gent.map((g) => g.emp);
    recolocarFestes(horario, employees, REGLES, ['DOMINGO']);

    const nuria = horario[0].dias;
    assert.equal(nuria.find((d) => d.dia === 'JUEVES').turno, 'MANANA', 'dijous, que anava curt, cobert');
    assert.equal(nuria.find((d) => d.dia === 'LUNES').turno, 'LIBRE', 'la festa se n\'ha anat al dilluns, que tenia marge');
    assert.equal(nuria.filter((d) => d.turno === 'LIBRE' && d.dia !== 'DOMINGO').length, 1, 'segueix tenint un dia de festa');
  });

  test('si cap dia va curt i la festa ja és entre setmana, no es toca res', () => {
    const gent = [
      persona(1, ['MANANA', 'MANANA', 'MANANA', 'LIBRE', 'MANANA', 'MANANA']),
      persona(2, ['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA']),
      persona(3, ['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA']),
      persona(4, ['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA']),
    ];
    const horario = gent.map((g) => g.sched);
    recolocarFestes(horario, gent.map((g) => g.emp), REGLES, ['DOMINGO']);
    assert.equal(horario[0].dias.find((d) => d.dia === 'JUEVES').turno, 'LIBRE');
  });

  // Trading a covered counter for a broken condition is not a trade worth making.
  test('no es fa el canvi si trenca una condició de la persona', () => {
    const gent = [
      persona(1, ['MANANA', 'MANANA', 'MANANA', 'LIBRE', 'MANANA', 'MANANA'],
        { condicionesFijas: 'Si el dissabte fa MATÍ, el dilluns fa PARTIDO' }),
      persona(2, ['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA']),
      persona(3, ['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA']),
    ];
    const horario = gent.map((g) => g.sched);
    // Already broken on Monday; freeing Monday would not fix it, and the swap
    // must not make the count worse than it starts.
    recolocarFestes(horario, gent.map((g) => g.emp), REGLES, ['DOMINGO'],
      ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO']);
    const dies = horario[0].dias;
    assert.equal(dies.filter((d) => d.turno === 'LIBRE' && d.dia !== 'DOMINGO').length, 1);
  });
});

// ── Covering a gap with a split shift ────────────────────────────────────
//
// The Saturday of 2026-W34: the whole shop worked it, two people were off
// sick, and the morning was still one short of the seven the rule demands.
// The fill pass looks for somebody free and there was nobody, so it gave up.
describe('tapar un forat amb un partit', () => {
  const DIES_S = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
  const persona = (id, turnos, extra = {}) => ({
    emp: { id, funcion: 'DEPENDIENTA', ...extra },
    sched: { empleadoId: id, dias: DIES_S.map((d, i) => ({ dia: d, turno: turnos[i] || 'LIBRE' })) },
  });
  const REGLA_DISSABTE = [{
    diasAplica: '["SABADO"]',
    minDependientasManana: 2, maxDependientasManana: 2,
    minDependientasTarde: 1, maxDependientasTarde: 1,
    minElaboracionManana: 0, maxElaboracionManana: 9,
    minElaboracionTarde: 0, maxElaboracionTarde: 9, minPersonasDescansoPartido: 0,
  }];

  test('el cas d\'en Manuel: ningú lliure, una tarda puja a partit', () => {
    // Saturday: one morning, one afternoon. Needs two mornings and one afternoon.
    const gent = [persona(1, ['', '', '', '', '', 'MANANA']), persona(2, ['', '', '', '', '', 'TARDE'])];
    const horario = gent.map((g) => g.sched);
    cobrirAmbPartits(horario, gent.map((g) => g.emp), REGLA_DISSABTE, ['DOMINGO']);
    assert.equal(horario[1].dias.find((d) => d.dia === 'SABADO').turno, 'PARTIDO',
      'la tarda cobreix ara les dues meitats');
    assert.equal(horario[0].dias.find((d) => d.dia === 'SABADO').turno, 'MANANA', 'l\'altre no es toca');
  });

  test('si no falta ningú, no promociona res', () => {
    const gent = [persona(1, ['', '', '', '', '', 'MANANA']), persona(2, ['', '', '', '', '', 'MANANA']),
      persona(3, ['', '', '', '', '', 'TARDE'])];
    const horario = gent.map((g) => g.sched);
    cobrirAmbPartits(horario, gent.map((g) => g.emp), REGLA_DISSABTE, ['DOMINGO']);
    assert.equal(horario[2].dias.find((d) => d.dia === 'SABADO').turno, 'TARDE');
  });

  test('una jornada reduïda no fa mai partits, encara que falti gent', () => {
    const gent = [persona(1, ['', '', '', '', '', 'MANANA']),
      persona(2, ['', '', '', '', '', 'TARDE'], { horasPorTurno: 4 })];
    const horario = gent.map((g) => g.sched);
    cobrirAmbPartits(horario, gent.map((g) => g.emp), REGLA_DISSABTE, ['DOMINGO']);
    assert.equal(horario[1].dias.find((d) => d.dia === 'SABADO').turno, 'TARDE');
  });

  test('no promociona qui té prohibits els partits', () => {
    const gent = [persona(1, ['', '', '', '', '', 'MANANA']),
      persona(2, ['', '', '', '', '', 'TARDE'], { condicionesFijas: 'No fa mai torns PARTIDO' })];
    const horario = gent.map((g) => g.sched);
    const employees = gent.map((g) => g.emp);
    for (const e of employees) e.condParsed = parseConditions(e.condicionesFijas);
    cobrirAmbPartits(horario, employees, REGLA_DISSABTE, ['DOMINGO']);
    assert.equal(horario[1].dias.find((d) => d.dia === 'SABADO').turno, 'TARDE');
  });

  test('un dia tancat no es mira', () => {
    const gent = [persona(1, ['', '', '', '', '', 'MANANA']), persona(2, ['', '', '', '', '', 'TARDE'])];
    const horario = gent.map((g) => g.sched);
    cobrirAmbPartits(horario, gent.map((g) => g.emp), REGLA_DISSABTE, ['DOMINGO', 'SABADO']);
    assert.equal(horario[1].dias.find((d) => d.dia === 'SABADO').turno, 'TARDE');
  });
});
