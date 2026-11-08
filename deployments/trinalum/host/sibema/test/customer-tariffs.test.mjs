import test from 'node:test';
import assert from 'node:assert/strict';
import {readCustomerTariffs,saveCustomerTariff,validateCustomerTariffRequest} from '../lib/customer-tariffs.mjs';
import {readApi} from '../lib/api-request.mjs';
import {discover,schemaFor} from '../lib/api-contract.mjs';
import {validateAction,executeAction} from '../bin/sibema-action.mjs';
import {actionFor,commandFor,connectorFailure} from '../../../../../infra/trinalum/connector-broker.mjs';
const customer={branch:null,customerid:12,customer:'Synthetic customer',idcardnumber:'B12345678',accountid:{password:'secret-sentinel',twofactor:'secret-sentinel'}};
const product={branch:null,productid:13,product:'Alumina',active:true,movementunitid:{movementunitid:2,movementunit:'KG'}};
const input={customerId:12,body:{product_id:13,reference:'NABALOX NO 325 Big Bags',valid_from:'2027-01-01',price:1040,price_basis:'EUR/t'}};
const row=(patch={})=>({branch:null,customerproductid:124,customerproduct:input.body.reference,customerid:customer,productid:product,saleorderid:null,taskid:null,since:'2025-12-31T23:00:00.000+00:00',until:'2026-12-30T23:00:00.000+00:00',fromquantity:500,toquantity:500000,price:1000,cost:null,remarks:'2026 original',...patch});
function fixture(initial=[],patch={}){
 const state={rows:structuredClone(initial),writes:[],calls:[],...patch};
 const client={host:'https://erp.example.invalid',token:'synthetic',tokenExpiresAt:Date.now()+3600000,getObject:async(resource,id)=>{assert.equal(resource,'customers');assert.equal(id,12);return {customer_id:12,name:customer.customer,vat_number:customer.idcardnumber};},fetchImpl:async(url,init)=>{
  const path=new URL(url).pathname.replace('/ERPBerma','');state.calls.push({path,method:init.method});
  assert.equal(init.redirect,'error');
  if(path==='/rest/customer/12')return Response.json(customer);
  if(path==='/rest/product/13')return Response.json(product);
  if(path==='/rest/getByQuery'){const q=JSON.parse(init.body);assert.deepEqual(q,{clazz:'customerproduct',items:[{field:'customerid',operator:'OPERATOR_EQUAL',value:customer}]});if(state.queryHook)state.queryHook(state);return Response.json(state.rows);}
  if(path==='/rest/customerproduct/update'){
   const body=JSON.parse(init.body);state.writes.push(body);
   if(state.writeFailure)throw new TypeError('connection lost');
   const saved={...body,customerproductid:body.customerproductid??900};
   if(state.corruptReadback)saved.price=0;
   const i=state.rows.findIndex(r=>r.customerproductid===saved.customerproductid);if(i>=0)state.rows[i]=saved;else state.rows.push(saved);
   return Response.json(saved);
  }
  throw Error('unexpected route');
 }};
 return {client,state};
}
test('creates the customer Tarifa with literal EUR/t, Madrid date and no invented bounds/end; preserves2026',async()=>{
 const historical=row(),f=fixture([historical]);const result=await saveCustomerTariff(f.client,input);
 assert.equal(f.state.writes.length,1);const written=f.state.writes[0];assert.equal(written.price,1040);assert.equal(written.since,'2026-12-31T23:00:00.000+00:00');assert.equal(written.until,null);assert.equal(written.fromquantity,null);assert.equal(written.toquantity,null);assert.equal(written.remarks,'Unidad precio: EUR/t.');assert.ok(!Object.hasOwn(written,'customerproductid'));assert.deepEqual(f.state.rows[0],historical);assert.equal(result.readback.destination,'CRM Tarifa');assert.equal(result.readback.valid_from,'2027-01-01');assert.ok(!JSON.stringify(result).includes('secret-sentinel'));assert.ok(!f.state.calls.some(c=>c.path.includes('offer')));
});
test('read projection and legacy-facing contract return only sanitized rows',async()=>{
 const f=fixture([row()]);const result=await readApi(f.client,{path:'/customers/12/tariffs'});
 assert.equal(result.data.tariffs[0].tariff_id,124);assert.ok(!JSON.stringify(result).includes('secret-sentinel'));assert.ok(discover().integrationExtensions.customerTariffs.includes('create_customer_tariff'));assert.equal(schemaFor('GET','/customers/{id}/tariffs').integrationProjection,true);
 await assert.rejects(readApi(f.client,{path:'/customers/12/tariffs',query:{customer_id:99}}));
});
test('exact existing2027 row is reused; different price cannot silently overwrite',async()=>{
 const f=fixture();await saveCustomerTariff(f.client,input);const result=await saveCustomerTariff(f.client,input);assert.equal(result.result.already_present,true);assert.equal(f.state.writes.length,1);
 await assert.rejects(saveCustomerTariff(f.client,{...input,body:{...input.body,price:1041}}),/different values/);assert.equal(f.state.writes.length,1);
});
test('guarded update preserves other historical rows, costs and links; stale preview refuses write',async()=>{
 const f=fixture([row(),row({customerproductid:125,customerproduct:'Another grade',cost:200,saleorderid:{saleorderid:77},taskid:{taskid:88}})]);
 const before=(await readCustomerTariffs(f.client,12)).tariffs[1],request={customerId:12,tariffId:125,expectedTariff:before,body:{...input.body,reference:'Another grade',price:1100}};
 const value=await saveCustomerTariff(f.client,request,{update:true});assert.equal(value.readback.cost,200);assert.equal(value.readback.sale_order_id,77);assert.equal(value.readback.task_id,88);assert.equal(f.state.rows[0].remarks,'2026 original');
 await assert.rejects(saveCustomerTariff(f.client,request,{update:true}),/changed since preview/);assert.equal(f.state.writes.length,1);
});
test('duplicates, foreign customers, schema drift and concurrent changes fail before write',async()=>{
 const exact=row({since:'2026-12-31T23:00:00.000+00:00',until:null,fromquantity:null,toquantity:null,price:1040,remarks:'Unidad precio: EUR/t.'});
 for(const data of [[exact,{...exact,customerproductid:125}],[row({customerid:{customerid:99}})],[row({unexpected:true})]]){
  const f=fixture(data);await assert.rejects(saveCustomerTariff(f.client,input));assert.equal(f.state.writes.length,0);
 }
 let queries=0;const f=fixture([row()],{queryHook:s=>{if(++queries===2)s.rows[0].price=2000;}});await assert.rejects(saveCustomerTariff(f.client,input),/changed concurrently/);assert.equal(f.state.writes.length,0);
});
test('network uncertainty and failed independent readback never return a successful tariff',async()=>{
 for(const patch of [{writeFailure:true},{corruptReadback:true}]){const f=fixture([],patch);await assert.rejects(saveCustomerTariff(f.client,input),error=>error.outcomeUncertain===true);assert.equal(f.state.writes.length,1);}
});
test('input rejects undocumented keys, price coercion, bad dates, missing units and inverted ranges',()=>{
 for(const body of [{...input.body,price:'1040'},{...input.body,valid_until:'2027-02-30'},{...input.body,price_basis:undefined},{...input.body,quantity_from:100,quantity_until:1},{...input.body,filename:'tariff.pdf'}])assert.throws(()=>validateCustomerTariffRequest({...input,body}));
});
test('real employee broker and durable action dispatch reach tariff adapter while Tristan remains denied',async()=>{
 const binding=owner=>({installationId:'trinalum-production',owner,userId:'11111111-1111-4111-8111-111111111111',status:'active',operations:['sibema_action','sibema_api']});
 for(const owner of ['trini','miguel','nerea']){const action=validateAction(actionFor(binding(owner),'sibema_action',{type:'create_customer_tariff',request:input},'web-'+'a'.repeat(64)));const f=fixture();assert.equal((await executeAction(f.client,action)).readback.tariff_id,900);const [cli,args]=commandFor(binding(owner),'sibema_api',{command:'read',method:'GET',path:'/customers/12/tariffs'});assert.equal(cli,'/opt/trinalum/bin/trinalum-sibema-api');assert.equal(JSON.parse(args.at(-1)).path,'/customers/12/tariffs');}
 assert.throws(()=>actionFor(binding('tristan'),'sibema_action',{type:'create_customer_tariff',request:input},'web-'+'a'.repeat(64)),/ACCESS_DENIED/);
});

