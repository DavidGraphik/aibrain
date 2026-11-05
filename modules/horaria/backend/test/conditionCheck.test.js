import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseConditions, checkEmployeeConditions, trobaCompany, parseCondicional } from '../src/services/conditionCheck.js';

// Every sentence here is the real text from a Girona employee's record, because
// the point is not that the regexes work on invented examples.
const TEXT = {
  nuria: 'Ha de tenir 1 dia de festa (LIBRE) cada setmana. Sempre MATINS',
  victor: 'Fa 2 torns PARTIDO per setmana, que NO poden ser en dies consecutius. La resta de dies sempre MATÍ. El dilluns sempre MATÍ. Si el dissabte fa MATÍ, el divendres fa PARTIDO.',
  gemma: 'Màxim 3 tardes per setmana, i l\'ideal són 2. IMPORTANT: un torn PARTIDO ja compta com una tarda (cobreix matí i tarda), no se suma a part.',
  eva: 'Reparteix la seva setmana en 3 MATINS i 3 TARDES. Si algun dia fes PARTIDO, aquest compta alhora com un matí i com una tarda (no se suma a part).',
  david: 'Sempre el mateix horari: de 8:00 a 12:00. Jornada reduïda de 4h per torn, contracte de 20h/setmana. No fa mai torns PARTIDO.',
  jordi: 'No fa festa entre setmana. Ha de fer els mateixos MATINS que Nuria Bachs.',
};

// Girona's ordinary week: open Monday to Saturday, never Sunday.
const HABITUALS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'];
const setmana = (...turnos) => turnos.map((t, i) => ({ dia: HABITUALS[i], turno: t }));
const revisa = (texto, dias) =>
  checkEmployeeConditions({ empleado: { condicionesFijas: texto }, dias, diasHabituales: HABITUALS }).problemas;

describe('llegir les condicions escrites', () => {
  test('dies de festa i només matins', () => {
    const c = parseConditions(TEXT.nuria);
    assert.equal(c.minDiasLibres, 1);
    assert.equal(c.soloMananas, true);
  });

  test('partits exactes, no consecutius, i la resta matins', () => {
    const c = parseConditions(TEXT.victor);
    assert.equal(c.partidosExactos, 2);
    assert.equal(c.partidosNoConsecutivos, true);
    assert.equal(c.restaMananas, true);
    // The false positive that flagged Victor Sanchez for the two split shifts
    // his own conditions grant him: "la resta de dies sempre MATÍ" and "el
    // dilluns sempre MATÍ" both contain "sempre MATÍ", and neither means the
    // week is mornings only.
    assert.notEqual(c.soloMananas, true, '"la resta sempre matí" no vol dir només matins');
  });

  test('màxim de tardes comptant el partit com una', () => {
    const c = parseConditions(TEXT.gemma);
    assert.equal(c.maxTardes, 3);
    assert.equal(c.partidoCuentaComoTarde, true);
  });

  test('matins i tardes exactes, amb el partit comptant a les dues bandes', () => {
    const c = parseConditions(TEXT.eva);
    assert.equal(c.mananasExactas, 3);
    assert.equal(c.tardesExactas, 3);
    assert.equal(c.partidoCuentaComoAmbos, true);
  });

  test('mai cap partit', () => {
    assert.equal(parseConditions(TEXT.david).partidosMax, 0);
  });

  // The sync sentence used to live in this list. It is checked now, and what is
  // left in the list is what genuinely is not checked — which is the point of
  // the list existing at all.
  // Both of Jordi's sentences are checked now; the list is for what genuinely
  // is not, and the soft preference in Antonia's record is what still lives
  // there. Keeping something in it that we do check would be as misleading as
  // the silence this list was created to end.
  test('el que no sap llegir ho diu, en comptes de callar', () => {
    const c = parseConditions(TEXT.jordi);
    assert.equal(c.sincronizadoCon, 'Nuria Bachs');
    assert.equal(c.senseFestaEntreSetmana, true);
    assert.deepEqual(c.noInterpretadas, []);

    const antonia = parseConditions('Vol fer 1 PARTIDO (prioritza-l\'hi), i en aquest cas només li queden 1 o 2 torns de TARDE més');
    assert.equal(antonia.noInterpretadas.length, 1, 'una preferència tova segueix sense garantia');
  });

  test('un text buit no inventa condicions', () => {
    assert.deepEqual(parseConditions(null), { noInterpretadas: [] });
    assert.deepEqual(parseConditions(''), { noInterpretadas: [] });
  });
});

