// Narrow official Saleorderfile UI extension. Provider paths never come from
// model arguments; each file is resolved under a freshly scoped native order.
import {createHash} from 'node:crypto';
import {sibemaOrigin as ORIGIN} from './provider-config.mjs';
const MAX=15*1024*1024;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const positive=v=>Number.isSafeInteger(v)&&v>0;
const hash=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function fail(message){throw Object.assign(Error('SIBEMA_ORDER_DOCUMENT: '+message),{code:'SIBEMA_ORDER_DOCUMENT_INVALID'});}
function filename(value){if(typeof value!=='string'||!/^[^/\\\x00-\x1f\x7f]{1,180}\.pdf$/i.test(value)||value!==value.trim())fail('safe PDF filename required');return value;}
export function validateOrderDocumentRequest(input,{remove=false}={}){
 if(!object(input)||!positive(input.orderId)||!object(input.body)||Object.keys(input).some(k=>!['orderId','body',...(remove?['fileId']:[])].includes(k)))fail('orderId and body required');
 const b=input.body;
 if(remove){if(!positive(input.fileId)||Object.keys(b).sort().join(',')!=='expectedFilename,expectedSha256'||!/^[a-f0-9]{64}$/.test(b.expectedSha256??''))fail('exact current file ID, filename and hash required');filename(b.expectedFilename);return input;}
 if(Object.keys(b).sort().join(',')!=='content_base64,filename')fail('only original PDF bytes and filename are accepted');filename(b.filename);
 if(typeof b.content_base64!=='string'||b.content_base64.length>Math.ceil(MAX/3)*4||!b.content_base64.length)fail('bounded canonical PDF base64 required');
 const bytes=Buffer.from(b.content_base64,'base64');if(bytes.toString('base64')!==b.content_base64||bytes.length<8||bytes.length>MAX||bytes.subarray(0,5).toString()!=='%PDF-')fail('original bounded PDF required');
 return input;
}
async function request(client,path,{method='GET',body,binary=false,write=false}={}){
 const allowed=method==='GET'&&/^\/rest\/saleorder\/[1-9]\d*$/.test(path)||method==='POST'&&['/rest/getByQuery','/rest/getFile','/rest/saleorderfile/create'].includes(path)||method==='DELETE'&&/^\/rest\/saleorderfile\/delete\/[1-9]\d*$/.test(path);
 if(client.host!==ORIGIN||!allowed)fail('unexpected tenant or route');
 if(!client.token||Date.now()>(client.tokenExpiresAt??0)-60000)await client.authenticate();
 // Match the official UI blob request. This provider labels valid PDF bytes
 // application/json and rejects an application/pdf-only Accept with HTTP500.
 // Original bytes, bounds and PDF signature remain independently validated.
 const response=await client.fetchImpl(ORIGIN+'/ERPBerma'+path,{method,headers:{authorization:'Bearer '+client.token,accept:binary?'application/json, text/plain, */*':'application/json',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Object.assign(Error('SIBEMA_ORDER_DOCUMENT: provider rejected operation ('+response.status+')'),{status:response.status});
 if(write){await response.body?.cancel();return;}
 const maximum=binary?MAX:4*1024*1024;if(Number(response.headers.get('content-length'))>maximum){await response.body?.cancel();fail('response exceeds bound');}
 const reader=response.body?.getReader();if(!reader)fail('missing provider response');const parts=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum){await reader.cancel();fail('response exceeds bound');}parts.push(Buffer.from(value));}}finally{reader.releaseLock();}
 const bytes=Buffer.concat(parts,size);if(binary){if(bytes.length<8||bytes.subarray(0,5).toString()!=='%PDF-')fail('provider file is not a PDF');return bytes;}
 try{return JSON.parse(bytes.toString('utf8'));}catch{fail('invalid provider JSON');}
}
async function order(client,id){
 if(!positive(id))fail('positive order ID required');
 const scoped=await client.getObject('orders',id),raw=await request(client,'/rest/saleorder/'+id);
 if(!object(scoped)||scoped.order_id!==id||!positive(scoped.customer_id)||!object(raw)||raw.saleorderid!==id||raw.branch!==null||raw.contractorid?.contractorid!==1||raw.customerid?.customerid!==scoped.customer_id||String(raw.serie)!==String(scoped.serie)||String(raw.number)!==String(scoped.number)||raw.reference!==scoped.reference)fail('order identity or tenant mismatch');
 return {raw,scoped};
}
function file(row,id){
 if(!object(row)||!positive(row.saleorderfileid)||row.saleorderid?.saleorderid!==id||typeof row.file!=='string'||!row.file||row.file.length>4096||/[\x00-\x1f\x7f]/.test(row.file)||typeof row.filename!=='string'||!row.filename||row.filename.length>255||/[\/\\\x00-\x1f\x7f]/.test(row.filename))fail('file schema or scoped parent mismatch');
 return {order_id:id,file_id:row.saleorderfileid,filename:row.filename};
}
async function files(client,parent){
 const rows=await request(client,'/rest/getByQuery',{method:'POST',body:{clazz:'saleorderfile',items:[{field:'saleorderid',operator:'OPERATOR_EQUAL',value:parent.raw}]}});
 if(!Array.isArray(rows)||rows.length>1000)fail('bounded file list required');const ids=new Set();for(const r of rows){const f=file(r,parent.scoped.order_id);if(ids.has(f.file_id))fail('duplicate file ID');ids.add(f.file_id);}return rows;
}
const ordered=rows=>[...rows].sort((a,b)=>a.saleorderfileid-b.saleorderfileid);
async function unchangedOrder(client,id,before){const current=await order(client,id);if(!same(before,current))fail('order changed during attachment operation');return current;}
async function pdf(client,row){return request(client,'/rest/getFile',{method:'POST',body:{path:row.file,completePath:true},binary:true});}
export async function readOrderFiles(client,id){const parent=await order(client,id),rows=await files(client,parent);return {order_id:id,files:rows.map(r=>file(r,id)),independent_readback:true,source:'official native Saleorderfile'};}
export async function readOrderPdf(client,id,fileId){
 if(!positive(fileId))fail('positive file ID required');const parent=await order(client,id),rows=await files(client,parent),row=rows.find(r=>r.saleorderfileid===fileId);if(!row)fail('file does not belong to this order');filename(row.filename);
 const bytes=await pdf(client,row);await unchangedOrder(client,id,parent);return {source:'SIBEMA',kind:'file',...file(row,id),mimeType:'application/pdf',bytes:bytes.length,sha256:hash(bytes),content_base64:bytes.toString('base64'),independent_readback:true};
}
export async function attachOrderPdf(client,input,{idempotencyKey,dispatchGuard}={}){
 validateOrderDocumentRequest(input);if(idempotencyKey!==undefined&&(typeof idempotencyKey!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)))fail('stable UUID idempotency key required');const {orderId,body}=input,bytes=Buffer.from(body.content_base64,'base64'),wanted=hash(bytes),parent=await order(client,orderId),before=await files(client,parent),existing=before.filter(r=>r.filename===body.filename);
 if(existing.length>1)fail('same filename is ambiguous');
 if(existing.length){const present=await pdf(client,existing[0]);if(hash(present)!==wanted)fail('filename already contains different bytes; preserve it');await unchangedOrder(client,orderId,parent);return {result:{...file(existing[0],orderId),created:false,already_present:true},readback:{...file(existing[0],orderId),bytes:present.length,sha256:wanted,independent_readback:true,order_preserved:true}};}
 const current=await unchangedOrder(client,orderId,parent);if(!same(ordered(before),ordered(await files(client,current))))fail('files changed before dispatch');
 let dispatched=false,phase='write';
 try{
  if(typeof dispatchGuard!=='function')fail('durable order PDF dispatch fence required');dispatchGuard();dispatched=true;const legacy=idempotencyKey===undefined;let response=null;if(legacy){await request(client,'/rest/saleorderfile/create',{method:'POST',body:{saleorderid:parent.raw,file:body.content_base64,filename:body.filename,documentfolderid:null},write:true});}else{response=await client.write(`/orders/${orderId}/files`,{method:'POST',body,idempotencyKey});}phase='readback';if(!legacy&&(!object(response)||response.order_id!==orderId||response.stored!==true||!positive(response.file_id)||response.filename!==body.filename))fail('provider response mismatch');
  const after=await files(client,parent),selected=after.filter(r=>r.filename===body.filename);if(selected.length!==1||(!legacy&&selected[0].saleorderfileid!==response.file_id)||before.some(r=>r.saleorderfileid===selected[0].saleorderfileid)||!same(ordered(before),ordered(after.filter(r=>r.saleorderfileid!==selected[0].saleorderfileid))))fail('file identity/count or unrelated files changed');
  const saved=await pdf(client,selected[0]);if(saved.length!==bytes.length||hash(saved)!==wanted)fail('original PDF byte readback mismatch');await unchangedOrder(client,orderId,parent);
  return {result:{...file(selected[0],orderId),created:true},readback:{...file(selected[0],orderId),bytes:saved.length,sha256:wanted,independent_readback:true,order_preserved:true,other_files_preserved:true}};
 }catch(error){if(dispatched)error.outcomeUncertain=true;throw error;}
}
export async function removeOrderPdf(client,input,{dispatchGuard}={}){
 validateOrderDocumentRequest(input,{remove:true});const {orderId,fileId,body}=input,parent=await order(client,orderId),before=await files(client,parent),row=before.find(r=>r.saleorderfileid===fileId);
 if(!row)return {result:{order_id:orderId,file_id:fileId,removed:false,already_absent:true},readback:{order_id:orderId,file_id:fileId,already_absent:true,independent_readback:true}};
 if(row.filename!==body.expectedFilename)fail('file name changed');const original=await pdf(client,row);if(hash(original)!==body.expectedSha256)fail('file bytes changed; preserve it');
 const current=await unchangedOrder(client,orderId,parent);if(!same(ordered(before),ordered(await files(client,current))))fail('files changed before removal');let dispatched=false,phase='write';
 try{
  if(typeof dispatchGuard!=='function')fail('durable order PDF dispatch fence required');dispatchGuard();dispatched=true;await request(client,'/rest/saleorderfile/delete/'+fileId,{method:'DELETE',write:true});phase='readback';const after=await files(client,parent);
  if(after.some(r=>r.saleorderfileid===fileId)||!same(ordered(before.filter(r=>r.saleorderfileid!==fileId)),ordered(after)))fail('removal or unrelated files readback mismatch');await unchangedOrder(client,orderId,parent);
  return {result:{order_id:orderId,file_id:fileId,removed:true},readback:{order_id:orderId,file_id:fileId,removed:true,original_sha256:body.expectedSha256,independent_readback:true,order_preserved:true,other_files_preserved:true}};
 }catch(error){if(dispatched)error.outcomeUncertain=true;throw error;}
}
