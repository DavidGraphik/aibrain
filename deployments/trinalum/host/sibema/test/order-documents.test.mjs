import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateOrderDocumentRequest,readOrderFiles,readOrderPdf,attachOrderPdf,removeOrderPdf} from '../lib/order-documents.mjs';
import {validateAction,executeAction} from '../bin/sibema-action.mjs';
import {readApi} from '../lib/api-request.mjs';
import {discover,schemaFor} from '../lib/api-contract.mjs';
import {actionFor} from '../../../../../infra/trinalum/connector-broker.mjs';
const bytes=Buffer.from('%PDF-1.7\nSynthetic order attachment, no commercial value.');
const digest=v=>createHash('sha256').update(v).digest('hex');
const key='01234567-89ab-5cde-abcd-0123456789ab';
const input={orderId:12,body:{filename:'QA-owned-order.pdf',content_base64:bytes.toString('base64')}};
function fixture(options={}){
 const raw={branch:null,saleorderid:12,contractorid:{contractorid:1},customerid:{customerid:42},serie:'QA',number:12,reference:'QA-ORDER-OWNED',remarks:'Preserve every original field'};
 const scoped={order_id:12,customer_id:42,serie:'QA',number:'12',reference:raw.reference,lines:[{line_id:10,quantity:1,unit_price:10}]};
 const rows=[{saleorderfileid:4,saleorderid:structuredClone(raw),filename:'unrelated.pdf',file:'private/provider/path/unrelated.pdf',size:0.001}];
 const contents=new Map([[rows[0].file,Buffer.from('%PDF-1.7\nUnrelated original')]]);const calls=[];let lists=0,writes=0,deletes=0,downloads=0;
 const client={write:async(path,writeOptions)=>{assert.equal(path,'/orders/12/files');assert.equal(writeOptions.method,'POST');assert.match(writeOptions.idempotencyKey,/^[0-9a-f-]{36}$/i);const body=writeOptions.body;writes++;if(options.writeStatus)throw Object.assign(Error('rejected'),{status:options.writeStatus});const pathFile='private/provider/path/created.pdf';rows.push({saleorderfileid:7,saleorderid:structuredClone(raw),filename:body.filename,file:pathFile,size:0.001});contents.set(pathFile,options.corruptBytes?Buffer.from('%PDF-different bytes'):Buffer.from(body.content_base64,'base64'));if(options.lostAck)throw new TypeError('lost acknowledgement');return options.nullResponse?null:{order_id:12,file_id:options.mismatchedFileId?8:7,filename:body.filename,stored:true};},host:'https://erp.example.invalid',token:'synthetic',tokenExpiresAt:Date.now()+600000,getObject:async(resource,id)=>{assert.equal(resource,'orders');assert.equal(id,12);return {...structuredClone(scoped),...(options.foreignPublic?{customer_id:99}:{})};},fetchImpl:async(url,init)=>{
  const path=new URL(url).pathname.replace('/ERPBerma','');calls.push({method:init.method,path});assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer synthetic');
  if(path==='/rest/saleorder/12')return Response.json({...structuredClone(raw),...(options.foreignTenant?{contractorid:{contractorid:2}}:{}),...(options.changeOrder&&writes?{remarks:'Human changed order'}:{})});
  if(path==='/rest/getByQuery'){
   const q=JSON.parse(init.body);assert.equal(q.clazz,'saleorderfile');assert.equal(q.items[0].field,'saleorderid');assert.equal(q.items[0].value.saleorderid,12);lists++;
   if(options.concurrentFiles&&lists===2)rows.push({saleorderfileid:5,saleorderid:structuredClone(raw),filename:'external.pdf',file:'private/external.pdf'});
   if(options.readbackFailure&&writes)return new Response('{}',{status:503});
   return Response.json(options.foreignFile?rows.map(r=>({...r,saleorderid:{saleorderid:99}})):rows);
  }
  if(path==='/rest/getFile'){
   const q=JSON.parse(init.body);assert.equal(q.completePath,true);assert.ok(rows.some(r=>r.file===q.path));downloads++;
   if(options.providerNegotiation&&init.headers.accept!=='application/json, text/plain, */*')return Response.json({error:'provider negotiation failure'},{status:500});
   if(options.downloadStatus)return Response.json({error:'real provider failure'},{status:options.downloadStatus});
   return new Response(options.nonPdf?Buffer.from('not an original PDF'):contents.get(q.path),{headers:{'content-type':options.providerNegotiation?'application/json':'application/pdf'}});
  }
  if(path==='/rest/saleorderfile/create'){
   const b=JSON.parse(init.body);assert.equal(init.method,'POST');assert.deepEqual(b.saleorderid,raw);assert.equal(b.documentfolderid,null);writes++;
   const pathFile='private/provider/path/created.pdf';rows.push({saleorderfileid:7,saleorderid:structuredClone(raw),filename:b.filename,file:pathFile,size:0.001});contents.set(pathFile,Buffer.from(b.file,'base64'));
   return new Response(null,{status:204});
  }
  if(path==='/rest/saleorderfile/delete/7'){
   assert.equal(init.method,'DELETE');deletes++;const index=rows.findIndex(r=>r.saleorderfileid===7);rows.splice(index,1);if(options.lostDeleteAck)throw new TypeError('lost delete acknowledgement');return new Response(null,{status:204});
  }
  throw Error('Unexpected provider route '+path);
 }};
 return {client,raw,scoped,rows,calls,writes:()=>writes,deletes:()=>deletes,downloads:()=>downloads};
}
test('attach reads back original bytes, preserves order/other files and exact replay creates no duplicate',async()=>{
 const f=fixture({providerNegotiation:true}),before=structuredClone(f.rows),r=await attachOrderPdf(f.client,input,{idempotencyKey:key,dispatchGuard:()=>{}});
 assert.equal(f.writes(),1);assert.equal(r.result.created,true);assert.equal(r.readback.sha256,digest(bytes));assert.equal(r.readback.order_preserved,true);assert.deepEqual(f.rows[0],before[0]);
 const again=await attachOrderPdf(f.client,input,{idempotencyKey:key,dispatchGuard:()=>{}});assert.equal(again.result.already_present,true);assert.equal(f.writes(),1);assert.equal(f.rows.length,2);
});
test('scoped list and private PDF original never expose native storage paths',async()=>{
 const f=fixture();await attachOrderPdf(f.client,input,{idempotencyKey:key,dispatchGuard:()=>{}});const list=await readOrderFiles(f.client,12);assert.equal(list.files.length,2);assert.ok(!JSON.stringify(list).includes('private/provider'));
 const file=await readOrderPdf(f.client,12,7);assert.equal(file.sha256,digest(bytes));assert.deepEqual(Buffer.from(file.content_base64,'base64'),bytes);assert.equal(file.filename,input.body.filename);
 const projected=await readApi(f.client,{path:'/orders/12/files'});assert.equal(projected.integrationProjection,true);assert.equal(schemaFor('GET','/orders/{id}/files/{fileId}/content').integrationProjection,true);assert.match(discover().integrationExtensions.orderDocuments,/Saleorderfile/);
 await assert.rejects(readApi(f.client,{path:'/orders/12/files',query:{url:'https://foreign.invalid'}}),/GET-only/);await assert.rejects(readOrderPdf(f.client,12,999),/does not belong/);
});
test('cleanup removes only exact received ID/name/hash and repeat reports absence without deleting again',async()=>{
 const f=fixture({providerNegotiation:true});await attachOrderPdf(f.client,input,{idempotencyKey:key,dispatchGuard:()=>{}});const removed={orderId:12,fileId:7,body:{expectedFilename:input.body.filename,expectedSha256:digest(bytes)}};
 const result=await removeOrderPdf(f.client,removed,{dispatchGuard:()=>{}});assert.equal(result.result.removed,true);assert.equal(result.readback.other_files_preserved,true);assert.equal(f.deletes(),1);assert.deepEqual(f.rows.map(r=>r.saleorderfileid),[4]);
 const again=await removeOrderPdf(f.client,removed,{dispatchGuard:()=>{}});assert.equal(again.result.already_absent,true);assert.equal(again.result.removed,false);assert.equal(f.deletes(),1);
});
test('wrong cleanup hash or name cannot delete even the same file ID',async()=>{
 const f=fixture();await attachOrderPdf(f.client,input,{idempotencyKey:key,dispatchGuard:()=>{}});
 for(const body of[{expectedFilename:'another.pdf',expectedSha256:digest(bytes)},{expectedFilename:input.body.filename,expectedSha256:'0'.repeat(64)}])await assert.rejects(removeOrderPdf(f.client,{orderId:12,fileId:7,body},{dispatchGuard:()=>{}}),/changed/);
 assert.equal(f.deletes(),0);assert.equal(f.rows.length,2);
});
test('foreign tenant/public/native or file parent fails before any original read or write',async()=>{
 for(const options of[{foreignTenant:true},{foreignPublic:true},{foreignFile:true}]){const f=fixture(options);await assert.rejects(attachOrderPdf(f.client,input,{idempotencyKey:key,dispatchGuard:()=>{}}),/identity|scope|parent/);assert.equal(f.writes(),0);assert.equal(f.downloads(),0);}
 const f=fixture();f.client.host='https://foreign.invalid';await assert.rejects(readOrderFiles(f.client,12),/tenant/);
});
test('concurrent file change and existing same-name different bytes abort before dispatch',async()=>{
 const concurrent=fixture({concurrentFiles:true});await assert.rejects(attachOrderPdf(concurrent.client,input,{idempotencyKey:key,dispatchGuard:()=>{}}),/files changed/);assert.equal(concurrent.writes(),0);
 const f=fixture();const request={...input,body:{...input.body,filename:'unrelated.pdf'}};await assert.rejects(attachOrderPdf(f.client,request,{idempotencyKey:key,dispatchGuard:()=>{}}),/different bytes/);assert.equal(f.writes(),0);
});
test('postwrite readback failures, changed order, altered bytes and lost ACK remain uncertain without another write',async()=>{
 for(const options of[{readbackFailure:true},{changeOrder:true},{corruptBytes:true},{lostAck:true}]){const f=fixture(options);await assert.rejects(attachOrderPdf(f.client,input,{idempotencyKey:key,dispatchGuard:()=>{}}),e=>e.outcomeUncertain===true);assert.equal(f.writes(),1);}
 const f=fixture({writeStatus:403});await assert.rejects(attachOrderPdf(f.client,input,{idempotencyKey:key,dispatchGuard:()=>{}}),e=>e.status===403&&e.outcomeUncertain===true);assert.equal(f.writes(),1);
 const d=fixture({lostDeleteAck:true});await attachOrderPdf(d.client,input,{idempotencyKey:key,dispatchGuard:()=>{}});await assert.rejects(removeOrderPdf(d.client,{orderId:12,fileId:7,body:{expectedFilename:input.body.filename,expectedSha256:digest(bytes)}},{dispatchGuard:()=>{}}),e=>e.outcomeUncertain===true);assert.equal(d.deletes(),1);
});
test('no arbitrary ID/path/URL/noncanonical bytes can enter the extension',()=>{
 for(const request of[{...input,orderId:'12'},{...input,body:{...input.body,url:'https://foreign.invalid'}},{...input,body:{...input.body,filename:'../private.pdf'}},{...input,body:{...input.body,content_base64:'not-pdf'}},{...input,body:{...input.body,content_base64:bytes.toString('base64')+'\n'}},{...input,path:'/rest/arbitrary'}])assert.throws(()=>validateOrderDocumentRequest(request));
});
test('named durable action and broker preserve employee restrictions; operator scope is not widened',async()=>{
 const f=fixture(),action=validateAction({id:'QA-ORDER-PDF-EXACT',requestedBy:'Trini',type:'attach_order_pdf',request:input});assert.equal((await executeAction(f.client,action,{pdfDispatchGuard:()=>{}})).readback.sha256,digest(bytes));
 const base={installationId:'trinalum-production',owner:'trini',userId:'11111111-1111-4111-8111-111111111111',status:'active',operations:['sibema_action']},id='web-'+'a'.repeat(64);
 assert.equal(actionFor(base,'sibema_action',{type:'attach_order_pdf',request:input},id).requestedBy,'Trini');
 for(const owner of['tristan','david'])assert.throws(()=>actionFor({...base,owner},'sibema_action',{type:'attach_order_pdf',request:input},id),/ACCESS_DENIED/);
 assert.throws(()=>validateAction({...action,requestedBy:'Tristan'}),/accounting entries only/);
});

