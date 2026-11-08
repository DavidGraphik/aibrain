import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readOfferLine,executeOfferLineUpdate} from '../lib/offer-line-update.mjs';
import {readApi,nativeApiAction} from '../lib/api-request.mjs';
import {schemaFor,discover} from '../lib/api-contract.mjs';
import {validateAction,executeAction} from '../bin/sibema-action.mjs';
import {SibemaStore} from '../lib/store.mjs';
function fixture(options={}){
 const root=mkdtempSync(join(tmpdir(),'offer-line-'));const store=new SibemaStore(join(root,'test.sqlite'));
 const state={writes:[],header:{branch:null,customerofferid:51,customeroffer:'Synthetic quote',customerid:{customerid:17,account:{password:'NEVER COPY'}},vendorid:{vendorid:9},paymentmethodid:null,incotermid:null,since:null,until:null,remarks:'UNCHANGED',saleorderid:null,purchaseorderid:null},rows:[{customerofferdetailid:61,customerofferid:{customerofferid:51},productid:{productid:7},movementunitid:{movementunitid:2},fromquantity:null,price:1.2,customerofferdetail:'Synthetic grade A'},{customerofferdetailid:62,customerofferid:{customerofferid:51},productid:{productid:8},movementunitid:{movementunitid:2},fromquantity:12,price:2.4,customerofferdetail:'Synthetic grade B'}],lineReads:0};
 const client={host:'https://erp.example.invalid',token:'fake',tokenExpiresAt:Date.now()+600000,async fetchImpl(url,req){
  if(req.method==='PUT'){
   assert.ok(url.endsWith('/rest/customerofferdetail/update'));const body=JSON.parse(req.body);state.writes.push(body);
   if(options.rejectStatus){const status=options.rejectStatus;options.rejectStatus=null;return new Response(null,{status});}
   if(!options.noCommit){const i=state.rows.findIndex(x=>x.customerofferdetailid===body.customerofferdetailid);state.rows[i]=body;}
   if(options.corruptSibling)state.rows[1].price=999;
   if(options.timeout)throw Error('synthetic response lost');return new Response(null);
  }
  if(url.endsWith('/customerofferdetail/getAll')){state.lineReads++;if(options.concurrent&&state.lineReads===3)state.rows[1].price=5;return Response.json(state.rows);}
  const id=/\/customerofferdetail\/(\d+)$/.exec(url);if(id)return Response.json(state.rows.find(x=>x.customerofferdetailid===Number(id[1])));
  assert.ok(url.endsWith('/customeroffer/51'));if(options.readbackTimeout&&state.writes.length&&!options.readbackFailed){options.readbackFailed=true;throw Error('synthetic readback timeout');}return Response.json(state.header);
 }};
 return {client,state,store,root,cleanup(){store.close();rmSync(root,{recursive:true,force:true});}};
}
const action=body=>({id:'synthetic-line-action',requestedBy:'Trini',type:'api_request',request:{method:'PATCH',path:'/offers/51/lines/61',body}});
test('generic API projection/schema/action patches price preserving exact ID, header, siblings, unit/reference and real field encoding',async()=>{
 const f=fixture();try{
  const initial=await readApi(f.client,{method:'GET',path:'/offers/51/lines/61'},{fence:f.store});assert.equal(initial.integrationProjection,true);
  assert.equal(schemaFor('PATCH','/offers/{id}/lines/{lineId}').integrationProjection,true);assert.match(discover().integrationExtensions.existingOfferLine,/never public whole-offer PUT/);
  const prepared=validateAction(action({expectedSnapshotSha256:initial.data.expectedSnapshotSha256,price:3.6}));assert.equal(nativeApiAction(prepared).native.type,'update_offer_line');
  const result=await executeAction(f.client,prepared,{deletionFence:f.store});assert.equal(result.readback.data.line_identity_preserved,true);assert.equal(f.state.writes.length,1);
  assert.deepEqual(f.state.writes[0],{customerofferdetailid:61,customerofferid:{customerofferid:51},productid:{productid:7},movementunitid:{movementunitid:2},fromquantity:null,price:3.6,customerofferdetail:'Synthetic grade A'});
  assert.equal(f.state.rows[1].price,2.4);assert.equal(f.state.header.remarks,'UNCHANGED');assert.ok(!JSON.stringify(result).includes('password'));
  const next=await readOfferLine(f.client,51,61,{fence:f.store});await executeOfferLineUpdate(f.client,{offerId:51,lineId:61,body:{expectedSnapshotSha256:next.expectedSnapshotSha256,price:3.6}},{fence:f.store,actionId:'synthetic-no-op'});assert.equal(f.state.writes.length,1);
 }finally{f.cleanup();}
});
test('rejects wrong parent, unsupported relationship edits and stale/concurrently changed baseline before a write',async()=>{
 for(const mode of ['wrong-parent','stale','concurrent','relationship']){const f=fixture({concurrent:mode==='concurrent'});try{
  const initial=await readOfferLine(f.client,51,61,{fence:f.store});const input={offerId:51,lineId:61,body:{expectedSnapshotSha256:initial.expectedSnapshotSha256,price:3}};
  if(mode==='wrong-parent')f.state.rows[0].customerofferid.customerofferid=52;
  if(mode==='stale')f.state.header.remarks='Concurrent header edit';
  if(mode==='relationship')input.body.product_id=8;
  await assert.rejects(executeOfferLineUpdate(f.client,input,{fence:f.store,actionId:'synthetic-failure'}));assert.equal(f.state.writes.length,0);
 }finally{f.cleanup();}}
});
test('reference/quantity updates use saved native fields, while timeout is reconciled once without replay',async()=>{
 const f=fixture({timeout:true});try{const initial=await readOfferLine(f.client,51,61,{fence:f.store});const result=await executeOfferLineUpdate(f.client,{offerId:51,lineId:61,body:{expectedSnapshotSha256:initial.expectedSnapshotSha256,reference:'Synthetic grade refined',quantity_from:4}},{fence:f.store,actionId:'synthetic-timeout'});assert.equal(result.readback.line.reference,'Synthetic grade refined');assert.equal(result.readback.line.quantity_from,4);assert.equal(result.readback.line.price,1.2);assert.equal(f.state.writes.length,1);}finally{f.cleanup();}
});
test('an uncertain write or changed siblings retains the durable offer fence against additional dispatch',async()=>{
 for(const options of [{timeout:true,noCommit:true},{corruptSibling:true}]){const f=fixture(options);try{const initial=await readOfferLine(f.client,51,61,{fence:f.store});const input={offerId:51,lineId:61,body:{expectedSnapshotSha256:initial.expectedSnapshotSha256,price:5}};await assert.rejects(executeOfferLineUpdate(f.client,input,{fence:f.store,actionId:'synthetic-uncertain'}),e=>e.outcomeUncertain===true);const observed=await readOfferLine(f.client,51,61,{fence:f.store});assert.equal(observed.reconciliation.status,'unresolved');await assert.rejects(executeOfferLineUpdate(f.client,{...input,body:{...input.body,expectedSnapshotSha256:observed.expectedSnapshotSha256}},{fence:f.store,actionId:'synthetic-other-id'}),/in progress or uncertain/);assert.equal(f.state.writes.length,1);}finally{f.cleanup();}}
});
test('existing durable action identity still rejects changed requests and completed actions cannot be claimed twice',()=>{
 const f=fixture();try{const raw={id:'synthetic-idempotence',type:'api_request',requestedBy:'Trini',request:{method:'PATCH',path:'/offers/51/lines/61',body:{expectedSnapshotSha256:'a'.repeat(64),price:1}}};f.store.prepareApprovedAction(raw);f.store.approveAction(raw.id,'Trini');assert.equal(f.store.claimApprovedAction(raw.id),true);f.store.completeApprovedAction(raw.id,{ok:true},{independent_readback:true});assert.equal(f.store.claimApprovedAction(raw.id),false);assert.throws(()=>f.store.prepareApprovedAction({...raw,request:{...raw.request,body:{...raw.request.body,price:2}}}));}finally{f.cleanup();}
});

