/** Internal read projection over the existing documented order-list contracts. */
function lookupSelector(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['reference', 'code', 'customer_id'].includes(key))) throw Error('INVALID_ARGUMENTS');
  const reference = Object.hasOwn(options, 'reference'), code = Object.hasOwn(options, 'code');
  if (reference === code) throw Error('INVALID_ARGUMENTS');
  const kind = code ? 'code' : 'reference', value = options[kind];
  if (typeof value !== 'string' || value !== value.trim() || value.length < (code ? 2 : 3) || value.length > 80 || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('INVALID_ARGUMENTS');
  if (options.customer_id != null && (typeof options.customer_id !== 'string' || !/^[1-9]\d{0,9}$/u.test(options.customer_id))) throw Error('INVALID_ARGUMENTS');
  return { kind, value };
}

export function orderLookupOptions(value) {
  if (typeof value !== 'string' || !value.startsWith('/order-lookup?') || value.split('?').length !== 2 || /[#\\\u0000-\u001f\u007f]/u.test(value)) throw Error('INVALID_ARGUMENTS');
  const params = new URLSearchParams(value.split('?')[1]);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some(k => !['reference', 'code', 'customer_id'].includes(k))) throw Error('INVALID_ARGUMENTS');
  const options = { ...(params.has('reference') ? { reference: params.get('reference') } : {}), ...(params.has('code') ? { code: params.get('code') } : {}), customer_id: params.get('customer_id') };
  lookupSelector(options);
  return options;
}

function nativeCode(order) {
  // The provider declares these as independent strings. Do not remove a prefix,
  // coerce a number or guess a split: series such as P and P4 may both exist.
  if (typeof order.serie !== 'string' || !order.serie || order.serie !== order.serie.trim() ||
      typeof order.number !== 'string' || !order.number || order.number !== order.number.trim() ||
      /[\u0000-\u001f\u007f]/u.test(order.serie + order.number)) throw Error('LOOKUP_CODE_FIELDS_UNAVAILABLE');
  return order.serie + order.number;
}

const normalized = value => value.normalize('NFC').toLocaleUpperCase('es');
function matchesReference(value, reference) {
  if (typeof value !== 'string') return false;
  const needle = normalized(reference).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${needle}(?=$|[^\\p{L}\\p{N}])`, 'u').test(normalized(value));
}

export async function buildOrderLookup(client, options) {
  const selector = lookupSelector(options);
  const startedAt = new Date().toISOString();
  // customer_id is a provider read scope, not a post-filter over every client.
  // The existing documented customer endpoint has the same page/size contract.
  const customerId = options.customer_id == null ? null : Number(options.customer_id);
  if (customerId !== null && (typeof options.customer_id !== 'string' || !/^[1-9]\d{0,9}$/u.test(options.customer_id))) throw Error('INVALID_ARGUMENTS');
  const listPath = customerId === null ? '/orders' : `/customers/${customerId}/orders`;
  const listed = [];
  let total = null, pages = 0, complete = false;
  for (let page = 0; page < 20; page++) {
    const response = await client.get(`${listPath}?page=${page}&size=200`);
    if (!Array.isArray(response?.data) || typeof response.has_next !== 'boolean' || !Number.isSafeInteger(response.total) || response.total < 0 || (response.page !== undefined && response.page !== page) || (total !== null && total !== response.total) || response.data.length > 200 || (response.has_next && response.data.length === 0)) throw Error('LOOKUP_PAGINATION_INCONSISTENT');
    if (customerId !== null && response.data.some(order => order?.customer_id !== customerId)) throw Error('LOOKUP_CUSTOMER_SCOPE_INCONSISTENT');
    total = response.total; pages++;
    listed.push(...response.data);
    if (!response.has_next) { complete = true; break; }
  }
  if (!complete || listed.length !== total || listed.some(o => !Number.isSafeInteger(o.order_id) || o.order_id <= 0) || new Set(listed.map(o => o.order_id)).size !== listed.length) throw Error('LOOKUP_PAGINATION_INCONSISTENT');
  if (selector.kind === 'code') listed.forEach(nativeCode);
  const matches = listed.filter(o => (!options.customer_id || String(o.customer_id) === options.customer_id) && (selector.kind === 'code' ? nativeCode(o) === selector.value : matchesReference(o.reference, selector.value)));
  const refine = matches.length > 20;
  const ambiguousCode = selector.kind === 'code' && matches.length > 1;
  const details = [];
  if (!refine) for (const row of matches) {
    const detail = await client.get(`/orders/${row.order_id}`);
    if (!detail || detail.order_id !== row.order_id || detail.reference !== row.reference || detail.customer_id !== row.customer_id || !Array.isArray(detail.lines) ||
      (selector.kind === 'code' && (!Number.isSafeInteger(row.customer_id) || row.customer_id <= 0 || detail.serie !== row.serie || detail.number !== row.number))) throw Error('LOOKUP_DETAIL_INCONSISTENT');
    details.push(detail);
  }
  return {
    source: selector.kind === 'code' ? 'Internal code lookup over native Sibema orders; not a provider endpoint' : 'Internal reference lookup over native Sibema orders; not a provider endpoint',
    checked_from: startedAt, checked_at: new Date().toISOString(),
    query: options, match_basis: selector.kind === 'code'
      ? 'Exact literal native order.serie + order.number; never native ID, reference, numeric coercion or inferred series/number split'
      : 'Complete reference token within native order.reference; never native ID, P-number, remarks, name or amount',
    coverage: { complete: true, scope: customerId === null ? 'all_orders' : 'customer', customer_id: customerId, native_orders: listed.length, pages, atomic_snapshot_supported: false },
    matched_order_ids: matches.map(o => o.order_id), matched_count: matches.length,
    details_complete: !refine, requires_refinement: refine || ambiguousCode, ...(selector.kind === 'code' ? { code_ambiguous: ambiguousCode } : {}), orders: details,
    warnings: [...(selector.kind === 'code' ? ['A concatenated code may match different series/number partitions or distinct native orders. Preserve all matches and resolve ambiguity; never pick an arbitrary ID.', 'No code match proves absence only within the declared complete scope and exact native strings, not under another code or reference.'] : ['Keep every distinct matched order; matching references do not prove duplicate orders or the same contract position.', 'No reference match does not prove absence of a business order under another native reference.']), 'FACTURADO is an order status, not proof of delivered or invoiced quantities. No monetary conversion or partial-delivery write is performed.'],
  };
}
