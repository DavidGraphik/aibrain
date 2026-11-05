import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fusionaPaperIWhatsapp, marquesDelFull, TORN_DE_LA_MARCA } from '../src/utils/fusioPaper.js';
import { alternancaCompleix } from '../src/services/saturdayRotation.js';

describe('el full de paper i el WhatsApp', () => {
  test('sense res dit abans, el full val tot sencer', () => {
    const r = fusionaPaperIWhatsapp({ LUNES: 'MANANA', SABADO: 'MANANA' }, null);
    assert.deepEqual(r.turnosPorDia, { LUNES: 'MANANA', SABADO: 'MANANA' });
    assert.deepEqual(r.conflictes, []);
  });

  // El cas que va decidir la regla.
  test('la Montse: matí al full, festa pel WhatsApp → queda festa', () => {
    const r = fusionaPaperIWhatsapp(
      { MIERCOLES: 'MANANA', JUEVES: 'MANANA' },
      { diasNoDisponible: ['MIERCOLES'], turnosPorDia: {} },
    );
    assert.equal(r.turnosPorDia.MIERCOLES, undefined, 'el dimecres no ha de quedar cap torn');
    assert.equal(r.turnosPorDia.JUEVES, 'MANANA', 'el dijous, que no es contradiu, sí que val');
    assert.deepEqual(r.conflictes, [{ dia: 'MIERCOLES', deiaElFull: 'MANANA', mana: 'FESTA' }]);
  });

  test('si pel WhatsApp va demanar l\'altre torn, mana el WhatsApp', () => {
    const r = fusionaPaperIWhatsapp(
      { VIERNES: 'MANANA' },
      { diasNoDisponible: [], turnosPorDia: { VIERNES: 'TARDE' } },
    );
    assert.equal(r.turnosPorDia.VIERNES, 'TARDE');
    assert.equal(r.conflictes.length, 1);
  });

  test('dir el mateix als dos llocs no és cap conflicte', () => {
    const r = fusionaPaperIWhatsapp(
      { VIERNES: 'TARDE' },
      { diasNoDisponible: [], turnosPorDia: { VIERNES: 'TARDE' } },
    );
    assert.equal(r.turnosPorDia.VIERNES, 'TARDE');
    assert.deepEqual(r.conflictes, [], 'avisar d\'un xoc que no existeix és soroll');
  });

  // Es resol dia per dia i no tota la fila: si es descartés la fila sencera,
  // parlar d'un sol dia pel WhatsApp esborraria la resta del que va apuntar.
  test('el que no es contradiu es conserva', () => {
    const r = fusionaPaperIWhatsapp(
      { LUNES: 'MANANA', MARTES: 'MANANA', SABADO: 'TARDE' },
      { diasNoDisponible: ['MARTES'], turnosPorDia: {} },
    );
    assert.deepEqual(r.turnosPorDia, { LUNES: 'MANANA', SABADO: 'TARDE' });
  });

  test('el que ja hi havia no es perd encara que el full no en digui res', () => {
    const r = fusionaPaperIWhatsapp(
      { LUNES: 'MANANA' },
      { diasNoDisponible: [], turnosPorDia: { DOMINGO: 'TARDE' } },
    );
    assert.equal(r.turnosPorDia.DOMINGO, 'TARDE');
  });
});