test('nullable readback fields roundtrip through create and guarded update without changing their meaning',async()=>{
 const f=fixture([row()]);const nullable={...input,body:{...input.body,valid_until:null,quantity_from:null,quantity_until:null}};
 const created=await saveCustomerTariff(f.client,nullable);
 const previous=(await readCustomerTariffs(f.client,12)).tariffs.find(t=>t.tariff_id===created.result.tariff_id);
 const notes=previous.remarks+' Plastic tax: synthetic source detail.';
 const updated=await saveCustomerTariff(f.client,{...nullable,tariffId:previous.tariff_id,expectedTariff:previous,body:{...nullable.body,remarks:notes}},{update:true});
 assert.equal(updated.readback.remarks,notes);assert.equal(updated.readback.valid_until,null);assert.equal(updated.readback.quantity_from,null);assert.equal(updated.readback.quantity_until,null);assert.equal(f.state.rows[0].remarks,'2026 original');assert.equal(updated.readback.remarks.split('Unidad precio:').length-1,1);
 const noDates=fixture();await saveCustomerTariff(noDates.client,{...input,body:{...input.body,valid_from:null,valid_until:null}});assert.equal(noDates.state.writes[0].since,null);
});
test('existing prefixed notes fit the exact limit once; overlength is typed, preserves original and performs zero network',async()=>{
 const prefix='Unidad precio: EUR/t. ',notes=prefix+'a'.repeat(255-prefix.length),f=fixture();
 const complete=await saveCustomerTariff(f.client,{...input,body:{...input.body,remarks:notes}});assert.equal(complete.readback.remarks,notes);assert.equal(f.state.writes.length,1);
 const rejected=fixture();for(const length of [256,289]){
  await assert.rejects(saveCustomerTariff(rejected.client,{...input,body:{...input.body,remarks:prefix+'a'.repeat(length-prefix.length)}}),error=>error.code==='SIBEMA_TARIFF_REMARKS_TOO_LONG');
 }
 assert.equal(rejected.state.writes.length,0);assert.equal(rejected.state.calls.length,0);
 const malformed=structuredClone(input);malformed.body.quantity_from=-1;
 assert.throws(()=>validateCustomerTariffRequest(malformed),error=>error.code==='SIBEMA_TARIFF_INVALID_ARGUMENTS');
 assert.throws(()=>validateCustomerTariffRequest({...input,body:{...input.body,remarks:'Unidad precio: EUR/kg. Prior note'}}),error=>error.code==='SIBEMA_TARIFF_INVALID_ARGUMENTS');
});


