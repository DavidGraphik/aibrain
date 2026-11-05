import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir as nativeTmpdir} from 'node:os';
import {realpathSync as canonicalTmpPath} from 'node:fs';
const tmpdir=()=>canonicalTmpPath(nativeTmpdir());
import {join} from 'node:path';
import {discover,schemaFor,specification,validateApiRequest,contractFingerprint} from '../lib/api-contract.mjs';
import {readApi,accountingReadback} from '../lib/api-request.mjs';
import {validateAction,operationFor,executeAction} from '../bin/sibema-action.mjs';
import {SibemaClient} from '../lib/sibema-client.mjs';
import {SibemaStore} from '../lib/store.mjs';
const base={order_id:153,customer_id:42,reference:'contract-153',lines:[{line_id:981,product_id:7,description:'Lingote',quantity:100000,final_quantity:100000,unit_id:1,unit_price:2.45,discount:0,vat_rate:21}]};
const entry={contractor_id:1,date:'2026-10-15',description:'Synthetic journal',lines:[{account:'4300001',debit:100,credit:0},{account:'7000001',debit:0,credit:100}]};
const fixture=[
 ['POST','/customers',{name:'Synthetic customer',vat_number:'B12345678'}],
 ['POST','/offers',{customer_id:42,description:'Synthetic offer',lines:[{product_id:7,quantity_from:100000,unit_id:1,price:2.45}]}],
 ['PUT','/offers/10',{description:'Updated offer'}],
 ['POST','/offers/10/files',{filename:'original.pdf',content_base64:Buffer.from('%PDF-1.7\nsynthetic').toString('base64')}],
 ['POST','/offers/10/convert-to-order',{contractor_id:1,date:'2026-10-15'}],
 ['PATCH','/orders/153',{remarks:'Synthetic update'},base],
 ['POST','/orders/153/deliveries',{date:'2026-10-15',reference:'ANL QA 1',lines:[{line_id:981,quantity:24000}]},base],
 ['PATCH','/orders/153/status',{status_id:1}],
 ['POST','/invoices/purchase',{provider_id:1,date:'2026-10-15',contractor_id:1,lines:[{product_id:7,quantity:10,price:2.45}]}],
 ['PATCH','/invoices/purchase/12',{status_id:1}],
 ['POST','/accounting/entries',{entries:[entry]}],
 ['POST','/accounting/entries/validate',{entries:[entry]}],
];
const action=([method,path,body,expectedOrder]=fixture[0])=>({id:'web-'+'a'.repeat(64),type:'api_request',requestedBy:'Trini',request:{method,path,body:structuredClone(body),...(expectedOrder?{expectedOrder:structuredClone(expectedOrder)}:{})}});

test('contract hash ignores synthetic example annotations but binds schema rules and operation path',()=>{
 const baseline=contractFingerprint('POST','/customers');
 const provider=structuredClone(specification);
 const body=provider.paths['/company/api/v1/customers'].post.requestBody.content['application/json'];
 body.example={name:'Provider example',email:'provider@example.test'};
 body.examples={other:{value:{name:'Another example'}}};
 provider.components.schemas.CustomerWrite.properties.name.examples=['Presentation only'];
 assert.equal(contractFingerprint('POST','/customers',provider),baseline);
 assert.equal(contractFingerprint('POST','/customers',structuredClone(specification)),baseline);
 for(const mutate of [
  spec=>spec.components.schemas.CustomerWrite.required.push('phone'),
  spec=>{spec.components.schemas.CustomerWrite.properties.name.type='number';},
  spec=>{spec.components.schemas.CustomerWrite.properties.name.enum=['Only this value'];},
 ]){
  const changed=structuredClone(provider);mutate(changed);
  assert.notEqual(contractFingerprint('POST','/customers',changed),baseline);
 }
 const moved=structuredClone(provider);
 moved.paths['/company/api/v1/example-customers']=moved.paths['/company/api/v1/customers'];
 delete moved.paths['/company/api/v1/customers'];
 assert.notEqual(contractFingerprint('POST','/example-customers',moved),baseline);
 const namedProperty=structuredClone(provider);
 namedProperty.components.schemas.CustomerWrite.properties.example={type:'string'};
 const first=contractFingerprint('POST','/customers',namedProperty);
 namedProperty.components.schemas.CustomerWrite.properties.example.type='number';
 assert.notEqual(contractFingerprint('POST','/customers',namedProperty),first);
});

