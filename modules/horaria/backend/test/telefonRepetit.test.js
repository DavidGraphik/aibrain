import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { respostaDeDuplicat } from '../src/controllers/employees.js';

// El telèfon i el correu són únics a la base de dades, i desar-ne un de repetit
// sortia com a «error intern del servidor»: ni deia què passava ni què fer. El
// número el sol tenir una fitxa vella, de proves o duplicada, que des de la
// pantalla no es veu — o sigui que l'única sortida era endevinar-ho.
//
// CAP D'AQUESTES PROVES ARRIBA A LA BASE DE DADES: només es proven els camins
// que tornen abans de consultar-la, i la resta es mira al codi font, com a
// `alternancaEndollada.test.js`.
const P2002 = (camp) => ({ code: 'P2002', meta: { target: [camp] } });
const dolors = { id: 1, rol: 'MANAGER_GENERAL', establecimientos: [] };

describe('quan el telèfon o el correu ja els té una altra fitxa', () => {
  test('un error que no sigui un duplicat torna null, per deixar-lo pujar', async () => {
    assert.equal(await respostaDeDuplicat(new Error('la connexió ha caigut'), {}, dolors), null);
    assert.equal(await respostaDeDuplicat({ code: 'P2025' }, {}, dolors), null);
    assert.equal(await respostaDeDuplicat(undefined, {}, dolors), null);
  });

  test('un camp únic que encara no consti no s\'endevina', async () => {
    // Abans, qualsevol camp que no fos el telèfon es tractava com un correu i
    // es buscava com si ho fos. Si algun dia s'afegeix un DNI, diria que el
    // correu està repetit.
    const r = await respostaDeDuplicat(P2002('dni'), { dni: '12345678Z' }, dolors);
    assert.match(r.error, /aquesta dada/i);
    assert.equal(r.camp, 'dni');
    assert.equal(r.idEnConflicte, null);
  });

  test('sense valor no es va a buscar de qui és', async () => {
    const r = await respostaDeDuplicat(P2002('telefonoWhatsapp'), {}, dolors);
    assert.equal(r.idEnConflicte, null);
  });

  test('qui no pot veure la fitxa rep el mateix que si no s\'hagués trobat res', () => {
    // Dir «existeix però no t'ho puc dir» convertiria el formulari en una
    // manera de saber si un número qualsevol està donat d'alta en alguna
    // botiga. Es comprova al codi font perquè aquest camí consulta la BD.
    const FONT = readFileSync(new URL('../src/controllers/employees.js', import.meta.url), 'utf8');
    const cos = FONT.slice(FONT.indexOf('export async function respostaDeDuplicat'));
    const generic = 'Aquesta dada ja consta en una altra fitxa.';
    assert.equal((cos.match(new RegExp(generic, 'g')) || []).length, 1);
    assert.match(cos, /if \(!dequi\) return \{ error: 'Aquesta dada ja consta/);
    assert.match(cos, /if \(altre && potTocarPersona\(usuari, altre\)\) dequi = altre;/);
  });
});

const FONT = readFileSync(new URL('../src/controllers/employees.js', import.meta.url), 'utf8');
const tros = (nom) => {
  const i = FONT.indexOf(`export async function ${nom}(`);
  return FONT.slice(i, FONT.indexOf('\n}\n', i));
};

// Provar la regla sense provar el cable dona confiança sense donar cobertura.
// Aquí a més hi ha el precedent directe: es va arreglar l'update i l'alta va
// quedar petant igual una setmana més, perquè eren dues còpies del mateix.
describe('els dos camins que desen una fitxa ho diuen igual', () => {
  for (const nom of ['create', 'update']) {
    test(`${nom} captura el xoc i respon 409`, () => {
      const cos = tros(nom);
      assert.match(cos, /const xoc = await respostaDeDuplicat\(/, `${nom} no ho comprova`);
      assert.match(cos, /if \(!xoc\) throw err;/, `${nom} s'empassaria errors que no són duplicats`);
      assert.match(cos, /res\.status\(409\)\.json\(xoc\)/);
      assert.doesNotMatch(cos, /res\.status\(500\)/);
    });
  }

  test('i li passen les dades que s\'estaven desant, no el cos de la petició', () => {
    // Del cos de la petició en surt el telèfon en brut; de les dades, el que
    // de veritat s'ha intentat escriure.
    assert.match(tros('create'), /respostaDeDuplicat\(err, dades, req\.user\)/);
    assert.match(tros('update'), /respostaDeDuplicat\(err, data, req\.user\)/);
  });
});
