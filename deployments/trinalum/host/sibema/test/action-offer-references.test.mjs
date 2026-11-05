import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAction,executeAction} from '../bin/sibema-action.mjs';

function action(){return {id:'offer-reference-integration-20261020',type:'create_offer',requestedBy:'Nerea',request:{body:{customer_id:123,lines:[{product_id:13,unit_id:2,quantity_from:0,price:1.18}]},lineReferences:['SYNTHETIC GRADE 113']}};}
test('invalid frozen references are rejected before a provider dispatch',()=>{
 const a=action();assert.deepEqual(validateAction(a).request.lineReferences,a.request.lineReferences);
 a.request.lineReferences=[];assert.throws(()=>validateAction(a),/one reference/);
 a.type='create_customer';assert.throws(()=>validateAction(a),/only to offers/);
});
test('offer completion requires every exact native description and preserves the public body',async()=>{
 const a=validateAction(action());let native={customerofferdetailid:456,customerofferdetail:'Alumina',customerofferid:{customerofferid:123},productid:{productid:13},movementunitid:{movementunitid:2},fromquantity:0,price:1.18};let creates=0,descriptions=0;
 const client={host:'https://erp.example.invalid',token:'test-only',tokenExpiresAt:Date.now()+60000*10,
  async write(path,input){creates++;assert.equal(path,'/offers');assert.deepEqual(input.body,a.request.body);return {offer_id:123};},
  async getObject(resource,id){assert.equal(resource,'offers');assert.equal(id,123);return {offer_id:123,lines:[{line_id:456,product_id:13,quantity_from:0,price:1.18}]};},
  async fetchImpl(url,init){if(init.method==='PUT'){descriptions++;native=JSON.parse(init.body);return new Response(null,{status:200});}return Response.json(structuredClone(native));},
 };
 const result=await executeAction(client,a);assert.equal(creates,1);assert.equal(descriptions,1);assert.equal(result.readback.lines[0].reference,'SYNTHETIC GRADE 113');assert.equal(result.readback.exact_line_references_verified,true);
});
test('a missing native reference after the write stays uncertain, never successful',async()=>{
 const a=validateAction(action());let creates=0;
 const client={write:async()=>{creates++;return {offer_id:123};},getObject:async()=>({offer_id:123,lines:[]})};
 await assert.rejects(executeAction(client,a),e=>e.outcomeUncertain===true);assert.equal(creates,1);
});

test('reference offers reject numeric strings and missing price/unit/threshold before dispatch',()=>{
 for(const field of ['product_id','unit_id','quantity_from','price']){
  const a=action();a.request.body.lines[0][field]=String(a.request.body.lines[0][field]);assert.throws(()=>validateAction(a),/explicit numeric/);
  delete a.request.body.lines[0][field];if(field==='quantity_from')assert.doesNotThrow(()=>validateAction(a));else assert.throws(()=>validateAction(a),/explicit numeric/);
 }
});

test('existing chat sessions can read the safe catalogue projection without public-API route invention',async()=>{
 const {readApi}=await import('../lib/api-request.mjs');const calls=[];
 const client={host:'https://erp.example.invalid',token:'test-only',tokenExpiresAt:Date.now()+600000,fetchImpl:async(url,init)=>{calls.push({url,method:init.method});return Response.json(url.includes('/product/')?[{productid:13,product:'Synthetic material',active:true,accountid:{password:'never-output'}}]:url.includes('/vendor/')?[{vendorid:2,vendor:'Synthetic represented company',providerid:{providerid:2,provider:'Synthetic provider',accountid:{password:'never-output'}},active:true,workerid:{accountid:{password:'never-output'}}}]:[{movementunitid:2,movementunit:'KG'}]);}};
 const value=await readApi(client,{method:'GET',path:'/product-catalog'});assert.equal(value.integrationProjection,true);assert.equal(value.data.products[0].product_id,13);assert.equal(JSON.stringify(value).includes('password'),false);assert.equal(JSON.stringify(value).includes('accountid'),false);assert.deepEqual(value.data.vendors,[{vendor_id:2,vendor:'Synthetic represented company',provider_id:2,provider:'Synthetic provider',active:true}]);assert.equal(calls.length,3);
 assert.deepEqual(calls.map(call=>({path:new URL(call.url).pathname,method:call.method})),[{path:'/ERPBerma/rest/product/getAll',method:'GET'},{path:'/ERPBerma/rest/movementunit/getAll',method:'GET'},{path:'/ERPBerma/rest/vendor/getAll',method:'GET'}]);
 for(const input of [{method:'POST',path:'/product-catalog'},{path:'/product-catalog',body:{}},{path:'/product-catalog',query:{url:'https://example.com'}}])await assert.rejects(readApi(client,input));
 assert.equal(calls.length,3);
});

test('missing source threshold preserves the native default while writing exact descriptions',async()=>{
 const a=action();delete a.request.body.lines[0].quantity_from;let row={customerofferdetailid:456,customerofferdetail:'Family',customerofferid:{customerofferid:123},productid:{productid:13},movementunitid:{movementunitid:2},fromquantity:null,price:1.18};
 const client={host:'https://erp.example.invalid',token:'test-only',tokenExpiresAt:Date.now()+600000,write:async()=>({offer_id:123}),getObject:async()=>({offer_id:123,lines:[{line_id:456,product_id:13,quantity_from:null,price:1.18}]}),fetchImpl:async(url,init)=>{if(init.method==='PUT'){row=JSON.parse(init.body);return new Response(null);}return Response.json(row);}};
 const value=await executeAction(client,validateAction(a));assert.equal(row.fromquantity,null);assert.equal(value.readback.lines[0].reference,a.request.lineReferences[0]);
});

test('header-only offer edits cannot fall through to the public PUT that deletes children',async()=>{
 let writes=0;
 const client={write:async()=>{writes++;throw Error('destructive public PUT must never be called');}};
 await assert.rejects(executeAction(client,validateAction({id:'header-failclosed-20261020',type:'update_offer',requestedBy:'Nerea',request:{offerId:110,body:{remarks:'Updated terms'}}})),/only an exact vendor_id/);
 assert.equal(writes,0);
});
