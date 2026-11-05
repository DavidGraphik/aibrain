// Official UI entity deletes, never an arbitrary API or a child-delete fallback.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {openSync,closeSync,fstatSync,readSync,realpathSync,readFileSync,constants} from 'node:fs';
import {sibemaOrigin as origin} from './provider-config.mjs';
const actors=new Set(['Trini','Miguel','Nerea']);
export const deletionModuleSha256=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),id=v=>Number.isSafeInteger(v)&&v>0;
const canonical=v=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const stable=v=>JSON.stringify(canonical(v)),hash=v=>createHash('sha256').update(stable(v)).digest('hex'),same=(a,b)=>stable(a)===stable(b);
function fail(message){throw Object.assign(Error('SIBEMA_DELETE: '+message),{code:'SIBEMA_DELETE_INVALID'});}
const targetKey=kind=>kind==='tariff'?'tariffId':'offerId';
function identity(kind,input){if(!['tariff','offer'].includes(kind)||!object(input)||!id(input.customerId)||!id(input[targetKey(kind)]))fail('positive customer and target IDs required');}
export function validateDeletionRequest(kind,input){
 identity(kind,input);if(Object.keys(input).sort().join(',')!==['body','customerId',targetKey(kind)].sort().join(',')||!object(input.body)||Object.keys(input.body).sort().join(',')!=='expectedSnapshotSha256,proof'||!/^[a-f0-9]{64}$/.test(input.body.expectedSnapshotSha256??'')||typeof input.body.proof!=='string'||input.body.proof.length>2000)fail('exact signed preview and snapshot hash required');return input;
}
export const deletionKeyPath='/opt/trinalum/.secrets/sibema-deletion-proof.key';
// Stable tenant integration, independent of employee and credential rotation.
function integration(client){if(client.host!==origin)fail('native integration identity unavailable');return hash({provider:'SIBEMA',origin,contractor_id:1});}
function signingKey(client){
 const path=client.deletionKeyFile??deletionKeyPath;let fd;
 try{
  if(typeof path!=='string'||!path.startsWith('/')||realpathSync(path)!==path)fail('dedicated local signing key unavailable');
  fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const before=fstatSync(fd);
  if(!before.isFile()||before.nlink!==1||before.uid!==process.getuid()||(before.mode&0o7777)!==0o600||before.size<32||before.size>64)fail('dedicated local signing key metadata invalid');
  const key=Buffer.alloc(before.size);let offset=0;while(offset<key.length){const n=readSync(fd,key,offset,key.length-offset,null);if(!n)fail('dedicated key incomplete');offset+=n;}
  const after=fstatSync(fd);if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('dedicated key changed');return key;
 }catch{fail('dedicated local signing key unavailable or unsafe');}finally{if(fd!==undefined)closeSync(fd);}
}
function signature(client,payload){return createHmac('sha256',signingKey(client)).update(payload).digest('base64url');}
export function assertDeletionProof(client,kind,input,actor,now=Date.now()){
 validateDeletionRequest(kind,input);if(!actors.has(actor))fail('employee deletion scope required');
 const parts=input.body.proof.split('.');if(parts.length!==3||parts[0]!=='v1'||!/^[A-Za-z0-9_-]+$/.test(parts[1])||!/^[A-Za-z0-9_-]{43}$/.test(parts[2]))fail('invalid preview signature');
 const expected=signature(client,parts[1]),actual=parts[2];if(actual.length!==expected.length||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))fail('invalid preview signature');
 let p;try{const bytes=Buffer.from(parts[1],'base64url');if(bytes.toString('base64url')!==parts[1])fail('noncanonical preview');p=JSON.parse(bytes);}catch{fail('invalid preview payload');}
 if(!object(p)||Object.keys(p).sort().join(',')!=='actor,customerId,expiresAt,integration,issuedAt,kind,snapshotSha256,targetId,version'||p.version!==1||p.integration!==integration(client)||p.kind!==kind||p.actor!==actor||p.customerId!==input.customerId||p.targetId!==input[targetKey(kind)]||p.snapshotSha256!==input.body.expectedSnapshotSha256||!Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||p.issuedAt>now||p.expiresAt-p.issuedAt!==300000||p.expiresAt<=now)fail('preview expired or actor/target/snapshot mismatch');return p;
}
// Store structural error evidence, never provider text (which can contain SQL,
// customer data or credentials). Failure to read diagnostics preserves status.
async function providerErrorEvidence(response){
 const limit=16384,chunks=[];let bytes=0,complete=false,reader;
 try{
  reader=response.body?.getReader();
  if(reader)for(;;){const {done,value}=await reader.read();if(done){complete=true;break;}const remaining=limit-bytes;chunks.push(Buffer.from(value.subarray(0,remaining)));bytes+=Math.min(value.byteLength,remaining);if(value.byteLength>remaining||bytes===limit){await reader.cancel();break;}}
 }catch{/* Never replace a real provider rejection with a diagnostic error. */}
 finally{try{reader?.releaseLock();}catch{/* already released */}}
 const captured=Buffer.concat(chunks,bytes),text=captured.toString('utf8');let code=null;
 if(complete)try{const candidate=JSON.parse(text)?.code;if(['BAD_REQUEST','VALIDATION','NOT_FOUND','INTERNAL','FORBIDDEN','UNAUTHORIZED','CONFLICT'].includes(candidate))code=candidate;}catch{/* HTML and invalid JSON are not exposed. */}
 const signal=/foreign.?key|constraintviolation|integrityconstraint|sqlstate\D*23503/i.test(text)?'referential_integrity':/unsupported.?media|content.?type/i.test(text)?'media_contract':'unclassified';
 return {capturedBytes:bytes,complete,bodyPrefixSha256:createHash('sha256').update(captured).digest('hex'),code,signal};
}
async function native(client,path,{body,remove=false,dispatchGuard}={}){
 const query=path==='/rest/getByQuery',allowed=query||/^\/rest\/customer\/[1-9]\d*$/.test(path)||remove&&/^\/rest\/(?:customerproduct|customeroffer)\/delete\/[1-9]\d*$/.test(path);
 if(client.host!==origin||!allowed||query!==Boolean(body))fail('unexpected tenant or provider route');
 if(!client.token||Date.now()>(client.tokenExpiresAt??0)-60000)await client.authenticate();
 if(remove){if(typeof dispatchGuard!=='function'||typeof client.fetchImpl!=='function')fail('durable dispatch fence required');dispatchGuard();}
 // Official pL uses Axios.delete(data:null, Content-Type:application/json).
 // Its JSON transform sends the literal four-byte body "null", not no body.
 const r=await client.fetchImpl(origin+'/ERPBerma'+path,{method:remove?'DELETE':query?'POST':'GET',headers:{authorization:'Bearer '+client.token,accept:remove?'application/json, text/plain, */*':'application/json',...(query||remove?{'content-type':'application/json'}:{})},...(remove?{body:'null'}:query?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!r.ok){const evidence=await providerErrorEvidence(r);const error=Object.assign(Error('SIBEMA_DELETE: provider rejected '+(remove?'delete':'read')+' ('+r.status+'); provider_evidence='+JSON.stringify(evidence)),{status:r.status,providerEvidence:evidence});if(remove&&[400,401,403,404,409,422].includes(r.status))error.definitiveRejection=true;throw error;}
 if(remove){await r.body?.cancel();return;}
 const limit=8*1024*1024;if(Number(r.headers.get('content-length'))>limit){await r.body?.cancel();fail('response exceeds bound');}
 const reader=r.body?.getReader();if(!reader)fail('missing provider response');const chunks=[];let n=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;n+=value.byteLength;if(n>limit){await reader.cancel();fail('response exceeds bound');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks,n).toString());}catch{fail('invalid provider JSON');}
}
async function query(client,clazz,parentField,parent){
 const rows=await native(client,'/rest/getByQuery',{body:{clazz,items:[{field:parentField,operator:'OPERATOR_EQUAL',value:parent}]}}),key=clazz+'id';
 if(!Array.isArray(rows)||rows.length>1000)fail('bounded native rows required');const ids=new Set();for(const r of rows){if(!object(r)||!id(r[key])||ids.has(r[key])||r.branch!==null||r[parentField]?.[parentField]!==parent[parentField])fail('native row or parent mismatch');ids.add(r[key]);}return [...rows].sort((a,b)=>a[key]-b[key]);
}
async function customer(client,customerId){
 const scoped=await client.getObject('customers',customerId),raw=await native(client,'/rest/customer/'+customerId);
 if(!object(scoped)||scoped.customer_id!==customerId||!object(raw)||raw.customerid!==customerId||raw.branch!==null||raw.customer!==scoped.name||raw.idcardnumber!==scoped.vat_number)fail('scoped customer identity mismatch');return {scoped,raw};
}
async function customerOrders(client,customerId){
 const rows=[],seen=new Set();let total;
 for(let page=0;page<10;page++){
  const p=await client.get('/customers/'+customerId+'/orders?'+new URLSearchParams({page,size:200}));
  if(!object(p)||!Array.isArray(p.data)||p.page!==page||p.size!==200||!Number.isSafeInteger(p.total)||p.total<0||typeof p.has_next!=='boolean'||total!==undefined&&total!==p.total)fail('incomplete order coverage');total=p.total;
  for(const r of p.data){if(!object(r)||!id(r.order_id)||r.customer_id!==customerId||seen.has(r.order_id))fail('scoped order mismatch');seen.add(r.order_id);rows.push(r);}
  if(!p.has_next){if(rows.length!==total)fail('incomplete order coverage');return rows.sort((a,b)=>a.order_id-b.order_id);}
 }fail('order coverage limit');
}
async function portfolio(client,kind,customerId){
 const c=await customer(client,customerId);
 if(kind==='tariff')return {customer:c,rows:await query(client,'customerproduct','customerid',c.raw)};
 const headers=await query(client,'customeroffer','customerid',c.raw);if(headers.length>50)fail('offer portfolio exceeds deletion safety bound');
 const rows=new Array(headers.length);let next=0;
 await Promise.all(Array.from({length:Math.min(4,headers.length)},async()=>{for(;;){const i=next++;if(i>=headers.length)return;const header=headers[i];rows[i]={header,lines:await query(client,'customerofferdetail','customerofferid',header),files:await query(client,'customerofferfile','customerofferid',header)};}}));
 return {customer:c,rows,orders:await customerOrders(client,customerId)};
}
const find=(p,kind,targetId)=>p.rows.find(r=>(kind==='tariff'?r.customerproductid:r.header.customerofferid)===targetId);
function safeTarget(kind,target){
 if(kind==='tariff'){
  const fields=['branch','customerproductid','customerproduct','customerid','productid','saleorderid','taskid','since','until','fromquantity','toquantity','price','cost','remarks'];
  if(Object.keys(target).length!==fields.length||fields.some(k=>!Object.hasOwn(target,k))||!id(target.productid?.productid)||target.saleorderid!==null||target.taskid!==null)fail('tariff linked or schema changed');
  return {tariff_id:target.customerproductid,reference:target.customerproduct,product_id:target.productid.productid,price:target.price,remarks:target.remarks};
 }
 const h=target.header,fields=['branch','customerofferid','customeroffer','customerid','vendorid','paymentmethodid','incotermid','since','until','remarks','saleorderid','purchaseorderid'];
 if(Object.keys(h).length!==fields.length||fields.some(k=>!Object.hasOwn(h,k))||h.saleorderid!==null||h.purchaseorderid!==null)fail('offer linked or header schema changed');
 if(target.files.length)fail('offer has original files; preserve them');
 return {offer_id:h.customerofferid,description:h.customeroffer,line_count:target.lines.length,file_count:0};
}
function unlinked(p,kind,targetId){const t=find(p,kind,targetId);if(t){safeTarget(kind,t);if(kind==='offer'&&p.orders.some(r=>r.offer_id===targetId))fail('order references this offer');}return t;}
// Private host recovery helper only; no chat/API route. Hash complete reads
// without exporting customer/provider payloads or reading the signing key.
export async function readDeletionRecoverySnapshot(client,kind,input){
 identity(kind,input);if(Object.keys(input).sort().join(',')!==['customerId',targetKey(kind)].sort().join(','))fail('exact recovery read target required');
 const p=await portfolio(client,kind,input.customerId),target=unlinked(p,kind,input[targetKey(kind)]);if(!target)fail('recovery target absent; no retry authorization');
 return {integration:integration(client),snapshotSha256:hash(p),moduleSha256:deletionModuleSha256,atMs:Date.now(),targetSha256:hash(target),portfolioRows:p.rows.length,customerSha256:hash(p.customer)};
}
export async function previewDeletion(client,kind,input,actor){
 identity(kind,input);if(Object.keys(input).sort().join(',')!==['customerId',targetKey(kind)].sort().join(',')||!actors.has(actor))fail('trusted employee and exact preview target required');
 const p=await portfolio(client,kind,input.customerId),target=unlinked(p,kind,input[targetKey(kind)]);if(!target)fail('target absent; no deletion preview issued');
 const issuedAt=Date.now(),snapshotSha256=hash(p),payload={version:1,integration:integration(client),actor,kind,customerId:input.customerId,targetId:input[targetKey(kind)],snapshotSha256,issuedAt,expiresAt:issuedAt+300000},encoded=Buffer.from(stable(payload)).toString('base64url');
 return {customer_id:input.customerId,...safeTarget(kind,target),expectedSnapshotSha256:snapshotSha256,expiresAt:new Date(payload.expiresAt).toISOString(),proof:'v1.'+encoded+'.'+signature(client,encoded),independent_readback:true,warning:'Only this exact unlinked snapshot may be deleted. No child-delete fallback; original files block offer deletion.'};
}
export async function executeDeletion(client,kind,input,actor,{fence,actionId}={}){
 assertDeletionProof(client,kind,input,actor);const targetId=input[targetKey(kind)],before=await portfolio(client,kind,input.customerId),target=unlinked(before,kind,targetId);
 if(!target)return {result:{customer_id:input.customerId,[kind==='tariff'?'tariff_id':'offer_id']:targetId,removed:false,already_absent:true},readback:{independent_readback:true,absence_verified:true,deletion_attributed:false}};
 if(hash(before)!==input.body.expectedSnapshotSha256)fail('snapshot changed since signed preview');
 // Recheck the whole customer portfolio immediately before the single dispatch.
 const current=await portfolio(client,kind,input.customerId);if(!same(current,before))fail('concurrent customer/target/portfolio change');assertDeletionProof(client,kind,input,actor);
 const resource={integration:integration(client),kind,customerId:input.customerId,targetId};
 if(!fence||typeof fence.claimDeletionResource!=='function'||typeof fence.finishDeletionResource!=='function'||typeof actionId!=='string'||actionId.length<8||actionId.length>200)fail('durable native resource fence and action identity required');
 let dispatched=false,phase='delete';
 try{
  await native(client,'/rest/'+(kind==='tariff'?'customerproduct':'customeroffer')+'/delete/'+targetId,{remove:true,dispatchGuard:()=>{assertDeletionProof(client,kind,input,actor);if(!fence.claimDeletionResource({...resource,actionId,actor,snapshotSha256:input.body.expectedSnapshotSha256,requestHash:hash(input),moduleSha256:deletionModuleSha256}))throw Object.assign(Error('SIBEMA_DELETE: native resource already fenced; no replay permitted'),{code:'SIBEMA_DELETE_RESOURCE_FENCED'});dispatched=true;}});phase='readback';
  const after=await portfolio(client,kind,input.customerId),expected={...before,rows:before.rows.filter(r=>r!==target)};
  if(find(after,kind,targetId)||!same(after,expected))fail('absence or unrelated customer/portfolio preservation not verified');
  if(kind==='offer'){
   const lines=await query(client,'customerofferdetail','customerofferid',target.header),files=await query(client,'customerofferfile','customerofferid',target.header);
   if(lines.length||files.length)fail('provider left target children; no cleanup fallback dispatched');
  }
  fence.finishDeletionResource(resource,actionId,'completed');
  return {result:{customer_id:input.customerId,[kind==='tariff'?'tariff_id':'offer_id']:targetId,removed:true},readback:{independent_readback:true,absence_verified:true,customer_preserved:true,other_records_preserved:true,approved_snapshot_sha256:input.body.expectedSnapshotSha256,no_child_delete_dispatched:true,resource_fence_completed:true}};
 }catch(error){if(dispatched){if(phase==='readback'||!error.definitiveRejection){error.outcomeUncertain=true;error.code='SIBEMA_DELETE_OUTCOME_UNCERTAIN';}try{fence.finishDeletionResource(resource,actionId,error.outcomeUncertain?'uncertain':'rejected');}catch{error.outcomeUncertain=true;error.code='SIBEMA_DELETE_OUTCOME_UNCERTAIN';}}throw error;}
}
