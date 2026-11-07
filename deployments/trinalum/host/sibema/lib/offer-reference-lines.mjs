// SIBEMA's official UI (6000.ec0b1c53, Customerofferdetail) exposes the
// description omitted by OfferWrite. Keep product families and exact references.
import {sibemaOrigin as origin} from './provider-config.mjs';
const fail = message => { throw new Error(`SIBEMA_LINE_REFERENCES: ${message}`); };
const positive = value => Number.isSafeInteger(value) && value > 0;
export function validateLineReferences(action) {
  const request = action?.request ?? {};
  if (request.lineReferences === undefined) return null;
  const references = request.lineReferences;
  if (!['create_offer', 'update_offer'].includes(action.type)) fail('references apply only to offers');
  if (!Array.isArray(request.body?.lines) || !Array.isArray(references) || !references.length || references.length !== request.body.lines.length || references.length > 1000) fail('one reference per requested line is required');
  for (const line of request.body.lines) {
    if (!line || !positive(line.product_id) || !positive(line.unit_id) ||
        (line.quantity_from !== undefined && (typeof line.quantity_from !== 'number' || !Number.isFinite(line.quantity_from) || line.quantity_from < 0)) ||
        typeof line.price !== 'number' || !Number.isFinite(line.price) || line.price < 0) fail('reference lines require explicit numeric product_id, unit_id, quantity_from and price');
  }
  if (references.some(value => typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 1000 || /[\x00-\x1f]/.test(value))) fail('invalid exact reference');
  return references;
}

async function requestNative(client, path, body) {
  if (client.host !== origin || !/^\/rest\/(?:customerofferdetail\/(?:[1-9]\d*|update|getAll)|(?:product|movementunit|vendor)\/getAll|getByQuery)$/.test(path)) fail('unexpected provider or route');
  const queryRead = path === '/rest/getByQuery';
  if (queryRead && (body?.clazz !== 'saleorderdetail' || body.items?.length !== 1 || Object.keys(body).some(key => !['clazz', 'items'].includes(key)) || body.items[0].field !== 'saleorderdetail' || body.items[0].operator !== 'OPERATOR_LIKE' || typeof body.items[0].value !== 'string' || Object.keys(body.items[0]).some(key => !['field', 'operator', 'value'].includes(key)))) fail('unexpected historical read query');
  const writing = path === '/rest/customerofferdetail/update';
  if (!client.token || Date.now() > (client.tokenExpiresAt ?? 0) - 60000) await client.authenticate();
  const response = await client.fetchImpl(`${origin}/ERPBerma${path}`, {
    method: queryRead ? 'POST' : writing ? 'PUT' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${client.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // Never propagate raw provider errors or nested customer/account objects.
  if (!response.ok) fail(`native ${writing ? 'update' : 'read'} failed (${response.status})`);
  if (writing) return null;
  const maximum = 16 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); fail('native response exceeds 16MiB'); }
  const reader = response.body?.getReader();
  if (!reader) fail('native response body missing');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); fail('native response exceeds 16MiB'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { fail('native response is not JSON'); }
}
function safeLine(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('native line response missing');
  return {
    line_id: value.customerofferdetailid, reference: value.customerofferdetail,
    offer_id: value.customerofferid?.customerofferid, product_id: value.productid?.productid,
    unit_id: value.movementunitid?.movementunitid, quantity_from: value.fromquantity, price: value.price,
  };
}
async function native(client, path, body) {
  const value = await requestNative(client, path, body);
  return body ? null : safeLine(value);
}
function validatedCatalogReferences(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'references')) fail('unknown catalog argument');
  if (input.references === undefined) return [];
  if (!Array.isArray(input.references) || input.references.length > 100 || input.references.some(value => typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f%_]/.test(value))) fail('at most 100 bounded exact references required');
  return input.references;
}
const compactReference = reference => reference.normalize('NFKC').toUpperCase().replace(/®|\s/g, '');
function referencePattern(reference) {
  const compact = compactReference(reference);
  if (!compact || !/[A-Z0-9]/.test(compact)) fail('reference must contain letters or numbers');
  const escaped = [...compact].map(character => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  // Require the entire grade. In particular 713-10 must not match 713-10RF.
  return new RegExp(`(?<![A-Z0-9_-])${escaped}(?![A-Z0-9_-])`, 'u');
}
export async function readProductCatalog(client, input = {}) {
  const references = validatedCatalogReferences(input);
  const patterns = references.map(referencePattern);
  const products = await requestNative(client, '/rest/product/getAll');
  const units = await requestNative(client, '/rest/movementunit/getAll');
  const vendors = await requestNative(client, '/rest/vendor/getAll');
  if (!Array.isArray(products) || !Array.isArray(units) || !Array.isArray(vendors)) fail('catalog missing');
  const result = {
    products: products.map(value => ({ product_id: value.productid, product: value.product,
      reference: value.externalcode ?? null, product_type_id: value.producttypeid?.producttypeid,
      product_type: value.producttypeid?.producttype, unit_id: value.movementunitid?.movementunitid,
      unit: value.movementunitid?.movementunit, active: value.active })),
    units: units.map(value => ({ unit_id: value.movementunitid, unit: value.movementunit })),
    vendors: vendors.filter(value=>positive(value.vendorid)).map(value=>({vendor_id:value.vendorid,vendor:value.vendor,provider_id:value.providerid?.providerid,provider:value.providerid?.provider,active:value.active})),
  };
  if (references.length) {
    const history = [];
    // This official UI POST is a read, with a fixed entity/field/operator. Three
    // workers bound provider load. Keep all reference characters in LIKE order;
    // provider wildcard matching tolerates spacing, then exact grade checks run.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, references.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= references.length) return;
        const compact = compactReference(references[index]);
        const value = [...compact].join('%');
        const rows = await requestNative(client, '/rest/getByQuery', { clazz: 'saleorderdetail', items: [{ field: 'saleorderdetail', operator: 'OPERATOR_LIKE', value }] });
        if (!Array.isArray(rows)) fail('historical lines missing');
        history[index] = rows;
      }
    }));
    result.reference_matches = references.map((reference, index) => {
      const matches = new Map();
      for (const row of history[index]) {
        const description = row?.saleorderdetail;
        if (typeof description !== 'string' || description.length > 20000 || !patterns[index].test(description.normalize('NFKC').toUpperCase().replace(/®/g, ''))) continue;
        // A suffix separated by whitespace can otherwise look like packaging.
        // When both grades are requested, the complete longer grade wins.
        const normalizedDescription = description.normalize('NFKC').toUpperCase().replace(/®/g, '');
        const compact = compactReference(reference);
        if (references.some((other, otherIndex) => compactReference(other).length > compact.length && compactReference(other).startsWith(compact) && patterns[otherIndex].test(normalizedDescription))) continue;
        const productId = row.productid?.productid;
        const product = result.products.find(value => value.product_id === productId && value.active === true);
        if (!positive(productId) || !product || !positive(row.saleorderdetailid)) continue;
        if (!matches.has(productId)) matches.set(productId, { product_id: productId, product: product.product, evidence: [] });
        const evidence = matches.get(productId).evidence;
        if (evidence.length < 10) evidence.push({ line_id: row.saleorderdetailid, description: description.replace(/[\x00-\x1f]/g, ' ').slice(0, 1000) });
      }
      const candidates = [...matches.values()];
      return { reference, status: candidates.length === 1 ? 'matched' : candidates.length > 1 ? 'ambiguous' : 'not_found', candidates };
    });
  }
  return result;
}
export async function readOfferLineReferences(client, offerReadback) {
  if (!positive(offerReadback?.offer_id) || !Array.isArray(offerReadback.lines)) fail('offer required');
  const records = await requestNative(client, '/rest/customerofferdetail/getAll');
  if (!Array.isArray(records)) fail('native lines missing');
  const relevant = records.filter(value => value.customerofferid?.customerofferid === offerReadback.offer_id).map(safeLine);
  if (relevant.length !== offerReadback.lines.length || new Set(relevant.map(line => line.line_id)).size !== relevant.length) fail('native line set mismatch');
  return { ...offerReadback, lines: offerReadback.lines.map(line => {
    const row = relevant.find(value => value.line_id === line.line_id);
    if (!row) fail('native line missing');
    verify(row, line, offerReadback.offer_id);
    return { ...line, unit_id: row.unit_id, reference: row.reference };
  }) };
}
function verify(line, expected, offerId, reference) {
  for (const [key, value] of Object.entries({ line_id: expected.line_id, offer_id: offerId, product_id: expected.product_id, quantity_from: expected.quantity_from, price: expected.price, ...(expected.unit_id === undefined ? {} : { unit_id: expected.unit_id }) })) {
    if (line[key] !== value) fail(`independent line ${key} mismatch`);
  }
  if (!positive(line.unit_id)) fail('native unit missing');
  if (reference !== undefined && line.reference !== reference) fail('exact reference readback mismatch');
  return line;
}

