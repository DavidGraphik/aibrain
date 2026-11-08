import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_ORDER,
  DEFERRED_FIELDS,
  schemaModels,
  schemaModelNames,
  dependenciesOf,
  missingFromOrder,
  staleInOrder,
  reviveDates,
  encodeBytes,
  decodeBytes,
  bytesFields,
  stripDeferred,
  tableName,
  dateFields,
} from '../src/utils/backupModels.js';

// The failure this guards against is not a crash, it is a quiet one: somebody
// adds a table months from now, the backup keeps reporting success, and the
// hole only shows up the day the data has to come back.
describe('la còpia cobreix tot l\'esquema', () => {
  test('cap model queda fora de MODEL_ORDER', () => {
    assert.deepEqual(missingFromOrder(), [],
      'afegeix els models que falten a backend/src/utils/backupModels.js');
  });

  test('MODEL_ORDER no menciona models inexistents', () => {
    assert.deepEqual(staleInOrder(), []);
  });

  test('no hi ha entrades repetides', () => {
    assert.equal(new Set(MODEL_ORDER).size, MODEL_ORDER.length);
  });
});

// Restoring in the wrong order fails on a foreign key, which at least is loud —
// but it fails halfway, with the database already emptied.
describe('ordre de restauració', () => {
  test('cada taula s\'escriu després de les que apunta', () => {
    const posicio = new Map(MODEL_ORDER.map((name, i) => [name, i]));
    for (const name of MODEL_ORDER) {
      for (const dep of dependenciesOf(name)) {
        assert.ok(posicio.get(dep) < posicio.get(name),
          `${name} apunta a ${dep}, que s'escriu més tard`);
      }
    }
  });

  test('els camps ajornats són opcionals', () => {
    // A cycle through a required column could not be restored at all: neither
    // side could be written first.
    for (const [modelName, fields] of Object.entries(DEFERRED_FIELDS)) {
      const model = schemaModels().find((m) => m.name === modelName);
      assert.ok(model, `${modelName} no existeix a l'esquema`);
      for (const f of fields) {
        const field = model.fields.find((x) => x.name === f);
        assert.ok(field, `${modelName}.${f} no existeix`);
        assert.equal(field.isRequired, false, `${modelName}.${f} hauria de ser opcional`);
      }
    }
  });

  test('el cicle conegut entre establiment i empleat està cobert', () => {
    // If this pair ever stops being circular the deferred pass is dead weight;
    // if a new cycle appears, the ordering test above starts failing instead.
    assert.deepEqual(DEFERRED_FIELDS.Establishment, ['managerLocalId']);
  });
});

describe('preparació de les dades', () => {
  test('les dates tornen a ser dates', () => {
    const [row] = reviveDates('Employee', [{ id: 1, createdAt: '2026-08-04T09:00:00.000Z' }]);
    assert.ok(row.createdAt instanceof Date);
    assert.equal(row.createdAt.toISOString(), '2026-08-04T09:00:00.000Z');
  });

  test('els nuls es queden com estan', () => {
    const [row] = reviveDates('WhatsappConversation', [{ id: 1, completedAt: null }]);
    assert.equal(row.completedAt, null);
  });

  test('troba les dates de les absències, inclosos els camps @db.Date', () => {
    const camps = dateFields('Absence');
    for (const f of ['fechaInicio', 'fechaFin', 'createdAt', 'updatedAt']) {
      assert.ok(camps.includes(f), `falta ${f}`);
    }
  });

  test('els camps ajornats s\'esborren sense tocar l\'original', () => {
    const original = [{ id: 1, nombre: 'Girona', managerLocalId: 7 }];
    const [net] = stripDeferred('Establishment', original);
    assert.equal(net.managerLocalId, null);
    assert.equal(net.nombre, 'Girona');
    assert.equal(original[0].managerLocalId, 7, 'no s\'ha de modificar l\'entrada');
  });

  test('un model sense camps ajornats es deixa intacte', () => {
    const rows = [{ id: 1, contenido: 'hola' }];
    assert.equal(stripDeferred('WhatsappMessage', rows)[0].contenido, 'hola');
  });

  // A photographed sheet is binary. JSON.stringify turns a Buffer into
  // {"type":"Buffer","data":[...]} — five times the size, and something Prisma
  // cannot write back.
  test('troba les columnes binàries', () => {
    assert.deepEqual(bytesFields('PaperSheet'), ['imagen']);
    assert.deepEqual(bytesFields('Employee'), []);
  });

  test('una imatge sobreviu al viatge d\'anada i tornada', () => {
    const original = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]); // capçalera JPEG
    const [desat] = encodeBytes('PaperSheet', [{ id: 1, imagen: original }]);
    assert.equal(typeof desat.imagen, 'string', 'al fitxer hi ha d\'anar en base64');
    assert.ok(JSON.parse(JSON.stringify(desat)).imagen === desat.imagen, 'ha de sobreviure al JSON');

    const [tornat] = decodeBytes('PaperSheet', JSON.parse(JSON.stringify([desat])));
    assert.ok(Buffer.isBuffer(tornat.imagen));
    assert.deepEqual(tornat.imagen, original, 'els bytes han de ser exactament els mateixos');
  });

  test('una imatge absent no es converteix en res estrany', () => {
    const [r] = encodeBytes('PaperSheet', [{ id: 1, imagen: null }]);
    assert.equal(r.imagen, null);
    assert.equal(decodeBytes('PaperSheet', [{ id: 1, imagen: null }])[0].imagen, null);
  });
});

// The id counters live under the table name, not the model name; getting this
// wrong would leave every sequence at zero and the next insert would collide
// with a restored row.
describe('noms de taula', () => {
  test('fa servir el nom real de la taula (@@map)', () => {
    assert.equal(tableName('Establishment'), 'establishments');
    assert.equal(tableName('WhatsappConversation'), 'whatsapp_conversations');
    assert.equal(tableName('SemanaIntensidad'), 'semana_intensidad');
  });

  test('cada model té un nom de taula', () => {
    for (const name of schemaModelNames()) {
      assert.ok(tableName(name), `${name} no té taula`);
    }
  });
});