describe('recuperar el que deia el full d\'una persona', () => {
  const lectura = {
    empleados: [
      { nombreEnPapel: 'MONTSE SURROCA', empleadoId: 7, marcas: [
        { dia: 'MIERCOLES', marca: 'M' }, { dia: 'JUEVES', marca: 'M' }] },
      { nombreEnPapel: 'EVA MADEMONT', empleadoId: 9, marcas: [
        { dia: 'LUNES', marca: 'T' }, { dia: 'SABADO', marca: 'T' }] },
      { nombreEnPapel: 'ALGÚ QUE NO HI ÉS', empleadoId: null, marcas: [{ dia: 'LUNES', marca: 'M' }] },
    ],
  };

  test('en treu les seves i no les dels altres', () => {
    assert.deepEqual(marquesDelFull(lectura, 7), { MIERCOLES: 'MANANA', JUEVES: 'MANANA' });
    assert.deepEqual(marquesDelFull(lectura, 9), { LUNES: 'TARDE', SABADO: 'TARDE' });
  });

  test('de qui no hi surt, res', () => {
    assert.deepEqual(marquesDelFull(lectura, 999), {});
  });

  test('sense full, res — i sense petar', () => {
    assert.deepEqual(marquesDelFull(null, 7), {});
    assert.deepEqual(marquesDelFull(undefined, 7), {});
    assert.deepEqual(marquesDelFull({}, 7), {});
    assert.deepEqual(marquesDelFull(lectura, null), {}, 'sense id no pot coincidir amb el null del paper');
  });

  test('ignora dies i marques que no siguin dels que esperem', () => {
    const brut = { empleados: [{ empleadoId: 7, marcas: [
      { dia: 'LUNES', marca: 'X' }, { dia: 'FUNDAY', marca: 'M' }, { dia: 'MARTES', marca: 'T' }] }] };
    assert.deepEqual(marquesDelFull(brut, 7), { MARTES: 'TARDE' });
  });

  // El cas que va motivar tot això: escriure pel WhatsApp per una cosa no ha
  // d'esborrar la resta del que havia apuntat al full.
  test('escriure pel WhatsApp per un dia no s\'endú els altres', () => {
    const delFull = marquesDelFull(lectura, 7);            // MIE i JUE, del paper
    const laConversa = { diasNoDisponible: ['VIERNES'], turnosPorDia: {} };  // només parla del divendres
    const r = fusionaPaperIWhatsapp(delFull, laConversa);
    assert.equal(r.turnosPorDia.MIERCOLES, 'MANANA');
    assert.equal(r.turnosPorDia.JUEVES, 'MANANA');
    assert.deepEqual(r.conflictes, []);
  });

  test('i si en parla, mana el que ha dit ara', () => {
    const r = fusionaPaperIWhatsapp(marquesDelFull(lectura, 7), {
      diasNoDisponible: ['MIERCOLES'], turnosPorDia: {},
    });
    assert.equal(r.turnosPorDia.MIERCOLES, undefined);
    assert.equal(r.turnosPorDia.JUEVES, 'MANANA');
  });
});

// Provar la regla sense provar el cable dona confiança sense donar cobertura:
// aquesta setmana ja s'ha provat una regla que es calculava i no s'endollava
// enlloc, i les proves passaven totes.
const FONT = readFileSync(new URL('../src/services/whatsapp.js', import.meta.url), 'utf8');

