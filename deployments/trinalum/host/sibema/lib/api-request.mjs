import {readOfferLine,offerLineRoute} from './offer-line-update.mjs';
import {previewDeletion} from './guarded-deletes.mjs';
import {readCustomerTariffs} from './customer-tariffs.mjs';
import {readCustomerNotes} from './customer-notes.mjs';
import {readOrderFiles,readOrderPdf} from './order-documents.mjs';
import {readPaymentMethods,readOrderConditions} from './payment-methods.mjs';
import {createHash} from 'node:crypto';
import {readOfferLineReferences,readProductCatalog} from './offer-reference-lines.mjs';
import {contractFingerprint,validateApiRequest} from './api-contract.mjs';

export function nativeApiAction(action){
 const request={...action.request};delete request.contractHash;
 const validated=validateApiRequest(request);
 if(validated.method==='GET')throw Error('SIBEMA reads use the read command, never approved writes');
 const hash=contractFingerprint(validated.method,validated.path);
 if(action.request.contractHash!==undefined&&action.request.contractHash!==hash)throw Error('SIBEMA_CONTRACT_CHANGED: prepare and approve the current schema again');
 const {method,path,body,expectedOrder}=validated;
 const routes=[
  ['PATCH',/^\/offers\/(\d+)\/lines\/(\d+)$/,'update_offer_line',m=>({offerId:Number(m[1]),lineId:Number(m[2]),body})],
  ['POST',/^\/customers$/,'create_customer',()=>({body})],
  ['POST',/^\/offers$/,'create_offer',()=>({body})],
  ['PUT',/^\/offers\/(\d+)$/,'update_offer',m=>({offerId:Number(m[1]),body})],
  ['POST',/^\/offers\/(\d+)\/files$/,'attach_offer_pdf',m=>({offerId:Number(m[1]),body})],
  ['POST',/^\/offers\/(\d+)\/convert-to-order$/,'convert_offer_to_order',m=>({offerId:Number(m[1]),body})],
  ['PATCH',/^\/orders\/(\d+)$/,'update_order',m=>({orderId:Number(m[1]),body,expectedOrder})],
  ['POST',/^\/orders\/(\d+)\/deliveries$/,'record_order_delivery',m=>({orderId:Number(m[1]),body,expectedOrder})],
  ['PATCH',/^\/orders\/(\d+)\/status$/,'update_order_status',m=>({orderId:Number(m[1]),body})],
  ['POST',/^\/invoices\/purchase$/,'create_purchase_invoice',()=>({body})],
  ['PATCH',/^\/invoices\/purchase\/(\d+)$/,'update_purchase_invoice_status',m=>({invoiceId:Number(m[1]),body})],
  ['POST',/^\/accounting\/entries$/,'import_accounting_entries',()=>({body})],
  ['POST',/^\/accounting\/entries\/validate$/,'validate_accounting_entries',()=>({body})],
 ];
 for(const [verb,pattern,type,build] of routes){const m=pattern.exec(path);if(method===verb&&m)return {native:{...action,type,request:build(m)},validated,contractHash:hash};}
 throw Error('SIBEMA mutation lacks a verified readback adapter');
}
export function preparedApiRequest(action){const {validated,contractHash}=nativeApiAction(action);return {method:validated.method,path:validated.path,...(Object.keys(validated.query).length?{query:validated.query}:{}),body:validated.body,...(validated.expectedOrder?{expectedOrder:validated.expectedOrder}:{}),contractHash};}
export async function assertProviderContract(client,action){
 const {validated,contractHash}=nativeApiAction(action);
 if(offerLineRoute(validated.method,validated.path))return; // Native integration schema; actual origin/parent are checked by its fixed UI primitive.
 const current=await client.getContract();
 if(contractFingerprint(validated.method,validated.path,current)!==contractHash)throw Error('SIBEMA_CONTRACT_CHANGED: provider schema changed; no write performed');
}
export function stableApiKey(action){const h=createHash('sha256').update('trinalum-production:'+action.id).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
export function validateAccountingBody(body){
 if(!Array.isArray(body?.entries)||!body.entries.length||body.entries.length>1000)throw Error('A bounded nonempty accounting batch is required');
 for(const entry of body.entries){
  if(entry.contractor_id!==1||!entry.date||!Array.isArray(entry.lines)||entry.lines.length<2)throw Error('Each accounting entry requires contractor1, date and balanced lines');
  let debit=0,credit=0;
  for(const line of entry.lines){if(typeof line.account!=='string'||!line.account.trim())throw Error('Native accounting account code required');for(const key of ['debit','credit'])if(line[key]!==undefined&&(typeof line[key]!=='number'||!Number.isFinite(line[key])||line[key]<0))throw Error('Accounting debit/credit must be nonnegative numbers');debit+=line.debit??0;credit+=line.credit??0;}
  if(Math.abs(debit-credit)>0.005)throw Error('Accounting entry debit and credit do not balance');
 }
}
function includesFields(actual,expected){if(Array.isArray(expected))return Array.isArray(actual)&&actual.length===expected.length&&expected.every((v,i)=>includesFields(actual[i],v));if(expected&&typeof expected==='object')return actual&&typeof actual==='object'&&Object.entries(expected).every(([k,v])=>includesFields(actual[k],v));return actual===expected;}
export async function accountingReadback(client,action,result){
 if(action.type==='validate_accounting_entries'){
  if(typeof result?.valid!=='boolean')throw Error('Provider omitted accounting validation result');
  return {validation_only:true,imported:false,valid:result.valid,errors:result.errors??[]};
 }
 const requested=action.request.body.entries,ids=result?.entry_ids;
 if(result?.valid!==true||result.imported!==requested.length||!Array.isArray(ids)||ids.length!==requested.length||new Set(ids).size!==ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<1))throw Error('Accounting import did not return exact committed entry IDs/count');
 const from=requested.map(e=>e.date).sort()[0],to=requested.map(e=>e.date).sort().at(-1);
 const entries=await client.listAll('accounting/entries',{contractor_id:1,from,to,size:200});
 const readback=ids.map((id,i)=>{const row=entries.find(e=>e.entry_id===id);if(!row||row.contractor_id!==1||!includesFields(row,requested[i]))throw Error('Imported accounting entry independent readback mismatch');return row;});
 return {imported:readback.length,entry_ids:ids,entries:readback,independent_readback:true};
}
export async function readApi(client,input,{actor,fence}={}){
 if(offerLineRoute(input?.method??'GET',input?.path)&& (input.method??'GET')==='GET'){const r=validateApiRequest(input,{readOnly:true});const m=/^\/offers\/(\d+)\/lines\/(\d+)$/.exec(r.path);return {source:'SIBEMA',method:'GET',path:r.path,data:await readOfferLine(client,Number(m[1]),Number(m[2]),{fence}),integrationProjection:true,untrustedSourceContent:true};}
 const deletion=/^\/customers\/([1-9]\d*)\/(tariffs|offers)\/([1-9]\d*)\/deletion-preview$/.exec(input?.path??'');
 if(deletion){
  if((input.method??'GET')!=='GET'||Object.keys(input).some(k=>!['method','path','query'].includes(k))||(input.query!==undefined&&(!input.query||typeof input.query!=='object'||Array.isArray(input.query)||Object.keys(input.query).length)))throw Error('SIBEMA_API_CONTRACT: deletion preview is GET-only without query');
  const kind=deletion[2]==='tariffs'?'tariff':'offer',customerId=Number(deletion[1]),targetId=Number(deletion[3]);
  return {source:'SIBEMA',method:'GET',path:input.path,data:await previewDeletion(client,kind,{customerId,[kind==='tariff'?'tariffId':'offerId']:targetId},actor),integrationProjection:true,untrustedSourceContent:true};
 }
 if(/^\/orders\/[1-9]\d*\/files(?:\/[1-9]\d*\/content)?$/.test(input?.path??'')){
  if((input.method??'GET')!=='GET'||Object.keys(input).some(k=>!['method','path','query'].includes(k))||(input.query!==undefined&&(!input.query||typeof input.query!=='object'||Array.isArray(input.query)||Object.keys(input.query).length)))throw Error('SIBEMA_API_CONTRACT: order document projection is GET-only without query');
  const parts=input.path.split('/'),orderId=Number(parts[2]);
  if(parts.length>4)return readOrderPdf(client,orderId,Number(parts[4]));
  return {source:'SIBEMA',method:'GET',path:input.path,data:await readOrderFiles(client,orderId),integrationProjection:true,untrustedSourceContent:true};
 }
 if(/^\/customers\/[1-9]\d*\/tariffs$/.test(input?.path??'')){
  if((input.method??'GET')!=='GET'||Object.keys(input).some(k=>!['method','path','query'].includes(k))||(input.query!==undefined&&(!input.query||typeof input.query!=='object'||Array.isArray(input.query)||Object.keys(input.query).length)))throw Error('SIBEMA_API_CONTRACT: customer tariffs are a read-only projection without query');
  return {source:'SIBEMA',method:'GET',path:input.path,data:await readCustomerTariffs(client,Number(input.path.split('/')[2])),integrationProjection:true,untrustedSourceContent:true};
 }

 if(/^\/customers\/[1-9]\d*\/notes$/.test(input?.path??'')){
  if((input.method??'GET')!=='GET'||Object.keys(input).some(k=>!['method','path','query'].includes(k))||(input.query!==undefined&&(!input.query||typeof input.query!=='object'||Array.isArray(input.query)||Object.keys(input.query).length)))throw Error('SIBEMA_API_CONTRACT: customer notes are a read-only projection without query');
  return {source:'SIBEMA',method:'GET',path:input.path,data:await readCustomerNotes(client,Number(input.path.split('/')[2])),integrationProjection:true,untrustedSourceContent:true};
 }

 if(input?.path==='/payment-methods'||/^\/orders\/[1-9]\d*\/conditions$/.test(input?.path??'')){
  if((input.method??'GET')!=='GET'||Object.keys(input).some(k=>!['method','path','query'].includes(k)))throw Error('SIBEMA_API_CONTRACT: conditions are read-only projections');
  if(input.path!=='/payment-methods'&&(input.query!==undefined&&(!input.query||typeof input.query!=='object'||Array.isArray(input.query)||Object.keys(input.query).length)))throw Error('SIBEMA_API_CONTRACT: conditions accept no query');
  return {source:'SIBEMA',method:'GET',path:input.path,data:input.path==='/payment-methods'?await readPaymentMethods(client,input.query??{}):await readOrderConditions(client,Number(input.path.split('/')[2])),integrationProjection:true,untrustedSourceContent:true};
 }

 if(input?.path==='/product-catalog'){
  if((input.method??'GET')!=='GET'||Object.keys(input).some(k=>!['method','path','query'].includes(k)))throw Error('SIBEMA_API_CONTRACT: product-catalog is a read-only integration projection');
  return {source:'SIBEMA',method:'GET',path:'/product-catalog',data:await readProductCatalog(client,input.query??{}),integrationProjection:true,untrustedSourceContent:true};
 }
 const r=validateApiRequest(input,{readOnly:true});
 if(/^\/offers\/\d+\/files\/\d+\/content$/.test(r.path)){
  const [,offerId,fileId]=/^\/offers\/(\d+)\/files\/(\d+)\/content$/.exec(r.path);
  const list=await client.get(`/offers/${offerId}/files`),files=Array.isArray(list)?list:list?.data??[];
  const file=files.find(f=>String(f.file_id)===fileId);
  if(!file||file.stored!==true)throw Error('SIBEMA_FILE_NOT_STORED');
  const bytes=await client.getBinary(r.path);
  const candidate=String(file.filename??'');
  const filename=/^[^/\\\x00-\x1f]{1,180}\.pdf$/i.test(candidate)?candidate:`sibema-offer-${offerId}-file-${fileId}.pdf`;
  return {source:'SIBEMA',kind:'file',offer_id:Number(offerId),file_id:Number(fileId),mimeType:'application/pdf',filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),content_base64:bytes.toString('base64')};
 }
 const data=await client.get(r.route);
 return {source:'SIBEMA',method:'GET',path:r.path,query:r.query,data:/^\/offers\/\d+$/.test(r.path)&&Array.isArray(data?.lines)?await readOfferLineReferences(client,data):data,untrustedSourceContent:true};
}