test('omitted or null scope cannot create a duplicate beside an existing scoped tariff',async()=>{
 for(const body of [
  {product_id:13,reference:input.body.reference,price:3.89,price_basis:'EUR/kg'},
  {product_id:13,reference:input.body.reference,valid_from:null,valid_until:null,quantity_from:null,quantity_until:null,price:3.89,price_basis:'EUR/kg'},
  {...input.body,valid_from:'2026-01-01'},
 ]){
  const existing=row(),f=fixture([existing]);
  await assert.rejects(saveCustomerTariff(f.client,{customerId:12,body}),error=>{
   assert.equal(error.code,'SIBEMA_TARIFF_SCOPE_AMBIGUOUS');assert.equal(error.status,409);
   assert.equal(error.outcomeUncertain,undefined);assert.equal(error.candidateTariffs[0].tariff_id,124);
   assert.equal(error.candidateTariffs[0].price,1000);assert.equal(error.candidateTariffs[0].remarks,'2026 original');
   assert.ok(!JSON.stringify(error.candidateTariffs).includes('secret-sentinel'));return true;
  });
  assert.equal(f.state.writes.length,0);assert.deepEqual(f.state.rows,[existing]);
 }
});
test('explicit distinct validity and quantity bands remain creatable and repeat without duplicates',async()=>{
 for(const body of [
  {...input.body,valid_from:'2027-01-01'},
  {...input.body,valid_from:'2026-01-01',valid_until:'2026-12-31',quantity_from:500001,quantity_until:600000},
  {...input.body,valid_from:'2025-01-01',valid_until:'2025-12-31'},
 ]){
  const existing=row(),f=fixture([existing]);
  const created=await saveCustomerTariff(f.client,{customerId:12,body});
  assert.equal(created.result.created,true);assert.deepEqual(f.state.rows[0],existing);
  const repeated=await saveCustomerTariff(f.client,{customerId:12,body});
  assert.equal(repeated.result.already_present,true);assert.equal(f.state.writes.length,1);
 }
});
test('guarded update of an existing scoped tariff remains available after an ambiguous create',async()=>{
 const f=fixture([row()]);
 const previous=(await readCustomerTariffs(f.client,12)).tariffs[0];
 const {product_id,reference,valid_from,valid_until,quantity_from,quantity_until}=previous;
 const result=await saveCustomerTariff(f.client,{customerId:12,tariffId:previous.tariff_id,expectedTariff:previous,body:{product_id,reference,valid_from,valid_until,quantity_from,quantity_until,price:3.89,price_basis:'EUR/kg',remarks:previous.remarks}},{update:true});
 assert.equal(result.result.updated,true);assert.equal(result.readback.tariff_id,previous.tariff_id);
 assert.equal(f.state.rows.length,1);assert.equal(result.readback.price,3.89);
 assert.equal(result.readback.valid_from,previous.valid_from);assert.equal(result.readback.quantity_from,500);
});

test('a shared product family does not confuse another exact grade reference with this tariff',async()=>{
 const existing=row({customerproduct:'Different source grade'}),f=fixture([existing]);
 const body={product_id:13,reference:input.body.reference,price:3.89,price_basis:'EUR/kg'};
 const saved=await saveCustomerTariff(f.client,{customerId:12,body});
 assert.equal(saved.result.created,true);assert.equal(f.state.rows.length,2);assert.deepEqual(f.state.rows[0],existing);
});

