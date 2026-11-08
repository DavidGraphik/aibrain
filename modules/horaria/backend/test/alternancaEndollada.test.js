import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Mira el codi font i no el resultat de cridar les funcions, perquè el circuit
// del xatbot necessita base de dades i aquí no n'hi ha.
//
// Existeix per la lliçó del 17 d'agost: aquell mateix dia es va provar una regla
// (`falla`) que es calculava i no s'endollava enlloc, i les proves passaven
// totes mentre l'alarma real estava apagada. Provar la regla sense provar el
// cable dona confiança sense donar cobertura.
const FONT = readFileSync(new URL('../src/services/whatsapp.js', import.meta.url), 'utf8');

describe('l\'avís de l\'alternança està endollat al xatbot', () => {
  test('la regla s\'importa i es crida', () => {
    assert.match(FONT, /import \{[\s\S]*?avisAlDemanar[\s\S]*?\} from '\.\/saturdayRotation\.js'/);
    assert.match(FONT, /avisAlDemanar\(\{/, 'la funció no es crida enlloc');
  });

  test('es consulta l\'historial de dissabtes de la persona', () => {
    assert.match(FONT, /ultimDissabteDe\(employee\.id, conv\.semana, /);
  });

  test('el torn que trenca l\'alternança NO es desa a la preferència', () => {
    // Si es desés esperant el «no», un «no» que no arribés mai el deixaria
    // concedit — que és exactament el que volíem deixar de fer.
    assert.match(FONT, /delete turnosPorDia\.SABADO/);
  });

  test('el que s\'espera queda desat a la conversa, no a la memòria', () => {
    // A la memòria es perdria a cada reinici del Render, que passa unes quantes
    // vegades al dia.
    assert.match(FONT, /pendentAlternanca: pendentDissabte/);
  });

  test('i es neteja en contestar, tant si diu sí com si diu no', () => {
    assert.match(FONT, /pendentAlternanca: null/);
  });

  test('l\'avís arriba de debò al missatge que se li envia', () => {
    // El pas que més fàcil és descuidar: calcular l'avís i no posar-lo al text.
    assert.match(FONT, /avisAlternanca \?[\s\S]{0,80}replyToSend/);
  });

  test('el sí i el no tenen cadascun la seva resposta', () => {
    assert.match(FONT, /textAlternancaSi\(demanat, idioma\)/);
    assert.match(FONT, /textAlternancaNo\(idioma\)/);
  });
});

describe('el dissabte no es pot perdre pel camí', () => {
  test('un dissabte ja confirmat es conserva si la ronda no en parla', () => {
    // Cada ronda la IA torna a deduir les preferències senceres i el que es desa
    // reemplaça el que hi havia. El dissabte confirmat no surt de la IA —el vam
    // escriure nosaltres quan va dir que sí— o sigui que una ronda posterior
    // sobre el dimecres l'hauria esborrat sense que ningú el retirés.
    assert.match(FONT, /const parlaDelDissabte = 'SABADO' in turnosPorDia/);
    assert.match(FONT, /if \(!parlaDelDissabte && dissabteJaConfirmat\) turnosPorDia\.SABADO = dissabteJaConfirmat/);
  });

  test('no es torna a preguntar el que ja estava confirmat', () => {
    assert.match(FONT, /if \(turnosPorDia\.SABADO && !dissabteJaConfirmat\)/);
  });

  test('una pregunta sense resposta no s\'esborra sola', () => {
    // `pendentDissabte` és local i es reinicia a cada missatge: escrit a cegues,
    // qualsevol ronda sobre una altra cosa deixava la pregunta sense rastre.
    assert.match(FONT, /pendentAlternanca: pendentDissabte \?\? conv\.pendentAlternanca \?\? null/);
  });

  test('l\'historial de dissabtes no barreja botigues', () => {
    // L'alternança és el repartiment dels dissabtes DINS d'una botiga.
    assert.match(FONT, /async function ultimDissabteDe\(empleadoId, semana, establecimientoId\)/);
    assert.match(FONT, /where: \{ empleadoId, establecimientoId, dia: 'SABADO'/);
    assert.match(FONT, /ultimDissabteDe\(employee\.id, conv\.semana, employee\.establecimientoId\)/);
  });

  test('la IA sap que hi ha una pregunta esperant resposta', () => {
    // Si no, una resposta que no sigui exactament «sí» o «no» deixava la
    // pregunta òrfena: ni contestada ni tornada a fer.
    assert.match(FONT, /conv\.pendentAlternanca \? `## HAY UNA PREGUNTA TUYA SIN RESPONDER/);
  });
});

describe('un «val» no es pot perdre pel camí', () => {
  test('el bloc de la pregunta pendent fa servir els patrons amples', () => {
    // La prova que faltava. La primera versió comprovava que el patró
    // reconegués «val» — cert, però el patró no es feia servir enlloc: la
    // substitució havia fallat en silenci per dos espais d'indentació i les
    // proves passaven igual. Tercera vegada aquesta setmana provant la regla
    // sense provar el cable.
    assert.match(FONT, /const esSi = SI_DISSABTE\.test\(texto\);/);
    assert.match(FONT, /const esNo = NO_DISSABTE\.test\(texto\);/);
    // I que siguin els d'aquest bloc i no els d'un altre lloc.
    const bloc = FONT.slice(FONT.indexOf('if (conv.pendentAlternanca) {'), FONT.indexOf('reason: esSi'));
    assert.ok(bloc.includes('SI_DISSABTE'), 'el bloc de la pregunta pendent no els fa servir');
  });

  test('les paraules amb què la gent diu que sí, totes reconegudes', () => {
    const SI = FONT.match(/const SI_DISSABTE = (\/.*\/i);/);
    assert.ok(SI, 'no s\'ha trobat el patró del sí');
    const re = new RegExp(SI[1].slice(1, -2), 'i');
    for (const t of ['sí', 'val', 'vale', 'entesos', 'perfecte', 'genial', 'ok', 'd\'acord', 'clar']) {
      assert.match(t, re, `«${t}» hauria de comptar com a sí`);
    }
  });

  test('i amb una pregunta pendent no es calla mai', () => {
    // Això no depèn d'encertar cap llista, i per això és la meitat que aguanta.
    assert.match(FONT, /if \(!conv\.pendentAlternanca && esComiat\(texto\)\)/);
  });

  test('el sí del dissabte no toca el de les absències de l\'encarregada', () => {
    // Confirmar una baixa mèdica amb un «genial» seria massa lleuger.
    assert.match(FONT, /const AFFIRMATIVE = /);
    assert.doesNotMatch(FONT, /const AFFIRMATIVE = \/\^\\s\*\(s\[ií\]\|sisi/);
  });
});
