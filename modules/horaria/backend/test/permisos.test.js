import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { potAccedirABotiga, potTocarPersona, potPosarContrasenya, esGeneral } from '../src/utils/permisos.js';
import { requireEstablishmentAccess, requireEstablishmentParam } from '../src/middleware/roles.js';

// L'auditoria del 12 d'agost: PUT /api/employees/:id només comprovava que qui
// truqués fos responsable, sense mirar de quina botiga era la persona editada.
// Com que el mateix endpoint deixa posar contrasenya, una encarregada podia
// canviar la de la responsable general i entrar com ella.
const dolors = { id: 1, rol: 'MANAGER_GENERAL', establecimientos: [] };
const neus = { id: 2, rol: 'MANAGER_LOCAL', establecimientos: [3] };
const maria = { id: 3, rol: 'MANAGER_LOCAL', establecimientos: [1] };

describe('accés a una botiga', () => {
  test('la responsable general entra a totes', () => {
    assert.equal(potAccedirABotiga(dolors, 1), true);
    assert.equal(potAccedirABotiga(dolors, 99), true);
  });

  test('una encarregada, només a la seva', () => {
    assert.equal(potAccedirABotiga(neus, 3), true);
    assert.equal(potAccedirABotiga(neus, 1), false);
  });

  test('accepta l\'id com a text, que és com arriba per query', () => {
    assert.equal(potAccedirABotiga(neus, '3'), true);
    assert.equal(potAccedirABotiga(neus, '1'), false);
  });

  // La guarda antiga feia `if (!requestedId) return next()`: sense id vàlida
  // deixava passar. Era com no tenir guarda.
  test('sense botiga concreta no s\'obre la porta', () => {
    assert.equal(potAccedirABotiga(neus, undefined), false);
    assert.equal(potAccedirABotiga(neus, 'tres'), false);
    assert.equal(potAccedirABotiga(neus, null), false);
  });
});

describe('tocar la fitxa d\'una persona', () => {
  const treballadorGirona = { rol: 'EMPLEADO', establecimientoId: 3 };
  const treballadorPalamos = { rol: 'EMPLEADO', establecimientoId: 1 };

  test('l\'encarregada arriba a la seva gent', () => {
    assert.equal(potTocarPersona(neus, treballadorGirona), true);
  });

  test('però no a la d\'una altra botiga', () => {
    assert.equal(potTocarPersona(neus, treballadorPalamos), false);
  });

  // El cor de l'escalada de privilegis.
  test('una encarregada NO pot tocar la responsable general', () => {
    assert.equal(potTocarPersona(neus, { rol: 'MANAGER_GENERAL', establecimientoId: null }), false);
  });

  test('ni una altra encarregada', () => {
    assert.equal(potTocarPersona(neus, { id: 3, rol: 'MANAGER_LOCAL', establecimientoId: 1 }), false);
    assert.equal(potTocarPersona(neus, { id: 9, rol: 'MANAGER_LOCAL', establecimientoId: 3 }), false);
  });

  // Sense això, la regla de rangs deixaria una encarregada sense poder ni obrir
  // la seva pròpia fitxa: el seu rol no és inferior al seu.
  test('la seva pròpia fitxa, sempre', () => {
    assert.equal(potTocarPersona(neus, { id: 2, rol: 'MANAGER_LOCAL', establecimientoId: 3 }), true);
  });

  test('la responsable general arriba a tothom', () => {
    assert.equal(potTocarPersona(dolors, treballadorPalamos), true);
    assert.equal(potTocarPersona(dolors, { rol: 'MANAGER_GENERAL', establecimientoId: null }), true);
  });

  test('també arriba a qui té la seva botiga com a establiment addicional', () => {
    const compartit = { rol: 'EMPLEADO', establecimientoId: 1, establecimientosPermitidos: [{ establishmentId: 3 }] };
    assert.equal(potTocarPersona(neus, compartit), true);
    assert.equal(potTocarPersona(maria, compartit), true);
  });

  test('sense saber qui és, no', () => {
    assert.equal(potTocarPersona(neus, null), false);
  });
});

