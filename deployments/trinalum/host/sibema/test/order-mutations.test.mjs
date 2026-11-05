import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir as nativeTmpdir} from 'node:os';
import {realpathSync as canonicalTmpPath} from 'node:fs';
const tmpdir=()=>canonicalTmpPath(nativeTmpdir());
import {join} from 'node:path';
import {validateAction,operationFor} from '../bin/sibema-action.mjs';
import {validateOrderMutation,assertOrderUnchanged,verifyOrderMutation,executeOrderMutation,mutationIdempotencyKey} from '../lib/order-mutations.mjs';
import {SibemaStore} from '../lib/store.mjs';
import {SibemaClient} from '../lib/sibema-client.mjs';
const base={order_id:153,customer_id:42,reference:'contract-153',lines:[{line_id:981,product_id:7,description:'Lingote',quantity:100000,final_quantity:100000,unit_id:1,unit_price:2.45,discount:0,vat_rate:21}]};
const clone=x=>structuredClone(x);
test('native nullable final quantity is unresolved and rejects before any provider write',async()=>{
 const a=action(); a.request.expectedOrder.lines[0].final_quantity=null;
 let reads=0,writes=0;
 await assert.rejects(executeOrderMutation({getObject:async()=>{reads++;return clone(a.request.expectedOrder);},write:async()=>{writes++;}},a,{method:'POST',path:'/orders/153/deliveries',body:a.request.body}),/ORDER_FINAL_QUANTITY_MISSING/);
 assert.equal(writes,0);assert.equal(reads,1);
});
test('metadata PATCH executes once and preserves explicit native null kilos in untouched lines',async()=>{
 const a=action();a.type='update_order';a.request.expectedOrder.lines[0].final_quantity=null;
 a.request.expectedOrder.lines.push({...clone(base.lines[0]),line_id:982});
 a.request.body={remarks:'Verified invoice details',lines:[{line_id:981,remarks:'Original invoice reference'}]};
 const after=clone(a.request.expectedOrder);after.remarks=a.request.body.remarks;after.lines[0].remarks=a.request.body.lines[0].remarks;
 let reads=0,writes=0;
 const out=await executeOrderMutation({getObject:async()=>++reads===1?clone(a.request.expectedOrder):clone(after),write:async(path,options)=>{writes++;assert.equal(path,'/orders/153');assert.deepEqual(options.body,a.request.body);return clone(after);}},a,operationFor(a));
 assert.equal(writes,1);assert.equal(reads,2);assert.equal(out.readback.lines[0].final_quantity,null);assert.deepEqual(out.readback.lines[1],a.request.expectedOrder.lines[1]);
});
test('metadata PATCH does not fill missing quantities or accept a concurrent null-to-number change',async()=>{
 const a=action();a.type='update_order';a.request.body={remarks:'Verified invoice details'};
 delete a.request.expectedOrder.lines[0].final_quantity;
 assert.throws(()=>validateOrderMutation(a),/FINAL_QUANTITY/);
 a.request.expectedOrder.lines[0].final_quantity=null;
 const changed=clone(a.request.expectedOrder);changed.lines[0].final_quantity=0;
 let writes=0;
 await assert.rejects(executeOrderMutation({getObject:async()=>changed,write:async()=>{writes++;}},a,operationFor(a)),/ORDER_CHANGED/);
 assert.equal(writes,0);
});
test('metadata PATCH rejects provider quantity coercion after write as uncertain without a retry',async()=>{
 const a=action();a.type='update_order';a.request.body={remarks:'Verified invoice details'};a.request.expectedOrder.lines[0].final_quantity=null;
 const after={...clone(a.request.expectedOrder),remarks:a.request.body.remarks};after.lines[0].final_quantity=0;
 let reads=0,writes=0;
 await assert.rejects(executeOrderMutation({getObject:async()=>++reads===1?clone(a.request.expectedOrder):clone(after),write:async()=>{writes++;return clone(after);}},a,operationFor(a)),error=>error.outcomeUncertain===true);
 assert.equal(writes,1);assert.equal(reads,2);
});
test('any unresolved native quantity still blocks quantity, price, unit, product, addition or deletion PATCHes',()=>{
 for(const line of [{line_id:981,quantity:120000},{line_id:981,final_quantity:100000},{line_id:981,unit_price:3},{line_id:981,unit_id:2},{line_id:981,product_id:8},{line_id:981,delete:true},{product_id:7,quantity:1}]){
  const a=action();a.type='update_order';a.request.expectedOrder.lines[0].final_quantity=null;a.request.body={lines:[line]};
  assert.throws(()=>operationFor(a),/FINAL_QUANTITY/);
 }
});
const action=()=>({id:'web-'+'a'.repeat(64),type:'record_order_delivery',requestedBy:'Trini',request:{orderId:153,expectedOrder:clone(base),body:{date:'2026-10-15',reference:'ANL 4711',lines:[{line_id:981,quantity:24000}]}}});
function delivered(input=action(),lineId=994){const before=clone(input.request.expectedOrder), body=input.request.body; for(const change of body.lines){const old=before.lines.find(l=>l.line_id===change.line_id),fresh={...old,line_id:lineId++,quantity:change.quantity,final_quantity:change.quantity,delivery_date:body.date,remarks:body.reference};old.quantity-=change.quantity;old.final_quantity-=change.quantity;before.lines.push(fresh);} return before;}
test('exact v1.2 delivery route and valid approved payload',()=>{const a=validateAction(action()); assert.deepEqual(operationFor(a),{method:'POST',path:'/orders/153/deliveries',body:a.request.body}); assert.equal(a.requestedBy,'Trini');});
test('100000 to 76000 plus 24000 retains all economic fields and total',()=>{const a=action(),after=delivered(a); assert.deepEqual(verifyOrderMutation(a,after,clone(after)),after); assert.equal(after.lines.reduce((s,l)=>s+l.quantity,0),100000);});
test('subsequent ANL preserves earlier delivery line and complete order',()=>{const a=action(); a.request.expectedOrder=delivered(a); a.request.body.reference='ANL 4712'; a.request.body.lines[0].quantity=20000; const after=delivered(a,995); assert.equal(after.lines[0].quantity,56000);assert.deepEqual(after.lines[1],a.request.expectedOrder.lines[1]);verifyOrderMutation(a,after,clone(after));});
test('documented overdelivery keeps a negative remainder, not contract inflation',()=>{const a=action();a.request.body.lines[0].quantity=124000;const after=delivered(a);assert.equal(after.lines[0].quantity,-24000);verifyOrderMutation(a,after,clone(after));});
test('multi-line delivery matches each product, preserves independent quantities',()=>{const a=action();a.request.expectedOrder.lines.push({...base.lines[0],line_id:982,product_id:8,quantity:30000,final_quantity:30000});a.request.body.lines.push({line_id:982,quantity:5000});verifyOrderMutation(a,delivered(a),delivered(a));});
test('rejects non-native IDs, unknown fields, invalid dates, duplicates and non-positive kilos',()=>{const cases=[a=>a.request.body.lines[0].line_id='981',a=>a.request.orderId=true,a=>a.request.body.date='2026-02-30',a=>a.request.body.reference='',a=>a.request.body.reference='a'.repeat(256),a=>a.request.body.lines[0].quantity='24000',a=>a.request.body.lines[0].quantity=0,a=>a.request.body.lines[0].quantity=-1,a=>a.request.body.lines[0].quantity=Infinity,a=>a.request.body.lines[0].received_quantity=24000,a=>a.request.body.lines.push(clone(a.request.body.lines[0])),a=>a.request.body.lines[0].line_id=888,a=>a.request.expectedOrder.lines[0].remarks='ANL 123',a=>delete a.request.expectedOrder.lines[0].final_quantity,a=>a.request.expectedOrder.customer_id=undefined];for(const change of cases){const a=action();change(a);assert.throws(()=>validateOrderMutation(a));}});
test('requires complete approved order and detects native changes before write',async()=>{const a=action();for(const change of [x=>x.lines[0].quantity--,x=>x.customer_id++,x=>x.reference='other',x=>x.lines.push({...x.lines[0],line_id:555})]){const current=clone(base);change(current);let writes=0;await assert.rejects(executeOrderMutation({getObject:async()=>current,write:async()=>{writes++;}},a,operationFor(a)),/ORDER_CHANGED/);assert.equal(writes,0);}assertOrderUnchanged(a,clone(base));});
test('refuses changed totals, price, ANL, date, previous lines, identity and inconsistent HTTP readback',()=>{const a=action();for(const change of [x=>x.lines[0].quantity++,x=>x.lines[1].unit_price++,x=>x.lines[1].remarks='other',x=>x.lines[1].delivery_date='2026-10-16',x=>x.lines[1].final_quantity--,x=>x.customer_id++,x=>x.lines.pop(),x=>x.lines.push({...x.lines[0],line_id:999})]){const after=delivered(a);change(after);assert.throws(()=>verifyOrderMutation(a,after,clone(after)));}assert.throws(()=>verifyOrderMutation(a,delivered(a),base),/differs/);});
test('UUID per native order and ANL is stable across action retry envelopes',()=>{const a=action(),key=mutationIdempotencyKey(a);assert.match(key,/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);a.id='different-approval-id';a.request.body.lines[0].quantity=25000;assert.equal(mutationIdempotencyKey(a),key);a.request.body.reference='anl  4711';assert.equal(mutationIdempotencyKey(a),key);a.request.body.reference='ANL 4712';assert.notEqual(mutationIdempotencyKey(a),key);});
test('real HTTP client mock sends one UUID-keyed write, then independent GET',async()=>{const a=action(),after=delivered(a),calls=[];const client=new SibemaClient({username:'synthetic',password:'synthetic',fetchImpl:async(url,init={})=>{calls.push({url,init});if(url.endsWith('/authenticate'))return Response.json({token:'synthetic-token'});return Response.json(init.method==='POST'?after:calls.filter(c=>c.init.method!=='POST').length===1?base:after);}});const result=await executeOrderMutation(client,a,operationFor(a));assert.deepEqual(result.readback,after);const writes=calls.filter(c=>c.url.endsWith('/deliveries'));assert.equal(writes.length,1);assert.equal(writes[0].init.headers['Idempotency-Key'],mutationIdempotencyKey(a));assert.deepEqual(JSON.parse(writes[0].init.body),a.request.body);assert.equal(calls.filter(c=>c.url.endsWith('/orders/153')).length,2);});
test('atomic 422 is not treated as an uncertain write and never readback/retries',async()=>{const a=action();let reads=0,writes=0;await assert.rejects(executeOrderMutation({getObject:async()=>{reads++;return base;},write:async()=>{writes++;throw Object.assign(new Error('validation'),{status:422});}},a,operationFor(a)),e=>e.status===422&&!e.outcomeUncertain);assert.equal(reads,1);assert.equal(writes,1);});
test('network loss or readback mismatch is uncertain and never blindly retries',async()=>{const a=action();for(const write of [async()=>{throw new TypeError('network');},async()=>delivered(a)]){let writes=0;await assert.rejects(executeOrderMutation({getObject:async()=>clone(base),write:async()=>{writes++;return write();}},a,operationFor(a)),e=>e.outcomeUncertain===true);assert.equal(writes,1);}});
test('uncertain durable action cannot be approved or executed again; exact content immutable',async()=>{const dir=await mkdtemp(join(tmpdir(),'sibema-uncertain-'));const store=new SibemaStore(join(dir,'test.sqlite'));try{const a=action();store.prepareApprovedAction(a);store.approveAction(a.id,'Trini');assert.equal(store.claimApprovedAction(a.id),true);store.failApprovedAction(a.id,Object.assign(new Error('readback unavailable'),{outcomeUncertain:true}));assert.equal(store.approvedAction(a.id).status,'uncertain');assert.throws(()=>store.approveAction(a.id,'Trini'),/not ready/);assert.equal(store.claimApprovedAction(a.id),false);a.request.body.lines[0].quantity++;assert.throws(()=>store.prepareApprovedAction(a),/different exact content/);}finally{store.close();await rm(dir,{recursive:true,force:true});}});
test('atomic PATCH undo restores pending and removes only its delivery line',()=>{const a=action();a.type='update_order';a.request.expectedOrder=delivered(action());a.request.body={lines:[{line_id:981,quantity:100000,final_quantity:100000},{line_id:994,delete:true}]};assert.deepEqual(operationFor(a),{method:'PATCH',path:'/orders/153',body:a.request.body});verifyOrderMutation(a,clone(base),clone(base));const wrong=clone(base);wrong.lines.push({...base.lines[0],line_id:994});assert.throws(()=>verifyOrderMutation(a,wrong,wrong));});
test('sparse PATCH preserves all untouched lines, validates scalar changes and new lines',()=>{const a=action();a.type='update_order';a.request.body={reference:'revised',lines:[{line_id:981,quantity:120000}]};const after=clone(base);after.reference='revised';after.lines[0].quantity=120000;verifyOrderMutation(a,after,clone(after));for(const body of [{lines:[{line_id:981}]},{lines:[{line_id:999,quantity:1}]},{lines:[{delete:true}]},{lines:[{line_id:981,delete:true,quantity:1}]},{payment_method_id:0},{lines:[]},{unknown:true},{lines:[{product_id:7}]},{remarks:null}]){a.request.body=body;assert.throws(()=>validateOrderMutation(a));}});

