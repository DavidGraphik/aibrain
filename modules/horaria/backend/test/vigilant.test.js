import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectaProblemes, textAvis } from '../src/services/vigilant.js';
import { quiRepLaPeticio } from '../src/services/whatsapp.js';

describe('a qui va la petició d\'una botiga', () => {
  test('els seus i els compartits que hi poden treballar', () => {
    // Aquesta prova existeix perquè el vigilant es va escriure amb una consulta
    // pròpia que deixava els compartits fora. Una botiga que només en tingui
    // hauria semblat buida, i el vigilant hauria callat justament el dia que el
    // cron morís. Si algú torna a partir-les, això peta.
    const on = quiRepLaPeticio(7);
    assert.deepEqual(on.OR, [
      { establecimientoId: 7 },
      { establecimientosPermitidos: { some: { establishmentId: 7 } } },
    ]);
    assert.equal(on.activo, true);
    assert.deepEqual(on.telefonoWhatsapp, { not: null });
  });
});

describe('el vigilant del cicle setmanal', () => {
  test('una botiga que ha enviat no és cap problema', () => {
    const r = detectaProblemes([{ nombre: 'Girona', ambTelefon: 4, enviats: 4 }]);
    assert.deepEqual(r, []);
  });

  test('una botiga que havia d\'enviar i no ha enviat res, sí', () => {
    // El cas que motiva tot això: diumenge a les 09:00 no es dispara el cron.
    // Ningú no rep res, i fins ara el sistema no ho sabia perquè tots els
    // avisos eren a dins de la feina que no s'ha executat.
    const r = detectaProblemes([{ nombre: 'Girona', ambTelefon: 4, enviats: 0 }]);
    assert.deepEqual(r, [{ botiga: 'Girona', esperava: 4 }]);
  });

  test('una botiga on ningú no té telèfon no és un problema del cron', () => {
    // Si ho fos, saltaria cada setmana per sempre, i un avís que salta sempre
    // s'acaba ignorant — que és exactament el que no volem el dia que sí.
    const r = detectaProblemes([{ nombre: 'S\'Agaró', ambTelefon: 0, enviats: 0 }]);
    assert.deepEqual(r, []);
  });

  test('només es queixa de les que han fallat, no de totes', () => {
    const r = detectaProblemes([
      { nombre: 'Girona', ambTelefon: 4, enviats: 4 },
      { nombre: 'Palamós', ambTelefon: 9, enviats: 0 },
      { nombre: 'S\'Agaró', ambTelefon: 0, enviats: 0 },
    ]);
    assert.deepEqual(r, [{ botiga: 'Palamós', esperava: 9 }]);
  });

  test('cap botiga automàtica encesa: res a vigilar', () => {
    assert.deepEqual(detectaProblemes([]), []);
  });

  test('l\'avís diu la setmana, quines botigues i què s\'ha de fer', () => {
    const text = textAvis({
      setmana: '2026-W34',
      problemes: [{ botiga: 'Girona', esperava: 4 }],
    });
    assert.match(text, /2026-W34/);
    assert.match(text, /Girona/);
    assert.match(text, /4 persones/);
    // Ha de dir què fer-hi. Un avís que només diu que passa alguna cosa deixa
    // la persona igual de quieta que no dir res.
    assert.match(text, /a mà/);
  });
});
