import {readPaymentMethods,readOrderConditions,assertPaymentConditions} from './payment-methods.mjs';
import { createHash } from 'node:crypto';

const lineKeys = ['line_id','product_id','product','description','quantity','final_quantity','unit_id','unit','unit_price','discount','vat_rate','delivery_date','remarks'];
const orderKeys = ['order_id','customer_id','offer_id','serie','number','date','status','delivery_date','shipping_date','payment_method','incoterm','reference','remarks','vendor'];
const patchKeys = ['date','delivery_date','shipping_date','payment_method_id','incoterm_id','vendor_id','reference','remarks','lines'];
const conditionLabels={payment_method_id:'payment_method',incoterm_id:'incoterm',vendor_id:'vendor'};
const patchLineKeys = ['line_id','delete','product_id','description','quantity','final_quantity','unit_id','unit_price','discount','delivery_date','remarks'];
const own = (o,k) => Object.hasOwn(o,k);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const id = value => Number.isSafeInteger(value) && value > 0 || fail('Native IDs must be positive JSON integers');
const number = value => typeof value === 'number' && Number.isFinite(value) || fail('Quantities/prices must be finite JSON numbers');
const anlReference = value => value.normalize('NFKC').replace(/\s+/g,' ').toLocaleUpperCase('es');
const close = (a,b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a-b) <= 0.0000001;
const same = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value; }
function keys(value, allowed) { if (!object(value) || Object.keys(value).some(k=>!allowed.includes(k))) fail('Unknown order mutation fields'); }
function date(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value) fail('A real YYYY-MM-DD date is required'); }
function text(value,max=20000) { if (typeof value!=='string' || value.length>max || value.includes('\0')) fail('Invalid text field'); }
function pick(value,allowed) { return Object.fromEntries(allowed.filter(k=>own(value,k)).map(k=>[k,value[k]])); }
// Metadata patches can preserve an explicit historical null without inventing
// kilos. Deliveries and economic/quantity edits still require a complete basis.
function snapshotOptions(action) {
  const lines=action.request?.body?.lines;
  const metadataOnly=action.type==='update_order' && (lines===undefined ||
    Array.isArray(lines) && lines.every(line=>object(line) && own(line,'line_id') &&
      Object.keys(line).every(key=>['line_id','description','delivery_date','remarks'].includes(key))));
  return {allowUnresolvedFinalQuantity:metadataOnly};
}
export function orderSnapshot(order,{allowUnresolvedFinalQuantity=false}={}) {
  if (!object(order)) fail('A complete native expectedOrder is required');
  id(order.order_id); id(order.customer_id);
  if (!Array.isArray(order.lines) || !order.lines.length || order.lines.length>1000) fail('A bounded complete order with lines is required');
  const seen=new Set();
  const lines=order.lines.map(line=>{
    if (!object(line)) fail('Invalid native order line');
    id(line.line_id); id(line.product_id); number(line.quantity);
    if(line.final_quantity===null || line.final_quantity===undefined) {
      if(!(allowUnresolvedFinalQuantity && own(line,'final_quantity') && line.final_quantity===null)) fail(`ORDER_FINAL_QUANTITY_MISSING: native line ${line.line_id} has no confirmed final_quantity; do not substitute ordered quantity or zero`);
    } else number(line.final_quantity);
    if(seen.has(line.line_id)) fail('Duplicate native line ID'); seen.add(line.line_id);
    return pick(line,lineKeys);
  }).sort((a,b)=>a.line_id-b.line_id);
  return {...pick(order,orderKeys),lines};
}
export function validateOrderMutation(action) {
  keys(action.request,['orderId','body','expectedOrder']);
  id(action.request.orderId);
  const before=orderSnapshot(action.request.expectedOrder,snapshotOptions(action));
  if(before.order_id!==action.request.orderId) fail('Order ID does not match the approved snapshot');
  const body=action.request.body;
  if(action.type==='record_order_delivery') {
    keys(body,['date','reference','lines']); date(body.date); text(body.reference,255);
    if(!body.reference.trim() || body.reference!==body.reference.trim()) fail('ANL reference is required without surrounding whitespace');
    if(before.lines.some(line=>typeof line.remarks==='string' && anlReference(line.remarks)===anlReference(body.reference))) fail('ANL_ALREADY_RECORDED: reconcile the existing delivery, do not create another');
    if(!Array.isArray(body.lines)||!body.lines.length||body.lines.length>1000) fail('Delivery lines are required');
    const seen=new Set();
    for(const line of body.lines) {
      keys(line,['line_id','quantity']); id(line.line_id); number(line.quantity);
      if(line.quantity<=0||seen.has(line.line_id)) fail('Delivery quantities must be positive and line IDs unique'); seen.add(line.line_id);
      const source=before.lines.find(l=>l.line_id===line.line_id);
      if(!source) fail('Delivery line is absent from approved order');
      // The provider allows over-delivery, including a negative remainder.
      // An existing delivered line must never be selected as the pending line.
      if(/^ANL\b/i.test(source.remarks??'')) fail('Select the verified pending line, not an earlier delivery');
    }
  } else if(action.type==='update_order') {
    keys(body,patchKeys);
    if(!Object.keys(body).length) fail('Order patch is empty');
    for(const [key,value] of Object.entries(body)) {
      if(value===null) fail('Omit unchanged fields instead of null');
      if(key.endsWith('_id')) id(value);
      else if(['date','delivery_date','shipping_date'].includes(key)) date(value);
      else if(['reference','remarks'].includes(key)) text(value);
    }
    if(body.lines!==undefined) {
      if(!Array.isArray(body.lines)||!body.lines.length||body.lines.length>1000) fail('Patch lines must be nonempty');
      const seen=new Set();
      for(const line of body.lines) {
        keys(line,patchLineKeys);
        if(own(line,'line_id')) { id(line.line_id); if(seen.has(line.line_id)||!before.lines.some(l=>l.line_id===line.line_id)) fail('Unknown/duplicate patch line'); seen.add(line.line_id); }
        else { id(line.product_id); number(line.quantity); if(own(line,'delete')) fail('New lines cannot be deleted'); }
        if(own(line,'delete') && (line.delete!==true || Object.keys(line).sort().join(',')!=='delete,line_id')) fail('Deletion requires only line_id and delete:true');
        if(Object.keys(line).length===1 && own(line,'line_id')) fail('Line patch is empty');
        for(const [key,value] of Object.entries(line)) {
          if(value===null) fail('Omit unchanged line fields instead of null');
          if(key.endsWith('_id')) id(value);
          else if(['quantity','final_quantity','unit_price','discount'].includes(key)) number(value);
          else if(key==='delivery_date') date(value);
          else if(['description','remarks'].includes(key)) text(value);
        }
      }
    }
  } else fail('Unsupported order mutation');
  return before;
}
export function assertOrderUnchanged(action,current) {
  const expected=validateOrderMutation(action);
  if(!same(expected,orderSnapshot(current,snapshotOptions(action)))) fail('ORDER_CHANGED_SINCE_APPROVAL: read and approve the current order again');
}
export function deliveryIdempotencyKey(action) {
  // Stable UUID scoped to the native order and ANL, independent of tool retries
  // or another approval envelope. Different content for the same ANL is not a
  // second delivery: provider replay is checked against the exact before/after.
  const hash=createHash('sha256').update(JSON.stringify(['trinalum-production',action.request.orderId,anlReference(action.request.body.reference)])).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
export function mutationIdempotencyKey(action) {
  if(action.type==='record_order_delivery') return deliveryIdempotencyKey(action);
  const h=createHash('sha256').update(action.id).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function verifyOrderMutation(action,result,readback) {
  const before=validateOrderMutation(action), options=snapshotOptions(action), after=orderSnapshot(readback,options);
  if(!same(orderSnapshot(result,options),after)) fail('Write response differs from independent order readback');
  if(before.order_id!==after.order_id || before.customer_id!==after.customer_id) fail('Order/customer readback mismatch');
  const body=action.request.body, oldIds=new Set(before.lines.map(l=>l.line_id));
  if(action.type==='record_order_delivery') {
    if(!same(pick(before,orderKeys),pick(after,orderKeys))) fail('Delivery changed order conditions');
    const fresh=after.lines.filter(l=>!oldIds.has(l.line_id));
    if(fresh.length!==body.lines.length || after.lines.length!==before.lines.length+body.lines.length) fail('Delivery line count mismatch');
    for(const old of before.lines) {
      const line=after.lines.find(l=>l.line_id===old.line_id), delivered=body.lines.find(l=>l.line_id===old.line_id);
      if(!line) fail('Existing order line disappeared');
      if(!delivered) { if(!same(old,line)) fail('Earlier order/delivery line changed'); continue; }
      if(!close(line.quantity,old.quantity-delivered.quantity)||!close(line.final_quantity,old.final_quantity-delivered.quantity)||!same(pick(old,lineKeys.filter(k=>!['quantity','final_quantity'].includes(k))),pick(line,lineKeys.filter(k=>!['quantity','final_quantity'].includes(k))))) fail('Pending line readback mismatch');
      const index=fresh.findIndex(l=>close(l.quantity,delivered.quantity)&&close(l.final_quantity,delivered.quantity)&&l.delivery_date===body.date&&l.remarks===body.reference&&same(pick(l,['product_id','unit_id','unit_price','discount','vat_rate']),pick(old,['product_id','unit_id','unit_price','discount','vat_rate'])));
      if(index<0) fail('Delivered line readback mismatch'); fresh.splice(index,1);
    }
    for(const field of ['quantity','final_quantity']) if(!close(before.lines.reduce((s,l)=>s+l[field],0),after.lines.reduce((s,l)=>s+l[field],0))) fail('Contract total changed');
  } else {
    // The provider accepts condition IDs but only echoes text labels. Compare
    // all other approved fields strictly, and disclose these IDs as unverifiable.
    for(const key of Object.keys(body).filter(k=>k!=='lines'&&!own(conditionLabels,k))) {
      if(!own(after,key)) fail(`Order readback cannot verify ${key}`);
      if(!same(after[key],body[key])) fail(`Order readback mismatch: ${key}`);
    }
    const changingLabels=Object.keys(conditionLabels).filter(k=>own(body,k)).map(k=>conditionLabels[k]);
    for(const key of orderKeys.filter(k=>!own(body,k)&&!changingLabels.includes(k))) if(!same(before[key],after[key])) fail(`Unchanged order field changed: ${key}`);
    const changes=body.lines??[], added=after.lines.filter(l=>!oldIds.has(l.line_id));
    if(added.length!==changes.filter(l=>!own(l,'line_id')).length) fail('New line count mismatch');
    for(const old of before.lines) {
      const change=changes.find(l=>l.line_id===old.line_id), actual=after.lines.find(l=>l.line_id===old.line_id);
      if(change?.delete) { if(actual) fail('Deleted line still exists'); continue; }
      if(!actual || !same({...old,...change},actual)) fail('Patched or untouched order line differs');
    }
    for(const change of changes.filter(l=>!own(l,'line_id'))) {
      const index=added.findIndex(l=>Object.entries(change).every(([k,v])=>same(l[k],v)));
      if(index<0) fail('Added line readback mismatch'); added.splice(index,1);
    }
  }
  return readback;
}
export async function executeOrderMutation(sibema,action,operation) {
  const paymentId=action.type==='update_order'?action.request.body?.payment_method_id:undefined;
  if(paymentId!==undefined){
    validateOrderMutation(action);
    const catalogue=await readPaymentMethods(sibema);
    if(!catalogue.payment_methods.some(row=>row.payment_method_id===paymentId))fail('Unknown native payment method ID');
    assertPaymentConditions(await readOrderConditions(sibema,action.request.orderId),action.request.expectedOrder);
  }
  assertOrderUnchanged(action,await sibema.getObject('orders',action.request.orderId));
  let phase='write';
  try {
    const result=await sibema.write(operation.path,{method:operation.method,body:operation.body,idempotencyKey:mutationIdempotencyKey(action)});
    phase='readback';
    const readback=await sibema.getObject('orders',action.request.orderId);
    verifyOrderMutation(action,result,readback);
    const paymentConditions=paymentId===undefined?null:await readOrderConditions(sibema,action.request.orderId);
    if(paymentConditions)assertPaymentConditions(paymentConditions,readback,paymentId);
    const conditionFields=action.type==='update_order'?Object.keys(conditionLabels).filter(k=>own(action.request.body,k)&&k!=='payment_method_id'):[];
    if(conditionFields.length)return {result,readback:{data:readback,verification:{independent_readback:true,unverifiable_fields:conditionFields,requested_condition_ids:Object.fromEntries(conditionFields.map(k=>[k,action.request.body[k]])),provider_echoes_ids:false,...(paymentConditions?{native_payment_conditions:paymentConditions,verified_fields:['payment_method_id']}:{}),other_fields_verified:true,warning:'Provider accepted condition IDs but only returns labels; the requested IDs have not been independently verified.'}}};
    return paymentConditions?{result,readback:{data:readback,verification:{independent_readback:true,native_payment_conditions:paymentConditions,verified_fields:['payment_method_id'],unverifiable_fields:[],other_fields_verified:true}}}:{result,readback};
  } catch(error) {
    // A definite rejection applies only to the write request itself. Once the
    // write returned successfully, every readback/verification failure is
    // uncertain regardless of its HTTP status: the mutation may be committed.
    if(phase==='readback' || ![400,401,404,422].includes(error.status)) error.outcomeUncertain=true;
    throw error;
  }
}