// Compare every echoed requested field; retain explicit coverage for fields the
// provider does not echo as native IDs (town, incoterm, payment method, etc.).
export function verifyGenericReadback(action,readback){
 if(['record_order_delivery','update_order','attach_offer_pdf','validate_accounting_entries','import_accounting_entries'].includes(action.type))return {independent_readback:true,specific_adapter:true};
 const verified=[],unverifiable=[];
 function visit(actual,expected,path='body'){
  if(Array.isArray(expected)){
   if(!Array.isArray(actual)||actual.length!==expected.length)throw Error(`SIBEMA readback mismatch: ${path}`);
   expected.forEach((value,i)=>visit(actual[i],value,`${path}[${i}]`));return;
  }
  if(expected&&typeof expected==='object'){
   for(const[key,value]of Object.entries(expected)){
    const label=`${path}.${key}`;
    if(key==='contractor_id'){unverifiable.push(label+' (enforced as1 by request/company binding)');continue;}
    if(key==='status_id'&&actual?.status?.id!==undefined){if(actual.status.id!==value)throw Error(`SIBEMA readback mismatch: ${label}`);verified.push(label);continue;}
    if(!actual||!Object.hasOwn(actual,key)){unverifiable.push(label);continue;}
    visit(actual[key],value,label);
   }
   return;
  }
  if(actual!==expected)throw Error(`SIBEMA readback mismatch: ${path}`);verified.push(path);
 }
 visit(readback,action.request.body);
 return {independent_readback:true,verified_fields:verified,unverifiable_fields:unverifiable,all_requested_fields_echoed:unverifiable.length===0};
}
