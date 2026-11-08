// Scoped existing-line mutation using the same native UI entity as reference edits.
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {SibemaStore} from './store.mjs';
import {requestNative,safeLine} from './offer-reference-lines.mjs';
import {offerMutationSnapshot} from './offer-header-update.mjs';
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const id=v=>Number.isSafeInteger(v)&&v>0;
const fail=message=>{throw Error('SIBEMA_OFFER_LINE: '+message);};
const canonical=v=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export const offerLineSchema={type:'object',required:['expectedSnapshotSha256'],properties:{expectedSnapshotSha256:{type:'string',maxLength:64},price:{type:'number',minimum:0},quantity_from:{type:['number','null'],minimum:0},reference:{type:'string',maxLength:1000}}};
export const offerLineRoute=(method,path)=>['GET','PATCH'].includes(method)&&/^\/offers\/(?:\{id\}|[1-9]\d*)\/lines\/(?:\{lineId\}|[1-9]\d*)$/.test(path);
export function validateOfferLineUpdate(request){
 if(!object(request)||Object.keys(request).some(k=>!['offerId','lineId','body'].includes(k))||!id(request.offerId)||!id(request.lineId)||!object(request.body))fail('exact offer, existing line and patch required');
 const b=request.body;
 if(Object.keys(b).some(k=>!Object.hasOwn(offerLineSchema.properties,k))||!/^[a-f0-9]{64}$/.test(b.expectedSnapshotSha256??'')||Object.keys(b).length<2)fail('current snapshot hash and at least one supported change required');
 for(const k of ['price','quantity_from'])if(Object.hasOwn(b,k)&&!(k==='quantity_from'&&b[k]===null)&&(typeof b[k]!=='number'||!Number.isFinite(b[k])||b[k]<0))fail('invalid '+k);
 if(Object.hasOwn(b,'reference')&&(typeof b.reference!=='string'||!b.reference.trim()||b.reference!==b.reference.trim()||b.reference.length>1000||/[\x00-\x1f]/.test(b.reference)))fail('invalid exact reference');
 return request;
}
function selected(snapshot,offerId,lineId){
 const row=snapshot.lines.find(x=>x.line_id===lineId);
 if(!row||snapshot.header.customerofferid!==offerId)fail('line does not belong to offer');
 return row;
}
export async function readOfferLine(client,offerId,lineId,{fence}={}){
 if(!id(offerId)||!id(lineId))fail('invalid identity');
 const snapshot=await offerMutationSnapshot(client,offerId),line=selected(snapshot,offerId,lineId);
 let ownStore,reconciliation;
 try{
  const ledger=fence??(ownStore=new SibemaStore(process.env.SIBEMA_DB_PATH?.trim()||join(process.env.SIBEMA_DATA_DIR?.trim()||'/opt/trinalum/data/sibema','sibema.sqlite')));
  reconciliation=ledger.reconcileOfferMutation(offerId,canonical(snapshot));
 }finally{ownStore?.close();}
 return {offer_id:offerId,customer_id:snapshot.header.customerid.customerid,line:{...line,reference:line.description},expectedSnapshotSha256:hash(snapshot),independent_readback:true,...(reconciliation?{reconciliation}:{})};
}
export async function executeOfferLineUpdate(client,request,{fence,actionId}={}){
 validateOfferLineUpdate(request);const {offerId,lineId,body}=request;
 if(!fence?.claimOfferMutation||!fence?.releaseOfferMutation||typeof actionId!=='string'||actionId.length<8)fail('existing durable action/fence required');
 let claimed=false,uncertain=false,dispatched=false;
 try{
  const before=await offerMutationSnapshot(client,offerId),line=selected(before,offerId,lineId);
  if(hash(before)!==body.expectedSnapshotSha256)fail('offer or lines changed since read');
  const detail=safeLine(await requestNative(client,`/rest/customerofferdetail/${lineId}`));
  if(!same(detail,{line_id:lineId,offer_id:offerId,product_id:line.product_id,unit_id:line.unit_id,quantity_from:line.quantity_from,price:line.price,reference:line.description}))fail('independent line/parent changed');
  const next={...line,...(Object.hasOwn(body,'price')?{price:body.price}:{}),...(Object.hasOwn(body,'quantity_from')?{quantity_from:body.quantity_from}:{}),...(Object.hasOwn(body,'reference')?{description:body.reference}:{})};
  const expected={header:before.header,lines:before.lines.map(x=>x.line_id===lineId?next:x)};
  fence.claimOfferMutation(offerId,actionId,{snapshot:canonical(expected),line_id:lineId,changed:!same(line,next)});claimed=true;
  if(!same(before,await offerMutationSnapshot(client,offerId)))fail('concurrent offer or sibling change');
  if(!same(line,next)){
   const entity={customerofferdetailid:lineId,customerofferid:{customerofferid:offerId},productid:{productid:line.product_id},movementunitid:{movementunitid:line.unit_id},fromquantity:next.quantity_from,price:next.price,customerofferdetail:next.description};
   dispatched=true;
   try{await requestNative(client,'/rest/customerofferdetail/update',entity);}catch(error){if(error.definitiveRejection){dispatched=false;throw error;}uncertain=true;}
  }
  try{
   const after=await offerMutationSnapshot(client,offerId);
   if(!same(after,expected))fail('exact header, sibling, relationship or target preservation failed');
   const current=safeLine(await requestNative(client,`/rest/customerofferdetail/${lineId}`));
   if(!same(current,{line_id:lineId,offer_id:offerId,product_id:next.product_id,unit_id:next.unit_id,quantity_from:next.quantity_from,price:next.price,reference:next.description}))fail('target independent readback mismatch');
   uncertain=false;
   return {result:{offer_id:offerId,line_id:lineId,changed:!same(line,next)},readback:{offer_id:offerId,line_id:lineId,line:current,expectedSnapshotSha256:hash(after),independent_readback:true,line_identity_preserved:true,header_preserved:true,siblings_preserved:true,relationships_preserved:true}};
  }catch(error){if(dispatched){uncertain=true;error.outcomeUncertain=true;}throw error;}
 }finally{if(claimed&&!uncertain)fence.releaseOfferMutation(offerId,actionId);}
}
