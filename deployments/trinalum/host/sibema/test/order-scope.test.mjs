import test from 'node:test';
import assert from 'node:assert/strict';
import {operationFor} from '../bin/sibema-action.mjs';

test('order status cannot silently ignore partial-delivery fields',()=>{
 const request={orderId:328,body:{status_id:2}};
 assert.deepEqual(operationFor({type:'update_order_status',request}),{method:'PATCH',path:'/orders/328/status',body:{status_id:2}});
 for(const extra of [{quantity:23515},{delivery_date:'2026-10-08'},{invoiced:true},{received_quantity:23515}]) {
  assert.throws(()=>operationFor({type:'update_order_status',request:{...request,body:{...request.body,...extra}}}),/accept only status_id/);
 }
 for(const body of [{},{status_id:0},{status_id:null},{status_id:'2'},{status_id:true}])assert.throws(()=>operationFor({type:'update_order_status',request:{...request,body}}));
});

test('conversion preserves order traceability without accepting fabricated shipment data',()=>{
 const request={offerId:102,body:{contractor_id:1,date:'2026-10-08'}};
 assert.equal(operationFor({type:'convert_offer_to_order',request}).path,'/offers/102/convert-to-order');
 for(const date of ['2026-02-30','2026-10-08T00:00:00Z','not a date'])assert.throws(()=>operationFor({type:'convert_offer_to_order',request:{...request,body:{contractor_id:1,date}}}),/real YYYY-MM-DD/);
 assert.throws(()=>operationFor({type:'convert_offer_to_order',request:{...request,body:{contractor_id:1,quantity:100000}}}),/accepts only/);
 for(const contractor_id of [2,'1',true])assert.throws(()=>operationFor({type:'convert_offer_to_order',request:{...request,body:{contractor_id}}}),/contractor_id=1/);
});
