import test from 'node:test';
import assert from 'node:assert/strict';
import {readPaymentMethods,readOrderConditions,assertPaymentConditions} from '../lib/payment-methods.mjs';
import {readApi} from '../lib/api-request.mjs';
import {legacyRead} from '../lib/legacy-read.mjs';
import {discover,schemaFor} from '../lib/api-contract.mjs';
import {executeOrderMutation} from '../lib/order-mutations.mjs';
const clone=x=>structuredClone(x);
function client({methods=[{paymentmethodid:17,paymentmethod:'Efecto 30 días',account:{password:'secret'}}],native,order,after}={}){
 const calls=[];let writes=0;const c={host:'https://erp.example.invalid',token:'synthetic',tokenExpiresAt:Date.now()+600000,
 fetchImpl:async(url,init)=>{calls.push({url,init});return Response.json(url.endsWith('/paymentmethod/getAll')?methods:typeof native==='function'?native(writes):native);},
 getObject:async()=>clone(writes?after:order),write:async()=>{writes++;return clone(after);}};
 return {c,calls,get writes(){return writes;}};
}
const condition=(id=17)=>({saleorderid:71,contractorid:{contractorid:1,account:{password:'secret'}},customerid:{customerid:92,account:{password:'secret'}},paymentmethodid:{paymentmethodid:id,paymentmethod:'Efecto 30 días',account:{password:'secret'}}});
const base={order_id:71,customer_id:92,payment_method:'Anterior',lines:Array.from({length:5},(_,i)=>({line_id:i+1,product_id:8,quantity:20+i,final_quantity:null,unit_price:2,description:`Exact source ${i}`}))};
const action=()=>({id:'synthetic',type:'update_order',request:{orderId:71,expectedOrder:clone(base),body:{payment_method_id:17}}});
test('catalogue projects only native numeric IDs and safe names; exact Unicode/space normalization',async()=>{
 const {c,calls}=client();const result=await readPaymentMethods(c,{name:'  EFECTO  30 DÍAS '});
 assert.deepEqual(result.payment_methods,[{payment_method_id:17,name:'Efecto 30 días'}]);assert(!JSON.stringify(result).includes('account'));assert(!JSON.stringify(result).includes('secret'));
 assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.redirect,'error');assert(calls[0].url.endsWith('/rest/paymentmethod/getAll'));
 await assert.rejects(readPaymentMethods(c,{name:'Efecto'}),/not found/);
});
test('ambiguous, malformed and unknown catalogue inputs fail closed without fuzzy resolution',async()=>{
 for(const methods of [[{paymentmethodid:1,paymentmethod:'A'},{paymentmethodid:2,paymentmethod:' a '}],[{paymentmethodid:'17',paymentmethod:'A'}],[{paymentmethodid:1,paymentmethod:'A\nB'}],[{paymentmethodid:1,paymentmethod:'A'},{paymentmethodid:1,paymentmethod:'A'}],{}]){
  const {c}=client({methods});await assert.rejects(readPaymentMethods(c,{name:'A'}));
 }
 const {c,calls}=client();for(const input of [{url:'https://bad'},{name:''},{name:'x'.repeat(256)},[],null])await assert.rejects(readPaymentMethods(c,input));assert.equal(calls.length,0);
});
test('fixed tenant, route and byte limits; no arbitrary methods or arguments',async()=>{
 const {c,calls}=client();c.host='https://example.com';await assert.rejects(readPaymentMethods(c),/tenant/);assert.equal(calls.length,0);c.host='https://erp.example.invalid';
 await assert.rejects(readOrderConditions(c,'71'));await assert.rejects(readOrderConditions(c,0));
 c.fetchImpl=async()=>new Response('x',{headers:{'content-length':String(1024*1024+1)}});await assert.rejects(readPaymentMethods(c),/large/);
 c.fetchImpl=async()=>new Response('x'.repeat(1024*1024+1));await assert.rejects(readPaymentMethods(c),/large/);
});
test('single-order condition read requires exact order, contractor and customer identity',async()=>{
 const {c}=client({native:condition()});assert.deepEqual(await readOrderConditions(c,71),{order_id:71,contractor_id:1,customer_id:92,payment_method_id:17,payment_method:'Efecto 30 días'});
 for(const change of [{saleorderid:72},{contractorid:null},{contractorid:{contractorid:2}},{customerid:null},{paymentmethodid:{paymentmethodid:'17'}}]){
  const {c}=client({native:{...condition(),...change}});await assert.rejects(readOrderConditions(c,71));
 }
 assert.throws(()=>assertPaymentConditions({order_id:71,contractor_id:1,customer_id:93,payment_method_id:17,payment_method:'Efecto 30 días'},{order_id:71,customer_id:92,payment_method:'Efecto 30 días'},17));
});
test('modern and legacy read projections expose safe catalogue/conditions and schema',async()=>{
 const {c}=client({native:condition()});for(const fn of [()=>readApi(c,{path:'/payment-methods'}),()=>legacyRead(c,'/payment-methods'),()=>readApi(c,{path:'/orders/71/conditions'}),()=>legacyRead(c,'/orders/71/conditions')])assert.equal(JSON.stringify(await fn()).includes('secret'),false);
 for(const input of [{path:'/payment-methods',method:'POST'},{path:'/payment-methods',body:{}},{path:'/payment-methods',query:{url:'bad'}},{path:'/orders/71/conditions',query:{customer:1}}])await assert.rejects(readApi(c,input));
 assert(schemaFor('GET','/payment-methods').integrationProjection);assert(schemaFor('GET','/orders/{id}/conditions').integrationProjection);assert(discover().integrationExtensions.paymentMethods);
});
test('payment update retains complete five-line public concurrency snapshot and proves native ID',async()=>{
 const after={...clone(base),payment_method:'Efecto 30 días'};const {c,...rest}=client({order:base,after,native:writes=>writes?condition():{...condition(9),paymentmethodid:{paymentmethodid:9,paymentmethod:'Anterior'}}});
 const result=await executeOrderMutation(c,action(),{method:'PATCH',path:'/orders/71',body:{payment_method_id:17}});
 assert.deepEqual(result.readback.data.lines,base.lines);assert.deepEqual(result.readback.verification.verified_fields,['payment_method_id']);assert.deepEqual(result.readback.verification.unverifiable_fields,[]);
});
test('concurrent five-line changes and unknown IDs reject before writing',async()=>{
 for(const changed of ['description','quantity']){
  const order=clone(base);order.lines[4][changed]=changed==='quantity'?999:'Concurrent source';const fixture=client({order,native:{...condition(),paymentmethodid:{paymentmethodid:9,paymentmethod:'Anterior'}}});
  await assert.rejects(executeOrderMutation(fixture.c,action(),{}),/ORDER_CHANGED/);assert.equal(fixture.writes,0);
 }
 const f=client({methods:[]});await assert.rejects(executeOrderMutation(f.c,action(),{}),/Unknown/);assert.equal(f.writes,0);
});
test('contradictory native ID/label/customer readback fails uncertain after exactly one write',async()=>{
 for(const bad of [{paymentmethodid:{paymentmethodid:18,paymentmethod:'Efecto 30 días'}},{paymentmethodid:{paymentmethodid:17,paymentmethod:'WRONG'}},{customerid:{customerid:93}},{contractorid:null}]){
 const after={...clone(base),payment_method:'Efecto 30 días'};const f=client({order:base,after,native:writes=>writes?{...condition(),...bad}:{...condition(),paymentmethodid:{paymentmethodid:9,paymentmethod:'Anterior'}}});
 await assert.rejects(executeOrderMutation(f.c,action(),{}),e=>e.outcomeUncertain===true);assert.equal(f.writes,1);
 }
});
