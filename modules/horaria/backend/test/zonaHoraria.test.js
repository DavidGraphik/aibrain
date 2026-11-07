import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { zonaHoraria, ZONA_PER_DEFECTE } from '../src/utils/zonaHoraria.js';

// Tot el cicle setmanal es calcula amb hores locals — la finestra obre diumenge
// a les 9 i tanca dimecres a la 1 — i el Render executa els contenidors en UTC
// per defecte. Amb el servidor en UTC, el cron de diumenge a les 9:00 de Madrid
// hauria trobat la finestra tancada, hauria tornat «0 enviats» amb un HTTP 200,
// i com que és un 200 el cron no envia el correu de job fallit. Ningú hauria
// rebut la petició i ningú se n'hauria assabentat.
describe('la zona horària del servidor', () => {
  test('per defecte, la de la botiga', () => {
    assert.equal(zonaHoraria({}), 'Europe/Madrid');
    assert.equal(zonaHoraria({}), ZONA_PER_DEFECTE);
  });

  test('una TZ posada des de fora mana', () => {
    assert.equal(zonaHoraria({ TZ: 'Atlantic/Canary' }), 'Atlantic/Canary');
  });

  test('queda aplicada de debò en importar el mòdul', () => {
    assert.ok(process.env.TZ, 'sense TZ, les hores locals són les del servidor');
  });

  // El cas exacte de diumenge: les 9 del matí a Madrid són les 7 UTC.
  test('les 07:00 UTC d\'un diumenge d\'agost es llegeixen com les 9', () => {
    const d = new Date('2026-08-16T07:00:00Z');
    assert.equal(d.getHours(), 9, 'si dona 7, el servidor està en UTC i la finestra no obrirà');
    assert.equal(d.getDay(), 0, 'i segueix sent diumenge');
  });
});
