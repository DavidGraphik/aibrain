import 'server-only';
import path from 'node:path';
import { FileLocalUserStore } from '@/auth/local-user-store';
import type { InstallationConfig } from '@/config/installation-schema';
import { productContextForIdentity, type ProductContext } from './access';
import { ProductStore } from './persistence';
import { requireProduct } from './contracts';
import { g03SageReadForIdentity, g03SageReceivingCapabilities, g03SageReceiptWriteForIdentity } from '@/connectors/g03-sage-service';
import { buildSagePurchaseReceipt, parseSageReceiptWriteResponse, reconcileSagePurchaseReceipt, reconcileSageReceiptStock, type SageReceiptIdentity } from '@/connectors/g03-sage-receipt';
import { processReceivingReceipt, receivingReadDates, type ReceivingProvider, type ReceivingReceipt, type ReceivingState } from './receiving';

const expected=(r:ReceivingReceipt)=>({id:r.id,vendorId:r.binding.vendorId,productId:r.binding.productId,quantity:String(r.quantity)});
export async function receivingCapabilities(ctx:ProductContext){if(ctx.syntheticPreview)return {providerWrites:false,productionWrites:false};return g03SageReceivingCapabilities(ctx.installationId,ctx.actor).catch(()=>({providerWrites:false,productionWrites:false}));}
export async function createReceivingProvider(ctx:ProductContext,installation:Readonly<InstallationConfig>):Promise<ReceivingProvider>{
  requireProduct(!ctx.syntheticPreview,'El circuit SAGE real no està disponible en una vista de prova.',403);
  const capabilities=await receivingCapabilities(ctx);
  const read:ReceivingProvider['read']=async(query,parameters,skip=0,take=50)=>g03SageReadForIdentity(ctx.installationId,ctx.actor,'read',{query,parameters,skip,take}) as ReturnType<ReceivingProvider['read']>;
  return {applyProvider:capabilities.providerWrites,applyProduction:capabilities.productionWrites,read,
    authorize:async()=>{const actor=await new FileLocalUserStore(installation.paths.usersRoot).read(ctx.actor);requireProduct(actor?.enabled&&actor.userId===ctx.actor,'La persona validadora ja no té un compte actiu.',403);const fresh=await productContextForIdentity(ctx.installationId,ctx.actor,installation);requireProduct(fresh.grants.includes('validate-receipts'),'Permís de validació revocat.',403);const policy=await g03SageReceivingCapabilities(ctx.installationId,ctx.actor);requireProduct(policy.providerWrites&&policy.productionWrites,'Moviments automàtics desactivats a la instal·lació.',403);},
    prepare:r=>{const price=r.binding.sourceLine.Price;requireProduct((typeof price==='number'||typeof price==='string')&&Number.isFinite(Number(price))&&Number(price)>=0,'Falta el preu verificable de la línia de compra SAGE.',409);requireProduct(Object.hasOwn(r.binding.sourceLine,'VATIncluded')&&(r.binding.sourceLine.VATIncluded===false||r.binding.sourceLine.VATIncluded===0)&&['ProductDiscountRate','ProductDiscount2Rate','ProductDiscount3Rate'].every(k=>Object.hasOwn(r.binding.sourceLine,k)&&(r.binding.sourceLine[k]===0||typeof r.binding.sourceLine[k]==='string'&&/^0(?:\.0+)?$/.test(r.binding.sourceLine[k] as string))),'Cal verificar explícitament que el preu no inclou IVA i els tres descomptes són zero abans de preparar l’albarà.',409);requireProduct(typeof r.binding.sageUnitCode==='string','Falta la unitat SAGE explícita.',409);return buildSagePurchaseReceipt({...expected(r),issueDate:r.issueDate,receiptSerie:r.binding.receiptSerie,storeId:r.binding.storeId,unitPrice:String(price),purchase:{period:Number(r.binding.purchase.period),serie:r.binding.purchase.serie,number:Number(r.binding.purchase.number),position:r.binding.purchase.position},measureUnit:r.binding.sageUnitCode}).payload;},
    send:async r=>{requireProduct(r.outbox,'Outbox no preparada.',409);const raw=await g03SageReceiptWriteForIdentity(ctx.installationId,ctx.actor,r.outbox.payload);return parseSageReceiptWriteResponse(raw) as unknown as Record<string,unknown>;},
    reconcile:(r,documents)=>{const result=reconcileSagePurchaseReceipt(expected(r),documents);requireProduct(result.status!=='multiple'&&result.status!=='incompatible','Albarà SAGE ambigu o incompatible: cal revisar-lo, no reenviar-lo.',409);return result.status==='one'?result.document as unknown as Record<string,unknown>:null;},
    stockProof:async(r,document)=>{const records:Record<string,unknown>[]=[];let skip:number|null=0;const parameters=receivingReadDates(r.issueDate);while(skip!==null){const current=skip,p=await read('StockMovements',parameters,skip,50);if(p.limitReached)return false;records.push(...p.items);skip=p.nextOffset;if(records.length>5000||skip!==null&&(!Number.isSafeInteger(skip)||skip<=current||skip>5000)||skip===null&&!p.complete)return false;}
      return reconcileSageReceiptStock({...expected(r),document:document as SageReceiptIdentity,storeId:r.binding.storeId,measureUnit:r.binding.sageUnitCode},records).status==='one';},
  };
}
/** Runs outside LLM automation turns. Disabled installation policy means no provider calls or mutations. */
export async function drainG03Receiving(installation:Readonly<InstallationConfig>){
  if(installation.installationId!=='g03-production')return {processed:0};
  const store=new ProductStore(path.join(installation.paths.dataRoot,'g03-products'),installation.installationId),state=await store.read<ReceivingState>('sage-receiving');
  if(!state)return {processed:0};let processed=0;
  for(const receipt of state.receipts.filter(r=>r.validator&&r.state!=='pending'&&r.state!=='complete').slice(0,2)){
    try{const ctx=await productContextForIdentity(installation.installationId,receipt.validator!,installation),provider=await createReceivingProvider(ctx,installation);if(!provider.applyProvider||!provider.applyProduction)continue;await processReceivingReceipt(ctx,receipt.id,provider);processed++;}catch{/* Retain durable outbox; never log supplier records, private paths or tokens. */}
  }
  return {processed};
}