test('all documented read operations discover and validate with native ID/contractor1 scope',()=>{
 const discovery=discover();assert.equal(discovery.version,'1.2');assert.ok(!discovery.operations.some(o=>o.path==='/authenticate'));
 for(const op of discovery.operations.filter(o=>o.method==='GET')){
  const path=op.path.replace('{id}','153').replace('{fileId}','2').replace('{account}','4300001');
  const validated=validateApiRequest({method:'GET',path},{readOnly:true});assert.equal(validated.path,path);
  if(path.startsWith('/accounting/'))assert.equal(validated.query.contractor_id,1);
 }
 for(const path of ['/customers/{id}/contacts','/customers/{id}/prices','/providers/{id}/products','/invoices/sale/{id}','/accounting/accounts/{account}/movements'])assert.ok(discovery.operations.some(o=>o.path===path));
 const schema=schemaFor('POST','/accounting/entries');assert.equal(schema.requestBody.content['application/json'].schema.properties.entries.type,'array');assert.ok(!JSON.stringify(schema).includes('$ref'));
});
test('tariff destination is distinct from offers and is not invented as a provider operation',()=>{
 const discovery=discover();
 assert.ok(discovery.limitations.some(value=>value.includes('CRM customer tariffs and CRM offers are distinct')));
 assert.ok(discovery.limitations.some(value=>value.includes('Never use offer creation/update or offer attachments as a tariff substitute')));
 assert.throws(()=>validateApiRequest({method:'POST',path:'/tariffs',body:{customer_id:12}}),/not offered/);
});
test('read CLI accepts bounded JSON argv without credentials for discover/schema',()=>{
 const cli=fileURLToPath(new URL('../bin/sibema-api.mjs',import.meta.url));
 assert.equal(JSON.parse(execFileSync(process.execPath,[cli,'discover','--json','{}'],{encoding:'utf8'})).version,'1.2');
 assert.equal(JSON.parse(execFileSync(process.execPath,[cli,'schema','--json',JSON.stringify({method:'GET',path:'/providers/{id}/contacts'})],{encoding:'utf8'})).method,'GET');
});
test('forbids external hosts, encoded traversal, arbitrary endpoints/query, contractor override and write-via-read',()=>{
 for(const input of [{path:'https://evil.invalid/x'},{path:'//evil.invalid/x'},{path:'/orders/%2e%2e'},{path:'/orders/../customers'},{path:'/customers?contractor_id=2'},{path:'/authenticate'},{path:'/orders/0'},{path:'/customers',query:{url:'https://evil.invalid'}},{path:'/accounting/entries',query:{contractor_id:2}},{method:'POST',path:'/customers',body:{name:'x',vat_number:'B12345678'}}])assert.throws(()=>validateApiRequest(input,{readOnly:true}));
 assert.throws(()=>validateApiRequest({method:'POST',path:'/accounting/third-parties',body:{}}),/not offered/);
 assert.throws(()=>validateApiRequest({method:'DELETE',path:'/orders/153'}));
 assert.throws(()=>validateApiRequest({path:'/orders',query:{page:-1}}));
 assert.throws(()=>validateApiRequest({path:'/orders',query:{size:201}}));
 assert.throws(()=>validateApiRequest({path:'/orders',query:{from:'2026-02-30'}}));
});
test('all twelve documented writes map to durable native adapters and pin prepared schema',()=>{
 for(const f of fixture){const prepared=validateAction(action(f));assert.equal(prepared.type,'api_request');assert.match(prepared.request.contractHash,/^[a-f0-9]{64}$/);const op=operationFor(prepared);assert.equal(op.path,f[1]);assert.equal(op.method,f[0]);}
 const a=action();a.request.contractHash='wrong';assert.throws(()=>validateAction(a),/CONTRACT_CHANGED/);
});
test('request validation rejects invented fields, wrong types/dates/IDs, foreign contractor and unbalanced accounting',()=>{
 const cases=[a=>a.request.body.unknown=true,a=>a.request.body.name=123,a=>a.request.body.contractor_id=2];for(const change of cases){const a=action();change(a);assert.throws(()=>validateAction(a));}
 for(const mutation of [x=>x.request.body.entries[0].contractor_id=2,x=>x.request.body.entries[0].lines[0].debit=101,x=>x.request.body.entries[0].date='2026-02-30',x=>x.request.body.entries[0].lines[0].credit='0']){const a=action(fixture[10]);mutation(a);assert.throws(()=>validateAction(a));}
 const a=action(fixture[5]);a.request.body={payment_method_id:0};assert.throws(()=>validateAction(a),/positive JSON integers/);
 const b=action(fixture[6]);delete b.request.expectedOrder;assert.throws(()=>validateAction(b));
 const c=action(fixture[6]);c.request.expectedOrder.lines[0].final_quantity=null;assert.throws(()=>validateAction(c),/FINAL_QUANTITY/);
 const d=action(fixture[6]);d.request.expectedOrder.lines[0].remarks='ANL QA 1';assert.throws(()=>validateAction(d),/ALREADY_RECORDED/);
});
test('generic metadata PATCH retains historical null final_quantity under the pinned native contract',async()=>{
 const input=action(fixture[5]);input.request.expectedOrder.lines[0].final_quantity=null;
 const prepared=validateAction(input),before=structuredClone(input.request.expectedOrder),after={...structuredClone(before),remarks:input.request.body.remarks};
 let reads=0,writes=0;
 const result=await executeAction({getContract:async()=>specification,getObject:async()=>++reads===1?structuredClone(before):structuredClone(after),write:async()=>{writes++;return structuredClone(after);}},prepared);
 assert.equal(writes,1);assert.equal(reads,2);assert.equal(result.readback.lines[0].final_quantity,null);
});
test('contract mismatch aborts before any write and does not mark the result uncertain',async()=>{
 const a=validateAction(action());const spec=structuredClone(specification);spec.paths['/company/api/v1/customers'].post.requestBody={content:{'application/json':{schema:{type:'object'}}}};
 let writes=0;await assert.rejects(executeAction({getContract:async()=>spec,write:async()=>{writes++;}},a),e=>/CONTRACT_CHANGED/.test(e.message)&&!e.outcomeUncertain);assert.equal(writes,0);
});
test('one write then independent readback for generic customer, with UUID idempotency and no blind replay',async()=>{
 const a=validateAction(action()),calls=[];const client={getContract:async()=>specification,write:async(path,options)=>{calls.push({path,options});return {customer_id:77};},getObject:async(resource,id)=>{assert.equal(resource,'customers');assert.equal(id,77);return {customer_id:77,...a.request.body};}};
 const out=await executeAction(client,a);assert.equal(out.readback.data.customer_id,77);assert.ok(out.readback.verification.verified_fields.includes("body.name"));assert.equal(calls.length,1);assert.match(calls[0].options.idempotencyKey,/^[a-f0-9-]{36}$/);
 for(const mode of ['network','readback']){let count=0;await assert.rejects(executeAction({...client,write:async()=>{count++;if(mode==='network')throw new TypeError('disconnected');return {customer_id:77};},getObject:async()=>{throw Object.assign(new Error('gone'),{status:404});}},a),e=>e.outcomeUncertain===true);assert.equal(count,1);}
});
test('generic delivery keeps specific unchanged-order and ANL guards before write',async()=>{
 const a=validateAction(action(fixture[6]));let writes=0;
 await assert.rejects(executeAction({getContract:async()=>specification,getObject:async()=>({...structuredClone(base),reference:'changed'}),write:async()=>{writes++;}},a),/ORDER_CHANGED/);assert.equal(writes,0);
});
test('accounting import reads committed entry IDs and full values independently, cannot claim validation as import',async()=>{
 const a={type:'import_accounting_entries',request:{body:{entries:[structuredClone(entry)]}}};
 const client={listAll:async(resource,q)=>{assert.equal(resource,'accounting/entries');assert.equal(q.contractor_id,1);return [{entry_id:500,...structuredClone(entry)}];}};
 const result={valid:true,imported:1,entry_ids:[500]};const out=await accountingReadback(client,a,result);assert.equal(out.independent_readback,true);
 await assert.rejects(accountingReadback(client,a,{valid:true}),/IDs/);
 await assert.rejects(accountingReadback({listAll:async()=>[{entry_id:500,...entry,contractor_id:2}]},a,result),/mismatch/);
 assert.deepEqual(await accountingReadback({}, {type:'validate_accounting_entries'}, {valid:false,errors:[{entry_index:0,message:'bad'}]}),{validation_only:true,imported:false,valid:false,errors:[{entry_index:0,message:'bad'}]});
});
test('download returns original verified PDF bytes/hash and safe original filename, rejects missing storage',async()=>{
 const bytes=Buffer.from('%PDF-1.7\noriginal synthetic bytes');const client={get:async p=>{assert.equal(p,'/offers/10/files');return [{file_id:11,stored:true,filename:'Original 2026.pdf'}];},getBinary:async p=>{assert.equal(p,'/offers/10/files/11/content');return bytes;}};
 const out=await readApi(client,{method:'GET',path:'/offers/10/files/11/content'});assert.equal(out.filename,'Original 2026.pdf');assert.equal(out.kind,'file');assert.equal(out.content_base64,bytes.toString('base64'));assert.equal(out.sha256,createHash('sha256').update(bytes).digest('hex'));
 const sanitized=await readApi({...client,get:async()=>[{file_id:11,stored:true,filename:'../secret.pdf'}]},{path:'/offers/10/files/11/content'});assert.equal(sanitized.filename,'sibema-offer-10-file-11.pdf');
 await assert.rejects(readApi({...client,get:async()=>[]},{path:'/offers/10/files/11/content'}),/NOT_STORED/);
});
test('HTTP client refuses foreign origin, follows no redirects, bounds chunked and announced PDF bodies',async()=>{
 assert.throws(()=>new SibemaClient({username:'synthetic',password:'synthetic',host:'https://evil.invalid'}),/origin/);
 const bytes=Buffer.from('%PDF-1.7\nfixture');const requests=[];
 const c=new SibemaClient({username:'synthetic',password:'synthetic',fetchImpl:async(url,options)=>{requests.push({url,options});return url.endsWith('/authenticate')?Response.json({jwttoken:'synthetic'}):new Response(bytes);}});
 assert.deepEqual(await c.getBinary('/offers/10/files/11/content'),bytes);assert.ok(requests.every(r=>r.options.redirect==='error'));
 await assert.rejects(c.getBinary('https://evil.invalid'),/native offer/);
 for(const response of [new Response('not pdf'),new Response(bytes,{headers:{'content-length':String(16*1024*1024)}}),new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.alloc(8*1024*1024));controller.enqueue(Buffer.alloc(8*1024*1024));controller.close();}}))]){
  c.fetchImpl=async()=>response;await assert.rejects(c.getBinary('/offers/10/files/11/content'),/PDF|byte limit/);
 }
});
test('uncertain generic action remains durable across store reopen and refuses approval or payload replacement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sibema-api-durable-'));const file=join(dir,'test.sqlite');let store=new SibemaStore(file);
 try{const a=validateAction(action());store.prepareApprovedAction(a);store.approveAction(a.id,'Trini');store.claimApprovedAction(a.id);store.failApprovedAction(a.id,Object.assign(new Error('after write'),{outcomeUncertain:true}));store.close();store=new SibemaStore(file);assert.equal(store.approvedAction(a.id).status,'uncertain');assert.throws(()=>store.approveAction(a.id,'Trini'));a.request.body.name='changed';assert.throws(()=>store.prepareApprovedAction(a),/different exact content/);}finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('echoed requested values cannot silently differ in a successful generic mutation',async()=>{
 const a=validateAction(action());
 await assert.rejects(executeAction({getContract:async()=>specification,write:async()=>({customer_id:77}),getObject:async()=>({customer_id:77,vat_number:a.request.body.vat_number,name:'Wrong name'})},a),e=>e.outcomeUncertain===true&&/mismatch/.test(e.message));
});