describe('posar contrasenya', () => {
  // Els treballadors no entren a l'app: el login rebutja el rol EMPLEADO. Una
  // encarregada no té cap motiu per canviar la contrasenya de ningú, i era el
  // camí exacte per fer-se responsable general.
  test('només la responsable general', () => {
    assert.equal(potPosarContrasenya(dolors), true);
    assert.equal(potPosarContrasenya(neus), false);
    assert.equal(potPosarContrasenya(maria), false);
  });

  test('sense usuari, no', () => {
    assert.equal(potPosarContrasenya(undefined), false);
    assert.equal(esGeneral(undefined), false);
  });
});

// La guarda de rutes que no guardava res: llegia `req.params.establishmentId`
// però l'única ruta que la fa servir declara el paràmetre com a `:id`, i el
// `if (!requestedId) return next()` deixava passar tothom.
describe('la guarda de ruta per establiment', () => {
  const res = () => {
    const r = { code: 200 };
    r.status = (c) => { r.code = c; return r; };
    r.json = (d) => { r.body = d; return r; };
    return r;
  };
  const passa = (guarda) => (req) => {
    const r = res();
    let seguit = false;
    guarda(req, r, () => { seguit = true; });
    return { codi: r.code, seguit };
  };
  const crida = passa(requireEstablishmentAccess);
  const cridaParam = passa(requireEstablishmentParam);

  // Són dues guardes i no una a posta. A /establishments/:id el paràmetre és
  // una botiga, però a /rules/:id és una norma i a /schedules/:id un torn: una
  // guarda que llegís `:id` a totes les rutes compararia el número d'un torn
  // amb la llista de botigues de qui truca i tancaria la porta a l'atzar.
  test('la de paràmetre llegeix el :id de la ruta', () => {
    assert.deepEqual(cridaParam({ user: neus, params: { id: '3' }, query: {} }), { codi: 200, seguit: true });
    assert.equal(cridaParam({ user: neus, params: { id: '1' }, query: {} }).seguit, false);
  });

  test('i la general no el llegeix, que allà no és cap botiga', () => {
    assert.equal(crida({ user: neus, params: { id: '3' }, query: {} }).seguit, false);
  });

  test('i també l\'altre nom, per si alguna ruta el fa servir', () => {
    assert.equal(crida({ user: neus, params: { establishmentId: '3' }, query: {} }).seguit, true);
    assert.equal(crida({ user: neus, params: { establishmentId: '1' }, query: {} }).seguit, false);
  });

  // L'atac que va trobar el revisor: la María posa a l'adreça la seva botiga,
  // que és legítima, i dins del missatge la de Girona. La guarda mirava
  // l'adreça, hi veia la seva i obria; el controlador de broadcast només
  // llegeix el cos, i el WhatsApp se n'anava als treballadors de la Neus.
  test('no s\'obre ensenyant la botiga pròpia i fent servir-ne una altra', () => {
    const colada = {
      user: maria,
      params: {},
      query: { establecimiento: '1' },    // la seva
      body: { establecimientoId: 3 },     // la que faria servir el controlador
    };
    assert.equal(crida(colada).seguit, false);
    assert.equal(crida(colada).codi, 403);
  });

  test('i tampoc al revés, amb la bona al cos', () => {
    const alreves = {
      user: maria,
      params: {},
      query: { establecimiento: '3' },
      body: { establecimientoId: 1 },
    };
    assert.equal(crida(alreves).seguit, false);
  });

  test('repetir la mateixa botiga a dos llocs no molesta', () => {
    const normal = {
      user: maria,
      params: {},
      query: { establecimiento: '1' },
      body: { establecimientoId: 1 },
    };
    assert.equal(crida(normal).seguit, true);
  });

  test('i el query, que és per on venia a mitges', () => {
    assert.equal(crida({ user: neus, params: {}, query: { establecimiento: '3' } }).seguit, true);
    assert.equal(crida({ user: neus, params: {}, query: { establecimiento: '1' } }).seguit, false);
  });

  // El cor del problema: davant del dubte, tancava obrint.
  test('sense cap botiga a la petició, tanca en comptes d\'obrir', () => {
    const r = crida({ user: neus, params: {}, query: {} });
    assert.equal(r.seguit, false, 'abans deixava passar');
    assert.equal(r.codi, 403);
  });

  test('la responsable general passa sempre', () => {
    assert.equal(crida({ user: dolors, params: {}, query: {} }).seguit, true);
    assert.equal(crida({ user: dolors, params: { id: '99' }, query: {} }).seguit, true);
  });
});
