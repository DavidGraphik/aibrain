import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLineReferences, applyOfferLineReferences, readOfferLineReferences, readProductCatalog } from '../lib/offer-reference-lines.mjs';

const action = () => ({ type: 'create_offer', request: { body: { lines: [{ product_id: 13, unit_id: 2, quantity_from: 1000, price: 1.3 }] }, lineReferences: ['NABALOX NO 325'] } });
const offer = () => ({ offer_id: 101, lines: [{ line_id: 20, product_id: 13, quantity_from: 1000, price: 1.3 }] });
const record = () => ({ customerofferdetailid: 20, customerofferdetail: 'Alumina', customerofferid: { customerofferid: 101, customerid: { accountid: { password: 'must-not-leak' } } }, productid: { productid: 13 }, movementunitid: { movementunitid: 2 }, fromquantity: 1000, price: 1.3 });
function fixture(options = {}) {
  const state = { row: record(), writes: [], reads: 0, paths: [] };
  const client = { host: 'https://erp.example.invalid', token: 'private-test-token', tokenExpiresAt: Date.now() + 3600000,
    async fetchImpl(url, init) {
      state.paths.push(url);
      if (init.method === 'PUT') {
        state.writes.push(JSON.parse(init.body));
        if (!options.noCommit) state.row = JSON.parse(init.body);
        if (options.timeout) throw new Error('network unknown');
        return { ok: true };
      }
      state.reads++;
      if (options.changeAfterFirst && state.reads === 2) state.row.price = 9;
      let data = structuredClone(state.row);
      if (url.endsWith('/customerofferdetail/getAll')) data = [data];
      if (url.endsWith('/product/getAll')) data = [{ productid: 13, product: 'Alumina', producttypeid: { producttypeid: 13, producttype: 'Alumina' }, movementunitid: { movementunitid: 2, movementunit: 'KG' }, active: true, accountid: { password: 'must-not-leak' } }];
      if (url.endsWith('/movementunit/getAll')) data = [{ movementunitid: 2, movementunit: 'KG' }];
      if (url.endsWith('/vendor/getAll')) data = [{ vendorid: 2, vendor: 'Synthetic represented company', providerid: { providerid: 2, provider: 'Synthetic provider', accountid: { password: 'must-not-leak' } }, active: true, workerid: { accountid: { password: 'must-not-leak' } } }];
      if (url.endsWith('/getByQuery')) data = options.history ?? [];
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
  return { client, state };
}

test('exact references preserve digits and punctuation and reject controls/count mismatch', () => {
  const a = action();
  for (const value of ['APYRAL 40CD', 'NABALOX NO 325', 'NABALOX® A-10']) { a.request.lineReferences = [value]; assert.deepEqual(validateLineReferences(a), [value]); }
  a.request.lineReferences = ['invalid\nreference']; assert.throws(() => validateLineReferences(a));
  a.request.lineReferences = []; assert.throws(() => validateLineReferences(a));
});
test('catalog only reads historical lines when exact references are requested', async () => {
  const { client, state } = fixture();
  await readProductCatalog(client);
  assert.deepEqual(state.paths.map(path => new URL(path).pathname), ['/ERPBerma/rest/product/getAll', '/ERPBerma/rest/movementunit/getAll', '/ERPBerma/rest/vendor/getAll']);
  assert.equal(state.paths.some(path => path.includes('getByQuery')), false);
  for (const input of [{ extra: 1 }, { references: Array(101).fill('a') }, { references: ['x'.repeat(201)] }, { references: ['a\nb'] }, { references: [1] }, { references: 'a' }]) {
    const calls = state.paths.length;
    await assert.rejects(readProductCatalog(client, input));
    assert.equal(state.paths.length, calls);
  }
});
test('historical query is fixed POST read, rejects overrides, and has at most three concurrent requests', async () => {
  const { client } = fixture();
  const original = client.fetchImpl;
  let active = 0, maximum = 0; const queries = [];
  client.fetchImpl = async (url, init) => {
    if (!url.endsWith('/getByQuery')) return original(url, init);
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body); queries.push(body);
    assert.equal(body.clazz, 'saleorderdetail');
    assert.deepEqual(Object.keys(body).sort(), ['clazz', 'items']);
    assert.equal(body.items[0].field, 'saleorderdetail');
    assert.equal(body.items[0].operator, 'OPERATOR_LIKE');
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return new Response('[]');
  };
  await readProductCatalog(client, { references: ['APYRAL40CD', 'NABALOX713-10', 'NABALOX325', 'NABALOX713-10RF'] });
  assert.equal(queries[0].items[0].value, 'A%P%Y%R%A%L%4%0%C%D');
  assert.equal(maximum, 3);
  for (const input of [{ references: ['APYRAL40CD'], clazz: 'account' }, { references: ['APYRAL%'] }, { references: ['APYRAL_'] }, { references: ['APYRAL40CD'], path: '/rest/account/getAll' }]) await assert.rejects(readProductCatalog(client, input));
});
test('historical reference matching normalizes spaces and registered mark, preserving grade suffixes', async () => {
  const history = [
    { saleorderdetailid: 1, saleorderdetail: 'NABALOX® 713 - 10 en sacos', productid: { productid: 13, password: 'must-not-leak' } },
    { saleorderdetailid: 2, saleorderdetail: 'NABALOX 713-10RF en sacos', productid: { productid: 13 } },
    { saleorderdetailid: 3, saleorderdetail: 'APYRAL 40 CDO', productid: { productid: 13 } },
    { saleorderdetailid: 4, saleorderdetail: 'NABALOX 713-10 RF en sacos', productid: { productid: 13 } },
  ];
  const { client } = fixture({ history });
  const value = await readProductCatalog(client, { references: ['nabalox 713-10', 'NABALOX713-10RF', 'APYRAL40CD'] });
  assert.equal(value.reference_matches[0].status, 'matched');
  assert.deepEqual(value.reference_matches[0].candidates[0].evidence.map(row => row.line_id), [1]);
  assert.deepEqual(value.reference_matches[1].candidates[0].evidence.map(row => row.line_id), [2, 4]);
  assert.equal(value.reference_matches[2].status, 'not_found');
  assert.equal(JSON.stringify(value).includes('password'), false);
});
test('multiple historical product IDs remain ambiguous and never get auto-selected', async () => {
  const { client } = fixture({ history: [
    { saleorderdetailid: 1, saleorderdetail: 'APYRAL 40CD', productid: { productid: 13 } },
    { saleorderdetailid: 2, saleorderdetail: 'APYRAL 40CD en BB', productid: { productid: 10 } },
  ] });
  const original = client.fetchImpl;
  client.fetchImpl = async (url, init) => url.endsWith('/product/getAll') ? new Response(JSON.stringify([
    { productid: 13, product: 'A', active: true }, { productid: 10, product: 'B', active: true },
  ])) : original(url, init);
  const result = await readProductCatalog(client, { references: ['APYRAL40CD'] });
  assert.equal(result.reference_matches[0].status, 'ambiguous');
  assert.equal(result.reference_matches[0].candidates.length, 2);
});
test('native responses are bounded by headers and streaming bytes', async () => {
  for (const declared of [true, false]) {
    const { client } = fixture();
    client.fetchImpl = async () => new Response(new ReadableStream({ start(controller) {
      if (!declared) controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
      controller.close();
    } }), { headers: declared ? { 'content-length': String(16 * 1024 * 1024 + 1) } : {} });
    await assert.rejects(readProductCatalog(client), /exceeds 16MiB/);
  }
});
test('writes only native line fields, verifies identity and resumes idempotently', async () => {
  const { client, state } = fixture();
  const value = await applyOfferLineReferences(client, action(), offer());
  assert.equal(value.lines[0].reference, 'NABALOX NO 325');
  assert.equal(value.exact_line_references_verified, true);
  assert.deepEqual(Object.keys(state.writes[0]).sort(), ['customerofferdetail', 'customerofferdetailid', 'customerofferid', 'fromquantity', 'movementunitid', 'price', 'productid']);
  assert.equal(JSON.stringify(state.writes).includes('password'), false);
  await applyOfferLineReferences(client, action(), offer());
  assert.equal(state.writes.length, 1);
});
test('uncertain committed result is recovered with readback and never posted twice', async () => {
  const { client, state } = fixture({ timeout: true });
  const value = await applyOfferLineReferences(client, action(), offer());
  assert.equal(value.exact_line_references_verified, true);
  assert.equal(state.writes.length, 1);
});
test('uncommitted uncertain write fails without retrying', async () => {
  const { client, state } = fixture({ timeout: true, noCommit: true });
  await assert.rejects(applyOfferLineReferences(client, action(), offer()), /reference readback mismatch/);
  assert.equal(state.writes.length, 1);
});
test('parent mismatch or concurrent price change stops before any write', async () => {
  for (const concurrent of [false, true]) {
    const { client, state } = fixture({ changeAfterFirst: concurrent });
    if (!concurrent) state.row.customerofferid.customerofferid = 999;
    await assert.rejects(applyOfferLineReferences(client, action(), offer()), /mismatch/);
    assert.equal(state.writes.length, 0);
  }
});
test('reads preserve only safe fields and verify native line set', async () => {
  const { client, state } = fixture();
  const enriched = await readOfferLineReferences(client, offer());
  assert.equal(enriched.lines[0].reference, 'Alumina');
  assert.equal(JSON.stringify(enriched).includes('password'), false);
  const catalog = await readProductCatalog(client);
  assert.equal(catalog.products[0].product_id, 13);
  assert.deepEqual(catalog.units, [{ unit_id: 2, unit: 'KG' }]);
  assert.deepEqual(catalog.vendors, [{ vendor_id: 2, vendor: 'Synthetic represented company', provider_id: 2, provider: 'Synthetic provider', active: true }]);
  assert.equal(JSON.stringify(catalog).includes('password'), false);
  assert.equal(JSON.stringify(catalog).includes('accountid'), false);
  state.row.customerofferid.customerofferid = 999;
  await assert.rejects(readOfferLineReferences(client, offer()), /line set mismatch/);
});
