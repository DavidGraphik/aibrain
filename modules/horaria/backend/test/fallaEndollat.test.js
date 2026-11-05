import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Aquesta prova mira el codi font i no el resultat de cridar les funcions,
// perquè totes dues necessiten base de dades i aquí no n'hi ha.
//
// Existeix perquè hi havia cinc proves que comprovaven que la regla de l'alarma
// era correcta i cap que comprovés que estigués endollada: `recordatorisAutomatics`
// calculava `falla` i després se'l deixava fora del que retornava. Els
// controladors llegien `undefined`, i l'alarma de WhatsApp caigut havia deixat
// de sonar sense que res ho digués. Es va provar la regla, no el cable.
const FONT = readFileSync(new URL('../src/services/whatsapp.js', import.meta.url), 'utf8');

function cosDe(nom) {
  const inici = FONT.indexOf(`export async function ${nom}(`);
  assert.notEqual(inici, -1, `no s'ha trobat ${nom}`);
  const fi = FONT.indexOf('\n}\n', inici);
  assert.notEqual(fi, -1, `no s'ha trobat el final de ${nom}`);
  return FONT.slice(inici, fi);
}

describe('el camp que decideix l\'alarma arriba a totes les sortides', () => {
  for (const nom of ['broadcastAutomatic', 'recordatorisAutomatics']) {
    test(`${nom} retorna falla per tots els camins`, () => {
      const sortides = cosDe(nom).match(/return \{[^}]*\}/g) || [];
      assert.ok(sortides.length >= 3, `${nom} hauria de tenir com a mínim 3 sortides, n'hi ha ${sortides.length}`);
      for (const sortida of sortides) {
        assert.match(sortida, /\bfalla\b/,
          `una sortida de ${nom} no diu res de falla, i els controladors hi llegiran undefined:\n${sortida}`);
      }
    });
  }
});
