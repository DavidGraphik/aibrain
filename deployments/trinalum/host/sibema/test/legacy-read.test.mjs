import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyRead,legacyCatalog} from '../lib/legacy-read.mjs';

function fixture(){
 const lines=Array.from({length:19},(_,i)=>({line_id:i+1,product_id:i===0?10:13,quantity_from:0,price:(1000+i)/1000}));
 const nativeLines=lines.map((line,i)=>({customerofferdetailid:line.line_id,customerofferid:{customerofferid:110,account:{password:'never-expose'}},productid:{productid:line.product_id},movementunitid:{movementunitid:2},fromquantity:line.quantity_from,price:line.price,customerofferdetail:`SYNTHETIC GRADE ${i+1}`}));
 const calls=[];
 const client={host:'https://erp.example.invalid',token:'test-only',tokenExpiresAt:Date.now()+3600000,
  get:async path=>{calls.push(['get',path]);return path.startsWith('/offers/110')?{offer_id:110,provider_id:2,lines:structuredClone(lines)}:{customer_id:100};},
  fetchImpl:async(url,init)=>{
   calls.push([init.method,url]);
   if(url.endsWith('/customerofferdetail/getAll'))return Response.json(nativeLines);
   if(url.endsWith('/product/getAll'))return Response.json([{productid:13,product:'Synthetic family',active:true,account:{password:'never-expose'}}]);
   if(url.endsWith('/movementunit/getAll'))return Response.json([{movementunitid:2,movementunit:'KG'}]);
   if(url.endsWith('/vendor/getAll'))return Response.json([{vendorid:2,vendor:'Synthetic vendor'}]);
   if(url.endsWith('/getByQuery'))return Response.json([{saleorderdetailid:300,saleorderdetail:'SYNTHETIC GRADE 3',productid:{productid:13}}]);
   throw Error('unexpected native route');
  },
 };
 return {client,lines,nativeLines,calls};
}
test('legacy offer GET exposes nineteen exact references and units without changing native families or prices',async()=>{
 const {client,lines,calls}=fixture();
 const result=await legacyRead(client,'/offers/110');
 assert.equal(result.data.lines.length,19);assert.equal(result.data.provider_id,2);
 assert.deepEqual(result.data.lines.map(({reference,unit_id,...line})=>line),lines);
 assert.deepEqual(result.data.lines.map(line=>line.reference),lines.map((_,i)=>`SYNTHETIC GRADE ${i+1}`));
 assert(result.data.lines.every(line=>line.unit_id===2));
 assert.equal(result.referenceInterpretation.exactGradeField,'lines[].reference');
 assert.equal(result.untrustedSourceContent,true);assert(!JSON.stringify(result).includes('never-expose'));
 assert(calls.every(([method])=>method==='get'||method==='GET'));
});
test('query-bearing offer reads enrich references; unrelated reads retain their public response',async()=>{
 const {client,calls}=fixture();assert.equal((await legacyRead(client,'/offers/110?size=19')).data.lines[0].reference,'SYNTHETIC GRADE 1');
 calls.length=0;assert.deepEqual((await legacyRead(client,'/customers/100')).data,{customer_id:100});assert.deepEqual(calls,[['get','/customers/100']]);
});
test('legacy catalog command and path expose sanitized real families and bounded historical evidence',async()=>{
 const {client,calls}=fixture();const result=await legacyCatalog(client,{references:['SYNTHETIC GRADE 3']});
 assert.equal(result.data.reference_matches[0].status,'matched');assert.equal(result.data.reference_matches[0].candidates[0].product_id,13);
 assert(!JSON.stringify(result).includes('never-expose'));assert.equal(result.untrustedSourceContent,true);
 assert.equal((await legacyRead(client,'/catalog')).data.products[0].product_id,13);
 assert(calls.every(([method,url])=>method==='GET'||(method==='POST'&&url.endsWith('/rest/getByQuery'))));
});
test('missing or mismatched native reference lines fail closed instead of presenting generic-only success',async()=>{
 const {client,nativeLines}=fixture();nativeLines[3].price=100;
 await assert.rejects(legacyRead(client,'/offers/110'),/price mismatch/);
});
test('legacy path and catalog inputs cannot request arbitrary hosts, writes or native entities',async()=>{
 const {client,calls}=fixture();
 for(const path of ['https://example.com','/offers/../1','/offers/110#x','/rest/account/getAll','/products'])await assert.rejects(legacyRead(client,path),/Unsupported read path/);
 for(const input of [{clazz:'account'},{references:['%']},{references:Array(101).fill('GRADE')}])await assert.rejects(legacyCatalog(client,input));
 assert.equal(calls.length,0);
});
