import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tradueixCondicions, enParaules } from '../src/services/traductorCondicions.js';

// CAP D'AQUESTES PROVES PARLA AMB LA IA. La crida s'injecta, que és el que
// permet provar el reintent — la part que més fàcil és escriure malament i la
// que no es veu fallar fins que falla de debò, amb una fitxa de veritat.
const ambCrida = (crida) => ({ crida });
const respon = (...respostes) => {
  const dites = [];
  const fn = async (missatges) => { dites.push(missatges); return respostes.shift() ?? '{}'; };
  fn.dites = dites;
  return fn;
};

describe('traduir una condició', () => {
  test('una traducció bona es dona per bona a la primera', async () => {
    const r = await tradueixCondicions('Tot matins', ambCrida(respon('{"tornsPermesos":["MANANA"]}')));
    assert.equal(r.ok, true);
    assert.deepEqual(r.condicions, { tornsPermesos: ['MANANA'] });
    assert.equal(r.intents, 1);
  });

  test('accepta el JSON encara que vingui embolicat', async () => {
    const r = await tradueixCondicions('Tot matins', ambCrida(respon('Aquí tens:\n```json\n{"tornsPermesos":["MANANA"]}\n```')));
    assert.equal(r.ok, true);
  });

  test('sense text no es pregunta res', async () => {
    const crida = respon();
    const r = await tradueixCondicions('   ', { crida });
    assert.equal(r.ok, true);
    assert.equal(r.condicions, null);
    assert.equal(crida.dites.length, 0, 'no s\'ha de gastar una crida per no res');
  });
});

describe('quan la IA s\'equivoca', () => {
  test('es torna a demanar UNA vegada, dient-li què fallava', async () => {
    const crida = respon('{"sempreDeNit":true}', '{"tornsPermesos":["TARDE"]}');
    const r = await tradueixCondicions('Sempre tardes', { crida });
    assert.equal(r.ok, true);
    assert.equal(r.intents, 2);
    assert.deepEqual(r.condicions, { tornsPermesos: ['TARDE'] });
    // La segona vegada se li ha de dir QUÈ estava malament: repetir la mateixa
    // pregunta és demanar-li que encerti per atzar.
    const segona = JSON.stringify(crida.dites[1]);
    assert.match(segona, /sempreDeNit/);
  });

  test('i si torna a fallar, es diu que no ha anat bé', async () => {
    const r = await tradueixCondicions('Sempre tardes', ambCrida(respon('{"aixo":1}', '{"allo":2}')));
    assert.equal(r.ok, false);
    assert.equal(r.condicions, null);
    assert.ok(r.errors.length > 0, 'ha de dir per què no ha colat');
    assert.equal(r.intents, 2);
  });

  test('no es demana tres vegades', async () => {
    const crida = respon('{"a":1}', '{"b":2}', '{"tornsPermesos":["TARDE"]}');
    await tradueixCondicions('Sempre tardes', { crida });
    assert.equal(crida.dites.length, 2, 'insistir més és fer-li endevinar');
  });

  test('una resposta que no és JSON també es reintenta', async () => {
    const crida = respon('No ho sé, ho sento', '{"tornsPermesos":["MANANA"]}');
    const r = await tradueixCondicions('Tot matins', { crida });
    assert.equal(r.ok, true);
    assert.match(JSON.stringify(crida.dites[1]), /JSON/);
  });

  test('el que va contestar es guarda, per poder mirar què va entendre', async () => {
    const r = await tradueixCondicions('Sempre tardes', ambCrida(respon('{"a":1}', '{"b":2}')));
    assert.match(r.crua, /"b"/);
  });
});

describe('el que se li ensenya a qui ho ha de validar', () => {
  test('no és un JSON, són frases', () => {
    const l = enParaules({ maxTardes: 3, tardesIdeal: 2, partidoCompta: 'TARDA', maxPartidos: 1 });
    assert.deepEqual(l, [
      'Com a molt 3 tardes per setmana',
      "(preferència) L'ideal són 2 tardes",
      'Com a molt 1 dia partit',
      'Un dia partit compta com una tarda',
    ]);
  });

  test('els condicionals es diuen sencers', () => {
    const l = enParaules({ condicionals: [{ si: { dia: 'SABADO', torn: 'PARTIDO' }, llavors: { dia: 'VIERNES', torn: 'MANANA' } }] });
    assert.deepEqual(l, ['Si el dissabte fa dia partit, el divendres ha de fer matí']);
  });

  test('cada camp que es pugui desar s\'ha de poder llegir', () => {
    // Un camp que es desés i no sortís en paraules seria una condició que ningú
    // valida perquè ningú la veu.
    const tot = {
      tornsPermesos: ['MANANA'], maxTardes: 3, tardesIdeal: 2, matinsExactes: 3, tardesExactes: 3,
      partidosExactes: 1, maxPartidos: 1, partidosNoConsecutius: true, partidoCompta: 'TARDA',
      minDiesFesta: 1, capFestaEntreSetmana: true, tornFixe: { LUNES: 'MANANA' },
      condicionals: [{ si: { dia: 'SABADO', torn: 'MANANA' }, llavors: { dia: 'VIERNES', torn: 'PARTIDO' } }],
      sincronitzatAmb: { empleadoId: 113, que: 'MATINS' },
    };
    assert.equal(enParaules(tot).length, 14);
  });

  test('el que NO es garanteix també s\'ensenya, i marcat', () => {
    // Era el forat gros: qui validava la traducció no veia justament el que no
    // es garanteix, i la donava per bona creient que hi era tot.
    const l = enParaules({ maxTardes: 3, jaALaFitxa: 'de 16h fins al tancament', noGarantit: 'És encarregada.' });
    assert.ok(l.some((x) => x.includes('(ja consta a la fitxa) de 16h')));
    assert.ok(l.some((x) => x.includes('(NO garantit) És encarregada.')));
  });

  test('es llegeix bé en singular', () => {
    const l = enParaules({ maxPartidos: 1, minDiesFesta: 1, matinsExactes: 1, maxTardes: 1 });
    assert.deepEqual(l, [
      'Com a molt 1 tarda per setmana',
      'Exactament 1 matí',
      'Com a molt 1 dia partit',
      'Com a mínim 1 dia de festa',
    ]);
  });

  test('sense condicions, cap frase', () => {
    assert.deepEqual(enParaules(null), []);
    assert.deepEqual(enParaules({}), []);
  });
});
