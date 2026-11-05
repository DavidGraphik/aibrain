import test from 'node:test';
import assert from 'node:assert/strict';
import {appendCustomerNote,readCustomerNotes,validateCustomerNoteRequest} from '../lib/customer-notes.mjs';
import {validateAction,executeAction} from '../bin/sibema-action.mjs';
import {readApi} from '../lib/api-request.mjs';
import {discover,schemaFor} from '../lib/api-contract.mjs';
function fixture(options={}) {
 const raw={branch:null,customerid:12,customer:'Synthetic coating customer',comercialname:'Synthetic',idcardnumber:'B12345678',address:'Example',phone:'123',email:null,iban:null,accountid:null,createat:options.nativeCreatedAt??null,postalcode:'00000',townid:{townid:22,stateid:{stateid:22}},stateid:{stateid:22},countryid:{countryid:1},accountingaccountid:null,counterpart:null,vatid:null,paymentmethodid:null,remarks:options.remarks??null,inactivitydays:null,incotermid:null,customercontactpersonid:null};
 const scoped={customer_id:12,name:raw.customer,vat_number:raw.idcardnumber,phone:raw.phone,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z'};
 let writes=0,reads=0;const requests=[];
 const client={host:'https://erp.example.invalid',token:'synthetic',tokenExpiresAt:Date.now()+600000,getObject:async(resource,id)=>{assert.equal(resource,'customers');assert.equal(id,12);const output=structuredClone(scoped);if(options.originalCreatedAt)output.created_at=options.originalCreatedAt;if(options.originalUpdatedAt)output.updated_at=options.originalUpdatedAt;if(writes){if(options.publicTimestamps){output.created_at=options.publicTimestamps.created;output.updated_at=options.publicTimestamps.updated;}if(options.publicPhoneChange)output.phone='Changed public phone';}return output;},fetchImpl:async(url,init)=>{
  requests.push({url,method:init.method});assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer synthetic');
  if(init.method==='PUT'){writes++;assert.equal(url,'https://erp.example.invalid/ERPBerma/rest/customer/update');const updated=JSON.parse(init.body);assert.deepEqual({...updated,remarks:raw.remarks},raw);if(options.writeStatus)return new Response('{}',{status:options.writeStatus});Object.assign(raw,updated);if(options.mutateAfterWrite)raw.phone='changed';if(options.mutateNativeCreatedAt)raw.createat='2026-11-04T10:39:46.048+01:00';if(options.lostResponse)throw Error('lost PUT response');return new Response('{}');}
  assert.equal(url,'https://erp.example.invalid/ERPBerma/rest/customer/12');reads++;if(reads===2&&options.concurrent)raw.remarks='Concurrent human edit';if(writes&&options.readbackStatus)return new Response('{}',{status:options.readbackStatus});if(options.identityMismatch)raw.idcardnumber='B99999999';return new Response(JSON.stringify(raw));
 }};
 return {client,raw,requests,writes:()=>writes};
}
const input={customerId:12,body:{note:'Only uses liquid coating.'}};
test('appends exact note preserving previous remarks and every other native/public field',async()=>{
 const f=fixture({remarks:'Original observation.'});const r=await appendCustomerNote(f.client,input);assert.equal(f.writes(),1);assert.equal(f.raw.remarks,'Original observation.\nOnly uses liquid coating.');assert.equal(r.readback.other_customer_fields_preserved,true);assert.equal(r.readback.independent_readback,true);
});
test('an existing note is idempotent without a provider write',async()=>{const f=fixture({remarks:'Original\nOnly uses liquid coating.\nNew fact'});const r=await appendCustomerNote(f.client,input);assert.equal(f.writes(),0);assert.equal(r.result.already_present,true);});
test('accepts provider-created timestamp alias only while every native/public business field remains exact',async()=>{
 const f=fixture({publicTimestamps:{created:'2026-11-04T10:39:46.048+01:00',updated:'2026-11-04T10:39:46.048+01:00'}});
 const r=await appendCustomerNote(f.client,input);assert.equal(f.writes(),1);assert.equal(r.readback.other_customer_fields_preserved,true);assert.equal(f.raw.createat,null);
 const replay=await appendCustomerNote(f.client,input);assert.equal(replay.result.already_present,true);assert.equal(f.writes(),1);
});
for(const [label,created,updated]of[
 ['21ms','2025-10-29T22:53:57.899+01:00','2025-10-29T22:53:57.92+01:00'],
 ['16ms','2025-12-18T10:07:36.492+01:00','2025-12-18T10:07:36.508+01:00'],
])test(`first edit normalizes distinct legacy public timestamps (${label}) only with native createat null`,async()=>{
 const f=fixture({originalCreatedAt:created,originalUpdatedAt:updated,publicTimestamps:{created:'2026-11-04T11:34:08.035+01:00',updated:'2026-11-04T11:34:08.035+01:00'}});
 const out=await appendCustomerNote(f.client,input);assert.equal(out.result.appended,true);assert.equal(out.readback.other_customer_fields_preserved,true);assert.equal(f.raw.createat,null);assert.equal(f.writes(),1);
 const replay=await appendCustomerNote(f.client,input);assert.equal(replay.result.already_present,true);assert.equal(f.writes(),1);
});
test('a real created timestamp change, broken alias, invalid alias or public business mutation remains uncertain',async()=>{
 for(const options of [
  {publicTimestamps:{created:'2026-11-04T10:39:46.048+01:00',updated:'2026-11-04T10:40:46.048+01:00'}},
  {publicTimestamps:{created:'not-a-date',updated:'not-a-date'}},
  {nativeCreatedAt:'2026-09-01T00:00:00Z',originalCreatedAt:'2026-09-01T00:00:00Z',publicTimestamps:{created:'2026-11-04T10:39:46.048+01:00',updated:'2026-11-04T10:39:46.048+01:00'}},
  {originalCreatedAt:'not-a-date',publicTimestamps:{created:'2026-11-04T10:39:46.048+01:00',updated:'2026-11-04T10:39:46.048+01:00'}},
  {publicTimestamps:{created:'2026-09-01T00:00:00Z',updated:'2026-09-01T00:00:00Z'}},
  {originalCreatedAt:'2026-10-02T00:00:00Z',originalUpdatedAt:'2026-10-01T00:00:00Z',publicTimestamps:{created:'2026-11-04T10:39:46.048+01:00',updated:'2026-11-04T10:39:46.048+01:00'}},
  {publicPhoneChange:true,publicTimestamps:{created:'2026-11-04T10:39:46.048+01:00',updated:'2026-11-04T10:39:46.048+01:00'}},
  {originalCreatedAt:'2025-10-29T22:53:57.899+01:00',originalUpdatedAt:'2025-10-29T22:53:57.92+01:00',publicPhoneChange:true,publicTimestamps:{created:'2026-11-04T10:39:46.048+01:00',updated:'2026-11-04T10:39:46.048+01:00'}},
 ]){const f=fixture(options);await assert.rejects(appendCustomerNote(f.client,input),e=>e.outcomeUncertain===true&&/public customer fields changed/.test(e.message));assert.equal(f.writes(),1);}
});
test('public timestamp alias never hides a changed native creation field',async()=>{
 const f=fixture({originalCreatedAt:'2025-10-29T22:53:57.899+01:00',originalUpdatedAt:'2025-10-29T22:53:57.92+01:00',mutateNativeCreatedAt:true,publicTimestamps:{created:'2026-11-04T10:39:46.048+01:00',updated:'2026-11-04T10:39:46.048+01:00'}});
 await assert.rejects(appendCustomerNote(f.client,input),e=>e.outcomeUncertain===true&&/other customer fields readback mismatch/.test(e.message));assert.equal(f.writes(),1);
});
test('concurrent human changes abort before writing',async()=>{const f=fixture({concurrent:true});await assert.rejects(appendCustomerNote(f.client,input),/changed concurrently/);assert.equal(f.writes(),0);});
test('foreign/scoped identity mismatch aborts before writing',async()=>{const f=fixture({identityMismatch:true});await assert.rejects(appendCustomerNote(f.client,input),/identity mismatch/);assert.equal(f.writes(),0);});
test('unknown fields and replacement requests are rejected before dispatch',()=>{for(const bad of [{...input,host:'evil'},{customerId:12,body:{note:'x',remarks:'replace'}},{customerId:'12',body:{note:'x'}},{customerId:12,body:{note:''}},{customerId:12,body:{note:'a\0b'}}])assert.throws(()=>validateCustomerNoteRequest(bad),/expected customerId/);});
test('a postwrite mutation or readback failure is uncertain and never retried',async()=>{for(const opts of [{mutateAfterWrite:true},{readbackStatus:404},{lostResponse:true}]){const f=fixture(opts);await assert.rejects(appendCustomerNote(f.client,input),e=>e.outcomeUncertain===true);assert.equal(f.writes(),1);}});
test('explicit write403 is denied, without claiming uncertain success',async()=>{const f=fixture({writeStatus:403});await assert.rejects(appendCustomerNote(f.client,input),e=>e.status===403&&!e.outcomeUncertain);assert.equal(f.writes(),1);});
test('host mismatch is rejected, including the read projection',async()=>{const f=fixture();f.client.host='https://another.sibema.es';await assert.rejects(readCustomerNotes(f.client,12),/unexpected tenant/);assert.equal(f.writes(),0);});
test('read notes is scoped and discoverable without making a write',async()=>{const f=fixture({remarks:'Original note'});const r=await readApi(f.client,{path:'/customers/12/notes'});assert.equal(r.data.remarks,'Original note');assert.equal((await readApi(f.client,{method:'GET',path:'/customers/12/notes',query:{}})).data.remarks,'Original note');assert.equal(f.writes(),0);assert.match(discover().integrationExtensions.customerNotes,/append_customer_note/);assert.equal(schemaFor('GET','/customers/{id}/notes').integrationProjection,true);await assert.rejects(readApi(f.client,{path:'/customers/12/notes',query:{customer_id:999}}),/without query/);});
test('ordinary durable action dispatch reaches the narrow adapter',async()=>{const f=fixture();const action=validateAction({id:'synthetic-customer-note',type:'append_customer_note',requestedBy:'Trini',request:input});const r=await executeAction(f.client,action);assert.equal(r.readback.customer_id,12);assert.equal(f.writes(),1);assert.throws(()=>validateAction({...action,requestedBy:'Tristan'}),/accounting entries only/);});
