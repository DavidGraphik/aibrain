import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ─────────────────────────────────────────────
// QUE LES CONDICIONS ARRIBIN AL MOTOR
//
// Provar la regla sense provar el cable dona confiança sense donar cobertura.
// Aquesta setmana ja ha passat tres vegades: una regla que es calculava i no
// s'endollava enlloc, una taula de torns amb titlla que es desava i el motor
// descartava, i un camp que es podia escriure i no arribava a desar-se.
//
// El mòdul de les condicions està provat sol amb tres mil combinacions. Això
// comprova l'altra meitat: que el motor el cridi, que li carregui les dades i
// que ho faci al lloc de la fila que toca.
// ─────────────────────────────────────────────
const MOTOR = readFileSync(new URL('../src/services/aiScheduler.js', import.meta.url), 'utf8');

describe('les condicions estan endollades al motor', () => {
  test('s\'importen i es criden', () => {
    assert.match(MOTOR, /import \{ aplicaAUnaPersona, sincronitzaMatins \} from '\.\/passadesCondicions\.js'/);
    assert.match(MOTOR, /sincronitzaMatins\(scheduleData\.horario,/, 'la sincronització no es crida');
    assert.match(MOTOR, /aplicaCondicionsFixes\(scheduleData\.horario, employees, rules, festivoDays\)/,
      'la passada no es crida enlloc');
    assert.match(MOTOR, /aplicaAUnaPersona\(empSched\.dias, cond, \{/);
  });

  test('el camp es carrega de la base de dades', () => {
    // Sense això, `emp.condicionesEstructuradas` seria undefined per a tothom i
    // la passada no faria res, en silenci i amb totes les proves en verd.
    assert.match(MOTOR, /condicionesEstructuradas: true,/);
  });

  test('i cap passada posterior la pot desfer', () => {
    // El forat que el comentari deia haver tapat i no tapava: quedaven quatre
    // passades al darrere que no saben què és una condició estructurada i que
    // movien torns acabats de fixar.
    const pos = (t) => MOTOR.indexOf(t);
    const condicions = pos('aplicaCondicionsFixes(scheduleData.horario');
    for (const despres of [
      'recolocarFestes(scheduleData.horario',
      'cobrirAmbPartits(scheduleData.horario',
      'ajustarAlternancaDissabtes(scheduleData.horario',
      'honrarRecuentosExactos(scheduleData.horario',
    ]) {
      assert.ok(pos(despres) > 0 && pos(despres) < condicions,
        `${despres} corre DESPRÉS de les condicions i les pot desfer`);
    }
    // L'única que hi pot anar al darrere és la que posa les hores d'entrada,
    // que no mou cap torn.
    const ultima = pos('aplicarHorasFijas(scheduleData.horario');
    assert.ok(ultima > condicions, 'les hores es posen al final de tot');
  });

  test('va després de tot el que mana més', () => {
    // L'ordre de la fila no és decoratiu: si anés abans, les passades de
    // reparació desfarien les condicions, que és exactament el problema que
    // aquest canvi ha d'arreglar.
    const pos = (t) => MOTOR.indexOf(t);
    const condicions = pos('aplicaCondicionsFixes(scheduleData.horario');
    for (const abans of [
      'repairSchedule(scheduleData.horario',
      'enforceAvailability(scheduleData.horario',
      'forceClosedDays(scheduleData.horario',
      'forcePreferenceDaysOff(scheduleData.horario',
      'forceShiftRestrictions(scheduleData.horario',
    ]) {
      assert.ok(pos(abans) > 0 && pos(abans) < condicions, `${abans} ha d'anar abans de les condicions`);
    }
  });

  test('no toca el que la persona ha demanat aquesta setmana', () => {
    const cos = MOTOR.slice(MOTOR.indexOf('function aplicaCondicionsFixes'));
    assert.match(cos, /esIntocable: \(dia\) => demanats\.has\(dia\)/);
    assert.match(cos, /turnosPorDiaPreferencia/);
    assert.match(cos, /diasPreferenciaLibre/);
  });

  test('i no fa cap canvi que deixi el dia sense prou gent', () => {
    const cos = MOTOR.slice(MOTOR.indexOf('function aplicaCondicionsFixes'));
    assert.match(cos, /deixaMarge: marge\(horario, employees, rules, emp\)/);
    // La comprovació viu en una funció compartida perquè les dues passades que
    // la necessiten no acabin comprovant coses diferents.
    assert.match(MOTOR, /countForDay\(horario, employees, dia, emp\.funcion, slot\) <= \(min \?\? 0\)/);
  });

  test('i no posa ningú a treballar un dia que no és seu', () => {
    // «No fa festa entre setmana» és l'única condició que s'omple AFEGINT un
    // torn. Un dia de baixa o amb la botiga tancada també és LIBRE, i des de
    // la passada no es distingeixen.
    const cos = MOTOR.slice(MOTOR.indexOf('function aplicaCondicionsFixes'));
    // Els TRES motius. El de l'altra botiga se'm va escapar i és el que més
    // mal faria: qui aquell dia ja hi treballa quedaria compromès dues vegades.
    assert.match(cos, /potTreballar: \(dia\) => !emp\.diasAusente\?\.\[dia\]/);
    assert.match(cos, /!emp\.diasOcupadosOtrosEstablecimientos\?\.\[dia\]/);
    assert.match(cos, /!festivoDays\.includes\(dia\)/);
    assert.match(MOTOR, /aplicaCondicionsFixes\(scheduleData\.horario, employees, rules, festivoDays\)/);
  });

  test('els canvis queden al registre, per poder mirar què va passar', () => {
    assert.match(MOTOR, /\[Condicions\] \$\{emp\.nombre\}/);
  });
});
