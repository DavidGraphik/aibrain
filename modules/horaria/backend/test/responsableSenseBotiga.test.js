import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { create, update, updateAllowedEstablishments, potTenirEstabliment, rolDespresDeDesar } from '../src/controllers/employees.js';

const encarregada = { id: 2, rol: 'MANAGER_LOCAL', establecimientos: [3] };

// La responsable general no pertany a cap botiga: les porten les encarregades.
//
// Quatre consultes del flux de WhatsApp defineixen «l'equip d'una botiga» i
// només una excloïa el rol. En comptes de repetir el filtre a totes quatre i
// confiar que la cinquena que vingui també se'n recordi, es tanca la porta a
// l'hora d'assignar.
//
// CAP D'AQUESTES PROVES ARRIBA A LA BASE DE DADES. Les versions anteriors
// d'aquest fitxer sí: una va crear dos treballadors de debò a producció, una
// altra va escriure un camp a una persona real, i una tercera hauria esborrat
// establiments el dia que una id canviés — i totes tres passaven en verd. La
// decisió viu a `potTenirEstabliment`, que és una funció pura, i dels
// controladors només es proven els camins que retornen abans de consultar res.
//
// A més, `test/sense-produccio.js` canvia la connexió abans de cada fitxer, o
// sigui que una prova que hi arribi peta en comptes d'escriure. Ja ho ha fet:
// una quarta versió d'aquest fitxer provava que la guarda NO barra un
// treballador normal, i per comprovar-ho havia de deixar passar la petició fins
// a Prisma. Comprovar que una guarda no salta es fa sobre la funció pura, no
// deixant córrer el controlador a veure què passa.
const res = () => {
  const r = { code: 200 };
  r.status = (c) => { r.code = c; return r; };
  r.json = (d) => { r.body = d; return r; };
  return r;
};
const general = { rol: 'MANAGER_GENERAL' };
const MISSATGE = /no pertany a cap establiment/;

describe('qui pot tenir botiga assignada', () => {
  test('la responsable general, no', () => {
    assert.equal(potTenirEstabliment('MANAGER_GENERAL'), false);
  });

  test('l\'encarregada, sí: hi treballa i compta com a equip', () => {
    assert.equal(potTenirEstabliment('MANAGER_LOCAL'), true);
  });

  test('els treballadors, sí', () => {
    assert.equal(potTenirEstabliment('EMPLEADO'), true);
  });

  // update() li passa data.rol, que és undefined quan la petició no toca el rol.
  test('sense rol a la petició, no barra res', () => {
    assert.equal(potTenirEstabliment(undefined), true);
  });
});

// Aquí és on va fallar de debò. Una optimització va deixar el codi triant la
// branca amb el rol NOU i comprovant el VELL, i llavors degradar la responsable
// general a encarregada d'una botiga en el mateix desat es rebutjava: li deia
// que no pot tenir establiment quan en aquella mateixa petició ja deixava de
// ser-ho. El formulari envia sempre el rol, o sigui que no era cap cas rar.
describe('quin rol es mira per decidir', () => {
  test('el que ve a la petició mana sobre el que hi ha desat', () => {
    assert.equal(
      rolDespresDeDesar({ rol: 'MANAGER_LOCAL' }, { rol: 'MANAGER_GENERAL' }),
      'MANAGER_LOCAL',
      'degradar-la i donar-li botiga alhora ha de poder-se'
    );
  });

  test('promoure-la mana igualment', () => {
    assert.equal(rolDespresDeDesar({ rol: 'MANAGER_GENERAL' }, { rol: 'EMPLEADO' }), 'MANAGER_GENERAL');
  });

  test('si la petició no toca el rol, val el que hi ha desat', () => {
    assert.equal(rolDespresDeDesar({}, { rol: 'MANAGER_GENERAL' }), 'MANAGER_GENERAL');
  });

  test('i si no hi ha ni l\'un ni l\'altre, no barra res', () => {
    assert.equal(potTenirEstabliment(rolDespresDeDesar({}, null)), true);
  });
});

describe('assignar una botiga a la responsable general', () => {
  test('en crear-la, es rebutja', async () => {
    const r = res();
    await create({ body: { nombre: 'X', apellidos: 'Y', rol: 'MANAGER_GENERAL', establecimientoId: 3 }, user: general }, r);
    assert.equal(r.code, 400);
    assert.match(r.body.error, MISSATGE);
  });

  // Surt pel 400 sense consultar res: el rol ve a la mateixa petició.
  test('en promoure algú a responsable general amb botiga, es rebutja', async () => {
    const r = res();
    await update({ params: { id: '999999' }, body: { rol: 'MANAGER_GENERAL', establecimientoId: 3 }, user: general }, r);
    assert.equal(r.code, 400);
    assert.match(r.body.error, MISSATGE);
  });

  // L'escalada de privilegis que va trobar l'auditoria: aquest mateix endpoint
  // deixa posar contrasenya, i no mirava ni de quina botiga era la persona ni
  // quin rol tenia. Una encarregada podia canviar la de la responsable general
  // i entrar com ella. Es rebutja abans de consultar res.
  test('una encarregada no pot posar contrasenya a ningú', async () => {
    const r = res();
    await update({ params: { id: '1' }, body: { password: 'nova123' }, user: encarregada }, r);
    assert.equal(r.code, 403);
    assert.match(r.body.error, /responsable general pot posar contrasenyes/);
  });

  test('ni moure ningú a una botiga que no és seva', async () => {
    const r = res();
    await update({ params: { id: '108' }, body: { establecimientoId: 1 }, user: encarregada }, r);
    assert.equal(r.code, 403);
    assert.match(r.body.error, /accés a aquest establiment/);
  });

  test('ni llistar la plantilla d\'una altra botiga', async () => {
    const { getAll } = await import('../src/controllers/employees.js');
    const r = res();
    await getAll({ query: { establecimiento: '1' }, user: encarregada }, r);
    assert.equal(r.code, 403);
  });

  test('una llista d\'establiments que no és una llista es rebutja abans de res', async () => {
    const r = res();
    await updateAllowedEstablishments({ params: { id: '999999' }, body: { establishmentIds: 'tres' }, user: general }, r);
    assert.equal(r.code, 400);
    assert.match(r.body.error, /array/);
  });

});