test('official blob Accept reads real PDF bytes despite provider application/json metadata',async()=>{
 const f=fixture({providerNegotiation:true}),original=Buffer.from('%PDF-1.7\nUnrelated original');
 const result=await readOrderPdf(f.client,12,4);
 assert.equal(result.sha256,digest(original));assert.equal(result.bytes,original.length);assert.deepEqual(Buffer.from(result.content_base64,'base64'),original);
 assert.equal(f.downloads(),1);assert.equal(f.writes(),0);assert.equal(f.deletes(),0);
});
test('broader official blob negotiation preserves real provider failures without retry or write',async()=>{
 for(const status of [401,403,404,500]){
  const f=fixture({providerNegotiation:true,downloadStatus:status});
  await assert.rejects(readOrderPdf(f.client,12,4),e=>e.status===status&&/provider rejected/.test(e.message));
  assert.equal(f.downloads(),1);assert.equal(f.writes(),0);assert.equal(f.deletes(),0);
 }
});
test('provider JSON metadata or HTTP200 cannot certify non-PDF bytes',async()=>{
 const f=fixture({providerNegotiation:true,nonPdf:true});
 await assert.rejects(readOrderPdf(f.client,12,4),/provider file is not a PDF/);
 assert.equal(f.downloads(),1);assert.equal(f.writes(),0);assert.equal(f.deletes(),0);
});


