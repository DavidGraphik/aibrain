import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ─────────────────────────────────────────────
// QUE EL CAMP ARRIBI FINS AL FINAL
//
// L'hora del descans d'un PARTIDO es podia escriure al desplegable, es veia
// escrita, es premia desar... i es perdia. El desplegable l'enviava, però la
// pantalla que rep només agafava el torn i l'hora d'entrada, i el camp queia
// allà mateix sense que res es queixés. A l'alta, a més, el controlador tampoc
// el llegia. Dues baixades diferents del mateix camp, i cap error enlloc.
//
// Cap prova d'aquest projecte mirava la cadena sencera: totes provaven un tros.
// Un camp que es perd entre dues capes no el veu ni la prova del davant ni la
// del darrere.
// ─────────────────────────────────────────────
const llegeix = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const MODAL = llegeix('./fixtures/upstream-ui/components/ShiftEditModal.jsx');
const PANTALLA = llegeix('./fixtures/upstream-ui/pages/Dashboard.jsx');
const CONTROLADOR = llegeix('../src/controllers/schedules.js');

const tros = (font, nom) => {
  const i = font.indexOf(`function ${nom}(`);
  assert.ok(i > 0, `no trobo ${nom}`);
  // `indexOf` torna -1 quan no el troba, i -1 + 4 és 3: un número que val com
  // a cert, o sigui que un `|| font.length` no s'activaria mai i el retall
  // sortiria buit. Buit no fa match amb res i la prova falla amb un missatge
  // que no diu què passa.
  const fi = font.indexOf('\n}\n', i);
  assert.ok(fi > i, `no trobo el final de ${nom}`);
  return font.slice(i, fi);
};

describe('l\'hora del descans va del desplegable fins a la base de dades', () => {
  test('1. el desplegable l\'envia', () => {
    assert.match(MODAL, /onSave\(\{ turno, horaEntrada:[^}]*horaDescanso:/);
  });

  test('2. la pantalla la recull', () => {
    assert.match(PANTALLA, /function handleSaveShift\(\{[^}]*horaDescanso[^}]*\}\)/,
      'si no es desestructura, cau aquí mateix i ningú se n\'assabenta');
  });

  test('3. i la passa tant en editar com en crear', () => {
    const cos = tros(PANTALLA, 'handleSaveShift');
    assert.match(cos, /client\.put\(`\/schedules\/\$\{shift\.id\}`, \{[^}]*horaDescanso/);
    assert.match(cos, /horaDescanso,/, 'falta al cos del POST de creació');
  });

  test('4. el controlador la llegeix als dos camins', () => {
    for (const nom of ['createShift', 'updateShift']) {
      const cos = CONTROLADOR.slice(CONTROLADOR.indexOf(`export async function ${nom}(`));
      const capcalera = cos.slice(0, cos.indexOf('\n}\n'));
      assert.match(capcalera, /const \{[^}]*horaDescanso[^}]*\} = req\.body/,
        `${nom} no llegeix horaDescanso del cos de la petició`);
    }
  });

  test('5. i el desa, cadascú al seu tros', () => {
    // Acotat a cada funció i no buscat a tot el fitxer: si la línia
    // desaparegués d'updateShift i quedés en una altra banda, buscar-la al
    // fitxer sencer donaria verd igualment.
    assert.match(tros(CONTROLADOR, 'createShift'), /horaDescanso: horaDescanso \|\| null/);
    assert.match(tros(CONTROLADOR, 'updateShift'), /horaDescanso: descans \|\| null/);
  });

  test('6. i no el desa si el torn que queda no és un DIA', () => {
    // Una hora de descans en un matí no vol dir res, i deixada escrita
    // reapareixeria el dia que la casella tornés a ser un DIA.
    const cos = tros(CONTROLADOR, 'updateShift');
    assert.match(cos, /const tornFinal = turno !== undefined \? turno : existing\?\.turno;/);
    assert.match(cos, /const descans = tornFinal === 'PARTIDO' \? horaDescanso : null;/);
  });

  test('el camp existeix a la base de dades', () => {
    assert.match(llegeix('../prisma/schema.prisma'), /horaDescanso\s+String\?/);
  });
});
