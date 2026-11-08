// The public PUT /offers/{id} has been observed replacing omitted lines. The
// official UI instead sends the native header entity to this fixed PUT route.
// A live write still needs acceptance: schema observation alone is not proof.
import {sibemaOrigin as ORIGIN} from './provider-config.mjs';
const error = message => { throw new Error(`SIBEMA_HEADER: ${message}`); };
const id = value => Number.isSafeInteger(value) && value > 0;
const fields = ['branch', 'customerofferid', 'customeroffer', 'customerid', 'vendorid', 'paymentmethodid', 'incotermid', 'since', 'until', 'remarks', 'saleorderid', 'purchaseorderid'];
const relations = { customerid: 'customerid', vendorid: 'vendorid', paymentmethodid: 'paymentmethodid', incotermid: 'incotermid', saleorderid: 'saleorderid', purchaseorderid: 'purchaseorderid' };
function header(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !fields.includes(key)) || !id(raw.customerofferid) || raw.branch !== null) error('unsupported native header schema');
  const safe = { branch: null, customerofferid: raw.customerofferid };
  for (const key of ['customeroffer', 'since', 'until', 'remarks']) {
    if (raw[key] !== null && typeof raw[key] !== 'string') error(`invalid native header ${key}`);
    safe[key] = raw[key];
  }
  for (const [key, nativeId] of Object.entries(relations)) {
    if (raw[key] == null) safe[key] = null;
    else { const value = raw[key]?.[nativeId]; if (!id(value)) error(`invalid native relation ${key}`); safe[key] = { [nativeId]: value }; }
  }
  if (!safe.customerid) error('native customer missing');
  return safe;
}
async function native(client, path, body) {
  if (client.host !== ORIGIN || !/^\/rest\/(?:customeroffer\/(?:[1-9]\d*|update)|customerofferdetail\/getAll)$/.test(path)) error('unexpected provider route');
  if (!client.token || Date.now() > (client.tokenExpiresAt ?? 0) - 60000) await client.authenticate();
  const response = await client.fetchImpl(ORIGIN + '/ERPBerma' + path, { method: body ? 'PUT' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${client.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) error(`native ${body ? 'update' : 'read'} failed (${response.status})`);
  if (body) return;
  const maximum = 16 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); error('response exceeds 16MiB'); }
  const reader = response.body?.getReader(); if (!reader) error('missing native body');
  let bytes = 0; const chunks = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maximum) { await reader.cancel(); error('response exceeds 16MiB'); } chunks.push(Buffer.from(value)); } }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); } catch { error('invalid native JSON'); }
}
async function lineSnapshot(client, offerId) {
  const rows = await native(client, '/rest/customerofferdetail/getAll');
  if (!Array.isArray(rows)) error('native lines unavailable');
  const selected = rows.filter(row => row.customerofferid?.customerofferid === offerId).map(row => ({ line_id: row.customerofferdetailid, product_id: row.productid?.productid, unit_id: row.movementunitid?.movementunitid, quantity_from: row.fromquantity, price: row.price, description: row.customerofferdetail })).sort((a, b) => a.line_id - b.line_id);
  if (selected.some(row => !id(row.line_id) || !id(row.product_id) || !id(row.unit_id)) || new Set(selected.map(row => row.line_id)).size !== selected.length) error('native line identity unavailable');
  return selected;
}
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

/** Only vendor_id is currently needed and independently verified. Fail closed
 * for other changes until their native semantics have their own acceptance. */
export async function updateOfferHeader(client, input) {
  if (!input || Object.keys(input).some(key => !['offerId', 'body'].includes(key)) || !id(input.offerId) || !input.body || Object.keys(input.body).length !== 1 || !id(input.body.vendor_id)) error('only an exact vendor_id header update is supported');
  const offerId = input.offerId;
  const beforeHeader = header(await native(client, `/rest/customeroffer/${offerId}`));
  if (beforeHeader.customerofferid !== offerId) error('offer identity mismatch');
  const beforeLines = await lineSnapshot(client, offerId);
  // Check again immediately before writing; never merge stale concurrent edits.
  if (!same(beforeHeader, header(await native(client, `/rest/customeroffer/${offerId}`)))) error('header changed concurrently');
  if (!same(beforeLines, await lineSnapshot(client, offerId))) error('lines changed concurrently');
  const expectedHeader = { ...beforeHeader, vendorid: { vendorid: input.body.vendor_id } };
  let uncertain = false;
  if (!same(beforeHeader.vendorid, expectedHeader.vendorid)) {
    try { await native(client, '/rest/customeroffer/update', expectedHeader); }
    catch { uncertain = true; } // Never blindly repeat a potentially committed PUT.
  }
  try {
    const afterHeader = header(await native(client, `/rest/customeroffer/${offerId}`));
    const afterLines = await lineSnapshot(client, offerId);
    if (!same(beforeLines, afterLines)) error('line preservation failed after header update');
    if (!same(expectedHeader, afterHeader)) error('header readback mismatch');
    return { offer_id: offerId, vendor_id: input.body.vendor_id, line_count: afterLines.length, native_header_verified: true, exact_lines_preserved: true, ...(uncertain ? { recovered_by_independent_readback: true } : {}) };
  } catch (cause) {
    const failure = new Error('SIBEMA_HEADER: header update outcome uncertain; inspect offer and preserved line snapshot before any retry');
    failure.outcomeUncertain = true;
    failure.offer_id = offerId;
    failure.expectedLineSnapshot = beforeLines;
    failure.cause = cause;
    throw failure;
  }
}

export async function executeOfferHeaderUpdate(client, action) {
  if (action?.type !== 'update_offer' || !action.request || Object.keys(action.request).some(key => !['offerId', 'body'].includes(key))) error('expected header-only update_offer');
  const verification = await updateOfferHeader(client, action.request);
  try {
    const readback = await client.getObject('offers', action.request.offerId);
    const lines = await lineSnapshot(client, action.request.offerId);
    if (readback?.offer_id !== action.request.offerId || !Array.isArray(readback.lines) || readback.lines.length !== lines.length) error('public/native offer mismatch');
    const enriched = readback.lines.map(line => {
      const nativeLine = lines.find(row => row.line_id === line.line_id);
      if (!nativeLine || ['product_id', 'quantity_from', 'price'].some(key => line[key] !== nativeLine[key])) error('public/native line mismatch');
      return { ...line, reference: nativeLine.description, unit_id: nativeLine.unit_id };
    });
    return { result: { offer_id: action.request.offerId }, readback: { ...readback, lines: enriched, header_verification: verification } };
  } catch (cause) {
    const failure = new Error('SIBEMA_HEADER: public readback uncertain after native update');
    failure.outcomeUncertain = true; failure.cause = cause; throw failure;
  }
}

/** Shared sanitized mutation baseline; no provider objects or account fields escape. */
export async function offerMutationSnapshot(client, offerId) {
  if (!id(offerId)) error("invalid offer identity");
  const current = header(await native(client, `/rest/customeroffer/${offerId}`));
  if (current.customerofferid !== offerId) error("offer identity mismatch");
  return { header: current, lines: await lineSnapshot(client, offerId) };
}
