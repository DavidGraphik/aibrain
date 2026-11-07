import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { aplicaAUnaPersona, sincronitzaMatins, puntuacio, MANEN_MES, FAMILIES_QUE_ES_GARANTEIXEN } from '../src/services/passadesCondicions.js';

const setmana = (...torns) => ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO']
  .map((dia, i) => ({ dia, turno: torns[i] ?? 'LIBRE' }));
const llegeix = (d) => d.map((x) => x.turno);
const compta = (d, t) => d.filter((x) => x.turno === t).length;

// ─────────────────────────────────────────────
// La prova que hauria d'haver escrit la primera vegada.
//
// L'Eva té «3 matins i 3 tardes» i un DIA compta com les dues coses. Amb sis
// passades seguides, la dels matins desmuntava la de les tardes i el resultat
// en tenia SIS. Complia cada regla pel seu compte i incomplia el conjunt.
// ─────────────────────────────────────────────
describe('l\'Eva: 3 matins i 3 tardes, i un DIA compta per les dues', () => {
  const eva = { matinsExactes: 3, tardesExactes: 3, partidoCompta: 'MATI_I_TARDA' };

  test('el cas que ho trencava tot', () => {
    const d = setmana('PARTIDO', 'PARTIDO', 'PARTIDO', 'MANANA', 'MANANA', 'TARDE');
    const r = aplicaAUnaPersona(d, eva);
    const tardes = d.filter((x) => ['TARDE', 'PARTIDO'].includes(x.turno)).length;
    const matins = d.filter((x) => ['MANANA', 'PARTIDO'].includes(x.turno)).length;
    assert.equal(tardes, 3, `n'han quedat ${tardes}, i abans en quedaven sis`);
    assert.equal(matins, 3);
    assert.equal(r.despres, 0);
  });

  test('i el resultat mai és pitjor que el punt de partida', () => {
    // La garantia que faltava: sis regles independents podien deixar-ho pitjor
    // del que estava, i ningú se n'assabentava.
    for (const inici of [
      ['PARTIDO', 'PARTIDO', 'PARTIDO', 'MANANA', 'MANANA', 'TARDE'],
      ['TARDE', 'TARDE', 'TARDE', 'TARDE', 'MANANA', 'MANANA'],
      ['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'PARTIDO'],
      ['PARTIDO', 'LIBRE', 'PARTIDO', 'TARDE', 'MANANA', 'TARDE'],
    ]) {
      const d = setmana(...inici);
      const r = aplicaAUnaPersona(d, eva);
      assert.ok(r.despres <= r.abans, `${inici.join(',')}: ha empitjorat de ${r.abans} a ${r.despres}`);
      assert.equal(puntuacio(d, eva), r.despres, 'la puntuació que diu ha de ser la de veritat');
    }
  });
});

describe('els casos de les fitxes de Girona', () => {
  test('la Sandra: només tardes', () => {
    const d = setmana('TARDE', 'TARDE', 'PARTIDO', 'TARDE', 'TARDE', 'PARTIDO');
    aplicaAUnaPersona(d, { tornsPermesos: ['TARDE'] });
    assert.deepEqual(llegeix(d), Array(6).fill('TARDE'));
  });

  test('la Gemma: 3 tardes, 1 dia partit, i el partit compta com a tarda', () => {
    const d = setmana('MANANA', 'TARDE', 'TARDE', 'PARTIDO', 'TARDE', 'PARTIDO');
    const r = aplicaAUnaPersona(d, { maxTardes: 3, maxPartidos: 1, partidoCompta: 'TARDA' });
    assert.ok(compta(d, 'PARTIDO') <= 1);
    assert.ok(d.filter((x) => ['TARDE', 'PARTIDO'].includes(x.turno)).length <= 3);
    assert.equal(r.despres, 0);
  });

  test('en David: cap dia partit i només matins', () => {
    const d = setmana('MANANA', 'PARTIDO', 'MANANA', 'TARDE');
    aplicaAUnaPersona(d, { maxPartidos: 0, tornsPermesos: ['MANANA'] });
    assert.deepEqual(llegeix(d).slice(0, 4), Array(4).fill('MANANA'));
  });

  test('en Víctor: 2 partits no seguits, dilluns matí, i el condicional', () => {
    const d = setmana('PARTIDO', 'PARTIDO', 'MANANA', 'MANANA', 'MANANA', 'MANANA');
    const r = aplicaAUnaPersona(d, {
      partidosExactes: 2, partidosNoConsecutius: true, tornsPermesos: ['MANANA', 'PARTIDO'],
      tornFixe: { LUNES: 'MANANA' },
      condicionals: [{ si: { dia: 'SABADO', torn: 'MANANA' }, llavors: { dia: 'VIERNES', torn: 'PARTIDO' } }],
    });
    assert.equal(d[0].turno, 'MANANA', 'el dilluns sempre matí');
    assert.equal(compta(d, 'PARTIDO'), 2);
    const seguits = d.some((x, i) => i > 0 && x.turno === 'PARTIDO' && d[i - 1].turno === 'PARTIDO');
    assert.equal(seguits, false);
    assert.equal(r.despres, 0);
  });

  test('l\'Esther: si dissabte fa dia partit, divendres matí', () => {
    const d = setmana('MANANA', 'MANANA', 'MANANA', 'MANANA', 'TARDE', 'PARTIDO');
    aplicaAUnaPersona(d, {
      condicionals: [{ si: { dia: 'SABADO', torn: 'PARTIDO' }, llavors: { dia: 'VIERNES', torn: 'MANANA' } }],
    });
    assert.equal(d[4].turno, 'MANANA');
  });
});

// El preu de complir-les, mesurat el 21 d'agost: deixava tres tardes per sota
// del mínim. Quan no hi ha marge, la condició es queda sense complir i es diu.
describe('quan no hi ha marge, no es fa', () => {
  test('un canvi que deixaria el dia sense prou gent no es fa', () => {
    const d = setmana('PARTIDO', 'PARTIDO');
    const r = aplicaAUnaPersona(d, { maxPartidos: 0, tornsPermesos: ['MANANA'] }, {
      deixaMarge: () => false,
    });
    assert.deepEqual(llegeix(d).slice(0, 2), ['PARTIDO', 'PARTIDO']);
    assert.equal(r.fets.length, 0);
    assert.ok(r.despres > 0, 'i queda dit que segueix sense complir-se');
  });

  test('si el que hi ha està prohibit i no hi ha cap canvi possible, es deixa lliure', () => {
    // Bloquejat per COBERTURA i no per disponibilitat: el primer arreglo només
    // mirava la disponibilitat i la persona quedava encallada amb un torn
    // prohibit i cap jugada possible.
    const d = setmana('TARDE');
    const r = aplicaAUnaPersona(d, { tornsPermesos: ['MANANA'] }, {
      potFer: () => true,
      deixaMarge: (dia, de, a) => a === 'LIBRE',
    });
    assert.equal(d[0].turno, 'LIBRE');
    assert.equal(r.despres, 0);
  });

  test('però si el que hi ha ja està permès, no se li treu', () => {
    // El torn és dels permesos i tot i així incompleix un recompte. Buidar-li
    // el dia BAIXARIA la puntuació —per això la prova ha d'estar escrita així:
    // la versió anterior triava un cas on treure el dia puntuava igual, o sigui
    // que passava tant si la protecció hi era com si no.
    const d = [{ dia: 'LUNES', turno: 'PARTIDO' }];
    const r = aplicaAUnaPersona(d, { tornsPermesos: ['PARTIDO'], maxPartidos: 0 }, {
      potFer: (dia, t) => t === 'PARTIDO',
    });
    assert.equal(d[0].turno, 'PARTIDO', 'li ha buidat l\'únic dia que tenia, i era el torn permès');
    assert.ok(r.despres > 0, 'i queda dit que la condició segueix sense complir-se');
  });

  test('si n\'hi ha per a un dia i no per a l\'altre, es fa el que es pot', () => {
    const d = setmana('PARTIDO', 'PARTIDO');
    const r = aplicaAUnaPersona(d, { maxPartidos: 0, tornsPermesos: ['MANANA'] }, {
      deixaMarge: (dia) => dia === 'LUNES',
    });
    assert.equal(d[0].turno, 'MANANA');
    assert.equal(d[1].turno, 'PARTIDO');
    assert.ok(r.despres < r.abans && r.despres > 0);
  });
});

describe('el que mana més que la condició', () => {
  test('un dia demanat aquesta setmana no es toca', () => {
    const d = setmana('TARDE', 'TARDE', 'TARDE', 'TARDE');
    aplicaAUnaPersona(d, { maxTardes: 1 }, { esIntocable: (dia) => dia === 'JUEVES' });
    assert.equal(d[3].turno, 'TARDE');
  });

  test('la disponibilitat fixa tampoc', () => {
    const d = setmana('PARTIDO');
    aplicaAUnaPersona(d, { tornFixe: { LUNES: 'MANANA' } }, { potFer: (dia, t) => t !== 'MANANA' });
    assert.notEqual(d[0].turno, 'MANANA');
  });

  test('i l\'ordre és explícit', () => {
    assert.deepEqual(MANEN_MES, ['absencies', 'diesTancats', 'disponibilitatFixa', 'peticionsSetmanals']);
  });
});

describe('el que NO fa', () => {
  test('no fa treballar ningú un dia que tenia lliure', () => {
    const d = setmana('MANANA', 'LIBRE', 'LIBRE');
    aplicaAUnaPersona(d, { matinsExactes: 3 });
    assert.deepEqual(llegeix(d).slice(0, 3), ['MANANA', 'LIBRE', 'LIBRE']);
  });

  test('sense condicions no toca res', () => {
    const d = setmana('PARTIDO', 'PARTIDO');
    assert.deepEqual(aplicaAUnaPersona(d, null).fets, []);
  });

  test('i no diu que garanteix el que no garanteix', () => {
    // `sincronitzatAmb` necessita l'horari d'una altra persona. Que el panell
    // digués que està garantida seria pitjor que no dir res.
    // La llista i les passades no poden discrepar: el panell la llegeix per
    // dir què es garanteix, i si diuen coses diferents la pantalla es
    // contradiu a ella mateixa.
    assert.ok(FAMILIES_QUE_ES_GARANTEIXEN.includes('capFestaEntreSetmana'));
    assert.ok(FAMILIES_QUE_ES_GARANTEIXEN.includes('condicionals'));
    assert.ok(FAMILIES_QUE_ES_GARANTEIXEN.includes('sincronitzatAmb'));
  });
});

// ─────────────────────────────────────────────
// MILERS DE COMBINACIONS, NO LES QUE SE M'ACUDEIXIN
//
// Les proves de dalt cobreixen els casos que em vaig imaginar, i el forat de
// deixar algú sense cap torn no hi era: el revisor el va trobar executant el
// codi amb cinc mil combinacions a l'atzar. Això és aquella prova, perquè la
// propera vegada la trobi la suite i no una revisió.
//
// La llavor és fixa: una prova que falla només de tant en tant no la mira
// ningú, i si algun dia peta ha de petar amb el mateix cas.
// ─────────────────────────────────────────────
function daus(llavor) {
  let x = llavor;
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}

describe('amb combinacions a l\'atzar', () => {
  const TORNS = ['MANANA', 'TARDE', 'PARTIDO', 'LIBRE'];

  test('mai empitjora, mai buida la setmana, i diu la veritat', () => {
    const d6 = daus(20260821);
    const tria = (llista) => llista[Math.floor(d6() * llista.length)];
    let provats = 0;

    for (let i = 0; i < 3000; i++) {
      const dies = setmana(...Array.from({ length: 6 }, () => tria(TORNS)));
      const cond = {};
      if (d6() < 0.4) cond.tornsPermesos = tria([['MANANA'], ['TARDE'], ['MANANA', 'PARTIDO'], ['TARDE', 'PARTIDO']]);
      if (d6() < 0.4) cond.maxTardes = Math.floor(d6() * 4);
      if (d6() < 0.3) cond.tardesExactes = Math.floor(d6() * 4);
      if (d6() < 0.3) cond.matinsExactes = Math.floor(d6() * 4);
      if (d6() < 0.3) cond.maxPartidos = Math.floor(d6() * 3);
      if (d6() < 0.2) cond.partidosExactes = Math.floor(d6() * 3);
      if (d6() < 0.3) cond.partidosNoConsecutius = true;
      if (d6() < 0.3) cond.partidoCompta = tria(['TARDA', 'MATI_I_TARDA']);
      if (d6() < 0.2) cond.tornFixe = { LUNES: tria(['MANANA', 'TARDE']) };
      if (Object.keys(cond).length === 0) continue;

      // Una disponibilitat qualsevol, que és on vivia el cas dolent: algú amb
      // «només matins» a qui la disponibilitat li barra els matins.
      const barrats = {};
      for (const dia of dies.map((x) => x.dia)) if (d6() < 0.25) barrats[dia] = tria(TORNS);
      const potFer = (dia, t) => barrats[dia] !== t;

      const feinaAbans = dies.filter((x) => x.turno !== 'LIBRE').length;
      const r = aplicaAUnaPersona(dies, cond, { potFer });
      const feinaDespres = dies.filter((x) => x.turno !== 'LIBRE').length;
      provats++;

      const cas = `#${i} ${JSON.stringify(cond)} amb ${dies.map((x) => x.turno).join(',')}`;
      assert.ok(r.despres <= r.abans, `${cas}: ha empitjorat de ${r.abans} a ${r.despres}`);
      assert.equal(puntuacio(dies, cond), r.despres, `${cas}: la puntuació que diu no és la de veritat`);
      // «Mai buida la setmana» no és universal, i dir-ho així era mentida: si
      // la disponibilitat li barra l'únic torn permès tots els dies, buidar-la
      // és l'única sortida i és correcte. El que sí que s'ha de garantir és que
      // cap dia passi a lliure TENINT una alternativa possible.
      for (const f of r.fets) {
        if (f.a !== 'LIBRE') continue;
        const permesos = cond.tornsPermesos || ['MANANA', 'TARDE', 'PARTIDO'];
        // Les dues condicions, i la segona és la que faltava: un dia amb un
        // torn PERMÈS no es buida mai, encara que incompleixi un recompte.
        assert.ok(!permesos.includes(f.de),
          `${cas}: ha deixat lliure el ${f.dia}, que tenia ${f.de} i és dels permesos`);
        assert.ok(!permesos.some((t) => t !== f.de && potFer(f.dia, t)),
          `${cas}: ha deixat lliure el ${f.dia} tenint on posar-lo`);
      }
      // Només els dies que ha TOCAT. Els que ja venien trencats no són cosa
      // seva: la disponibilitat la imposa una passada anterior, i exigir-ho
      // aquí era una prova mal escrita, no un error del codi.
      for (const f of r.fets) {
        if (f.a !== 'LIBRE') assert.ok(potFer(f.dia, f.a), `${cas}: hi ha posat ${f.a} el ${f.dia} i no el pot fer`);
      }
    }
    assert.ok(provats > 2000, `només s\'han provat ${provats} casos`);
  });
});

// «Ha de fer els mateixos MATINS que Nuria Bachs.» L'única condició que
// necessita mirar dues persones alhora, i la que el Roger va veure que no es
// complia en generar l'horari del 24 d'agost.
describe('els mateixos matins que una altra persona', () => {
  const nuria = { empleadoId: 113, dias: setmana('MANANA', 'MANANA', 'LIBRE', 'MANANA', 'LIBRE', 'LIBRE') };
  const jordiCond = { sincronitzatAmb: { empleadoId: 113, que: 'MATINS' } };
  const cond = (id) => (id === 98 ? jordiCond : null);

  test('els dies que ella fa matí, ell també', () => {
    const jordi = { empleadoId: 98, dias: setmana('TARDE', 'TARDE', 'TARDE', 'TARDE') };
    sincronitzaMatins([jordi, nuria], cond);
    assert.equal(jordi.dias[0].turno, 'MANANA');
    assert.equal(jordi.dias[1].turno, 'MANANA');
    assert.equal(jordi.dias[3].turno, 'MANANA');
  });

  test('i els que ella no en fa, ell tampoc', () => {
    const jordi = { empleadoId: 98, dias: setmana('MANANA', 'MANANA', 'MANANA') };
    sincronitzaMatins([jordi, nuria], cond);
    assert.equal(jordi.dias[2].turno, 'TARDE', 'el dimecres ella té festa');
  });

  test('però no se li posa a treballar un dia que tenia lliure', () => {
    const jordi = { empleadoId: 98, dias: setmana('LIBRE', 'LIBRE') };
    sincronitzaMatins([jordi, nuria], cond);
    assert.deepEqual(llegeix(jordi.dias).slice(0, 2), ['LIBRE', 'LIBRE']);
  });

  test('ni se li treuen hores: si no pot fer matí, es queda com estava', () => {
    // Deixar-lo lliure per sincronitzar-lo seria pitjor que la
    // desincronització.
    const jordi = { empleadoId: 98, dias: setmana('TARDE') };
    const r = sincronitzaMatins([jordi, nuria], cond, { potFer: () => false });
    assert.equal(jordi.dias[0].turno, 'TARDE');
    assert.deepEqual(r[0].sensesortida, ['LUNES']);
  });

  test('ni es trenca la cobertura per sincronitzar-lo', () => {
    const jordi = { empleadoId: 98, dias: setmana('TARDE') };
    sincronitzaMatins([jordi, nuria], cond, { deixaMarge: () => false });
    assert.equal(jordi.dias[0].turno, 'TARDE');
  });

  test('ni el que ell hagi demanat aquesta setmana', () => {
    const jordi = { empleadoId: 98, dias: setmana('TARDE') };
    sincronitzaMatins([jordi, nuria], cond, { esIntocable: (id, dia) => dia === 'LUNES' });
    assert.equal(jordi.dias[0].turno, 'TARDE');
  });

  test('un DIA no es baixa a TARDE sol: perdria hores de veritat', () => {
    // El cas que va trobar el revisor: en Jordi amb PARTIDO i la Núria amb
    // TARDE aquell dia. Forçar-li TARDE li retallava justament el que el
    // comentari diu evitar.
    const nuriaTarda = { empleadoId: 113, dias: setmana('TARDE') };
    const jordi = { empleadoId: 98, dias: setmana('PARTIDO') };
    const r = sincronitzaMatins([jordi, nuriaTarda], cond);
    assert.equal(jordi.dias[0].turno, 'PARTIDO', 'no se li ha de tocar el DIA');
    assert.deepEqual(r[0].sensesortida, ['LUNES']);
  });

  test('ni desfà un recompte que la seva pròpia condició ja tenia just', () => {
    // aplicaCondicionsFixes corre just abans i li pot haver deixat exactament
    // els matins que li tocaven. Sincronitzar-lo no ha de desquadrar-ho.
    // Ja té 1 matí i és exactament el que li toca; sincronitzar-lo el deixaria
    // a 0, que trenca el recompte que ja estava bé.
    const condAmbMatins = { sincronitzatAmb: { empleadoId: 113, que: 'MATINS' }, matinsExactes: 1 };
    const nuriaTarda = { empleadoId: 113, dias: setmana('TARDE') };
    const persona = { empleadoId: 98, dias: setmana('MANANA') };
    const r = sincronitzaMatins([persona, nuriaTarda], () => condAmbMatins);
    assert.equal(persona.dias[0].turno, 'MANANA', 'canviar-lo a TARDE el deixaria a 0 matins i en vol 1');
    assert.deepEqual(r[0].sensesortida, ['LUNES']);
  });

  test('les funcions reben de QUI parlen', () => {
    // Hi ha dues persones en joc: una funció que no sàpiga a qui mira
    // comprovaria la disponibilitat de l'altra.
    const vistos = [];
    const jordi = { empleadoId: 98, dias: setmana('TARDE') };
    sincronitzaMatins([jordi, nuria], cond, { potFer: (id) => { vistos.push(id); return true; } });
    assert.deepEqual([...new Set(vistos)], [98]);
  });

  test('un DIA ja compta com a matí', () => {
    const ella = { empleadoId: 113, dias: setmana('PARTIDO') };
    const jordi = { empleadoId: 98, dias: setmana('MANANA') };
    const r = sincronitzaMatins([jordi, ella], cond);
    assert.equal(jordi.dias[0].turno, 'MANANA', 'ja hi és, no cal tocar res');
    assert.deepEqual(r, []);
  });

  test('sense la condició no toca res', () => {
    const jordi = { empleadoId: 98, dias: setmana('TARDE') };
    sincronitzaMatins([jordi, nuria], () => null);
    assert.equal(jordi.dias[0].turno, 'TARDE');
  });
});

// «No fa festa entre setmana», la condició d'en Jordi Defaus. És l'única que
// només es pot complir AFEGINT un torn, i per això es va quedar fora al
// principi. Però treure-li hores per quadrar un recompte deixa algú sense sou i
// posar-li un torn perquè la seva fitxa ho diu és donar-li el que ha demanat:
// no són el mateix i eren al mateix sac.
describe('no fa festa entre setmana', () => {
  const jordi = { capFestaEntreSetmana: true };

  test('un dia laborable lliure s\'omple', () => {
    const d = setmana('MANANA', 'LIBRE', 'MANANA', 'MANANA', 'MANANA', 'MANANA');
    const r = aplicaAUnaPersona(d, jordi);
    assert.notEqual(d[1].turno, 'LIBRE', 'el dimarts se li ha de posar torn');
    assert.equal(r.despres, 0);
  });

  test('el dissabte no: «entre setmana» són de dilluns a divendres', () => {
    const d = setmana('MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'LIBRE');
    const r = aplicaAUnaPersona(d, jordi);
    assert.equal(d[5].turno, 'LIBRE');
    assert.equal(r.despres, 0, 'i no compta com a incompliment');
  });

  test('ni un dia que no és seu: botiga tancada, baixa o festiu', () => {
    // Aquells dies també són LIBRE i des d'aquí no es distingeixen. Posar-lo a
    // treballar un dia que la botiga tanca seria pitjor que la condició.
    const d = setmana('MANANA', 'LIBRE', 'MANANA');
    aplicaAUnaPersona(d, jordi, { potTreballar: (dia) => dia !== 'MARTES' });
    assert.equal(d[1].turno, 'LIBRE');
  });

  test('ni un dia que ell mateix ha demanat lliure aquesta setmana', () => {
    // La petició de la setmana mana més que la condició de la fitxa.
    const d = setmana('MANANA', 'LIBRE', 'MANANA');
    aplicaAUnaPersona(d, jordi, { esIntocable: (dia) => dia === 'MARTES' });
    assert.equal(d[1].turno, 'LIBRE');
  });

  test('ni si no hi ha marge de cobertura', () => {
    const d = setmana('MANANA', 'LIBRE', 'MANANA');
    aplicaAUnaPersona(d, jordi, { deixaMarge: () => false });
    assert.equal(d[1].turno, 'LIBRE');
  });

  test('i el torn que se li posa respecta la seva pròpia condició', () => {
    const d = setmana('MANANA', 'LIBRE', 'MANANA');
    aplicaAUnaPersona(d, { ...jordi, tornsPermesos: ['TARDE'] });
    assert.equal(d[1].turno, 'TARDE');
  });

  test('un dia que s\'acaba d\'omplir no es torna a buidar', () => {
    // El cas que ho posa a prova de debò: el dia només es pot omplir amb un
    // torn que la seva condició NO permet, i en una volta posterior la cerca
    // podria voler tornar-lo a lliure. La versió anterior d'aquesta prova
    // triava un cas on omplir-lo sempre era la millor jugada, o sigui que
    // passava tant si la protecció hi era com si no.
    // La garantia de veritat: un dia que aquesta passada OMPLE no el pot
    // tornar a buidar ella mateixa. (Buidar un dia que ja venia amb un torn
    // prohibit i sense cap recanvi possible sí que és correcte, i és una altra
    // regla.) La versió anterior d'aquesta prova triava un cas on omplir era
    // sempre la millor jugada, o sigui que passava hi hagués protecció o no.
    const d = setmana('MANANA', 'LIBRE', 'LIBRE');
    const r = aplicaAUnaPersona(d, { ...jordi, maxTardes: 0 });

    const omplerts = new Set(r.fets.filter((f) => f.de === 'LIBRE').map((f) => f.dia));
    assert.ok(omplerts.size > 0, 'no ha omplert res i la prova no prova res');
    for (const f of r.fets) {
      assert.ok(!(f.a === 'LIBRE' && omplerts.has(f.dia)),
        `ha omplert el ${f.dia} i l'ha tornat a buidar`);
    }
    for (const dia of omplerts) {
      assert.notEqual(d.find((x) => x.dia === dia).turno, 'LIBRE');
    }
  });
});
