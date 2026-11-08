import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// El 18 d'agost el bot li va contestar a la Neus: «con tu contrato de 40 horas
// semanales solo puedes solicitar un máximo de 2 días libres». El prompt JA li
// deia que no mencionés mai el contracte, i ho va fer igualment — perquè la
// línia de sobre l'hi donava, amb la fórmula i tot.
//
// La lliçó: a un model no se li dona una dada i se li demana que se la calli.
// Se li dona el que necessita per decidir i prou.
const FONT = readFileSync(new URL('../src/services/whatsapp.js', import.meta.url), 'utf8');

// Només el text del prompt del treballador, no tot el fitxer: `maxHoras` s'ha de
// poder continuar fent servir per calcular.
// Es busca el final de debò de la plantilla i no una finestra de N caràcters:
// el prompt creix a cada millora, i amb un número fix arriba el dia que se'l
// passa i les proves deixen de veure'n el final sense dir-ho. Una prova que
// dona confiança sense donar cobertura és pitjor que no tenir-ne.
const INICI = FONT.indexOf('const systemPrompt = `');
const FINAL = FONT.indexOf('`;', INICI);
const PROMPT = FONT.slice(INICI, FINAL);

describe('el prompt del treballador no porta el seu contracte', () => {
  test('el tall agafa el prompt sencer', () => {
    // Si això falla, totes les proves de sota estaven mirant un tros i no el
    // text complet: qualsevol fuita al final hauria passat sense avisar.
    assert.ok(INICI > 0, 'no s\'ha trobat on comença el prompt');
    assert.ok(FINAL > INICI, 'no s\'ha trobat on acaba el prompt');
    assert.ok(PROMPT.includes('REGLAS DE VALIDACIÓN'), 'falta el bloc de regles');
    // El tall busca el primer accent greu seguit de punt i coma. Dins del prompt
    // n'hi ha sis més, d'accents greus, dins d'interpolacions: avui cap va
    // seguit de `;` per casualitat, i el dia que algú n'afegeixi un que sí, el
    // tall s'avançaria i totes les proves de sota mirarien un tros. Es comprova
    // que just després del tall hi hagi el que hi ha d'haver.
    assert.match(FONT.slice(FINAL, FINAL + 3), /^`;/, 'el tall no cau on toca');
    // Que el tall arribi fins al final es comprova amb l'ÚLTIMA regla del
    // prompt, i no amb el comentari que ve després: aquell el pot reescriure
    // qualsevol i faria fallar aquesta prova sense que res estigués malament.
    assert.ok(PROMPT.includes('C) Mensajes irrelevantes') || PROMPT.includes('irrelevant'),
      'el tall s\'ha avançat: falta el final del prompt');
  });

  test('no hi va el número d\'hores setmanals', () => {
    assert.doesNotMatch(PROMPT, /\$\{maxHoras\}/,
      'el contracte torna a ser al prompt: el model l\'acabarà dient');
  });

  test('ni la fórmula d\'on surten els dies', () => {
    assert.doesNotMatch(PROMPT, /8h\/día|máximo 8h/);
  });

  test('el llindar hi és, que el necessita per detectar el cas', () => {
    assert.match(PROMPT, /\$\{minDiasNecesarios\}/);
  });

  test('i se li diu que no el citi', () => {
    assert.match(PROMPT, /NUNCA se lo digas ni lo cites/);
    assert.match(PROMPT, /ni ningún número ni cálculo/);
  });
});

describe('el bot sap coses de la botiga i de la fitxa', () => {
  test('sap quins dies tanca la botiga', () => {
    assert.match(PROMPT, /La tienda CIERRA estos días/);
    assert.match(PROMPT, /diesTancats/);
  });

  test('i té les condicions que ja consten a la fitxa', () => {
    assert.match(PROMPT, /employee\.condicionesFijas/);
    assert.match(PROMPT, /se aplican SIEMPRE, sin que las tenga que pedir/);
  });

  test('no apunta com a dia lliure un dia que ja està tancat', () => {
    // Apuntar-lo li gastaria un dels dos dies que sí que pot demanar, a canvi
    // de res: aquell dia ja lliura tothom.
    assert.match(PROMPT, /NO lo anotes en "diasNoDisponible"/);
    assert.match(PROMPT, /NUNCA preguntes por su disponibilidad en un día cerrado/);
  });

  test('la fitxa es mira ABANS de dir-li que no tria torn', () => {
    // El 19 d'agost, a «vull tots els torns de matí» d'algú que té «sempre
    // matins» a la fitxa, el bot li va contestar que no pot triar torn. La
    // regla hi era; el que faltava era l'ordre.
    assert.match(PROMPT, /ANTES de decirle que no puede elegir turno, MIRA sus condiciones de ficha/);
  });

  test('el que ja consta a la fitxa no es torna a apuntar', () => {
    assert.match(PROMPT, /NO lo anotes otra vez en "diasNoDisponible" ni en "turnosPorDia"/);
  });

  test('i no els pregunta si tenen dies no disponibles com si n\'esperés', () => {
    assert.match(PROMPT, /NO se lo preguntes como si esperaras que tenga alguno/);
  });

  test('tancar la conversa no passa per davant de les regles que diuen que no', () => {
    // La regla A (massa dies lliures) i la C (missatges fora de tema) diuen
    // expressament que NO es marqui com a completa. Dir «tanca» sense excepció
    // ho deixava a la interpretació del model.
    assert.match(PROMPT, /SALVO que se active la regla A o la C de más abajo/);
  });

  test('una llista de dies d\'obertura absurda no fa tancar la botiga set dies', () => {
    assert.match(FONT, /Array\.isArray\(oberts\) && oberts\.length > 0/);
  });

  test('i no els ho torna a preguntar un cop ja han contestat', () => {
    // Preguntar-ho una segona vegada amb altres paraules és el que fa que el
    // xat sembli un formulari. Si no ha mencionat cap dia, és que no en té.
    assert.match(PROMPT, /UNA SOLA VEZ EN TODA LA CONVERSACIÓN/);
    assert.match(PROMPT, /Si ya se lo has preguntado UNA vez, NO se lo preguntes más/);
    // Que una conversa sense cap dia ni cap necessitat és NORMAL i completa, no
    // una conversa a mitges: és el que el feia allargar-se buscant dades.
    assert.match(PROMPT, /Eso es lo NORMAL, no una conversación a medias/);
  });
});
