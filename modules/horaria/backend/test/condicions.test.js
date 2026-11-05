import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validaCondicions, resumDeGarantia, PRECEDENCIA, FAMILIES } from '../src/utils/condicions.js';

// Les dotze condicions que hi ha escrites a les fitxes, traduïdes a mà a
// l'esquema. Si alguna no s'hi pot dir, l'esquema està incomplet i val més
// saber-ho aquí que el dia que una IA ho intenti.
const REALS = {
  'Núria Bachs': { tornsPermesos: ['MANANA'], minDiesFesta: 1 },
  'Gemma Casanovas': { maxTardes: 3, tardesIdeal: 2, partidoCompta: 'TARDA', maxPartidos: 1 },
  // El seu horari i les seves hores ja tenen camp propi a la fitxa; la frase
  // que els repeteix no es tradueix, però tampoc es perd.
  'David Castillo': {
    maxPartidos: 0, tornsPermesos: ['MANANA'],
    jaALaFitxa: 'de 8:00 a 12:00. Jornada reduïda de 4h per torn, contracte de 20h/setmana',
  },
  'Sandra Corominas': { tornsPermesos: ['TARDE'], jaALaFitxa: 'de 16h hasta el cierre' },
  // La tercera frase de la seva fitxa —«El dia que Nuria Bachs té festa, Jordi
  // pot fer PARTIDO o TARDE»— encara no té camp. Va a `noGarantit` i no
  // desapareix: una traducció a mitges que sembli sencera és pitjor que no
  // traduir-la, perquè es valida creient que hi és tota.
  'Jordi Defaus': {
    capFestaEntreSetmana: true,
    sincronitzatAmb: { empleadoId: 113, que: 'MATINS' },
    noGarantit: 'El dia que Nuria Bachs té festa, Jordi pot fer PARTIDO o TARDE.',
  },
  'Antonia Lopez': { maxTardes: 3, tardesIdeal: 2, partidoCompta: 'TARDA', partidosExactes: 1, maxPartidos: 1 },
  'Eva Mademont': { matinsExactes: 3, tardesExactes: 3, partidoCompta: 'MATI_I_TARDA' },
  'Esther Rabert': { condicionals: [{ si: { dia: 'SABADO', torn: 'PARTIDO' }, llavors: { dia: 'VIERNES', torn: 'MANANA' } }] },
  'Neus Sala': { noGarantit: 'És encarregada de la botiga.' },
  'Victor Sanchez': {
    partidosExactes: 2, partidosNoConsecutius: true, tornsPermesos: ['MANANA', 'PARTIDO'],
    tornFixe: { LUNES: 'MANANA' },
    condicionals: [{ si: { dia: 'SABADO', torn: 'MANANA' }, llavors: { dia: 'VIERNES', torn: 'PARTIDO' } }],
  },
  'Montse Surroca': { minDiesFesta: 1 },
  'Carmen Soteras': { condicionals: [{ si: { dia: 'SABADO', torn: 'PARTIDO' }, llavors: { dia: 'VIERNES', torn: 'MANANA' } }] },
};

describe('l\'esquema diu el que hi ha escrit a les fitxes', () => {
  for (const [qui, cond] of Object.entries(REALS)) {
    test(`${qui}`, () => {
      const r = validaCondicions(cond);
      assert.equal(r.ok, true, `no s'hi pot dir: ${r.errors.join(' · ')}`);
      assert.deepEqual(r.net, cond, 'no s\'ha de perdre res pel camí');
    });
  }

  test('les dotze, sense forats', () => {
    assert.equal(Object.keys(REALS).length, 12);
    const usats = new Set(Object.values(REALS).flatMap((c) => Object.keys(c)));
    // Cada família ha de servir per a algú de veritat. Una que no la faci
    // servir ningú és una que ens hem inventat.
    for (const f of Object.keys(FAMILIES)) {
      assert.ok(usats.has(f), `la família «${f}» no la fa servir cap condició real`);
    }
  });
});

