import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { peticioDeLaCasella, avisDeCanvi, compleixLaPeticio, queDemanava } from '../src/services/peticions.js';

// El motor honra les peticions, però un cop l'horari és a la graella res
// distingeix un torn demanat d'un torn que va sortir del quadre. La
// responsable gira dos torns per quadrar la cobertura i desfà, sense
// adonar-se'n, el que aquella persona havia demanat per WhatsApp.
describe('per què una casella és com és', () => {
  const prefs = {
    activa: true,
    diasNoDisponible: ['DOMINGO'],
    turnosPorDia: { MARTES: 'MANANA', MIERCOLES: 'MANANA' },
  };

  test('el dia que va dir que no podia', () => {
    assert.equal(peticioDeLaCasella({ dia: 'DOMINGO', turno: 'LIBRE', prefs }), 'NO_DISPONIBLE');
  });

  test('el torn que va demanar', () => {
    assert.equal(peticioDeLaCasella({ dia: 'MARTES', turno: 'MANANA', prefs }), 'TORN_DEMANAT');
  });

  // El cas real de la Carmen: va demanar dimarts i dimecres matí, i li van
  // tocar matins tota la setmana. Els altres matins NO són peticions seves.
  test('un torn que coincideix per casualitat un altre dia no és cap petició', () => {
    assert.equal(peticioDeLaCasella({ dia: 'JUEVES', turno: 'MANANA', prefs }), null);
  });

  test('si li han posat un altre torn del que va demanar, la marca hi és igual', () => {
    // El cas que va motivar el canvi: l'Antònia demanava tarda, se li va posar
    // DIA i sortia la marca; després un altre dia demanat es va passar a matí i
    // la marca desapareixia. En tots dos casos se li ha canviat el que havia
    // demanat, i en tots dos ho ha de veure.
    assert.equal(peticioDeLaCasella({ dia: 'MARTES', turno: 'TARDE', prefs }), 'TORN_CANVIAT');
    assert.equal(compleixLaPeticio('TORN_CANVIAT'), false);
  });

  test('dos estils, no quatre', () => {
    assert.equal(compleixLaPeticio('NO_DISPONIBLE'), true);
    assert.equal(compleixLaPeticio('TORN_DEMANAT'), true);
    assert.equal(compleixLaPeticio('FESTA_CANVIADA'), false);
    assert.equal(compleixLaPeticio('TORN_CANVIAT'), false);
    assert.equal(compleixLaPeticio(null), false, 'sense petició no hi ha res a pintar');
  });

  test('i es pot saber QUÈ havia demanat, per poder decidir', () => {
    assert.equal(queDemanava({ dia: 'MARTES', prefs }), 'MANANA');
    assert.equal(queDemanava({ dia: 'DOMINGO', prefs }), 'LIBRE');
    assert.equal(queDemanava({ dia: 'JUEVES', prefs }), null);
    assert.equal(queDemanava({ dia: 'MARTES', prefs: null }), null);
  });

  // Un DIA cobreix matí i tarda, o sigui que toca el que demanava — però no és
  // el que demanava: qui demanava tarda i fa el dia sencer rep la seva petició
  // MÉS un matí que no havia demanat. Es marca, però no com un torn exacte.
  //
  // Abans donava 'TORN_DEMANAT' i l'encarregada es trobava que una casella que
  // ella acabava de canviar a DIA seguia dient «demanat», com si res.
  test('un DIA sobre una petició de matí és un canvi com qualsevol altre', () => {
    assert.equal(peticioDeLaCasella({ dia: 'MARTES', turno: 'PARTIDO', prefs }), 'TORN_CANVIAT');
  });

  test('i sobre una petició de tarda, igual', () => {
    const tarda = { activa: true, diasNoDisponible: [], turnosPorDia: { VIERNES: 'TARDE' } };
    assert.equal(peticioDeLaCasella({ dia: 'VIERNES', turno: 'PARTIDO', prefs: tarda }), 'TORN_CANVIAT');
  });

  test('el torn exacte segueix sent exacte', () => {
    assert.equal(peticioDeLaCasella({ dia: 'MARTES', turno: 'MANANA', prefs }), 'TORN_DEMANAT',
      'només el DIA és parcial; el que coincideix segueix sent el que coincideix');
  });

  test('i el DIA es marca, que no marcar-lo diria que s\'ha ignorat', () => {
    assert.notEqual(peticioDeLaCasella({ dia: 'MARTES', turno: 'PARTIDO', prefs }), null);
  });

  // La regla vella deia que la marca només sortia si la petició es complia, i
  // per això desapareixia justament quan la responsable hi havia passat per
  // sobre — que és quan més falta li fa veure-la. Ara la marca diu que ALLÀ HI
  // HA UNA PETICIÓ, i l'estil diu si es compleix o no.
  test('el dia que no podia, però treballant: la petició hi és i no es compleix', () => {
    assert.equal(peticioDeLaCasella({ dia: 'DOMINGO', turno: 'MANANA', prefs }), 'FESTA_CANVIADA');
    assert.equal(compleixLaPeticio('FESTA_CANVIADA'), false);
  });

  describe('quan no hi ha res a mirar', () => {
    test('sense preferències', () => {
      assert.equal(peticioDeLaCasella({ dia: 'LUNES', turno: 'MANANA', prefs: null }), null);
    });

    test('amb la preferència desactivada', () => {
      assert.equal(peticioDeLaCasella({ dia: 'MARTES', turno: 'MANANA', prefs: { ...prefs, activa: false } }), null);
    });

    test('sense turnosPorDia', () => {
      assert.equal(peticioDeLaCasella({ dia: 'MARTES', turno: 'MANANA', prefs: { activa: true, diasNoDisponible: [] } }), null);
    });

    // turnosPorDia és Json? a Prisma i pot arribar com a text.
    test('amb turnosPorDia com a text JSON', () => {
      const p = { activa: true, diasNoDisponible: [], turnosPorDia: '{"MARTES":"MANANA"}' };
      assert.equal(peticioDeLaCasella({ dia: 'MARTES', turno: 'MANANA', prefs: p }), 'TORN_DEMANAT');
    });

    test('amb un JSON trencat no peta, simplement no marca', () => {
      const p = { activa: true, diasNoDisponible: [], turnosPorDia: '{ això no és json' };
      assert.equal(peticioDeLaCasella({ dia: 'MARTES', turno: 'MANANA', prefs: p }), null);
    });
  });
});

