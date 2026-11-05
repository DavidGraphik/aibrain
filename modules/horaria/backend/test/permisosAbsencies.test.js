import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAbsences, createAbsence, getAbsencesForWeek, getVacationBalance, importHolidays,
} from '../src/controllers/absences.js';

// Les vuit rutes d'absències portaven `requireAuth` i res més: ni rol ni
// establiment. Qualsevol responsable autenticat podia llegir, modificar o
// esborrar les baixes mèdiques i les vacances de qualsevol treballador de
// qualsevol botiga. Les baixes són dades de salut, categoria especial del RGPD.
//
// Aquí només es proven els camins que rebutgen, que retornen abans de consultar
// res. Els que van per id (modificar, esborrar) han de llegir l'absència per
// saber de quina botiga és, així que la seva guarda no es pot provar sense base
// de dades i queda fora d'aquest fitxer.
const res = () => {
  const r = { code: 200 };
  r.status = (c) => { r.code = c; return r; };
  r.json = (d) => { r.body = d; return r; };
  return r;
};
const neus = { id: 2, rol: 'MANAGER_LOCAL', establecimientos: [3] };
const FORA = /No tens accés a aquest establiment/;

describe('una encarregada i les botigues que no són seves', () => {
  test('no pot llistar-ne les absències', async () => {
    const r = res();
    await getAbsences({ query: { establecimiento: '1' }, user: neus }, r);
    assert.equal(r.code, 403);
    assert.match(r.body.error, FORA);
  });

  test('no pot crear-hi una baixa', async () => {
    const r = res();
    await createAbsence({
      body: { tipo: 'BAJA_MEDICA', fechaInicio: '2026-08-17', fechaFin: '2026-08-21', empleadoId: 5, establecimientoId: 1 },
      user: neus,
    }, r);
    assert.equal(r.code, 403);
    assert.match(r.body.error, FORA);
  });

  test('no pot mirar-ne la setmana', async () => {
    const r = res();
    await getAbsencesForWeek({ query: { establecimiento: '1', semana: '2026-W34' }, user: neus }, r);
    assert.equal(r.code, 403);
  });

  test('no pot mirar-ne el saldo de vacances', async () => {
    const r = res();
    await getVacationBalance({ query: { establecimiento: '1', year: '2026' }, user: neus }, r);
    assert.equal(r.code, 403);
  });

  test('no pot importar-hi els festius', async () => {
    const r = res();
    await importHolidays({ body: { establecimientoId: 1, year: 2026 }, user: neus }, r);
    assert.equal(r.code, 403);
  });
});

// El forat que va quedar obert al primer intent: es comprovava la botiga que
// ve al cos de la petició, però no la de la PERSONA. Amb una botiga seva i
// l'id d'algú d'una altra, s'hi podia crear una baixa mèdica a nom seu — i
// com que les absències es llisten per botiga, aquella baixa passava a ser
// visible per als responsables de la botiga on s'havia colat.
//
// La comprovació necessita llegir el treballador per saber de quina botiga és,
// així que aquí només es prova la decisió (potTocarPersona, a permisos.test.js)
// i que el camí de la botiga aliena talla abans. El cas de l'empleadoId aliè no
// es pot provar sense base de dades i queda documentat aquí en comptes de
// fingir que està cobert.
describe('la seva sí', () => {
  // No arriben al 403: el que passi després (consultar Prisma) no és cosa
  // d'aquesta prova, i amb la connexió de proves peta, que és el que toca.
  test('la seva botiga no la barra la guarda', async () => {
    const r = res();
    await getAbsences({ query: { establecimiento: '3' }, user: neus }, r).catch(() => {});
    assert.notEqual(r.code, 403);
  });
});

// Un id que no és un número arribava a Prisma, que el rebutja amb un error. Com
// que absences.js era l'ÚNIC fitxer de rutes del projecte sense asyncHandler,
// aquell error quedava com una promesa rebutjada sense capturar — i des de
// Node 15 això no tomba la petició sinó el procés sencer. Un formulari que
// envia un camp buit deixava tota l'app sense servei.
describe('un id que no és un número', () => {
  test('es rebutja amb un 400, sense arribar a la base de dades', async () => {
    const r = res();
    await createAbsence({
      body: { tipo: 'BAJA_MEDICA', fechaInicio: '2026-08-17', fechaFin: '2026-08-21', empleadoId: 'abc', establecimientoId: 3 },
      user: neus,
    }, r);
    assert.equal(r.code, 400);
    assert.match(r.body.error, /empleadoId no és vàlid/);
  });

  test('una cadena buida tampoc passa', async () => {
    const r = res();
    await createAbsence({
      body: { tipo: 'VACACIONES', fechaInicio: '2026-08-17', fechaFin: '2026-08-21', empleadoId: '', establecimientoId: 3 },
      user: neus,
    }, r);
    // Sense empleadoId, salta abans la validació de camps obligatoris.
    assert.equal(r.code, 400);
  });
});