test('v1.2 jwttoken and existing token auth formats are supported without accepting ambiguity',async()=>{
 for(const body of [{jwttoken:'v1.2-token'},{token:'legacy-token'}]) {
  const client=new SibemaClient({username:'synthetic',password:'synthetic',fetchImpl:async()=>Response.json(body)});
  await client.authenticate();assert.equal(client.token,body.jwttoken??body.token);
 }
 for(const body of [{jwttoken:''},{jwttoken:'one',token:'other'}]) {
  const client=new SibemaClient({username:'synthetic',password:'synthetic',fetchImpl:async()=>Response.json(body)});
  await assert.rejects(client.authenticate(),/authentication failed/);
 }
});

test('a previous ANL in the approved order blocks a second proposal even with a fresh action ID',()=>{
 const a=action();a.request.expectedOrder=delivered(a);a.id='new-approval-id';
 a.request.body.reference='anl  4711';assert.throws(()=>validateOrderMutation(a),/ANL_ALREADY_RECORDED/);
});

for(const type of ['record_order_delivery','update_order']) for(const status of [400,401,404,422]) {
 test(`${type}: readback ${status} after successful write is uncertain and not repeated`,async()=>{
  const a=action(); a.type=type;
  if(type==='update_order') a.request.body={remarks:'Verified exact change'};
  const result=type==='record_order_delivery'?delivered(a):{...clone(base),remarks:a.request.body.remarks};
  let reads=0,writes=0;
  await assert.rejects(executeOrderMutation({
   getObject:async()=>{reads++;if(reads===1)return clone(base);throw Object.assign(new Error('readback failed'),{status});},
   write:async()=>{writes++;return result;},
  },a,operationFor(a)),error=>error.status===status && error.outcomeUncertain===true);
  assert.equal(reads,2);assert.equal(writes,1);
 });
}

