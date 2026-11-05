export function summarizeSales(orders,customers,{from,to,limit=30}) {
  const clients=new Map(customers.map(c=>[Number(c.customer_id),c]));const rows=new Map();
  let missingLines=0,invalidAmounts=0,unknownUnits=0,invalidQuantities=0;const amountIssues=[];
  for(const order of orders){
    const client=clients.get(Number(order.customer_id));
    const row=rows.get(order.customer_id)??{customer_id:order.customer_id,name:client?.name??`Cliente ${order.customer_id}`,province:client?.address?.state??'Sin provincia',orders:0,net_line_amount:0,amount_incomplete:false,amount_issue_count:0,quantity_by_unit:{}};
    row.orders++;
    if(!Array.isArray(order.lines)||!order.lines.length){missingLines++;row.amount_incomplete=true;}
    for(const line of order.lines??[]){
      const q=line.quantity==null?NaN:Number(line.quantity),p=line.unit_price==null?NaN:Number(line.unit_price),d=line.discount==null?0:Number(line.discount);
      // The provider contract does not specify the discount unit. Never
      // interpret nonzero discounts as percentages without a verified unit.
      if(Number.isFinite(q)&&Number.isFinite(p)&&d===0)row.net_line_amount+=q*p;else {invalidAmounts++;row.amount_incomplete=true;row.amount_issue_count++;amountIssues.push({order_id:order.order_id,line_id:line.line_id,customer_id:order.customer_id,reason:'Missing quantity/price or nonzero discount with undocumented unit'});}
      if(!Number.isFinite(q))invalidQuantities++;
      let unit=String(line.unit??'').trim().toLowerCase();let factor=1;
      if(['kg','kgs','kilogramo','kilogramos'].includes(unit))unit='kg';
      else if(['t','tm','ton','tonelada','toneladas'].includes(unit)){unit='kg';factor=1000;}
      if(!unit){unit='unidad_no_informada';unknownUnits++;}
      if(Number.isFinite(q))row.quantity_by_unit[unit]=(row.quantity_by_unit[unit]??0)+q*factor;
    }
    rows.set(order.customer_id,row);
  }
  const round=n=>Math.round(n*100)/100;
  const all=[...rows.values()].map(r=>({...r,net_line_amount:r.amount_incomplete?null:round(r.net_line_amount),quantity_by_unit:Object.fromEntries(Object.entries(r.quantity_by_unit).map(([u,q])=>[u,round(q)]))}));
  const byProvince={};for(const r of all){const p=byProvince[r.province]??{customers:0,orders:0,net_line_amount:0,kg:0};p.customers++;p.orders+=r.orders;p.net_line_amount=p.net_line_amount==null||r.net_line_amount==null?null:round(p.net_line_amount+r.net_line_amount);p.kg=round(p.kg+(r.quantity_by_unit.kg??0));byProvince[r.province]=p;}
  return {source:'Sibema order details and customers',range:{from,to},basis:'FACTURADO by shipping_date; net line amounts before VAT; not company commission invoices',orders:orders.length,customers:all.length,missing_line_orders:missingLines,invalid_amount_lines:invalidAmounts,invalid_quantity_lines:invalidQuantities,amount_issues:amountIssues,unknown_unit_lines:unknownUnits,top_by_amount:all.filter(r=>!r.amount_incomplete).sort((a,b)=>b.net_line_amount-a.net_line_amount).slice(0,limit),top_by_kg:all.filter(r=>'kg'in r.quantity_by_unit).sort((a,b)=>b.quantity_by_unit.kg-a.quantity_by_unit.kg).slice(0,limit),by_province:byProvince,warnings:['Currency is not exposed on order lines; net amount is not cash collected or company revenue.','Kilograms and other units are kept separate. Tonnes are converted to kg.','Orders with missing shipping dates are excluded and reported separately.','Customers with incomplete monetary data are excluded from amount ranking, not treated as zero.']};
}

export async function buildSalesSummary(client,{from,to,limit=30}) {
  for(const d of [from,to])if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d)throw new Error('Valid --from and --to dates required');
  if(from>to)throw new Error('Date range reversed');
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Limit must be 1-100');
  const listed=await client.listAll('orders');const customers=await client.listAll('customers');
  const invoiced=listed.filter(o=>String(o.status?.name??'').toUpperCase()==='FACTURADO');
  const eligible=invoiced.filter(o=>o.shipping_date&&o.shipping_date.slice(0,10)>=from&&o.shipping_date.slice(0,10)<=to);
  const details=[],failed=[];let next=0;
  await Promise.all(Array.from({length:4},async()=>{while(next<eligible.length){const o=eligible[next++];try{details.push(await client.getObject('orders',o.order_id));}catch(e){failed.push({order_id:o.order_id,status:e.status??null,error:'Order detail could not be retrieved'});}}}));
  const result=summarizeSales(details,customers,{from,to,limit});
  return {...result,generated_at:new Date().toISOString(),complete:!failed.length&&!result.missing_line_orders&&!result.invalid_amount_lines,quantities_complete_for_dated_orders:!failed.length&&!result.missing_line_orders&&!result.invalid_quantity_lines&&!result.unknown_unit_lines,eligible_orders:eligible.length,failed_details:failed,excluded_invoiced_without_shipping_date:invoiced.filter(o=>!o.shipping_date).length};
}