test('a lost post-commit readback is recovered by the next normal read; a following action writes once without replay',async()=>{
 const f=fixture({readbackTimeout:true});try{
  const initial=await readOfferLine(f.client,51,61,{fence:f.store});const first=validateAction(action({expectedSnapshotSha256:initial.expectedSnapshotSha256,price:4}));
  f.store.prepareApprovedAction(first);f.store.approveAction(first.id,'Trini');assert.equal(f.store.claimApprovedAction(first.id),true);
  await assert.rejects(executeAction(f.client,first,{deletionFence:f.store}),error=>{f.store.failApprovedAction(first.id,error);return error.outcomeUncertain===true;});
  assert.equal(f.store.approvedAction(first.id).status,'uncertain');assert.equal(f.state.writes.length,1);
  const current=await readApi(f.client,{method:'GET',path:'/offers/51/lines/61'},{fence:f.store});
  assert.deepEqual(current.data.reconciliation,{status:'completed',independent_readback:true,writeRepeated:false});assert.equal(f.store.approvedAction(first.id).status,'completed');assert.equal(f.state.writes.length,1);
  const next=validateAction({...action({expectedSnapshotSha256:current.data.expectedSnapshotSha256,price:5}),id:'synthetic-following-action'});
  await executeAction(f.client,next,{deletionFence:f.store});assert.equal(f.state.writes.length,2);assert.equal(f.state.rows[0].price,5);
  assert.equal(f.store.claimApprovedAction(first.id),false);
 }finally{f.cleanup();}
});
test('definitive provider rejection leaves original state and releases the line resource for a fresh action',async()=>{
 const f=fixture({rejectStatus:422});try{const initial=await readOfferLine(f.client,51,61,{fence:f.store});const input={offerId:51,lineId:61,body:{expectedSnapshotSha256:initial.expectedSnapshotSha256,price:4}};
  await assert.rejects(executeOfferLineUpdate(f.client,input,{fence:f.store,actionId:'synthetic-rejection'}),e=>e.status===422&&e.definitiveRejection===true&&e.outcomeUncertain!==true);assert.equal(f.state.rows[0].price,1.2);
  await executeOfferLineUpdate(f.client,input,{fence:f.store,actionId:'synthetic-after-reject'});assert.equal(f.state.rows[0].price,4);
 }finally{f.cleanup();}
});
test('legacy full-offer operations do not inherit the new line-only uncertainty mutex',async()=>{
 const write=async()=>({offer_id:51}),getObject=async()=>({offer_id:51,lines:[{line_id:61,price:4}]});let writes=0;
 await executeAction({write:async(...a)=>{writes++;return write(...a);},getObject},{id:'synthetic-legacy-offer',type:'update_offer',requestedBy:'Trini',request:{offerId:51,body:{lines:[{product_id:7,unit_id:2,price:4}]}}},{deletionFence:{claimOfferMutation(){throw Error('must not be called');}}});
 assert.equal(writes,1);
});