export async function applyOfferLineReferences(client, action, offerReadback) {
  const references = validateLineReferences(action);
  if (!references) return offerReadback;
  const offerId = offerReadback?.offer_id;
  const lines = offerReadback?.lines;
  if (!positive(offerId) || (action.type === 'update_offer' && offerId !== action.request.offerId) || !Array.isArray(lines) || lines.length !== references.length) fail('offer identity or line count mismatch');
  if (new Set(lines.map(line => line.line_id)).size !== lines.length || lines.some(line => !positive(line.line_id))) fail('line identities missing or duplicated');
  const expected = lines.map((line, index) => {
    const requested = action.request.body.lines[index];
    for (const key of ['product_id', 'quantity_from', 'price']) if (requested[key] !== undefined && line[key] !== requested[key]) fail(`created line ${key} mismatch`);
    return { ...line, ...(requested.unit_id === undefined ? {} : { unit_id: requested.unit_id }) };
  });
  // Verify every line before mutating any; a concurrent change must stop the batch.
  const before = [];
  for (const line of expected) before.push(verify(await native(client, `/rest/customerofferdetail/${line.line_id}`), line, offerId));
  const result = [];
  for (let index = 0; index < expected.length; index++) {
    const line = verify(await native(client, `/rest/customerofferdetail/${expected[index].line_id}`), expected[index], offerId);
    if (line.reference !== before[index].reference && line.reference !== references[index]) fail('description changed concurrently');
    if (line.reference !== references[index]) {
      const body = {
        customerofferdetailid: line.line_id, customerofferid: { customerofferid: offerId },
        productid: { productid: line.product_id }, movementunitid: { movementunitid: line.unit_id },
        fromquantity: line.quantity_from, price: line.price, customerofferdetail: references[index],
      };
      try { await native(client, '/rest/customerofferdetail/update', body); }
      catch { // A timeout may have committed. Read once; never blindly retry.
        result.push(verify(await native(client, `/rest/customerofferdetail/${line.line_id}`), expected[index], offerId, references[index]));
        continue;
      }
    }
    result.push(verify(await native(client, `/rest/customerofferdetail/${line.line_id}`), expected[index], offerId, references[index]));
  }
  return { ...offerReadback, lines: lines.map((line, index) => ({ ...line, reference: result[index].reference })), exact_line_references_verified: true };
}
