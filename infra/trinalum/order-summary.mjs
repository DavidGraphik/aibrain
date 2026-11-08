// Read-only summaries of the same order/customer data exposed by sibema_read.
const dateFields = new Set(['date','shipping_date','delivery_date']);
export function summaryOptions(path) {
  const [pathname, query] = path.split('?');
  if(pathname!=='/order-summary'||path.split('?').length!==2)throw Error('INVALID_ARGUMENTS');
  const params=new URLSearchParams(query), seen=new Set();
  for(const [key] of params){if(seen.has(key)||!['from','to','date_basis','customer_id','vendor'].includes(key))throw Error('INVALID_ARGUMENTS');seen.add(key);}
  const options=Object.fromEntries(params);
  for(const key of ['from','to'])if(!/^\d{4}-\d{2}-\d{2}$/.test(options[key]??'')||!Number.isFinite(Date.parse(options[key]))||new Date(options[key]).toISOString().slice(0,10)!==options[key])throw Error('INVALID_ARGUMENTS');
  if(options.from>options.to||!dateFields.has(options.date_basis))throw Error('INVALID_ARGUMENTS');
  if(options.customer_id!==undefined&&!/^[1-9]\d{0,9}$/.test(options.customer_id))throw Error('INVALID_ARGUMENTS');
  if(options.vendor!==undefined&&(!options.vendor.trim()||options.vendor.length>80||/[\x00-\x1f]/.test(options.vendor)))throw Error('INVALID_ARGUMENTS');
  if(!options.customer_id&&!options.vendor)throw Error('INVALID_ARGUMENTS');
  return options;
}
const round=n=>Math.round(n*1000)/1000;
const normalize=s=>String(s??'').trim().toLocaleUpperCase('es');
function sourceDate(value){
  if(typeof value!=='string')return null;
  const date=value.slice(0,10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date?date:null;
}
function quantity(lines){
  const units={},issues=[];
  if(!Array.isArray(lines)||!lines.length)return {units,issues:['Missing order lines']};
  for(const line of lines){
    const value=line.quantity;
    const numeric=typeof value==='number'||(typeof value==='string'&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()));
    if(!numeric||!Number.isFinite(Number(value))){issues.push(`Invalid quantity at line ${line.line_id}`);continue;}
    let unit=normalize(line.unit),factor=1;
    if(['KG','KGS','KILOGRAMO','KILOGRAMOS'].includes(unit))unit='kg';
    else if(['T','TM','TON','TONELADA','TONELADAS'].includes(unit)){unit='kg';factor=1000;}
    else if(!unit){issues.push(`Missing unit at line ${line.line_id}`);continue;}
    units[unit]=round((units[unit]??0)+Number(value)*factor);
  }
  return {units,issues};
}
export function summarizeOrders(orders,customers,options){
  const names=new Map(customers.map(c=>[String(c.customer_id),{name:c.name,commercial_name:c.commercial_name,vat_number:c.vat_number??null,address:c.address??null}]));
  const byStatus={},byCustomer={},rows=[],issues=[];
  const add=(group,q)=>{group.orders++;for(const [u,n] of Object.entries(q))group.quantity_by_unit[u]=round((group.quantity_by_unit[u]??0)+n);};
  const total={orders:0,quantity_by_unit:{}};
  for(const order of orders){
    const q=quantity(order.lines),status=order.status?.name??'UNKNOWN';
    for(const issue of q.issues)issues.push({order_id:order.order_id,issue});
    const customer=names.get(String(order.customer_id))??{name:null,commercial_name:null};
    const row={order_id:order.order_id,customer_id:order.customer_id,...customer,status,date:order.date,shipping_date:order.shipping_date,delivery_date:order.delivery_date,vendor:order.vendor,reference:order.reference,quantity_by_unit:q.units,quantities_complete:q.issues.length===0};
    rows.push(row);
    add(total,q.units);
    byStatus[status]??={orders:0,quantity_by_unit:{}};add(byStatus[status],q.units);
    byCustomer[order.customer_id]??={customer_id:order.customer_id,...customer,orders:0,quantity_by_unit:{}};add(byCustomer[order.customer_id],q.units);
  }
  return {source:'Sibema order details',range:options,total,by_status:byStatus,by_customer:Object.values(byCustomer),orders:rows,issues,quantities_complete:issues.length===0,monetary_totals:null,warnings:['All distinct orders and lines are preserved, including apparently duplicate references. Do not subtract suspected duplicates without confirmation.','The selected date_basis is explicit; order, shipping and delivery dates are not interchangeable.','Monetary totals are not verified: currency and unit-price basis are not exposed. Never divide or normalize recorded prices by assumption. Use individual order details to flag data issues.','FACTURADO is the order status, not proof of a paid invoice. Other statuses are kept separate.']};
}
async function list(client,resource){
  const all=[];
  for(let page=0;page<20;page++){
    const result=await client.get(`/${resource}?page=${page}&size=200`);
    if(!Array.isArray(result?.data)||typeof result.has_next!=='boolean')throw Error('Invalid list response');
    all.push(...result.data);
    if(!result.has_next)return all;
  }
  throw Error('List exceeds bounded summary size');
}
export async function buildOrderSummary(client,options){
  const listed=await list(client,'orders');
  if(new Set(listed.map(o=>o.order_id)).size!==listed.length||listed.some(o=>!Number.isSafeInteger(o.order_id)))throw Error('Inconsistent order pagination');
  const customerScope=listed.filter(o=>!options.customer_id||String(o.customer_id)===options.customer_id);
  // Similar labels are discovery hints only, never authority to combine identities.
  const hintKey=value=>normalize(value).normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^A-Z0-9]/g,'');
  const vendorLabels=[...new Set(customerScope.map(o=>o.vendor).filter(value=>typeof value==='string'&&value.trim()))].sort();
  const candidates=options.vendor?vendorLabels.filter(value=>hintKey(value)===hintKey(options.vendor)):[];
  const exactFound=!options.vendor||vendorLabels.some(value=>normalize(value)===normalize(options.vendor));
  const vendorResolved=exactFound&&!candidates.some(value=>normalize(value)!==normalize(options.vendor));
  const vendorResolution=options.vendor?{requested_label:options.vendor,exact_label_found:exactFound,scope_resolved:vendorResolved,
    candidate_labels:candidates,matching_rule:'Exact label only; punctuation-insensitive candidates are unverified hints, not merged provider identities.'}:null;
  const scoped=customerScope.filter(o=>!options.vendor||normalize(o.vendor)===normalize(options.vendor));
  const missingDates=[],invalidDates=[],eligible=[];
  for(const o of scoped){
    const value=o[options.date_basis];
    if(value===null||value===undefined||(typeof value==='string'&&!value.trim())){missingDates.push(o.order_id);continue;}
    const date=sourceDate(value);
    if(!date){invalidDates.push(o.order_id);continue;}
    if(date>=options.from&&date<=options.to)eligible.push(o);
  }
  if(eligible.length>100)throw Error('More than 100 matching orders: narrow the customer, vendor or date range');
  const status=order=>normalize(order.status?.name);
  const within=(order,basis)=>{const day=sourceDate(order[basis]);return day&&day>=options.from&&day<=options.to;};
  const backlog=scoped.filter(order=>status(order)==='PEDIDO');
  const invoiced=scoped.filter(order=>status(order)==='FACTURADO');
  const sales=invoiced.filter(order=>within(order,'shipping_date'));
  const unclassified=scoped.filter(order=>!['PEDIDO','FACTURADO'].includes(status(order))).map(order=>order.order_id);
  // Preserve the requested period first. Additional sales/backlog reads share
  // the same 100-detail ceiling; any unread remainder stays explicitly partial.
  const wanted=[...new Map([...eligible,...sales,...backlog].map(order=>[order.order_id,order])).values()];
  const requested=wanted.slice(0,100),unread=wanted.slice(100).map(order=>order.order_id);
  const details=new Map(),failed=[];let next=0;
  await Promise.all(Array.from({length:4},async()=>{while(next<requested.length){const o=requested[next++];try{
    const detail=await client.get(`/orders/${o.order_id}`);
    if(detail.order_id!==o.order_id||detail.customer_id!==o.customer_id||detail[options.date_basis]!==o[options.date_basis]||detail.shipping_date!==o.shipping_date||detail.vendor!==o.vendor||status(detail)!==status(o))throw Error('Order changed');
    details.set(o.order_id,detail);
  }catch{failed.push(o.order_id);}}}));
  const customerIds=[...new Set(requested.map(o=>o.customer_id))],customers=[],unresolved=[];
  // Resolve only names needed for this summary, without listing unrelated contacts.
  next=0;
  await Promise.all(Array.from({length:4},async()=>{while(next<customerIds.length){const id=customerIds[next++];try{const c=await client.get(`/customers/${id}`);if(c.customer_id!==id)throw Error('Wrong customer');customers.push(c);}catch{unresolved.push(id);}}}));
  const ids=orders=>new Set(orders.map(order=>order.order_id));
  const subset=(values,orders)=>{const set=ids(orders);return values.filter(id=>set.has(id));};
  const unresolvedFor=orders=>unresolved.filter(id=>orders.some(order=>order.customer_id===id));
  const summarize=(orders,range)=>summarizeOrders(orders.map(order=>details.get(order.order_id)).filter(Boolean),customers,range);
  const summary=summarize(eligible,options),periodFailed=subset(failed,eligible),periodUnresolved=unresolvedFor(eligible);
  const complete=summary.quantities_complete&&!periodFailed.length&&!missingDates.length&&!invalidDates.length;
  const partial=(orders,range)=>{
    const {warnings,...result}=summarize(orders,range),failedIds=subset(failed,orders),unreadIds=subset(unread,orders),unknownCustomers=unresolvedFor(orders);
    return {...result,complete:vendorResolved&&result.quantities_complete&&!failedIds.length&&!unreadIds.length&&!unknownCustomers.length,
      expected_orders:orders.length,failed_order_ids:failedIds,unread_order_ids:unreadIds,unresolved_customer_ids:unknownCustomers};
  };
  const open=partial(backlog,null);
  const withoutShipping=backlog.filter(order=>order.shipping_date===null||order.shipping_date===undefined||(typeof order.shipping_date==='string'&&!order.shipping_date.trim())).map(order=>order.order_id);
  const invalidShipping=backlog.filter(order=>!withoutShipping.includes(order.order_id)&&!sourceDate(order.shipping_date)).map(order=>order.order_id);
  const sold=partial(sales,{...options,date_basis:'shipping_date'});
  const missingSalesDates=invoiced.filter(order=>!sourceDate(order.shipping_date)).map(order=>order.order_id);
  return {...summary,complete:vendorResolved&&complete&&!periodUnresolved.length,quantities_complete:complete,eligible_orders:eligible.length,
    vendor_resolution:vendorResolution,
    failed_order_ids:periodFailed,unresolved_customer_ids:periodUnresolved,excluded_without_date:missingDates,excluded_with_invalid_date:invalidDates,
    invoiced_sales_by_shipping_date:{...sold,complete:sold.complete&&!missingSalesDates.length,excluded_without_valid_shipping_date:missingSalesDates,monetary_totals:null},
    open_order_backlog:{...open,complete:open.complete&&!unclassified.length,
      scope:{customer_id:options.customer_id??null,vendor:options.vendor??null,status:'PEDIDO',date_filter_applied:false},
      unclassified_status_order_ids:unclassified,without_shipping_date:withoutShipping,with_invalid_shipping_date:invalidShipping,
      dates_complete:!withoutShipping.length&&!invalidShipping.length&&!open.failed_order_ids.length&&!open.unread_order_ids.length},
    customer_identities:customers.map(customer=>({customer_id:customer.customer_id,name:customer.name,commercial_name:customer.commercial_name,
      vat_number:customer.vat_number??null,address:customer.address??null,cross_system_identity_verified:false})),
    warnings:[...summary.warnings,
      ...(vendorResolved?[]:['Vendor scope is unresolved. Zero exact-label rows do not prove this supplier has no orders. Resolve candidate_labels against the provider and order source before a supplier-wide activity or absence claim; never merge candidates automatically.']),
      'The selected-period total includes every status and is not invoiced sales. Default sales uses invoiced_sales_by_shipping_date; state that date basis.',
      'open_order_backlog includes every current PEDIDO in this customer/vendor scope, including future or undated shipping. Never substitute the period PEDIDO subtotal for the complete backlog.',
      'A shared company name does not verify CRM identity. Compare VAT and location with CRM and report discrepancies or missing identifiers before combining records.'],
    generated_at:new Date().toISOString()};
}