describe('el que no s\'ha de colar', () => {
  test('un camp inventat es rebutja, no s\'ignora', () => {
    // El traduirà una IA. Un camp que passés en silenci seria una condició que
    // el responsable creu posada i que no fa complir ningú.
    const r = validaCondicions({ maxTardes: 3, sempreDeNit: true });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /sempreDeNit/);
    assert.equal(r.net, null);
  });

  test('un torn que no existeix', () => {
    assert.equal(validaCondicions({ tornsPermesos: ['MATINADA'] }).ok, false);
  });

  test('un dia que no existeix', () => {
    assert.equal(validaCondicions({ tornFixe: { DILLUNS: 'MANANA' } }).ok, false);
  });

  test('un número on va una llista', () => {
    assert.equal(validaCondicions({ tornsPermesos: 3 }).ok, false);
  });

  test('un condicional a mitges', () => {
    assert.equal(validaCondicions({ condicionals: [{ si: { dia: 'SABADO' } }] }).ok, false);
  });

  test('sincronitzar amb ningú', () => {
    assert.equal(validaCondicions({ sincronitzatAmb: { que: 'MATINS' } }).ok, false);
  });
});

describe('el que l\'esquema encara no sap dir, no es perd', () => {
  test('en Jordi es queda amb la frase que no té camp', () => {
    const { noGarantit } = resumDeGarantia(REALS['Jordi Defaus']);
    assert.match(noGarantit || '', /Nuria Bachs té festa/);
  });

  test('i de la resta, què es garanteix i què encara no', () => {
    // Cap de les dues, i és honest. `sincronitzatAmb` necessita l'horari d'una
    // altra persona; «no fa festa entre setmana» només es podria arreglar
    // POSANT-LO a treballar, i afegir torns és justament el que aquestes
    // passades no fan — és el que li va donar 41h sobre un contracte de 14.
    const r = resumDeGarantia(REALS['Jordi Defaus']);
    // Les dues ja es fan complir: «els mateixos matins» amb `sincronitzaMatins`
    // i «no fa festa entre setmana» afegint-li un torn, que és l'única condició
    // que ho demana i per això va ser l'última.
    assert.deepEqual(r.garantides.sort(), ['capFestaEntreSetmana', 'sincronitzatAmb']);
    assert.deepEqual(r.encaraNo, []);
  });
});

describe('contradiccions dins de la mateixa fitxa', () => {
  test('l\'ideal no pot passar del màxim', () => {
    const r = validaCondicions({ maxTardes: 2, tardesIdeal: 3 });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /tardesIdeal/);
  });

  test('un torn fix que els torns permesos no deixen', () => {
    const r = validaCondicions({ tornsPermesos: ['MANANA'], tornFixe: { LUNES: 'TARDE' } });
    assert.equal(r.ok, false);
  });

  test('cap PARTIDO i alhora PARTIDO permès', () => {
    assert.equal(validaCondicions({ maxPartidos: 0, tornsPermesos: ['MANANA', 'PARTIDO'] }).ok, false);
  });

  test('i al revés: demanar PARTIDO sense deixar-l\'hi', () => {
    // La manera fàcil d'equivocar-se traduint, i passava en silenci.
    assert.equal(validaCondicions({ tornsPermesos: ['MANANA', 'TARDE'], partidosExactes: 2 }).ok, false);
    assert.equal(validaCondicions({ tornsPermesos: ['MANANA'], maxPartidos: 1 }).ok, false);
  });

  test('més matins i tardes dels dies que té la setmana', () => {
    assert.equal(validaCondicions({ matinsExactes: 5, tardesExactes: 4 }).ok, false);
  });
});

