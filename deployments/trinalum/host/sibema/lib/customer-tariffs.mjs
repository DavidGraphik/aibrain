// Official CRM Tarifa (Customerproduct), verified against the provider UI.
// This is deliberately separate from Customeroffer and Providerproduct.
import {sibemaOrigin as origin} from './provider-config.mjs';
const fields=['branch','customerproductid','customerproduct','customerid','productid','saleorderid','taskid','since','until','fromquantity','toquantity','price','cost','remarks'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const positive=v=>Number.isSafeInteger(v)&&v>0;
const fail=message=>{throw Error(`SIBEMA_CUSTOMER_TARIFF: ${message}`);};
const canonical=v=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const localDate=v=>v===null?null:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v));
function midnight(value){
 if(value==null)return null;
 const target=Date.parse(value+'T00:00:00Z');let stamp=target;
 const format=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 for(let i=0;i<3;i++){const p=Object.fromEntries(format.formatToParts(new Date(stamp)).map(x=>[x.type,x.value]));const represented=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);stamp-=represented-target;}
 return new Date(stamp).toISOString().replace(/Z$/,'+00:00');
}
function text(value,label,max){if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail(`invalid ${label}`);}
export function validateCustomerTariffRequest(input,options={}){
 try{return validateRequest(input,options);}catch(error){
  // This is local input validation only. Provider failures/readback uncertainty
  // never acquire a recoverable validation code or leak their raw message.
  error.code??='SIBEMA_TARIFF_INVALID_ARGUMENTS';throw error;
 }
}
function validateRequest(input,{update=false}={}){
 if(!object(input)||Object.keys(input).some(k=>!['customerId','body',...(update?['tariffId','expectedTariff']:[])].includes(k))||!positive(input.customerId)||!object(input.body))fail('customerId and body required');
 const b=input.body;if(Object.keys(b).some(k=>!['product_id','reference','valid_from','valid_until','quantity_from','quantity_until','price','price_basis','remarks'].includes(k))||!positive(b.product_id))fail('invalid tariff fields or product ID');
 text(b.reference,'exact reference',255);text(b.price_basis,'source price basis',80);
 if(typeof b.price!=='number'||!Number.isFinite(b.price)||b.price<0)fail('price must be a nonnegative source number');
 for(const k of ['quantity_from','quantity_until'])if(b[k]!=null&&(typeof b[k]!=='number'||!Number.isFinite(b[k])||b[k]<0))fail('invalid tariff quantity');
 if(b.quantity_from!=null&&b.quantity_until!=null&&b.quantity_from>b.quantity_until)fail('quantity range inverted');
 for(const k of ['valid_from','valid_until'])if(b[k]!=null&&!date(b[k]))fail('real YYYY-MM-DD validity required');
 if(b.valid_from&&b.valid_until&&b.valid_from>b.valid_until)fail('validity range inverted');
 if(b.remarks!==undefined)text(b.remarks,'remarks',Number.MAX_SAFE_INTEGER);
 if(remarks(b).length>255)throw Object.assign(Error('SIBEMA_CUSTOMER_TARIFF: remarks including price basis exceed255 characters'),{code:'SIBEMA_TARIFF_REMARKS_TOO_LONG'});
 if(update&&(!positive(input.tariffId)||!object(input.expectedTariff)||input.expectedTariff.tariff_id!==input.tariffId||input.expectedTariff.customer_id!==input.customerId))fail('update requires same tariffId and complete current expectedTariff');
 return input;
}
function remarks(b){
 const prefix=`Unidad precio: ${b.price_basis}.`,value=b.remarks??'';
 // Read-modify-write callers naturally reuse the full existing remarks.
 // Preserve those bytes and do not consume the limit with a second prefix.
 if(value===prefix||value.startsWith(prefix+' '))return value;
 if(value.startsWith('Unidad precio: '))fail('remarks price basis conflicts with requested source basis');
 return prefix+(value?' '+value:'');
}
async function native(client,path,body){
 const query=path==='/rest/getByQuery',write=path==='/rest/customerproduct/update';
 if(client.host!==origin||!(query||write||/^\/rest\/(?:customer|product)\/[1-9]\d*$/.test(path))||(body!==undefined)!==(query||write))fail('unexpected tenant or route');
 if(!client.token||Date.now()>(client.tokenExpiresAt??0)-60000)await client.authenticate();
 const r=await client.fetchImpl(origin+'/ERPBerma'+path,{method:write?'PUT':query?'POST':'GET',headers:{authorization:`Bearer ${client.token}`,accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!r.ok){const e=Error(`SIBEMA_CUSTOMER_TARIFF: native request failed (${r.status})`);e.status=r.status;throw e;}
 if(write){await r.body?.cancel();return;}
 const limit=8*1024*1024;if(Number(r.headers.get('content-length'))>limit){await r.body?.cancel();fail('response exceeds8MiB');}
 const reader=r.body?.getReader();if(!reader)fail('missing response');const chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();fail('response exceeds8MiB');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{fail('invalid JSON');}
}
async function customer(client,id){
 const scoped=await client.getObject('customers',id),raw=await native(client,`/rest/customer/${id}`);
 if(!object(scoped)||scoped.customer_id!==id||!object(raw)||raw.customerid!==id||raw.branch!==null||raw.customer!==scoped.name||raw.idcardnumber!==scoped.vat_number)fail('scoped customer identity mismatch');
 return raw;
}
function safe(row,customerId){
 if(!object(row)||Object.keys(row).length!==fields.length||fields.some(k=>!Object.hasOwn(row,k))||!positive(row.customerproductid)||row.branch!==null||row.customerid?.customerid!==customerId||!positive(row.productid?.productid))fail('tariff schema or customer scope mismatch');
 for(const k of ['since','until'])if(row[k]!==null&&(typeof row[k]!=='string'||!Number.isFinite(Date.parse(row[k]))))fail('invalid native validity');
 for(const k of ['fromquantity','toquantity','price','cost'])if(row[k]!==null&&(typeof row[k]!=='number'||!Number.isFinite(row[k])))fail('invalid native price or quantity');
 return {tariff_id:row.customerproductid,customer_id:customerId,product_id:row.productid.productid,reference:row.customerproduct,valid_from:localDate(row.since),valid_until:localDate(row.until),quantity_from:row.fromquantity,quantity_until:row.toquantity,price:row.price,cost:row.cost,remarks:row.remarks,sale_order_id:row.saleorderid?.saleorderid??null,task_id:row.taskid?.taskid??null};
}
async function rows(client,customerRow){
 const result=await native(client,'/rest/getByQuery',{clazz:'customerproduct',items:[{field:'customerid',operator:'OPERATOR_EQUAL',value:customerRow}]});
 if(!Array.isArray(result)||result.length>10000)fail('invalid tariff list');
 const ids=new Set();for(const row of result){const v=safe(row,customerRow.customerid);if(ids.has(v.tariff_id))fail('duplicate tariff ID');ids.add(v.tariff_id);}
 return result;
}
export async function readCustomerTariffs(client,id){
 if(!positive(id))fail('positive customer ID required');const c=await customer(client,id),result=await rows(client,c);
 return {customer_id:id,name:c.customer,tariffs:result.map(row=>safe(row,id)),source:'official native CRM Tarifa (Customerproduct)',independent_readback:true,price_basis:'Native tariff has no unit field; preserve literal source prices and state their basis in remarks. Never infer EUR/kg from the product movement unit.'};
}
const ordered=values=>values.sort((a,b)=>a.tariff_id-b.tariff_id);
const key=v=>[v.customer_id,v.product_id,v.reference,v.valid_from,v.valid_until,v.quantity_from,v.quantity_until];
// Missing scope is not evidence for a second tariff. A different dated or
// quantity band is safe to create only when the provided bounds distinguish it.
const scopeFields=['valid_from','valid_until','quantity_from','quantity_until'];
const overlaps=(a,b,low,high)=>!(a[high]!=null&&b[low]!=null&&a[high]<b[low]||b[high]!=null&&a[low]!=null&&b[high]<a[low]);
function ambiguousCreateCandidates(before,desired){
 return before.filter(row=>row.customer_id===desired.customer_id&&row.product_id===desired.product_id&&row.reference===desired.reference&&
  scopeFields.some(field=>desired[field]===null&&row[field]!==null)&&
  overlaps(row,desired,'valid_from','valid_until')&&overlaps(row,desired,'quantity_from','quantity_until'));
}
export async function saveCustomerTariff(client,input,{update=false}={}){
 validateCustomerTariffRequest(input,{update});const {customerId,body:b}=input;
 const c=await customer(client,customerId),p=await native(client,`/rest/product/${b.product_id}`);
 if(!object(p)||p.productid!==b.product_id||p.branch!==null||p.active!==true)fail('native product identity or activity mismatch');
 const before=await rows(client,c);
 const desired={customer_id:customerId,product_id:b.product_id,reference:b.reference,valid_from:b.valid_from??null,valid_until:b.valid_until??null,quantity_from:b.quantity_from??null,quantity_until:b.quantity_until??null,price:b.price,remarks:remarks(b)};
 let original;
 if(update){original=before.find(row=>row.customerproductid===input.tariffId);if(!original||!same(safe(original,customerId),input.expectedTariff))fail('tariff changed since preview; reread before updating');}
 const matching=before.filter(row=>same(key(safe(row,customerId)),key(desired)));
 if(matching.length>1||matching.some(row=>update&&row.customerproductid!==input.tariffId))fail('ambiguous existing tariff; do not overwrite or duplicate');
 if(!update&&matching.length){const row=safe(matching[0],customerId);if(!Object.entries(desired).every(([k,v])=>same(row[k],v)))fail('tariff already exists with different values; read and use an exact guarded update');return {result:{tariff_id:row.tariff_id,created:false,already_present:true},readback:{...row,independent_readback:true,destination:'CRM Tarifa'}};}
 if(!update){
  const candidates=ambiguousCreateCandidates(before.map(row=>safe(row,customerId)),desired);
  if(candidates.length)throw Object.assign(Error('SIBEMA_CUSTOMER_TARIFF: missing scope overlaps existing tariff IDs '+candidates.slice(0,20).map(row=>row.tariff_id).join(',')+'; reread customer tariffs and use a guarded update or an explicitly distinct scope. No tariff written.'),{code:'SIBEMA_TARIFF_SCOPE_AMBIGUOUS',status:409,candidateTariffs:candidates.slice(0,20),candidateCount:candidates.length});
 }
 const expected=update?{...original}:{branch:null,customerproductid:null,customerid:c,productid:p,saleorderid:null,taskid:null,cost:null};
 Object.assign(expected,{customerproduct:b.reference,productid:p,since:midnight(b.valid_from),until:midnight(b.valid_until),fromquantity:b.quantity_from??null,toquantity:b.quantity_until??null,price:b.price,remarks:remarks(b)});
 if(!update)delete expected.customerproductid; // Official new-row form omits ID.
 const current=await rows(client,c);if(!same(ordered(before.map(row=>safe(row,customerId))),ordered(current.map(row=>safe(row,customerId)))))fail('customer tariffs changed concurrently; reread');
 let dispatched=false,phase='write';
 try{
  dispatched=true;await native(client,'/rest/customerproduct/update',expected);phase='readback';
  const after=await rows(client,c),selected=after.filter(row=>update?row.customerproductid===input.tariffId:same(key(safe(row,customerId)),key(desired)));
  if(selected.length!==1)fail('independent tariff identity/count readback mismatch');const saved=safe(selected[0],customerId);
  if(!Object.entries(desired).every(([k,v])=>same(saved[k],v)))fail('independent tariff values readback mismatch');
  const untouchedBefore=before.filter(row=>row.customerproductid!==saved.tariff_id).map(row=>safe(row,customerId));
  const untouchedAfter=after.filter(row=>row.customerproductid!==saved.tariff_id).map(row=>safe(row,customerId));
  if(!same(ordered(untouchedBefore),ordered(untouchedAfter)))fail('other tariff rows changed during write');
  if(update&&(saved.cost!==input.expectedTariff.cost||saved.sale_order_id!==input.expectedTariff.sale_order_id||saved.task_id!==input.expectedTariff.task_id))fail('unrequested tariff fields changed');
  return {result:{tariff_id:saved.tariff_id,created:!update,updated:update},readback:{...saved,independent_readback:true,destination:'CRM Tarifa',other_tariffs_preserved:true}};
 }catch(error){if(dispatched&&(phase==='readback'||![400,401,403,404,409,422].includes(error.status)))error.outcomeUncertain=true;throw error;}
}