describe('la fusió està endollada al lector de fulls', () => {
  test('s\'importa i es crida', () => {
    assert.match(FONT, /import \{[^}]*fusionaPaperIWhatsapp[^}]*\} from '\.\.\/utils\/fusioPaper\.js'/);
    assert.match(FONT, /fusionaPaperIWhatsapp\(delPaper, jaDit\)/, 'no es crida enlloc');
  });

  test('les marques del full es desen a turnosPorDia, no només com a text', () => {
    // A `notasAdicionales` el motor només les mira una vegada, per passar-les a
    // la IA com a text. A `turnosPorDia` hi ha passades deterministes que les
    // garanteixen. Anar només al text feia que una M del paper valgués menys
    // que la mateixa M dita pel WhatsApp.
    // Ancorada a la línia sencera: sense això també comptava la línia on es
    // desestructura el resultat de la fusió, i en donava tres.
    const desades = FONT.match(/^ +turnosPorDia: turnosFinals,$/gm) || [];
    assert.equal(desades.length, 2,
      'ha d\'anar tant quan es crea com quan s\'actualitza');
  });

  test('només compta com a «ja dit» el que no ve del paper', () => {
    assert.match(FONT, /existing\.recogidoVia !== 'PAPEL' \? existing : null/);
  });

  test('l\'origen no passa a PAPEL si venia de la persona', () => {
    // Si s'hi posés, la propera foto del mateix full ja no el veuria com a seu
    // i li passaria per sobre.
    assert.match(FONT, /\.\.\.\(jaDit \? \{\} : \{ recogidoVia: 'PAPEL' \}\)/);
  });

  test('el que va dir pel WhatsApp no s\'esborra de les notes', () => {
    assert.match(FONT, /jaDit\?\.notasAdicionales \? `\$\{jaDit\.notasAdicionales\}/);
  });

  test('els xocs es diuen a l\'encarregada', () => {
    assert.match(FONT, /conflictes\.push\(/);
    assert.match(FONT, /for \(const c of conflictes\) lines\.push/,
      'es calculen però no surten a la resposta');
  });
});

describe('el full no es perd quan es contesta pel WhatsApp', () => {
  test('es va a buscar el full de la setmana i s\'hi fusiona', () => {
    assert.match(FONT, /import \{[^}]*marquesDelFull[^}]*\} from '\.\.\/utils\/fusioPaper\.js'/);
    assert.match(FONT, /prisma\.paperSheet\.findFirst\(\{/, 'no es busca el full enlloc');
    assert.match(FONT, /marquesDelFull\(fullDeLaSetmana\?\.lectura, employee\.id\)/);
  });

  test('el que guanya el full s\'escriu a turnosPorDia abans de desar', () => {
    assert.match(FONT, /for \(const \[dia, torn\] of Object\.entries\(fusio\.guanyats\)\) turnosPorDia\[dia\] = torn;/);
    // Si anés després de l'upsert no serviria de res.
    assert.ok(FONT.indexOf('fusio.guanyats') < FONT.indexOf('// Upsert preference'),
      'la fusió ha d\'anar abans de desar');
  });

  test('es busca el full de la botiga i la setmana de la conversa', () => {
    assert.match(FONT, /establecimientoId: employee\.establecimientoId, semana: conv\.semana/);
    assert.match(FONT, /orderBy: \{ createdAt: 'desc' \}/, 'si se n\'ha pujat més d\'un, val l\'últim');
  });
});

// El dissabte no és una preferència personal sinó un repartiment entre
// companys. Quan el demanen pel WhatsApp se'ls avisa i decideix l'encarregada;
// del full no se'ls pot preguntar, i mentre les marques eren només text no
// importava perquè no es concedien. En passar-les a `turnosPorDia` vaig canviar
// perdre les marques del full per perdre el repartiment dels dissabtes.
describe('el dissabte del full també passa pel repartiment', () => {
  test('hi ha una sola comprovació i la fan servir els dos camins', () => {
    assert.match(FONT, /async function dissabteDelFullPassa\(/);
    const crides = FONT.match(/await dissabteDelFullPassa\(/g) || [];
    assert.equal(crides.length, 2,
      'l\'ha de fer tant qui puja el full com qui recupera les marques en contestar');
  });

  test('decideix amb la mateixa regla que la conversa, no amb una de pròpia', () => {
    assert.match(FONT, /import \{[\s\S]*?alternancaCompleix[\s\S]*?\} from '\.\/saturdayRotation\.js'/);
    assert.match(FONT, /alternancaCompleix\(ultim\?\.turno, demanat\)/);
  });

  test('el dissabte que no passa no es desa, per cap dels dos camins', () => {
    assert.equal((FONT.match(/delete delPaper\.SABADO;/g) || []).length, 1);
    assert.equal((FONT.match(/delete delFull\.SABADO;/g) || []).length, 1);
  });

  test('en pujar el full es diu a l\'encarregada, que és qui pot decidir', () => {
    assert.match(FONT, /dissabtes\.push\(/);
    assert.match(FONT, /for \(const d of dissabtes\) lines\.push/,
      'es recullen però no surten a la resposta');
  });

  test('la comprovació va ABANS de desar res', () => {
    // Si anés després, el dissabte ja hi seria.
    const i = FONT.indexOf('delete delPaper.SABADO;');
    const j = FONT.indexOf('const existing = await prisma.shiftPreference.findFirst({\n      where: { empleadoId: empPaper.empleadoId');
    assert.ok(i > 0 && j > i, 'el control ha d\'anar abans de buscar i desar la preferència');
  });

  test('sense cap dissabte treballat abans, no es bloqueja res', () => {
    // A qui acaba d'entrar no se li pot dir que li «toca» res.
    assert.match(FONT, /if \(!demanat\) return \{ passa: true \};/);
  });
});

// ─────────────────────────────────────────────
// EL VALOR, NO LA FORMA
//
// Les proves de dalt comproven que el codi crida el que ha de cridar. Cap
// executava el que en surt, i per això no van veure que el lector del full
// escrivia 'MAÑANA' amb titlla mentre tota l'app fa servir 'MANANA' sense: es
// desava bé, i el motor —que descarta el que no reconeix, sense dir res— se les
// menjava totes. Les marques de matí d'un full pujat no arribaven a l'horari.
//
// Provar el cable tampoc no n'hi ha prou si pel cable hi passa el valor
// equivocat.
// ─────────────────────────────────────────────
const ESQUEMA = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const MOTOR = readFileSync(new URL('../src/services/aiScheduler.js', import.meta.url), 'utf8');

describe('el torn que surt del full és el que entén la resta de l\'app', () => {
  test('és un dels valors que existeixen a la base de dades', () => {
    const enumTorns = ESQUEMA.slice(ESQUEMA.indexOf('enum TurnoTipo'));
    const valids = enumTorns.slice(0, enumTorns.indexOf('}')).match(/^\s+(\w+)$/gm).map((x) => x.trim());
    for (const [marca, torn] of Object.entries(TORN_DE_LA_MARCA)) {
      assert.ok(valids.includes(torn), `la marca ${marca} dona "${torn}", que no és cap TurnoTipo`);
    }
  });

  test('el motor no el descarta', () => {
    // El filtre del motor, tal com està escrit: el que no hi encaixa desapareix
    // sense cap avís ni error.
    assert.match(MOTOR, /t === 'MANANA' \|\| t === 'TARDE'/,
      'ha canviat el filtre del motor: repassa què accepta');
    for (const torn of Object.values(TORN_DE_LA_MARCA)) {
      assert.ok(torn === 'MANANA' || torn === 'TARDE', `el motor descartaria "${torn}"`);
    }
  });

  test('el repartiment dels dissabtes el reconeix', () => {
    // Amb la titlla, alternancaCompleix('TARDE', 'MAÑANA') donava fals i es
    // rebutjaven dissabtes que no trencaven res.
    const delFull = marquesDelFull(
      { empleados: [{ empleadoId: 4, marcas: [{ dia: 'SABADO', marca: 'M' }] }] }, 4);
    assert.equal(alternancaCompleix('TARDE', delFull.SABADO), true,
      'després d\'una tarda, un matí alterna correctament');
    assert.equal(alternancaCompleix('MANANA', delFull.SABADO), false,
      'i dos matins seguits, no');
  });

  test('només hi ha una taula de marques a tot el projecte', () => {
    // N'hi va haver dues, i van divergir. La d'aquí és la bona.
    const wa = readFileSync(new URL('../src/services/whatsapp.js', import.meta.url), 'utf8');
    assert.doesNotMatch(wa, /=\s*\{\s*M:\s*'MANANA'/, 'una segona còpia torna a ser-hi');
    assert.match(wa, /delPaper\[m\.dia\] = TORN_DE_LA_MARCA\[m\.marca\]/);
  });
});
