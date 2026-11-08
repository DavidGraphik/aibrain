// The official Sibema UI uses PUT rest/<entity>/update. Public API1.2 lacks
// customer PATCH. This narrow adapter appends remarks and preserves the entity.
import {sibemaOrigin as origin} from './provider-config.mjs';
const fields = ['branch','customerid','customer','comercialname','idcardnumber','address','phone','email','iban','accountid','createat','postalcode','townid','stateid','countryid','accountingaccountid','counterpart','vatid','paymentmethodid','remarks','inactivitydays','incotermid','customercontactpersonid'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = message => { throw Error(`SIBEMA_CUSTOMER_NOTES: ${message}`); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function publicFieldsPreserved(before,after) {
 // The provider currently projects both public timestamps from its last edit.
 // A first edit can collapse distinct legacy public timestamps into that alias
 // while native createat remains null. Never normalize a known native creation
 // date or a public creation value that does not become the verified edit alias.
 // The complete expected native entity is checked before this comparison.
 const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
 const aliases=row=>timestamp(row.created_at)&&row.created_at===row.updated_at;
 const previous=before.scoped,current=after.scoped;
 const orderedBefore=timestamp(previous.created_at)&&timestamp(previous.updated_at)&&Date.parse(previous.created_at)<=Date.parse(previous.updated_at);
 const forwardEdit=aliases(current)&&timestamp(previous.updated_at)&&Date.parse(current.updated_at)>=Date.parse(previous.updated_at);
 const firstEditProjection=before.raw.createat===null&&after.raw.createat===null&&orderedBefore&&forwardEdit;
 const editAlias=aliases(previous)&&forwardEdit;
 const excluded=['updated_at',...(editAlias||firstEditProjection?['created_at']:[])];
 const business=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!excluded.includes(key)));
 return same(before.raw.createat,after.raw.createat)&&same(business(previous),business(current));
}
export function validateCustomerNoteRequest(input) {
 if (!object(input) || Object.keys(input).some(key => !['customerId','body'].includes(key)) || !positive(input.customerId) || !object(input.body) || Object.keys(input.body).length !== 1 || typeof input.body.note !== 'string' || !input.body.note.trim() || input.body.note !== input.body.note.trim() || input.body.note.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.body.note)) fail('expected customerId and body.note (nonempty text, at most2000 characters)');
 return input;
}
async function native(client,path,body) {
 if (client.host !== origin || !/^\/rest\/customer\/(?:[1-9]\d*|update)$/.test(path) || (body !== undefined) !== (path === '/rest/customer/update')) fail('unexpected tenant, method or route');
 if (!client.token || Date.now() > client.tokenExpiresAt - 60000) await client.authenticate();
 const response = await client.fetchImpl(origin + '/ERPBerma' + path,{method:body === undefined?'GET':'PUT',headers:{authorization:`Bearer ${client.token}`,accept:'application/json',...(body === undefined?{}:{'content-type':'application/json'})},...(body === undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(15000)});
 if (!response.ok) { const error = Error(`SIBEMA_CUSTOMER_NOTES: native request failed (${response.status})`); error.status=response.status; throw error; }
 if (body !== undefined) { await response.body?.cancel(); return; }
 const maximum=1024*1024;if(Number(response.headers.get('content-length'))>maximum) {await response.body?.cancel();fail('response too large');}
 const reader=response.body?.getReader();if(!reader)fail('missing native response');const chunks=[];let count=0;
 try { for (;;) {const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>maximum){await reader.cancel();fail('response too large');}chunks.push(Buffer.from(value));} }
 finally {reader.releaseLock();}
 try {return JSON.parse(Buffer.concat(chunks,count).toString('utf8'));} catch {fail('invalid native JSON');}
}
function entity(raw,id,publicCustomer) {
 if (!object(raw) || Object.keys(raw).length!==fields.length || fields.some(key=>!Object.hasOwn(raw,key)) || raw.customerid !== id || raw.branch !== null || !object(publicCustomer) || publicCustomer.customer_id !== id || raw.customer !== publicCustomer.name || raw.idcardnumber !== publicCustomer.vat_number || typeof raw.idcardnumber !== 'string' || !raw.idcardnumber.trim() || !(raw.remarks===null || typeof raw.remarks==='string') || (raw.remarks?.length??0)>20000) fail('customer schema or scoped public/native identity mismatch');
 return raw;
}
async function snapshot(client,id) {
 const scoped = await client.getObject('customers',id);
 return {scoped,raw:entity(await native(client,`/rest/customer/${id}`),id,scoped)};
}
export async function readCustomerNotes(client,id) {
 if(!positive(id))fail('positive customer ID required');
 const {raw}=await snapshot(client,id);
 return {customer_id:id,name:raw.customer,vat_number:raw.idcardnumber,remarks:raw.remarks,source:'official native customer remarks',independent_readback:true};
}
export async function appendCustomerNote(client,input) {
 validateCustomerNoteRequest(input);
 const {customerId,body:{note}}=input;
 const before=await snapshot(client,customerId);
 // An exact existing note is idempotent, including a multiline note. Never
 // overwrite unrelated observations and never duplicate the requested text.
 const remarks=before.raw.remarks??'';
 const already=remarks===note || remarks.startsWith(note+'\n') || remarks.endsWith('\n'+note) || remarks.includes('\n'+note+'\n');
 const expected={...before.raw,remarks:already?before.raw.remarks:remarks+(remarks&&!remarks.endsWith('\n')?'\n':'')+note};
 if(expected.remarks.length>20000)fail('combined remarks exceed20000 characters');
 const current=await snapshot(client,customerId);
 if(!same(before.raw,current.raw) || !same(before.scoped,current.scoped)) fail('customer changed concurrently; reread before preparing another action');
 let dispatched=false,phase='write';
 try {
  if(!already) {dispatched=true;await native(client,'/rest/customer/update',expected);}
  phase='readback';
  const after=await snapshot(client,customerId);
  if(!same(expected,after.raw))fail('exact remarks or other customer fields readback mismatch');
  if(!publicFieldsPreserved(before,after))fail('public customer fields changed during note update');
  return {result:{customer_id:customerId,note,appended:!already,already_present:already},readback:{customer_id:customerId,name:after.raw.customer,remarks:after.raw.remarks,independent_readback:true,other_customer_fields_preserved:true}};
 } catch(error) {
  if(dispatched && (phase==='readback' || ![400,401,403,404,409,422].includes(error.status)))error.outcomeUncertain=true;
  throw error;
 }
}
