import test from 'node:test';
import assert from 'node:assert/strict';
import { updateOfferHeader, executeOfferHeaderUpdate } from '../lib/offer-header-update.mjs';
const input = () => ({ offerId: 110, body: { vendor_id: 2 } });
function fixture(options = {}) {
  const state = { writes: [], lineReads: 0, header: { branch: null, customerofferid: 110, customeroffer: 'Tariff', customerid: { customerid: 1151, accountid: { password: 'do-not-expose' } }, vendorid: null, paymentmethodid: { paymentmethodid: 1 }, incotermid: { incotermid: 2 }, since: null, until: '2026-12-30T23:00:00.000+00:00', remarks: 'Preserved conditions', saleorderid: null, purchaseorderid: null }, rows: [{ customerofferdetailid: 1, customerofferid: { customerofferid: 110 }, productid: { productid: 13 }, movementunitid: { movementunitid: 2 }, fromquantity: null, price: 1.18, customerofferdetail: 'NABALOX NO 113' }] };
  const client = { host: 'https://erp.example.invalid', token: 'fake', tokenExpiresAt: Date.now() + 600000,
    getObject: async () => ({ offer_id: 110, lines: state.rows.map(row => ({ line_id: row.customerofferdetailid, product_id: row.productid.productid, quantity_from: row.fromquantity, price: row.price })) }),
    async fetchImpl(url, request) {
      if (request.method === 'PUT') {
        const body = JSON.parse(request.body); state.writes.push(body); state.header = body;
        if (options.deleteLines) state.rows = [];
        if (options.timeout) throw new Error('unknown delivery');
        return new Response(null);
      }
      if (url.endsWith('/customerofferdetail/getAll')) {
        state.lineReads++;
        if (options.concurrent && state.lineReads === 2) state.rows[0].customerofferdetail = 'Concurrent grade';
        return Response.json(state.rows);
      }
      return Response.json(state.header);
    },
  };
  return { state, client };
}
test('native header update preserves all fields and exact children without leaking nested accounts', async () => {
  const { state, client } = fixture();
  const value = await executeOfferHeaderUpdate(client, { type: 'update_offer', request: input() });
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].paymentmethodid.paymentmethodid, 1);
  assert.equal(state.writes[0].incotermid.incotermid, 2);
  assert.equal(state.writes[0].remarks, 'Preserved conditions');
  assert.equal(state.writes[0].until, '2026-12-30T23:00:00.000+00:00');
  assert.deepEqual(state.writes[0].customerid, { customerid: 1151 });
  assert.equal(value.readback.lines[0].reference, 'NABALOX NO 113');
  assert.equal(value.readback.header_verification.exact_lines_preserved, true);
  assert.equal(JSON.stringify(state.writes).includes('password'), false);
});
test('unsupported partial-header fields and unknown native schemas fail before writing', async () => {
  const { state, client } = fixture();
  for (const body of [{ vendor_id: 2, lines: [] }, { valid_until: '2026-12-31' }, { payment_method_id: 1 }]) await assert.rejects(updateOfferHeader(client, { offerId: 110, body }));
  state.header.unknownNewField = 1;
  await assert.rejects(updateOfferHeader(client, input()), /unsupported native header/);
  assert.equal(state.writes.length, 0);
});
test('concurrent child edit blocks header write', async () => {
  const { state, client } = fixture({ concurrent: true });
  await assert.rejects(updateOfferHeader(client, input()), /lines changed concurrently/);
  assert.equal(state.writes.length, 0);
});
test('child deletion after header write is uncertain and exposes safe recovery evidence', async () => {
  const { state, client } = fixture({ deleteLines: true });
  await assert.rejects(updateOfferHeader(client, input()), failure => {
    assert.equal(failure.outcomeUncertain, true);
    assert.equal(failure.expectedLineSnapshot[0].description, 'NABALOX NO 113');
    assert.equal(JSON.stringify(failure.expectedLineSnapshot).includes('password'), false);
    return true;
  });
  assert.equal(state.writes.length, 1);
});
test('uncertain committed header write recovers only through independent readback', async () => {
  const { state, client } = fixture({ timeout: true });
  const result = await updateOfferHeader(client, input());
  assert.equal(result.recovered_by_independent_readback, true);
  assert.equal(state.writes.length, 1);
  await updateOfferHeader(client, input());
  assert.equal(state.writes.length, 1);
});