// Guarded native deletion uses the same existing approved-action surface.
{
 const {previewDeletion,executeDeletion:nativeExecuteDeletion,assertDeletionProof,readDeletionRecoverySnapshot,deletionModuleSha256}=await import('../lib/guarded-deletes.mjs');
 const {mkdtempSync,writeFileSync,rmSync,realpathSync,chmodSync,symlinkSync}=await import('node:fs'),{join}=await import('node:path'),{tmpdir}=await import('node:os'),{randomBytes}=await import('node:crypto'),{after}=await import('node:test'),{SibemaStore}=await import('../lib/store.mjs');
 const scratch=mkdtempSync(join(realpathSync(tmpdir()),'sibema-delete-proof-tests-')),stores=[];let fixtureNumber=0;
 after(()=>{for(const store of stores)store.close();rmSync(scratch,{recursive:true,force:true});});
 const executeDeletion=(client,kind,input,actor)=>nativeExecuteDeletion(client,kind,input,actor,{fence:client.deletionFence,actionId:client.deletionActionId});
 function deleteFixture(kind='tariff',options={}){
  const index=fixtureNumber++,keyFile=join(scratch,'key-'+index),fence=new SibemaStore(join(scratch,'fence-'+index+'.sqlite'));stores.push(fence);writeFileSync(keyFile,randomBytes(32),{mode:0o600});
  const customer={branch:null,customerid:42,customer:'Synthetic internal record',idcardnumber:'SYNTHETIC',private:'must-not-leak'};
  const tariff=id=>({branch:null,customerproductid:id,customerproduct:'Synthetic '+id,customerid:customer,productid:{productid:5},saleorderid:null,taskid:null,since:null,until:null,fromquantity:null,toquantity:null,price:920,cost:7,remarks:'Synthetic only'});
  const header=id=>({branch:null,customerofferid:id,customeroffer:'Synthetic '+id,customerid:customer,vendorid:null,paymentmethodid:null,incotermid:null,since:'2026-11-04',until:'2026-11-04',remarks:'Synthetic only',saleorderid:null,purchaseorderid:null});
  const state={tariffs:[tariff(7),tariff(8)],headers:[header(7),header(8)],lines:[{branch:null,customerofferdetailid:70,customerofferid:header(7),productid:{productid:5},price:0.95},{branch:null,customerofferdetailid:80,customerofferid:header(8),productid:{productid:5},price:1.5}],files:[],orders:[],calls:[],deletes:0,customerReads:0};
  const client={host:'https://erp.example.invalid',username:'synthetic-integration',password:'synthetic-ERP-password-never-signs',deletionKeyFile:keyFile,deletionFence:fence,deletionActionId:'synthetic-delete-action-'+index,token:'synthetic',tokenExpiresAt:Date.now()+600000,
   getObject:async(resource,id)=>{assert.equal(resource,'customers');assert.equal(id,42);state.customerReads++;if(options.concurrent&&state.customerReads===3)state.tariffs[1].price++;return {customer_id:42,name:customer.customer,vat_number:customer.idcardnumber};},
   get:async path=>{assert.equal(path,'/customers/42/orders?page=0&size=200');return {data:structuredClone(state.orders),page:0,size:200,total:state.orders.length,has_next:false};},
   fetchImpl:async(url,init)=>{
    const path=new URL(url).pathname.replace('/ERPBerma','');state.calls.push({path,method:init.method});assert.equal(init.redirect,'error');
    if(path==='/rest/customer/42')return Response.json(customer);
    if(path==='/rest/getByQuery'){
     assert.equal(init.method,'POST');const q=JSON.parse(init.body);assert.equal(q.items.length,1);assert.equal(q.items[0].operator,'OPERATOR_EQUAL');const parent=q.items[0].value;
     if(q.clazz==='customerproduct'){assert.equal(parent.customerid,42);return Response.json(state.tariffs);}
     if(q.clazz==='customeroffer'){assert.equal(parent.customerid,42);return Response.json(state.headers);}
     if(q.clazz==='customerofferdetail')return Response.json(state.lines.filter(x=>x.customerofferid.customerofferid===parent.customerofferid));
     if(q.clazz==='customerofferfile')return Response.json(state.files.filter(x=>x.customerofferid.customerofferid===parent.customerofferid));
     throw Error('Unknown entity');
    }
    if(path==='/rest/customerproduct/delete/7'||path==='/rest/customeroffer/delete/7'){
     assert.equal(init.method,'DELETE');state.deletes++;
     if(options.requireOfficialWire&&(init.body!=='null'||init.headers['content-type']!=='application/json'||init.headers.accept!=='application/json, text/plain, */*'))return Response.json({code:'INTERNAL'},{status:500});
     if(options.reject)return options.errorResponse?options.errorResponse():Response.json({error:'do not expose provider text'},{status:options.reject});
     if(kind==='tariff')state.tariffs=state.tariffs.filter(x=>x.customerproductid!==7);
     else {state.headers=state.headers.filter(x=>x.customerofferid!==7);if(!options.orphan)state.lines=state.lines.filter(x=>x.customerofferid.customerofferid!==7);}
     if(options.drift)state.tariffs[1-(kind==='tariff'?1:0)].price++;
     if(options.lostAck)throw new TypeError('lost delete acknowledgement');
     return new Response(null,{status:204});
    }
    throw Error('Unexpected route '+path);
   }};
  return {kind,client,state,fence,keyFile,input:{customerId:42,[kind==='tariff'?'tariffId':'offerId']:7},customer};
 }
 async function approved(f){const p=await previewDeletion(f.client,f.kind,f.input,'Nerea');return {...f.input,body:{expectedSnapshotSha256:p.expectedSnapshotSha256,proof:p.proof}};}
 test('official Axios JSON-null DELETE wire works for tariff and offer without a second request',async()=>{
  for(const kind of ['tariff','offer']){const f=deleteFixture(kind,{requireOfficialWire:true}),input=await approved(f);const r=await executeDeletion(f.client,kind,input,'Nerea');assert.equal(r.result.removed,true);assert.equal(f.state.deletes,1);assert.equal(f.fence.deletionResource({integration:f.fence.db.prepare('SELECT integration FROM deletion_resource_fences').get().integration,kind,customerId:42,targetId:7}).status,'completed');}
 });
 test('provider error evidence keeps only bounded structure; offer500 stays uncertain and fenced',async()=>{
  const f=deleteFixture('offer',{reject:500,errorResponse:()=>Response.json({code:'INTERNAL',detail:'Foreign key constraint; token=private-sentinel; SQL and customer data must never escape'},{status:500})}),input=await approved(f);
  let failure;await assert.rejects(executeDeletion(f.client,'offer',input,'Nerea'),e=>{failure=e;return e.status===500&&e.outcomeUncertain===true;});
  assert.equal(failure.providerEvidence.code,'INTERNAL');assert.equal(failure.providerEvidence.signal,'referential_integrity');assert.equal(failure.providerEvidence.complete,true);assert.match(failure.providerEvidence.bodyPrefixSha256,/^[a-f0-9]{64}$/);assert.ok(!failure.message.includes('private-sentinel'));assert.ok(!failure.message.includes('SQL and customer'));
  const row=f.fence.db.prepare('SELECT * FROM deletion_resource_fences').get();assert.equal(row.status,'uncertain');assert.equal(f.state.headers.length,2);assert.equal(f.state.lines.length,2);
  const p=await previewDeletion(f.client,'offer',f.input,'Miguel');f.client.deletionActionId+='-new-id';await assert.rejects(executeDeletion(f.client,'offer',{...f.input,body:{proof:p.proof,expectedSnapshotSha256:p.expectedSnapshotSha256}},'Miguel'),e=>e.code==='SIBEMA_DELETE_RESOURCE_FENCED');assert.equal(f.state.deletes,1);
 });
 test('oversize or unreadable provider diagnostics preserve original rejection and never expose body text',async()=>{
  for(const errorResponse of [()=>new Response('private-sentinel'.repeat(3000),{status:500}),()=>new Response(new ReadableStream({start(c){c.error(Error('private-reader-error'));}}),{status:500}),()=>Response.json({code:'PRIVATE_SECRET_SENTINEL'},{status:409})]){
   const f=deleteFixture('offer',{reject:500,errorResponse}),input=await approved(f);let failure;await assert.rejects(executeDeletion(f.client,'offer',input,'Nerea'),e=>{failure=e;return [409,500].includes(e.status);});assert.ok(failure.providerEvidence.capturedBytes<=16384);assert.equal(failure.providerEvidence.code,null);assert.ok(!failure.message.includes('private-sentinel'));assert.ok(!failure.message.includes('private-reader-error'));assert.ok(!failure.message.includes('PRIVATE_SECRET_SENTINEL'));assert.equal(f.state.deletes,1);
  }
 });
 test('reviewed recovery survives proof/snapshot failures before dispatch and permits exactly one new explicit action',async()=>{
  const {createHash}=await import('node:crypto'),digest=v=>createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])))).digest('hex');
  const options={reject:500},f=deleteFixture('offer',options),oldInput=await approved(f),s=f.fence,oldId=f.client.deletionActionId;
  s.prepareApprovedAction({id:oldId,type:'delete_offer',requestedBy:'Nerea',request:oldInput});s.approveAction(oldId,'Nerea');s.claimApprovedAction(oldId);let original;
  await assert.rejects(executeDeletion(f.client,'offer',oldInput,'Nerea'),e=>{original=e;return e.outcomeUncertain;});s.failApprovedAction(oldId,original);const old=s.approvedAction(oldId),resource={integration:s.db.prepare('SELECT integration FROM deletion_resource_fences').get().integration,kind:'offer',customerId:42,targetId:7},previous=s.deletionResource(resource);
  const input=await approved(f),nextId=oldId+'-reviewed',next=s.prepareApprovedAction({id:nextId,type:'delete_offer',requestedBy:'Nerea',request:input}),readbacks=[await readDeletionRecoverySnapshot(f.client,'offer',f.input),await readDeletionRecoverySnapshot(f.client,'offer',f.input)],now=Date.now();
  s.authorizeDeletionRecovery({...resource,grantId:'native-recovery-synthetic-grant',oldActionId:oldId,newActionId:nextId,actor:'Nerea',snapshotSha256:input.body.expectedSnapshotSha256,moduleSha256:deletionModuleSha256,newRequestHash:next.request_hash,oldFenceSha256:digest(previous),oldActionSha256:digest(old),createdAtMs:now,expiresAtMs:now+120000,readbacks,reason:'Synthetic operator-reviewed wire-contract correction'});
  f.client.deletionActionId=nextId;s.approveAction(nextId,'Nerea');s.claimApprovedAction(nextId);
  const bad={...input,body:{...input.body,proof:input.body.proof+'x'}};await assert.rejects(executeDeletion(f.client,'offer',bad,'Nerea'),/signature/);assert.equal(s.db.prepare('SELECT state FROM deletion_recovery_grants').get().state,'available');
  f.state.lines[0].price++;await assert.rejects(executeDeletion(f.client,'offer',input,'Nerea'),/snapshot changed/);assert.equal(s.db.prepare('SELECT state FROM deletion_recovery_grants').get().state,'available');assert.equal(f.state.deletes,1);f.state.lines[0].price--;
  options.reject=0;const result=await executeDeletion(f.client,'offer',input,'Nerea');s.completeApprovedAction(nextId,result.result,result.readback);assert.equal(f.state.deletes,2);assert.equal(s.approvedAction(oldId).status,'uncertain');assert.deepEqual(s.approvedAction(oldId),old);assert.equal(s.db.prepare('SELECT state FROM deletion_recovery_grants').get().state,'consumed');assert.equal(s.deletionResource(resource).status,'completed');assert.equal(s.db.prepare('SELECT COUNT(*) n FROM deletion_resource_recovery_audit').get().n,1);assert.equal(f.state.headers.length,1);assert.equal(f.state.headers[0].customerofferid,8);
 });
 test('signed deletion removes only approved tariff or offer, preserves unrelated portfolio and never deletes children',async()=>{
  for(const kind of ['tariff','offer']){const f=deleteFixture(kind),before=structuredClone(f.state),input=await approved(f),r=await executeDeletion(f.client,kind,input,'Nerea');assert.equal(r.result.removed,true);assert.equal(r.readback.other_records_preserved,true);assert.equal(r.readback.no_child_delete_dispatched,true);assert.equal(f.state.deletes,1);assert.ok(f.state.calls.filter(x=>x.method==='DELETE').every(x=>/\/(?:customerproduct|customeroffer)\/delete\/7$/.test(x.path)));assert.deepEqual(f.state.tariffs.find(x=>x.customerproductid===8),before.tariffs[1]);assert.deepEqual(f.state.headers.find(x=>x.customerofferid===8),before.headers[1]);assert.deepEqual(f.state.lines.find(x=>x.customerofferdetailid===80),before.lines[1]);assert.ok(!JSON.stringify(input).includes('must-not-leak'));}
 });
 test('deletion proof binds employee, kind, customer, target, snapshot, secret and expiry before provider access',async()=>{
  const f=deleteFixture(),input=await approved(f);f.state.calls.length=0;
  for(const [v,actor,kind]of[[input,'Miguel','tariff'],[{...input,customerId:99},'Nerea','tariff'],[{...input,tariffId:8},'Nerea','tariff'],[{...input,body:{...input.body,expectedSnapshotSha256:'0'.repeat(64)}},'Nerea','tariff'],[{...input,body:{...input.body,proof:input.body.proof+'x'}},'Nerea','tariff']])await assert.rejects(executeDeletion(f.client,kind,v,actor),/SIBEMA_DELETE/);
  assert.throws(()=>assertDeletionProof(f.client,'tariff',input,'Nerea',Date.now()+300001),/expired/);assert.doesNotThrow(()=>assertDeletionProof({...f.client,password:'changed-ERP-password'},'tariff',input,'Nerea'));const other=deleteFixture();assert.throws(()=>assertDeletionProof({...f.client,deletionKeyFile:other.keyFile},'tariff',input,'Nerea'),/signature/);assert.doesNotThrow(()=>assertDeletionProof({...f.client,username:'rotated-integration-login'},'tariff',input,'Nerea'));assert.throws(()=>assertDeletionProof({...f.client,host:'https://foreign.invalid'},'tariff',input,'Nerea'),/identity/);assert.equal(f.state.deletes,0);assert.equal(f.state.calls.length,0);
 });
 test('expected full snapshot and immediate concurrent recheck block any changed native field before delete',async()=>{
  for(const field of ['price','remarks','cost']){const f=deleteFixture(),input=await approved(f);f.state.tariffs[0][field]=field==='remarks'?'human change':23;await assert.rejects(executeDeletion(f.client,'tariff',input,'Nerea'),/snapshot changed/);assert.equal(f.state.deletes,0);}
  const parent=deleteFixture(),parentInput=await approved(parent);parent.customer.createat='native creation/version changed';await assert.rejects(executeDeletion(parent.client,'tariff',parentInput,'Nerea'),/snapshot changed/);assert.equal(parent.state.deletes,0);
  const f=deleteFixture('tariff',{concurrent:true}),input=await approved(f);await assert.rejects(executeDeletion(f.client,'tariff',input,'Nerea'),/concurrent/);assert.equal(f.state.deletes,0);
 });
 test('foreign parent, linked tariff/task, linked offers/orders and original files block deletion preview',async()=>{
  for(const change of [f=>f.state.tariffs[0].customerid={customerid:99},f=>f.state.tariffs[0].saleorderid={saleorderid:1},f=>f.state.tariffs[0].taskid={taskid:1},f=>f.state.tariffs[0].unknown='schema drift']){const f=deleteFixture();change(f);await assert.rejects(approved(f),/parent|linked|schema/);assert.equal(f.state.deletes,0);}
  for(const change of [f=>f.state.headers[0].saleorderid={saleorderid:1},f=>f.state.headers[0].purchaseorderid={purchaseorderid:1},f=>f.state.orders.push({order_id:10,customer_id:42,offer_id:7}),f=>f.state.files.push({branch:null,customerofferfileid:9,customerofferid:f.state.headers[0],filename:'original.pdf',file:'private/provider/path'})]){const f=deleteFixture('offer');change(f);await assert.rejects(approved(f),/linked|references|original files/);assert.equal(f.state.deletes,0);}
 });
 test('a provider rejection is durable rejection, not permission to delete children or another object',async()=>{
  for(const status of [400,401,403,404,409,422]){const f=deleteFixture('offer',{reject:status}),input=await approved(f);await assert.rejects(executeDeletion(f.client,'offer',input,'Nerea'),e=>e.status===status&&e.definitiveRejection===true&&!e.outcomeUncertain);assert.equal(f.state.deletes,1);assert.equal(f.state.headers.length,2);assert.equal(f.state.lines.length,2);}
 });
 test('500, lost ACK, readback drift and provider orphan children remain uncertain without another dispatch',async()=>{
  for(const [kind,options]of[['tariff',{reject:500}],['tariff',{lostAck:true}],['tariff',{drift:true}],['offer',{orphan:true}]]){const f=deleteFixture(kind,options),input=await approved(f);await assert.rejects(executeDeletion(f.client,kind,input,'Nerea'),e=>e.outcomeUncertain===true);assert.equal(f.state.deletes,1);}
 });
 test('an already absent signed target is independently observed without attributing or dispatching a deletion',async()=>{
  const f=deleteFixture(),input=await approved(f);f.state.tariffs.shift();const r=await executeDeletion(f.client,'tariff',input,'Nerea');assert.equal(r.result.removed,false);assert.equal(r.result.already_absent,true);assert.equal(r.readback.deletion_attributed,false);assert.equal(f.state.deletes,0);
 });
 test('dedicated local key fails closed for missing, short, open mode or symlink; ERP credentials cannot sign',async()=>{
  const f=deleteFixture();for(const variant of ['missing','short','mode','symlink']){
   const path=join(scratch,'invalid-key-'+variant);if(variant==='short')writeFileSync(path,randomBytes(16),{mode:0o600});if(variant==='mode')writeFileSync(path,randomBytes(32),{mode:0o644});if(variant==='symlink')symlinkSync(f.keyFile,path);
   await assert.rejects(previewDeletion({...f.client,deletionKeyFile:path},'tariff',f.input,'Nerea'),/dedicated local signing key/);
  }
  assert.equal(f.state.deletes,0);const input=await approved(f);chmodSync(f.keyFile,0o640);await assert.rejects(executeDeletion(f.client,'tariff',input,'Nerea'),/dedicated local signing key/);assert.equal(f.state.deletes,0);chmodSync(f.keyFile,0o600);
 });
 test('new preview, actor and action ID cannot repeat a resource after uncertain or rejected dispatch',async()=>{
  for(const options of [{reject:500},{reject:409}]){
   const f=deleteFixture('tariff',options),first=await approved(f);await assert.rejects(executeDeletion(f.client,'tariff',first,'Nerea'));assert.equal(f.state.deletes,1);
   const p=await previewDeletion(f.client,'tariff',f.input,'Miguel'),second={...f.input,body:{proof:p.proof,expectedSnapshotSha256:p.expectedSnapshotSha256}};f.client.deletionActionId+='-different-id';f.client.username='rotated-login';f.client.password='rotated-ERP-password';
   await assert.rejects(executeDeletion(f.client,'tariff',second,'Miguel'),e=>e.code==='SIBEMA_DELETE_RESOURCE_FENCED'&&!e.outcomeUncertain);assert.equal(f.state.deletes,1);
   const rows=f.fence.db.prepare('SELECT * FROM deletion_resource_fences').all();assert.equal(rows.length,1);assert.equal(rows[0].status,options.reject===500?'uncertain':'rejected');assert.equal(rows[0].actor,'Nerea');
  }
 });
 test('safe absence after lost acknowledgement does not attribute deletion or release the uncertain resource fence',async()=>{
  const f=deleteFixture('tariff',{lostAck:true}),input=await approved(f);await assert.rejects(executeDeletion(f.client,'tariff',input,'Nerea'),e=>e.outcomeUncertain===true);f.client.deletionActionId+='-new-absence-read';
  const result=await executeDeletion(f.client,'tariff',input,'Nerea');assert.equal(result.result.removed,false);assert.equal(result.readback.deletion_attributed,false);assert.equal(f.state.deletes,1);assert.equal(f.fence.db.prepare('SELECT status FROM deletion_resource_fences').get().status,'uncertain');
 });
 test('proven predispatch snapshot failures leave the resource unclaimed and a later fresh exact request can execute',async()=>{
  const f=deleteFixture(),input=await approved(f);f.state.tariffs[0].price++;await assert.rejects(executeDeletion(f.client,'tariff',input,'Nerea'),/snapshot changed/);assert.equal(f.fence.db.prepare('SELECT COUNT(*) n FROM deletion_resource_fences').get().n,0);
  const fresh=await approved(f);assert.equal((await executeDeletion(f.client,'tariff',fresh,'Nerea')).result.removed,true);assert.equal(f.state.deletes,1);
 });
 test('signed prepare freezes exact proof and durable completion prevents another dispatch',async()=>{
  const {SibemaStore}=await import('../lib/store.mjs'),{mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
  const f=deleteFixture(),input=await approved(f),directory=mkdtempSync(join(tmpdir(),'sibema-delete-durable-'));let store;
  try{
   const action=validateAction({id:'synthetic-signed-delete-durable',type:'delete_customer_tariff',requestedBy:'Nerea',request:input});
   assertDeletionProof(f.client,'tariff',action.request,action.requestedBy);store=new SibemaStore(join(directory,'test.sqlite'));store.prepareApprovedAction(action);store.close();store=new SibemaStore(join(directory,'test.sqlite'));
   const stored=store.approveAction(action.id,'Nerea');assert.deepEqual(JSON.parse(stored.request_json),action.request);assert.equal(store.claimApprovedAction(action.id),true);
   const result=await executeAction(f.client,action,{deletionFence:store});store.completeApprovedAction(action.id,result.result,result.readback);store.close();store=new SibemaStore(join(directory,'test.sqlite'));
   assert.equal(store.approvedAction(action.id).status,'completed');assert.equal(JSON.parse(store.approvedAction(action.id).result_json).removed,true);assert.equal(JSON.parse(store.approvedAction(action.id).readback_json).approved_snapshot_sha256,input.body.expectedSnapshotSha256);assert.equal(store.claimApprovedAction(action.id),false);assert.equal(f.state.deletes,1);
  }finally{store?.close();rmSync(directory,{recursive:true,force:true});}
 });
 test('native/broker general action interface preserves actor restrictions and rejects caller-supplied preview identity',async()=>{
  const f=deleteFixture(),input=await approved(f),binding={installationId:'trinalum-production',owner:'nerea',userId:'11111111-1111-4111-8111-111111111111',status:'active',operations:['sibema_action','sibema_api']};
  const native=validateAction({id:'synthetic-delete-action',type:'delete_customer_tariff',requestedBy:'Nerea',request:input});assert.equal((await executeAction(f.client,native,{deletionFence:f.fence})).result.removed,true);
  const args=commandFor(binding,'sibema_api',{command:'read',path:'/customers/42/tariffs/7/deletion-preview'});assert.deepEqual(args[1].slice(-2),['--actor','Nerea']);
  assert.throws(()=>commandFor(binding,'sibema_api',{command:'read',path:'/customers/42/tariffs/7/deletion-preview',actor:'Trini'}),/INVALID/);
  for(const owner of ['david','tristan'])assert.throws(()=>actionFor({...binding,owner},'sibema_action',{type:'delete_customer_tariff',request:input},'web-'+'a'.repeat(64)),/ACCESS_DENIED/);
  await assert.rejects(readApi(deleteFixture().client,{path:'/customers/42/tariffs/7/deletion-preview'}),/trusted employee/);
  const g=deleteFixture();const preview=await readApi(g.client,{path:'/customers/42/tariffs/7/deletion-preview'},{actor:'Nerea'});assert.equal(preview.data.tariff_id,7);assert.ok(preview.data.proof);assert.equal(g.state.deletes,0);
  await assert.rejects(readApi(g.client,{path:'/customers/42/tariffs/7/deletion-preview',query:{actor:'Miguel'}},{actor:'Nerea'}),/GET-only/);
  assert.deepEqual(connectorFailure({stderr:JSON.stringify({status:'error',code:'SIBEMA_DELETE_INVALID'})}),{error:'SIBEMA_API_INVALID_ARGUMENTS'});assert.deepEqual(connectorFailure({stderr:JSON.stringify({status:'error',code:'SIBEMA_DELETE_OUTCOME_UNCERTAIN'})}),{error:'CONNECTOR_UNAVAILABLE'});
  assert.equal(schemaFor('GET','/customers/{id}/tariffs/{tariffId}/deletion-preview').integrationProjection,true);assert.match(discover().integrationExtensions.guardedDeletion,/signed/);
 });
}