describe('detectar què incompleix una setmana', () => {
  test('Núria treballant els sis dies que la botiga obre', () => {
    const p = revisa(TEXT.nuria, setmana('MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA'));
    assert.equal(p.length, 1);
    assert.match(p[0], /1 dia\/es de festa i en té 0/);
  });

  test('una setmana normal seva: cinc matins i un dia de festa', () => {
    assert.deepEqual(
      revisa(TEXT.nuria, setmana('MANANA', 'MANANA', 'LIBRE', 'MANANA', 'MANANA', 'MANANA')), []
    );
  });

  // The 2026-W33 question. 15 August fell on the Saturday, so she worked five
  // mornings: 35h and two days of rest, exactly what an ordinary week gives her.
  // The holiday did the job of her weekly day off, and demanding a sixth
  // non-working day would only have cut her to 28h.
  test('un festiu excepcional li fa de dia de festa', () => {
    assert.deepEqual(
      revisa(TEXT.nuria, setmana('MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'LIBRE')), []
    );
  });

  // Sunday is a different matter: the shop never opens, so it was never a day
  // off she was granted. Counting it would mean she never gets one at all.
  test('el diumenge tancat no li fa de dia de festa', () => {
    const dias = [...setmana('MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA'),
      { dia: 'DOMINGO', turno: 'LIBRE' }];
    const p = checkEmployeeConditions({
      empleado: { condicionesFijas: TEXT.nuria }, dias, diasHabituales: HABITUALS,
    }).problemas;
    assert.equal(p.length, 1, 'el diumenge no és seu, la botiga no obre mai');
  });

  test('Eva amb dos matins quan li'.concat(' en toquen tres'), () => {
    const p = revisa(TEXT.eva, setmana('TARDE', 'MANANA', 'PARTIDO', 'LIBRE', 'TARDE'));
    assert.ok(p.some((x) => /3 matins i en té 2/.test(x)));
  });

  test('Albert amb tardes quan fora dels partits ha de fer matins', () => {
    const p = revisa(TEXT.victor, setmana('MANANA', 'TARDE', 'PARTIDO', 'TARDE', 'PARTIDO'));
    assert.ok(p.some((x) => /Fora dels torns de DIA/.test(x)));
  });

  test('una setmana correcta no genera cap avís', () => {
    // Victor's actual week: two non-consecutive split shifts, the rest mornings.
    const p = revisa(TEXT.victor, setmana('MANANA', 'PARTIDO', 'MANANA', 'MANANA', 'PARTIDO'));
    assert.deepEqual(p, []);
  });

  test('partits en dies consecutius', () => {
    const p = revisa(TEXT.victor, setmana('MANANA', 'PARTIDO', 'PARTIDO', 'MANANA', 'MANANA'));
    assert.ok(p.some((x) => /consecutius/.test(x)));
  });

  test('el partit compta com una tarda, no com dues', () => {
    // 2 afternoons + 1 split = 3, which is the limit and therefore fine.
    assert.deepEqual(revisa(TEXT.gemma, setmana('MANANA', 'TARDE', 'TARDE', 'PARTIDO', 'MANANA')), []);
    // 3 afternoons + 1 split = 4, which is not.
    const p = revisa(TEXT.gemma, setmana('TARDE', 'TARDE', 'TARDE', 'PARTIDO', 'MANANA'));
    assert.ok(p.some((x) => /Màxim 3 tardes i en té 4/.test(x)));
  });

  test('un partit a qui no n\'ha de fer cap', () => {
    const p = revisa(TEXT.david, setmana('MANANA', 'MANANA', 'PARTIDO', 'LIBRE', 'LIBRE'));
    assert.ok(p.some((x) => /cap torn de DIA/.test(x)));
  });

});

// ── "Els mateixos MATINS que Nuria Bachs" ────────────────────────────────
//
// The condition that produced the worst failure of the lot: the panel called
// 2026-W33 perfect while Jordi Defaus worked a Wednesday afternoon, and the
// generation report justified it with "Nuria Bachs té LIBRE el dimecres" — a
// day off she did not have. The sentence had been recognised, filed as
// unverifiable, and the unverifiable list was read by nobody.
describe('mateixos matins que una altra persona', () => {
  const DIES = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'];
  const jordi = {
    nombre: 'Jordi', apellidos: 'Defaus',
    condicionesFijas: 'No fa festa entre setmana. Ha de fer els mateixos MATINS que Nuria Bachs. El dia que Nuria Bachs té festa, Jordi pot fer PARTIDO o TARDE.',
  };
  const setmana = (turns) => DIES.map((d, i) => ({ dia: d, turno: turns[i] || 'LIBRE' }));
  const nuria = (turns) => [{ empleado: { nombre: 'Nuria ', apellidos: 'Bachs' }, dias: setmana(turns) }];

  test('llegeix a qui es refereix', () => {
    assert.equal(parseConditions(jordi.condicionesFijas).sincronizadoCon, 'Nuria Bachs');
  });

  test('el cas real: ella fa matí el dimecres i ell tarda', () => {
    const { problemas } = checkEmployeeConditions({
      empleado: jordi,
      dias: setmana(['MANANA', 'MANANA', 'TARDE', 'MANANA', 'MANANA']),
      diasHabituales: DIES,
      companys: nuria(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA']),
    });
    assert.equal(problemas.length, 1);
    assert.match(problemas[0], /mateixos matins que Nuria Bachs/);
    assert.match(problemas[0], /dimecres \(TARDA\)/);
  });

  test('coincidint tots els matins no hi ha res a dir', () => {
    const { problemas } = checkEmployeeConditions({
      empleado: jordi,
      dias: setmana(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA']),
      diasHabituales: DIES,
      companys: nuria(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA']),
    });
    assert.deepEqual(problemas, []);
  });

  // The escape clause the prose spells out, and the reason the AI reached for
  // an invented day off in the first place.
  test('el dia que ella fa festa, ell pot fer tarda', () => {
    const { problemas } = checkEmployeeConditions({
      empleado: jordi,
      dias: setmana(['MANANA', 'MANANA', 'TARDE', 'MANANA', 'MANANA']),
      diasHabituales: DIES,
      companys: nuria(['MANANA', 'MANANA', 'LIBRE', 'MANANA', 'MANANA']),
    });
    assert.deepEqual(problemas, []);
  });

  test('un dia que ella fa tarda no diu res sobre els matins', () => {
    const { problemas } = checkEmployeeConditions({
      empleado: jordi,
      dias: setmana(['MANANA', 'TARDE', 'MANANA', 'MANANA', 'MANANA']),
      diasHabituales: DIES,
      companys: nuria(['MANANA', 'TARDE', 'MANANA', 'MANANA', 'MANANA']),
    });
    assert.deepEqual(problemas, []);
  });

  test('un PARTIDO també cobreix el matí', () => {
    const { problemas } = checkEmployeeConditions({
      empleado: jordi,
      dias: setmana(['PARTIDO', 'MANANA', 'MANANA', 'MANANA', 'MANANA']),
      diasHabituales: DIES,
      companys: nuria(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA']),
    });
    assert.deepEqual(problemas, []);
  });

  test('els dies que la botiga no obre no compten', () => {
    const { problemas } = checkEmployeeConditions({
      empleado: jordi,
      dias: setmana(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'LIBRE']),
      diasHabituales: ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES'],
      companys: nuria(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA']),
    });
    assert.deepEqual(problemas, []);
  });

  // Silence here would be the old bug in a new place.
  test('si no es troba la persona, es diu — no es dona per bona', () => {
    const { problemas, cond } = checkEmployeeConditions({
      empleado: jordi,
      dias: setmana(['MANANA', 'MANANA', 'TARDE', 'MANANA', 'MANANA']),
      diasHabituales: DIES,
      companys: [{ empleado: { nombre: 'Gemma', apellidos: 'Casanovas' }, dias: setmana(['MANANA']) }],
    });
    assert.deepEqual(problemas, []);
    assert.equal(cond.noInterpretadas.length, 1);
    assert.ok(cond.noInterpretadas.some((f) => /no s'ha trobat aquesta persona/.test(f)));
  });

  test('el nom es troba encara que porti accents o espais de més', () => {
    const companys = [{ empleado: { nombre: '  Núria ', apellidos: 'Bachs  ' }, dias: setmana(['MANANA']) }];
    assert.ok(trobaCompany('Nuria Bachs', companys));
    assert.ok(trobaCompany('NÚRIA   BACHS', companys));
    assert.equal(trobaCompany('Gemma Casanovas', companys), null);
    assert.equal(trobaCompany('', companys), null);
  });
});

// ── The families that were only ever read by the AI ──────────────────────
//
// Nine people carried thirteen sentences nothing verified. They are the real
// text from the Girona records, in the three word orders they were actually
// written in.
describe('condicionals: "si el dissabte fa MATÍ, el divendres fa PARTIDO"', () => {
  test('les tres maneres com estan escrites de debò', () => {
    assert.deepEqual(parseCondicional('Si el dissabte fa MATÍ, el divendres fa PARTIDO'),
      { siDia: 'SABADO', siTurno: 'MANANA', entoncesDia: 'VIERNES', entoncesTurno: 'PARTIDO' });
    assert.deepEqual(parseCondicional('Si fa PARTIDO el dissabte, el divendres ha de fer MATÍ'),
      { siDia: 'SABADO', siTurno: 'PARTIDO', entoncesDia: 'VIERNES', entoncesTurno: 'MANANA' });
  });

  // Both wordings are one norm, per the general manager: that day the person
  // is on the afternoon side, whichever verb the sentence happens to use.
  test('"pot fer" obliga igual que "ha de fer"', () => {
    const c = parseCondicional('I a l\'inversa: si fa MATÍ el divendres, el dissabte pot fer PARTIDO');
    assert.deepEqual(c, { siDia: 'VIERNES', siTurno: 'MANANA', entoncesDia: 'SABADO', entoncesTurno: 'PARTIDO' });
  });

  // A split shift and a plain afternoon both put the person on the afternoon,
  // which is what the rule is actually asking for.
  test('una TARDE compleix un PARTIDO obligat, i a l\'inversa', () => {
    const DIES = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'];
    const set = (...t) => t.map((x, i) => ({ dia: DIES[i], turno: x }));
    const equip = [{ empleado: { nombre: 'A', apellidos: 'B' }, dias: set('MANANA','MANANA','MANANA','MANANA','MANANA','MANANA') }];
    const esther = { condicionesFijas: 'I a l\'inversa: si fa MATÍ el divendres, el dissabte pot fer PARTIDO' };
    const p = (d) => checkEmployeeConditions({ empleado: esther, dias: d, diasHabituales: DIES, companys: equip }).problemas;

    assert.deepEqual(p(set('MANANA','MANANA','MANANA','MANANA','MANANA','PARTIDO')), []);
    assert.deepEqual(p(set('MANANA','MANANA','MANANA','MANANA','MANANA','TARDE')), []);
    const fallada = p(set('MANANA','MANANA','MANANA','MANANA','MANANA','MANANA'));
    assert.equal(fallada.length, 1);
    assert.match(fallada[0], /ha de fer DIA o TARDA, i fa MATÍ/);
  });

  // A morning obligation stays exact: it exists to keep them off the afternoon.
  test('un MATÍ obligat segueix sent un MATÍ', () => {
    const DIES = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'];
    const set = (...t) => t.map((x, i) => ({ dia: DIES[i], turno: x }));
    const equip = [{ empleado: { nombre: 'A', apellidos: 'B' }, dias: set('MANANA','MANANA','MANANA','MANANA','MANANA','MANANA') }];
    const carmen = { condicionesFijas: 'Si fa PARTIDO el dissabte, el divendres ha de fer MATÍ' };
    const p = checkEmployeeConditions({
      empleado: carmen,
      dias: set('MANANA','MANANA','MANANA','MANANA','TARDE','PARTIDO'),
      diasHabituales: DIES, companys: equip,
    }).problemas;
    assert.equal(p.length, 1);
    assert.match(p[0], /el divendres ha de fer MATÍ, i fa TARDA/);
  });

  test('el que no és un condicional no ho sembla', () => {
    assert.equal(parseCondicional('Sempre MATINS'), null);
    assert.equal(parseCondicional('Si el dissabte fa MATÍ'), null);          // sense conseqüència
    assert.equal(parseCondicional('Si fa MATÍ, el dissabte fa MATÍ'), null); // sense dia a la condició
  });

  const DIES = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'];
  const victor = { condicionesFijas: 'Si el dissabte fa MATÍ, el divendres fa PARTIDO' };
  const setmana = (t) => DIES.map((d, i) => ({ dia: d, turno: t[i] || 'LIBRE' }));
  // Somebody else works every day, so no day counts as a closure.
  const equip = [{ empleado: { nombre: 'Altre', apellidos: 'Company' }, dias: setmana(['MANANA','MANANA','MANANA','MANANA','MANANA','MANANA']) }];
  const revisa = (emp, dias) => checkEmployeeConditions({ empleado: emp, dias, diasHabituales: DIES, companys: equip }).problemas;

  test('es dispara quan la condició es compleix i la conseqüència no', () => {
    const p = revisa(victor, setmana(['MANANA','MANANA','MANANA','MANANA','MANANA','MANANA']));
    assert.equal(p.length, 1);
    assert.match(p[0], /el divendres ha de fer DIA o TARDA, i fa MATÍ/);
  });

  test('no diu res quan la condició no es dispara', () => {
    assert.deepEqual(revisa(victor, setmana(['MANANA','MANANA','MANANA','MANANA','MANANA','TARDE'])), []);
  });

  test('complint-se les dues bandes, no hi ha res a dir', () => {
    assert.deepEqual(revisa(victor, setmana(['MANANA','MANANA','MANANA','MANANA','PARTIDO','MANANA'])), []);
  });

  // The 15th of August: the shop shuts, nobody works, and it is not the
  // employee's doing.
  test('un dia que la botiga tanca no dispara res', () => {
    const tancat = [{ empleado: { nombre: 'Altre', apellidos: 'Company' }, dias: setmana(['MANANA','MANANA','MANANA','MANANA','MANANA','LIBRE']) }];
    const p = checkEmployeeConditions({
      empleado: victor,
      dias: setmana(['MANANA','MANANA','MANANA','MANANA','MANANA','LIBRE']),
      diasHabituales: DIES, companys: tancat,
    }).problemas;
    assert.deepEqual(p, []);
  });
});

describe('les altres famílies que ningú comprovava', () => {
  const DIES = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'];
  const setmana = (t) => DIES.map((d, i) => ({ dia: d, turno: t[i] || 'LIBRE' }));
  const tothomTreballa = [{ empleado: { nombre: 'A', apellidos: 'B' }, dias: setmana(['MANANA','MANANA','MANANA','MANANA','MANANA','MANANA']) }];

  test('"No fa festa entre setmana"', () => {
    const jordi = { condicionesFijas: 'No fa festa entre setmana' };
    const p = checkEmployeeConditions({ empleado: jordi, dias: setmana(['MANANA','LIBRE','MANANA','MANANA','MANANA','MANANA']),
      diasHabituales: DIES, companys: tothomTreballa }).problemas;
    assert.equal(p.length, 1);
    assert.match(p[0], /No ha de fer festa entre setmana.*dimarts/);
  });

  // Jordi Defaus works six days and the shop shuts on the 15th. Counting that
  // as a day he took off is the mistake Roger already corrected once.
  test('un festiu no compta com a festa seva', () => {
    const jordi = { condicionesFijas: 'No fa festa entre setmana' };
    const tancatDissabte = [{ empleado: { nombre: 'A', apellidos: 'B' }, dias: setmana(['MANANA','MANANA','MANANA','MANANA','MANANA','LIBRE']) }];
    const p = checkEmployeeConditions({ empleado: jordi, dias: setmana(['MANANA','MANANA','MANANA','MANANA','MANANA','LIBRE']),
      diasHabituales: DIES, companys: tancatDissabte }).problemas;
    assert.deepEqual(p, []);
  });

  // The sentence the manager reads and the column the engine obeys, held
  // against each other for the first time.
  test('la prosa i la fitxa han de dir el mateix sobre la jornada reduïda', () => {
    const text = 'Sempre el mateix horari: de 8:00 a 12:00. Jornada reduïda de 4h per torn, contracte de 20h/setmana';
    const dias = setmana(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA']);
    const args = (emp) => ({ empleado: { condicionesFijas: text, ...emp }, dias, diasHabituales: DIES, companys: tothomTreballa });

    assert.deepEqual(checkEmployeeConditions(args({ horasPorTurno: 4, horaEntradaManana: '08:00' })).problemas, []);
    assert.match(checkEmployeeConditions(args({ horasPorTurno: 6, horaEntradaManana: '08:00' })).problemas[0], /4h per torn i la fitxa en diu 6/);
    assert.match(checkEmployeeConditions(args({ horaEntradaManana: '08:00' })).problemas[0], /la fitxa no en té cap posada/);
    assert.match(checkEmployeeConditions(args({ horasPorTurno: 4, horaEntradaManana: '09:00' })).problemas[0], /entra a les 8:00 i la fitxa diu 09:00/);
  });

  test('"8:00" i "08:00" són la mateixa hora', () => {
    const text = 'Sempre el mateix horari: de 8:00 a 12:00';
    const { problemas } = checkEmployeeConditions({
      empleado: { condicionesFijas: text, horaEntradaManana: '08:00' },
      dias: setmana(['MANANA']), diasHabituales: DIES, companys: tothomTreballa,
    });
    assert.deepEqual(problemas, []);
  });

  // Listing these as unchecked was noise that hid the real gaps.
  test('les frases que descriuen no són regles pendents', () => {
    for (const f of ['És encarregada de la botiga', 'Exemple correcte: 1 PARTIDO + 2 TARDE = 3 tardes']) {
      assert.deepEqual(parseConditions(f).noInterpretadas, [], f);
    }
  });
});

 test('afternoon-only whole-week prose forbids mornings and split shifts without broadening weekday conditions', async () => {
  const { turnoPermitido } = await import('../src/services/conditionCheck.js');
  const c = parseConditions('Siempre hace de tardes, de 16h hasta el cierre. Nunca días ni mañanas');
  assert.equal(c.soloTardes, true);
  assert.equal(turnoPermitido(c, 'MANANA'), false);
  assert.equal(turnoPermitido(c, 'PARTIDO'), false);
  assert.equal(turnoPermitido(c, 'TARDE'), true);
  assert.notEqual(parseConditions('El lunes siempre tardes').soloTardes, true);
  assert.notEqual(parseConditions('Si el sábado trabaja, siempre hace tardes').soloTardes, true);
  assert.notEqual(parseConditions('Nunca hace tardes').soloTardes, true);
  assert.equal(checkEmployeeConditions({ empleado: { condicionesFijas: 'Siempre hace de tardes' }, dias: [{ dia: 'LUNES', turno: 'PARTIDO' }], idioma: 'es' }).problemas.length, 1);
 });
