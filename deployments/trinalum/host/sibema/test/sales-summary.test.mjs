import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildSalesSummary,summarizeSales} from '../lib/sales-summary.mjs';

test('sales amounts exclude incomplete discounts while units remain separate',()=>{
 const result=summarizeSales([
  {order_id:1,customer_id:1,lines:[{line_id:1,quantity:2,unit:'t',unit_price:25,discount:0}]},
  {order_id:2,customer_id:2,lines:[{line_id:2,quantity:3,unit:'boxes',unit_price:10,discount:1}]},
 ],[{customer_id:1,name:'Synthetic A',address:{state:'Example region'}},{customer_id:2,name:'Synthetic B',address:{state:'Example region'}}],{from:'2026-01-01',to:'2026-01-31'});
 assert.equal(result.top_by_amount.length,1);
 assert.equal(result.top_by_amount[0].net_line_amount,50);
 assert.deepEqual(result.top_by_kg[0].quantity_by_unit,{kg:2000});
 assert.equal(result.invalid_amount_lines,1);
 assert.equal(result.by_province['Example region'].net_line_amount,null);
});

test('invalid date ranges and limits stop before provider access',async()=>{
 const client={listAll(){throw Error('Unexpected provider access');}};
 for(const input of [{from:'2026-02-30',to:'2026-03-01'},{from:'2026-02-01',to:'2026-01-01'},{from:'2026-01-01',to:'2026-01-31',limit:0}])await assert.rejects(buildSalesSummary(client,input),/dates required|reversed|Limit/);
});

test('failed detail reads produce incomplete coverage without inventing amounts',async()=>{
 const client={listAll:async resource=>resource==='customers'?[{customer_id:1,name:'Synthetic'}]:[{order_id:1,customer_id:1,status:{name:'FACTURADO'},shipping_date:'2026-01-15'}],getObject:async()=>{throw Object.assign(Error('Synthetic failure'),{status:503});}};
 const result=await buildSalesSummary(client,{from:'2026-01-01',to:'2026-01-31'});
 assert.equal(result.complete,false);assert.equal(result.quantities_complete_for_dated_orders,false);
 assert.equal(result.eligible_orders,1);assert.equal(result.failed_details.length,1);
 assert.deepEqual(result.top_by_amount,[]);
});

test('sales-summary CLI executes real client pagination and details using transport fixtures without network',()=>{
 const cli=fileURLToPath(new URL('../bin/sibema-read.mjs',import.meta.url));
 const preload=fileURLToPath(new URL('./fixtures/sales-summary-preload.mjs',import.meta.url));
 const result=spawnSync(process.execPath,['--import',preload,cli,'sales-summary','--from','2026-01-01','--to','2026-01-31','--limit','1'],{encoding:'utf8',timeout:10000,env:{AIBRAIN_SIBEMA_ORIGIN:'https://erp.example.invalid',SIBEMA_API_NAMESPACE:'company',SIBEMA_USERNAME:'synthetic',SIBEMA_PASSWORD:'synthetic'}});
 assert.equal(result.status,0,result.stderr);
 const summary=JSON.parse(result.stdout);
 assert.equal(summary.complete,true);assert.equal(summary.eligible_orders,1);
 assert.equal(summary.excluded_invoiced_without_shipping_date,1);
 assert.equal(summary.top_by_amount[0].name,'Synthetic customer');
 assert.equal(summary.top_by_amount[0].net_line_amount,50);
 assert.deepEqual(summary.top_by_kg[0].quantity_by_unit,{kg:2000});
});
