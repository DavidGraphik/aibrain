import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkEmployeeConditions } from '../src/services/conditionCheck.js';

// Les peticions de WhatsApp manen per damunt de les condicions fixes: és la
// norma de la casa. Però el revisor no ho sabia, i quan una condició cedia
// davant d'una petició concedida ho comptava com un incompliment — el sistema
// feia el que tocava i tot seguit s'acusava a si mateix.
//
// El cas real: a en Jordi Defaus li marcava dues condicions incomplertes a la
// W34, i totes dues sortien del dimecres de festa que ell havia demanat.
describe('una condició que cedeix davant d\'una petició', () => {
  const DIES = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'];
  const setmana = (torns) => DIES.map((dia, i) => ({ dia, turno: torns[i] }));

  // La Núria fa matins tota la setmana; en Jordi ha de fer els mateixos.
  const nuria = {
    empleado: { nombre: 'Nuria', apellidos: 'Bachs' },
    dias: setmana(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA']),
  };
  const jordi = { condicionesFijas: 'No fa festa entre setmana. Ha de fer els mateixos MATINS que Nuria Bachs.' };

  const revisa = (torns, demanats = []) => checkEmployeeConditions({
    empleado: jordi,
    dias: setmana(torns),
    diasHabituales: DIES,
    companys: [nuria],
    idioma: 'ca',
    diesDemanats: demanats,
  });

  test('sense demanar res, el desquadre és un incompliment', () => {
    const r = revisa(['MANANA', 'MANANA', 'LIBRE', 'MANANA', 'MANANA', 'MANANA']);
    assert.equal(r.problemas.length, 2, 'la sincronia i la festa entre setmana');
    assert.equal(r.informatius.length, 0);
  });

  test('si va demanar aquell dia, deixa de comptar com a error', () => {
    const r = revisa(['MANANA', 'MANANA', 'LIBRE', 'MANANA', 'MANANA', 'MANANA'], ['MIERCOLES']);
    assert.equal(r.problemas.length, 0, 'cap incompliment');
    assert.equal(r.informatius.length, 2, 'però es continuen veient');
    assert.ok(r.informatius.every((m) => m.startsWith('Per petició seva:')));
  });

  // El que importa: demanar un dia no dona barra lliure per a la resta.
  test('un dia demanat i un altre que no: només el segon és incompliment', () => {
    const r = revisa(['MANANA', 'TARDE', 'LIBRE', 'MANANA', 'MANANA', 'MANANA'], ['MIERCOLES']);
    const tots = r.problemas.join(' ');
    assert.ok(tots.includes('dimarts'), 'el dimarts, que no va demanar, sí');
    assert.ok(!tots.includes('dimecres'), 'el dimecres, que va demanar, no');
    assert.equal(r.informatius.length, 2);
  });

  test('demanar un torn concret també protegeix aquell dia', () => {
    const r = revisa(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'TARDE', 'MANANA'], ['VIERNES']);
    assert.equal(r.problemas.length, 0);
    assert.match(r.informatius[0], /divendres/);
  });

  test('la setmana perfecta no diu res de res', () => {
    const r = revisa(['MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA', 'MANANA'], ['MIERCOLES']);
    assert.equal(r.problemas.length, 0);
    assert.equal(r.informatius.length, 0, 'no s\'inventa avisos per haver demanat');
  });

  test('sense dir-li res de peticions, es comporta com abans', () => {
    const r = checkEmployeeConditions({
      empleado: jordi,
      dias: setmana(['MANANA', 'MANANA', 'LIBRE', 'MANANA', 'MANANA', 'MANANA']),
      diasHabituales: DIES,
      companys: [nuria],
      idioma: 'ca',
    });
    assert.equal(r.problemas.length, 2);
    assert.deepEqual(r.informatius, []);
  });
});