describe('l\'avís abans de desfer una petició', () => {
  test('diu qui i què, en les dues llengües', () => {
    assert.match(avisDeCanvi('TORN_DEMANAT', 'Carmen', 'ca'), /Carmen va demanar expressament/);
    assert.match(avisDeCanvi('TORN_DEMANAT', 'Carmen', 'es'), /Carmen pidió expresamente/);
    assert.match(avisDeCanvi('NO_DISPONIBLE', 'Jordi', 'ca'), /no podia treballar/);
  });

  test('sense nom no es queda a mitges', () => {
    assert.match(avisDeCanvi('NO_DISPONIBLE', null, 'ca'), /aquesta persona/);
  });
});

// El frontend té una còpia d'aquesta funció perquè ha de respondre una pregunta
// diferent amb la mateixa regla: si canvio la casella, deixarà de complir la
// petició? Els miralls d'aquest projecte ja van derivar un cop sense que ho
// notés res, i comparar el text fallaria pels comentaris. Es compara el
// comportament, que és l'únic que importa.
describe('el mirall del frontend es comporta igual', async () => {
  const { peticioDeLaCasella: fe } = await import('./fixtures/upstream-ui/utils/peticions.js');

  const DIES = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
  const TORNS = ['MANANA', 'TARDE', 'PARTIDO', 'LIBRE'];
  const CASOS = [
    null,
    { activa: true, diasNoDisponible: [], turnosPorDia: null },
    { activa: false, diasNoDisponible: ['LUNES'], turnosPorDia: { MARTES: 'MANANA' } },
    { activa: true, diasNoDisponible: ['DOMINGO'], turnosPorDia: { MARTES: 'MANANA', VIERNES: 'TARDE' } },
    { activa: true, diasNoDisponible: ['LUNES', 'MARTES'], turnosPorDia: { MARTES: 'MANANA' } },
    { activa: true, diasNoDisponible: [], turnosPorDia: '{"SABADO":"TARDE"}' },
    { activa: true, diasNoDisponible: [], turnosPorDia: '{ trencat' },
  ];

  test('mateixa resposta a totes les combinacions', () => {
    let comprovades = 0;
    for (const prefs of CASOS) {
      for (const dia of DIES) {
        for (const turno of TORNS) {
          assert.equal(
            fe({ dia, turno, prefs }),
            peticioDeLaCasella({ dia, turno, prefs }),
            `discrepen a ${dia}/${turno} amb ${JSON.stringify(prefs)}`
          );
          comprovades++;
        }
      }
    }
    assert.equal(comprovades, CASOS.length * DIES.length * TORNS.length);
  });
});