test('documented condition IDs allow only their own label change and report unavailable ID readback explicitly',async()=>{
 const a=action();a.type='update_order';a.request.body={payment_method_id:3,incoterm_id:4,vendor_id:5};
 const after={...clone(base),payment_method:'Provider payment label',incoterm:'Provider incoterm label',vendor:'Provider vendor label'};
 assert.equal(validateOrderMutation(a).order_id,153);assert.deepEqual(verifyOrderMutation(a,after,clone(after)),after);
 const otherConditions=clone(a);delete otherConditions.request.body.payment_method_id;const out=await executeOrderMutation({getObject:async()=>clone(after),write:async()=>clone(after)}, {...otherConditions,request:{...otherConditions.request,expectedOrder:clone(after)}},operationFor(otherConditions));
 assert.deepEqual(out.readback.verification.unverifiable_fields,['incoterm_id','vendor_id']);assert.equal(out.readback.verification.provider_echoes_ids,false);assert.equal(out.readback.verification.other_fields_verified,true);
 for(const field of ['reference','customer_id']){const wrong=clone(after);wrong[field]=field==='customer_id'?99:'changed';assert.throws(()=>verifyOrderMutation(a,wrong,wrong));}
 const wrong=clone(after);wrong.lines[0].unit_price++;assert.throws(()=>verifyOrderMutation(a,wrong,wrong));
 const onlyPayment=clone(a);onlyPayment.request.body={payment_method_id:3};const unrelated=clone(base);unrelated.incoterm='UNREQUESTED';assert.throws(()=>verifyOrderMutation(onlyPayment,unrelated,unrelated));
});