test('provider response with a mismatched file ID is uncertain and is never replayed',async()=>{const f=fixture({mismatchedFileId:true});await assert.rejects(attachOrderPdf(f.client,input,{idempotencyKey:key,dispatchGuard:()=>{}}),e=>e.outcomeUncertain===true);assert.equal(f.writes(),1);});

test('legacy caller cannot dispatch without the new fence; new caller uses the public path',async()=>{const f=fixture();await assert.rejects(attachOrderPdf(f.client,input),/dispatch fence required/);assert.equal(f.writes(),0);const g=fixture();await attachOrderPdf(g.client,input,{idempotencyKey:key,dispatchGuard:()=>{}});assert.equal(g.writes(),1);assert.equal(g.calls.filter(x=>x.path==='/rest/saleorderfile/create').length,0);});
test('malformed explicit key refuses before write',async()=>{const f=fixture();await assert.rejects(attachOrderPdf(f.client,input,{idempotencyKey:'bad'}),/idempotency key/);assert.equal(f.writes(),0);});

test('empty public upload response is uncertain, even if file appeared',async()=>{const f=fixture({nullResponse:true});await assert.rejects(attachOrderPdf(f.client,input,{idempotencyKey:key,dispatchGuard:()=>{}}),e=>e.outcomeUncertain===true);assert.equal(f.writes(),1);});


test('attach and remove fail before a provider write if the durable transition guard is absent or fails',async()=>{
 const f=fixture();await assert.rejects(attachOrderPdf(f.client,input,{idempotencyKey:key}),/dispatch fence required/);assert.equal(f.writes(),0);
 await assert.rejects(attachOrderPdf(f.client,input,{idempotencyKey:key,dispatchGuard:()=>{throw Error('dispatch fence unavailable')}}),/fence unavailable/);assert.equal(f.writes(),0);
 await attachOrderPdf(f.client,input,{idempotencyKey:key,dispatchGuard:()=>{}});const target={orderId:12,fileId:7,body:{expectedFilename:input.body.filename,expectedSha256:digest(bytes)}};
 await assert.rejects(removeOrderPdf(f.client,target),/dispatch fence required/);assert.equal(f.deletes(),0);await assert.rejects(removeOrderPdf(f.client,target,{dispatchGuard:()=>{throw Error('dispatch fence unavailable')}}),/fence unavailable/);assert.equal(f.deletes(),0);
});
