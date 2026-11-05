import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { llistaMunicipis, festesLocals, buidaMemoria } from '../src/services/festesLocals.js';

// The two local holidays are the ones that actually catch a shop out — nothing
// national says Girona shuts for Sant Narcís — so this reads an outside
// service. Here it is stubbed: what matters is that we survive every shape it
// can hand back, including the two it returns with a 200.
function fingeixFetch(respostes) {
  const trucades = [];
  globalThis.fetch = async (url) => {
    trucades.push(String(url));
    const r = respostes.shift();
    if (r instanceof Error) throw r;
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.body,
    };
  };
  return trucades;
}

const fetchOriginal = globalThis.fetch;

describe('festes locals', () => {
  beforeEach(() => {
    buidaMemoria();
    globalThis.fetch = fetchOriginal;
  });

  test('la llista de municipis surt ordenada en català', async () => {
    fingeixFetch([{ body: [
      { codi_municipal: '17079000', ajuntament_o_nucli_municipal: 'Girona' },
      { codi_municipal: '17048000', ajuntament_o_nucli_municipal: 'Castell-Platja d\'Aro' },
      { codi_municipal: '17118000', ajuntament_o_nucli_municipal: 'Palamós' },
    ] }]);
    const m = await llistaMunicipis(2026);
    assert.deepEqual(m.map((x) => x.nom), ['Castell-Platja d\'Aro', 'Girona', 'Palamós']);
    assert.equal(m[1].codi, '17079000');
  });

  test('les files sense codi o sense nom no entren a la llista', async () => {
    fingeixFetch([{ body: [
      { codi_municipal: '17079000', ajuntament_o_nucli_municipal: 'Girona' },
      { codi_municipal: '', ajuntament_o_nucli_municipal: 'Sense codi' },
      { codi_municipal: '17118000' },
    ] }]);
    assert.deepEqual((await llistaMunicipis(2026)).map((x) => x.nom), ['Girona']);
  });

  test('les festes surten per ordre de data i amb la data neta', async () => {
    fingeixFetch([{ body: [
      { data: '2026-10-29T00:00:00.000', ajuntament_o_nucli_municipal: 'Girona', festiu: 'Festiu local' },
      { data: '2026-07-25T00:00:00.000', ajuntament_o_nucli_municipal: 'Girona', festiu: 'Festiu local' },
    ] }]);
    const f = await festesLocals('17079000', 2026);
    assert.deepEqual(f.map((x) => x.fecha), ['2026-07-25', '2026-10-29']);
    assert.equal(f[0].municipi, 'Girona');
  });

  test('una data il·legible s\'ignora en comptes de colar-se com a festiu', async () => {
    fingeixFetch([{ body: [
      { data: 'demà', ajuntament_o_nucli_municipal: 'Girona' },
      { data: null, ajuntament_o_nucli_municipal: 'Girona' },
      { data: '2026-10-29T00:00:00.000', ajuntament_o_nucli_municipal: 'Girona' },
    ] }]);
    assert.deepEqual((await festesLocals('17079000', 2026)).map((x) => x.fecha), ['2026-10-29']);
  });

  // The calendar for next year appears around December. Until then the honest
  // answer is "none published", not an error.
  test('cap festa publicada encara no és cap error', async () => {
    fingeixFetch([{ body: [] }]);
    assert.deepEqual(await festesLocals('17079000', 2030), []);
  });

  test('sense municipi no es pregunta res', async () => {
    const trucades = fingeixFetch([]);
    assert.deepEqual(await festesLocals(null, 2026), []);
    assert.equal(trucades.length, 0);
  });

  // Socrata answers its own errors with a 200 and an object where the list
  // should be. Taken at face value that becomes a crash further down.
  test('un error disfressat de 200 es tracta com a error', async () => {
    fingeixFetch([{ body: { error: true, message: 'Unrecognized arguments [municipi]' } }]);
    await assert.rejects(() => festesLocals('17079000', 2026), /Unrecognized arguments/);
  });

  test('un 500 del calendari es nota', async () => {
    fingeixFetch([{ ok: false, status: 500, body: '' }]);
    await assert.rejects(() => llistaMunicipis(2026), /500/);
  });

  test('la mateixa pregunta no es fa dos cops', async () => {
    const trucades = fingeixFetch([{ body: [
      { data: '2026-10-29T00:00:00.000', ajuntament_o_nucli_municipal: 'Girona' },
    ] }]);
    await festesLocals('17079000', 2026);
    await festesLocals('17079000', 2026);
    assert.equal(trucades.length, 1);
  });

  test('cada municipi i cada any es pregunten per separat', async () => {
    const trucades = fingeixFetch([{ body: [] }, { body: [] }, { body: [] }]);
    await festesLocals('17079000', 2026);
    await festesLocals('17118000', 2026);
    await festesLocals('17079000', 2027);
    assert.equal(trucades.length, 3);
    assert.ok(trucades[1].includes('17118000'));
    assert.ok(trucades[2].includes('2027'));
  });

  test('un error no es recorda: la propera vegada es torna a preguntar', async () => {
    const trucades = fingeixFetch([
      { ok: false, status: 503, body: '' },
      { body: [{ data: '2026-10-29T00:00:00.000', ajuntament_o_nucli_municipal: 'Girona' }] },
    ]);
    await assert.rejects(() => festesLocals('17079000', 2026));
    assert.equal((await festesLocals('17079000', 2026)).length, 1);
    assert.equal(trucades.length, 2);
  });
});
