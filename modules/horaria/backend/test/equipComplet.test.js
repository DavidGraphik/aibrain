import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { textEquipComplet } from '../src/services/whatsapp.js';

// Deia «tot l'equip ha enviat les seves preferències» comptant només els que
// tenen telèfon a la fitxa. A Girona això són 4 de 16: quan aquells quatre
// contestessin, la responsable hauria rebut llum verda per generar un horari
// amb tres quartes parts de l'equip a qui ningú ha preguntat res — i sense
// manera d'assabentar-se'n, perquè el missatge deia que estava tot fet.
describe('l\'avís de «ja pots generar»', () => {
  const base = { nom: 'Dolors', botiga: 'Girona', setmana: 'del 24 al 30 d\'agost' };

  test('amb tot l\'equip localitzable, ho diu i prou', () => {
    const t = textEquipComplet({ ...base, ambTelefon: 16, senseTelefon: 0 });
    assert.match(t, /Tot l'equip de Girona \(16\)/);
    assert.doesNotMatch(t, /Atenció/, 'no avisa del que no hi ha');
  });

  // El cas real de Girona ara mateix.
  test('amb mitja plantilla sense telèfon, no diu que hagi contestat tothom', () => {
    const t = textEquipComplet({ ...base, ambTelefon: 4, senseTelefon: 12 });
    assert.doesNotMatch(t, /Tot l'equip/, 'quatre de setze no és tot l\'equip');
    assert.match(t, /els 4 treballadors/);
    assert.match(t, /12 treballadors més no tenen telèfon/);
  });

  // El verb també ha de concordar. La primera versió deia «1 treballador més
  // no TENEN telèfon», i la prova la deixava passar perquè acceptava les dues.
  test('amb un de sol sense telèfon, tot en singular', () => {
    const t = textEquipComplet({ ...base, ambTelefon: 15, senseTelefon: 1 });
    assert.match(t, /1 treballador més no té telèfon/);
    assert.match(t, /no se li ha demanat res/);
    assert.doesNotMatch(t, /no tenen|no se'ls/, 'no barreja singular i plural');
  });

  test('amb un de sol que ha contestat, també', () => {
    const t = textEquipComplet({ ...base, ambTelefon: 1, senseTelefon: 3 });
    assert.match(t, /l'únic treballador al qual se li ha pogut preguntar/);
    assert.doesNotMatch(t, /els 1 treballadors/);
  });

  test('sempre acaba dient què pot fer', () => {
    for (const [a, s] of [[16, 0], [4, 12], [1, 0]]) {
      assert.match(textEquipComplet({ ...base, ambTelefon: a, senseTelefon: s }), /Ja pots generar l'horari/);
    }
  });

  // La responsable general compta com la resta: si se li demanen preferències,
  // forma part de l'equip. Abans se la treia només del compte dels que no
  // tenen telèfon, o sigui que hi era o no segons si en tenia.
  test('sense ningú a qui preguntar, no diu que hagi contestat tothom', () => {
    const t = textEquipComplet({ ...base, ambTelefon: 0, senseTelefon: 5 });
    assert.doesNotMatch(t, /han contestat els 0|Tot l'equip/);
    assert.match(t, /cap treballador té telèfon/);
  });

  test('sempre saluda pel nom i diu de quina botiga i quina setmana', () => {
    for (const [a, s] of [[16, 0], [4, 12]]) {
      const t = textEquipComplet({ ...base, ambTelefon: a, senseTelefon: s });
      assert.ok(t.startsWith('Hola Dolors.'));
      assert.ok(t.includes('Girona'));
      assert.ok(t.includes('del 24 al 30 d\'agost'));
    }
  });
});
