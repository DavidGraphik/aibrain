/** Native customer classification: no inferred turnover, prices or geography. */
export function salesCustomersOptions(path) {
  if (typeof path !== 'string' || path.length > 150 || !path.startsWith('/sales-customers?') || /[#\\]/.test(path)) throw Error('INVALID_ARGUMENTS');
  const [route, query, extra] = path.split('?');
  if (route !== '/sales-customers' || extra !== undefined) throw Error('INVALID_ARGUMENTS');
  const fields = new URLSearchParams(query), seen = new Set();
  for (const [key] of fields) {
    if (!['from', 'to'].includes(key) || seen.has(key)) throw Error('INVALID_ARGUMENTS');
    seen.add(key);
  }
  const from = fields.get('from'), to = fields.get('to');
  for (const day of [from, to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw Error('INVALID_ARGUMENTS');
  if (from > to) throw Error('INVALID_ARGUMENTS');
  return { from, to };
}

export async function buildSalesCustomers(client, { from, to }) {
  salesCustomersOptions(`/sales-customers?from=${from}&to=${to}`);
  const orders = await client.listAll('orders');
  const customers = await client.listAll('customers');
  const nativeCustomers = new Map(customers.map(c => [Number(c.customer_id), c]));
  const grouped = new Map(), seenOrders = new Set(), duplicates = [];
  let excludedStatus = 0, excludedDate = 0, missingShippingDate = 0, missingCustomer = 0, eligibleOrders = 0;
  for (const order of orders) {
    if (!Number.isSafeInteger(Number(order.order_id)) || Number(order.order_id) < 1 || !Number.isSafeInteger(Number(order.customer_id)) || Number(order.customer_id) < 1) throw Error('INVALID_ORDER_IDENTITY');
    const orderId = Number(order.order_id);
    if (seenOrders.has(orderId)) { duplicates.push(orderId); continue; }
    seenOrders.add(orderId);
    if (String(order.status?.name ?? '').toUpperCase() !== 'FACTURADO') { excludedStatus++; continue; }
    const day = order.shipping_date?.slice(0, 10);
    if (!day) { missingShippingDate++; continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw Error('INVALID_SHIPPING_DATE');
    if (day < from || day > to) { excludedDate++; continue; }
    eligibleOrders++;
    const id = Number(order.customer_id), native = nativeCustomers.get(id);
    const row = grouped.get(id) ?? { customer_id: id, name: native?.name ?? null, province: typeof native?.address?.state === 'string' ? native.address.state.trim() || null : null, country: native?.address?.country ?? null, order_ids: [], identity_verified_in_customer_master: Boolean(native) };
    if (!native) missingCustomer++;
    row.order_ids.push(orderId);
    grouped.set(id, row);
  }
  const rows = [...grouped.values()].sort((a, b) => (a.province ?? '\uffff').localeCompare(b.province ?? '\uffff') || (a.name ?? '').localeCompare(b.name ?? ''));
  return {
    source: 'Sibema complete paginated order list and customer master', generated_at: new Date().toISOString(),
    range: { from, to }, status_basis: 'FACTURADO', date_basis: 'shipping_date',
    province_basis: 'customer.address.state, as recorded in Sibema; not independently verified physical location',
    complete_customer_coverage: missingCustomer === 0 && duplicates.length === 0 && missingShippingDate === 0,
    complete_province_coverage: rows.every(r => r.province !== null),
    source_orders: orders.length, source_customers: customers.length, eligible_orders: eligibleOrders,
    exclusions: { other_status: excludedStatus, outside_shipping_range: excludedDate, invoiced_missing_shipping_date: missingShippingDate },
    duplicate_order_ids: duplicates, customers: rows,
    warnings: ['This identifies invoiced-order customers, not cash receipts or verified monetary revenue.', 'Missing shipping dates are excluded explicitly. Unknown provinces remain null; do not infer them from company names.'],
  };
}