describe('casos de vora', () => {
  test('sense condicions no és cap error', () => {
    assert.deepEqual(validaCondicions(null), { ok: true, errors: [], net: null });
    assert.deepEqual(validaCondicions(undefined), { ok: true, errors: [], net: null });
    assert.equal(validaCondicions({}).ok, true);
  });

  test('un camp dit a null és un camp no dit', () => {
    const r = validaCondicions({ maxTardes: 3, tardesIdeal: null });
    assert.equal(r.ok, true);
    assert.deepEqual(r.net, { maxTardes: 3 });
  });

  test('una llista no és un objecte de condicions', () => {
    assert.equal(validaCondicions([{ maxTardes: 3 }]).ok, false);
  });
});

describe('què es garanteix i què no', () => {
  test('separa el que el codi farà complir del que només és text', () => {
    const r = resumDeGarantia({ maxTardes: 3, noGarantit: 'És encarregada.' });
    assert.deepEqual(r.garantides, ['maxTardes']);
    assert.equal(r.noGarantit, 'És encarregada.');
  });

  test('el que ja consta a la fitxa no compta com a garantit per aquí', () => {
    // Ho garanteix el camp de la fitxa, no aquesta condició. Comptar-ho aquí
    // diria dues vegades el mateix i amagaria qui ho fa complir de debò.
    const { garantides } = resumDeGarantia(REALS['Sandra Corominas']);
    assert.deepEqual(garantides, ['tornsPermesos']);
  });

  test('el que no és cap regla no surt com a «no garantit»', () => {
    // `partidoCompta` diu COM es compten les altres i les passades ja el fan
    // servir; `tardesIdeal` és un desig, no un límit. Dir-ne «això no ho fa
    // complir ningú» confondria qui valida la traducció.
    const r = resumDeGarantia({ maxTardes: 3, tardesIdeal: 2, partidoCompta: 'TARDA', maxPartidos: 1 });
    assert.deepEqual(r.encaraNo, []);
    assert.deepEqual(r.garantides.sort(), ['maxPartidos', 'maxTardes']);
    assert.deepEqual(r.preferencies, ['tardesIdeal']);
  });

  test('el que encara no fa complir cap passada es diu a part', () => {
    // Dir que està garantit el que no toca ningú és pitjor que no dir res: el
    // responsable ho dona per resolt.
    // Ara mateix no en queda cap de vàlida sense passada: si algun dia se
    // n'afegeix una a l'esquema abans que la seva passada, ha de sortir aquí.
    const r = resumDeGarantia({ maxTardes: 3 });
    assert.deepEqual(r.garantides, ['maxTardes']);
    assert.deepEqual(r.encaraNo, []);
  });

  test('de la Neus no se n\'hi garanteix res', () => {
    const r = resumDeGarantia(REALS['Neus Sala']);
    assert.deepEqual(r.garantides, []);
    assert.ok(r.noGarantit);
  });
});

describe('l\'ordre de qui mana', () => {
  test('les peticions de la setmana passen davant de les condicions fixes', () => {
    // Decidit pel Roger el 21 d'agost. Sense això les passades no es podien ni
    // escriure: si l'Eva té «3 matins i 3 tardes» i aquesta setmana en demana
    // quatre, algú ha de manar, i mana ella.
    assert.ok(PRECEDENCIA.indexOf('peticionsSetmanals') < PRECEDENCIA.indexOf('condicionsFixes'));
  });

  test('i el que no es pot moure passa davant de tot', () => {
    for (const dur of ['absencies', 'diesTancats', 'disponibilitatFixa']) {
      assert.ok(PRECEDENCIA.indexOf(dur) < PRECEDENCIA.indexOf('peticionsSetmanals'), dur);
    }
  });

  test('i l\'objectiu d\'hores és l\'últim', () => {
    // La setmana del 24 d'agost va sortir amb gent al triple del contracte
    // perquè les hores empenyien més que les condicions. Van les últimes.
    assert.equal(PRECEDENCIA[PRECEDENCIA.length - 1], 'objectiuHores');
    assert.ok(PRECEDENCIA.indexOf('condicionsFixes') < PRECEDENCIA.indexOf('objectiuHores'));
  });
});
