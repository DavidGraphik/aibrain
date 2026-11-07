import 'server-only';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { ResourceLockManager } from '@/storage';
import { grant, type ProductContext } from './access';
import { date, number, object, requireProduct, text, type ProductionState, type Audit } from './contracts';
import { recalculateV7, v7EditEffects } from './v7-logic';

export type SageDocumentKey = { period:string; serie:string; number:string; position:number };
export type MaterialBinding = { id:string; orderRow:number; workOrder:string; orderReference:string|number|null; orderUnits:number|null; purchase:SageDocumentKey; vendorId:string; productId:string; storeId:string; receiptSerie:string; unit:string; sageUnitCode:string; materialRequired:number; piecesPerUnit:number; approvedBy:string; approvedAt:string; sourceOrder:Record<string,unknown>; sourceLine:Record<string,unknown> };
export type ReceivingReceipt = { id:string; key:string; binding:MaterialBinding; quantity:number; supplierDeliveryNote:string; issueDate:string; actor:string; createdAt:string; state:'pending'|'validated'|'sending'|'unknown'|'awaiting-provider'|'complete'; validator?:string; validatedAt?:string; provider?:Record<string,unknown>; outbox?:{payload:Record<string,unknown>;sha256:string}; providerAttempts:number; lastError?:string; completedAt?:string; productionQuantity?:number };
export type ReceivingState = { revision:number; bindings:MaterialBinding[]; receipts:ReceivingReceipt[]; audit:Audit[] };
export type ReceivingProvider = {
  applyProvider?:boolean; applyProduction?:boolean;
  authorize?():Promise<void>;
  stockProof(receipt:ReceivingReceipt,document:Record<string,unknown>):Promise<boolean>;
  read(query:string,parameters:Record<string,string>,skip?:number,take?:number):Promise<{items:Record<string,unknown>[];nextOffset:number|null;complete:boolean;limitReached?:boolean}>;
  prepare(receipt:ReceivingReceipt):Record<string,unknown>;
  send(receipt:ReceivingReceipt):Promise<Record<string,unknown>>;
  reconcile(receipt:ReceivingReceipt,documents:Record<string,unknown>[]):Record<string,unknown>|null;
};
const empty=():ReceivingState=>({revision:0,bindings:[],receipts:[],audit:[]});
const stringCode=(value:unknown,max=128)=>{requireProduct(typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f]/.test(value),'Codi invàlid.');return value;};
const actorAudit=(ctx:ProductContext,s:ReceivingState,action:string,target:string,before:unknown,after:unknown,reason:string)=>s.audit.push({at:new Date().toISOString(),actor:ctx.actor,action,target,before,after,reason});
const fingerprint=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const orderIdentity=(x:Record<string,unknown>)=>({period:String(x.Period??''),serie:String(x.Serie??''),number:String(x.Number??'')});
const purchaseLineIdentity=(key:SageDocumentKey)=>JSON.stringify([Number(key.period),key.serie,Number(key.number),key.position]);
/** Posting may occur after the supplier date. Read through today's SAGE-local date; pagination still fails closed at its cap. */
export function receivingReadDates(issueDate:string){const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());return {FechaInicial:issueDate,FechaFinal:today>issueDate?today:issueDate};}
const positive=(x:unknown)=>number(x,Number.EPSILON);
const providerError=(e:unknown)=>e instanceof Error&&/^SAGE_[A-Z_]+$/.test(e.message)?e.message:'SAGE_OPERATION_UNCONFIRMED';
export async function readReceiving(ctx:ProductContext){grant(ctx,'read');const s=await ctx.store.read<ReceivingState>('sage-receiving')??empty();return {...s,permissions:{configure:ctx.grants.includes('orders')&&ctx.grants.includes('validate-receipts'),submit:ctx.grants.includes('receipts'),validate:ctx.grants.includes('validate-receipts')},readAt:new Date().toISOString()};}

async function exactPurchase(provider:ReceivingProvider,key:SageDocumentKey){
  const value=await provider.read('PurchaseOrder',{Ejercicio:key.period,Serie:key.serie,Numero:key.number},0,50);
  requireProduct(value.complete&&!value.limitReached,'La compra retornada és parcial; no es pot vincular.',409);
  const headers=value.items.filter(row=>String(row.CompanyId)==='1'&&JSON.stringify(orderIdentity(row))===JSON.stringify({period:key.period,serie:key.serie,number:key.number}));
  requireProduct(headers.length===1,'Compra no trobada o ambigua.',409);const header=headers[0];requireProduct(Array.isArray(header.Lines),'La compra no conté línies verificables.',409);
  const lines=header.Lines.filter((row:unknown)=>row&&typeof row==='object'&&!Array.isArray(row)&&Number((row as Record<string,unknown>).Position)===key.position) as Record<string,unknown>[];
  requireProduct(lines.length===1,'Línia de compra no trobada o ambigua.',409);return {header,line:lines[0]};
}
export async function mutateReceiving(ctx:ProductContext,input:unknown,provider:ReceivingProvider){
  requireProduct(!ctx.syntheticPreview,'Les operacions de recepció no estan disponibles en aquesta vista de prova.',403);
  grant(ctx,'read');const b=object(input),action=text(b.action,40),reason=text(b.reason,1000),revision=number(b.revision);requireProduct(Number.isSafeInteger(revision),'Revisió invàlida.');
  requireProduct(['configure','submit','validate','sync','preview'].includes(action),'Acció de recepció desconeguda.');
  if(action==='configure'){
    grant(ctx,'orders');grant(ctx,'validate-receipts');const raw=object(b.binding),purchase=object(raw.purchase);
    const key:SageDocumentKey={period:text(purchase.period,4),serie:typeof purchase.serie==='string'?purchase.serie:'',number:text(purchase.number,12),position:number(purchase.position,1)};
    requireProduct(/^(19|20|21)\d{2}$/.test(key.period)&&/^\d+$/.test(key.number)&&key.serie.length<=32&&Number.isSafeInteger(key.position),'Identitat de compra invàlida.');
    const row=number(raw.orderRow,1),production=await ctx.store.read<ProductionState>('production');const order=production?.orders.find(o=>o.rowNumber===row);requireProduct(order?.workOrder,'OF no trobada.',404);
    const source=await exactPurchase(provider,key),productId=stringCode(source.line.ProductId,20),vendorId=stringCode(source.header.VendorId,15);
    requireProduct(raw.productId===productId&&raw.vendorId===vendorId,'La referència o el proveïdor no coincideixen exactament amb SAGE.',409);
    requireProduct(typeof raw.receiptSerie==='string'&&raw.receiptSerie.length<=10,'Indica explícitament la sèrie dels albarans SAGE (pot ser buida).');const receiptSerie=raw.receiptSerie;
    const storeId=stringCode(raw.storeId,4),unit=text(raw.unit,50);requireProduct(typeof raw.sageUnitCode==='string'&&raw.sageUnitCode.length<=10&&!/[\u0000-\u001f\u007f]/.test(raw.sageUnitCode),'Indica explícitament el codi d’unitat SAGE (pot ser buit).');const sageUnitCode=raw.sageUnitCode;
    const binding:MaterialBinding={id:randomUUID(),orderRow:row,workOrder:order.workOrder,orderReference:order.reference,orderUnits:order.units,purchase:key,vendorId,productId,storeId,receiptSerie,unit,sageUnitCode,materialRequired:positive(raw.materialRequired),piecesPerUnit:positive(raw.piecesPerUnit),approvedBy:ctx.actor,approvedAt:new Date().toISOString(),sourceOrder:Object.fromEntries(['CompanyId','Period','Serie','Number','VendorId','IssueDate'].map(k=>[k,source.header[k]])),sourceLine:source.line};
    const stores=await provider.read('Stores',{},0,50);requireProduct(stores.complete&&stores.items.filter(v=>String(v.CompanyId??v.CodigoEmpresa)==='1'&&String(v.Code??v.Id??v.CodigoAlmacen)===storeId).length===1,'Almacén no verificable en SAGE.',409);
    return ctx.store.mutate<ReceivingState,MaterialBinding>('sage-receiving',empty,s=>{requireProduct(s.bindings.length<5000,'Límit de correspondències assolit.',409);const old=s.bindings.find(x=>x.orderRow===row&&JSON.stringify(x.purchase)===JSON.stringify(key));if(old){requireProduct(!s.receipts.some(x=>x.binding.id===old.id&&x.state!=='complete'),'Hi ha recepcions pendents amb aquesta correspondència.',409);s.bindings=s.bindings.filter(x=>x.id!==old.id);}s.bindings.push(binding);actorAudit(ctx,s,'receiving.configure',binding.id,old??null,binding,reason);return binding;},revision);
  }
  if(action==='submit'){
    grant(ctx,'receipts');const id=text(b.bindingId,36),quantity=positive(b.quantity),supplierDeliveryNote=text(b.supplierDeliveryNote,100),issueDate=date(b.issueDate);
    return ctx.store.mutate<ReceivingState,ReceivingReceipt>('sage-receiving',empty,s=>{const binding=s.bindings.find(x=>x.id===id);requireProduct(binding,'Correspondència no trobada.',404);const key=fingerprint({company:'1',vendor:binding.vendorId,note:supplierDeliveryNote,purchase:binding.purchase,product:binding.productId});const existing=s.receipts.find(x=>x.key===key);if(existing){requireProduct(existing.quantity===quantity&&existing.issueDate===issueDate&&existing.binding.orderRow===binding.orderRow&&existing.binding.workOrder===binding.workOrder,'Aquest albarà ja existeix amb una quantitat o data diferent.',409);return existing;}requireProduct(s.receipts.length<10000,'Límit de recepcions assolit.',409);const receipt:ReceivingReceipt={id:randomUUID(),key,binding:structuredClone(binding),quantity,supplierDeliveryNote,issueDate,actor:ctx.actor,createdAt:new Date().toISOString(),state:'pending',providerAttempts:0};s.receipts.push(receipt);actorAudit(ctx,s,'receiving.submit',receipt.id,null,receipt,reason);return receipt;},revision);
  }
  if(action==='preview'){
    grant(ctx,'read');const id=text(b.id,36),state=await ctx.store.read<ReceivingState>('sage-receiving')??empty(),receipt=state.receipts.find(x=>x.id===id);requireProduct(receipt,'Recepció no trobada.',404);const purchase=await exactPurchase(provider,receipt.binding.purchase);const production=await ctx.store.read<ProductionState>('production');const order=production?.orders.find(x=>x.rowNumber===receipt.binding.orderRow);requireProduct(order?.workOrder===receipt.binding.workOrder,'L’OF ha canviat; cal revisar la correspondència.',409);
    return {mode:'preview',providerWrites:false,productionWrites:false,receipt,sourceVerifiedAt:new Date().toISOString(),sourceCompany:'1',currentPurchaseQuantity:purchase.line.Quantity,production:{orderRow:order.rowNumber,workOrder:order.workOrder,currentUnitsReceivedTotal:order.unitsReceivedTotal,plannedPieces:receipt.quantity*receipt.binding.piecesPerUnit},steps:['registre durable de quantitat/albarà','validació per una altra persona autoritzada','outbox amb correlació única','confirmació d’albarà i moviment d’estoc SAGE','comptabilització única a Producció'],providerPayload:provider.prepare(receipt),applyEnabled:provider.applyProvider===true&&provider.applyProduction===true};
  }
  grant(ctx,'validate-receipts');const id=text(b.id,36);
  if(action==='validate'){
    await ctx.store.mutate<ReceivingState,void>('sage-receiving',empty,s=>{const receipt=s.receipts.find(x=>x.id===id);requireProduct(receipt,'Recepció no trobada.',404);requireProduct(receipt.actor!==ctx.actor,'La recepció ha de validar-la una altra persona autoritzada.',403);if(receipt.state!=='pending'){requireProduct(receipt.validator===ctx.actor,'Recepció ja validada per una altra persona.',409);return;}const source=receipt.binding.sourceLine,ordered=Number(source.Quantity),allocated=s.receipts.filter(x=>x.id!==id&&purchaseLineIdentity(x.binding.purchase)===purchaseLineIdentity(receipt.binding.purchase)&&x.state!=='pending');requireProduct(allocated.every(x=>x.binding.sageUnitCode===receipt.binding.sageUnitCode),'Les recepcions de la línia tenen unitats SAGE diferents; cal revisar-les.',409);const prior=allocated.reduce((sum,x)=>sum+x.quantity,0);requireProduct(Number.isFinite(ordered)&&ordered>0&&Number.isFinite(prior),'Quantitat de compra no verificable.',409);requireProduct(prior+receipt.quantity<=ordered||b.allowOverReceipt===true,'Recepció superior a la compra: cal acceptar explícitament la discrepància.',409);const before=structuredClone(receipt);receipt.state='validated';receipt.validator=ctx.actor;receipt.validatedAt=new Date().toISOString();actorAudit(ctx,s,'receiving.validate',id,before,receipt,reason);if(prior+receipt.quantity>ordered)actorAudit(ctx,s,'receiving.over-receipt',id,{purchase:receipt.binding.purchase,ordered,prior},{quantity:receipt.quantity,total:prior+receipt.quantity,allowOverReceipt:true},reason);},revision);
  }else{const s=await ctx.store.read<ReceivingState>('sage-receiving')??empty();requireProduct(s.revision===revision,'Algú ha canviat les dades. Actualitza abans de continuar.',409);const receipt=s.receipts.find(x=>x.id===id);requireProduct(receipt?.validator===ctx.actor,'Només el validador pot continuar aquest moviment.',403);}
  return processReceivingReceipt(ctx,id,provider);
}

async function updateReceipt(ctx:ProductContext,id:string,fn:(r:ReceivingReceipt)=>void){const state=await ctx.store.read<ReceivingState>('sage-receiving'),old=state?.receipts.find(r=>r.id===id);requireProduct(old,'Recepció no trobada.',404);const candidate=structuredClone(old);fn(candidate);if(JSON.stringify(old)===JSON.stringify(candidate))return candidate;return ctx.store.mutate<ReceivingState,ReceivingReceipt>('sage-receiving',empty,s=>{const receipt=s.receipts.find(x=>x.id===id);requireProduct(receipt,'Recepció no trobada.',404);fn(receipt);return structuredClone(receipt);});}
async function deliveryNotes(provider:ReceivingProvider,receipt:ReceivingReceipt){
  const all:Record<string,unknown>[]=[];let skip:number|null=0;
  const parameters=receivingReadDates(receipt.issueDate);
  while(skip!==null){const current=skip,page=await provider.read('PurchaseDeliveryNotes',parameters,skip,50);requireProduct(!page.limitReached,'Cobertura parcial dels albarans: no es pot confirmar el moviment.',409);all.push(...page.items);skip=page.nextOffset;requireProduct(all.length<=5000&&(skip===null||Number.isSafeInteger(skip)&&skip>current&&skip<=5000),'Límit de conciliació assolit.',409);if(skip===null)requireProduct(page.complete,'Consulta d’albarans incompleta.',409);}
  return all;
}
export async function processReceivingReceipt(ctx:ProductContext,id:string,provider:ReceivingProvider){
  requireProduct(!ctx.syntheticPreview,'Les operacions de recepció no estan disponibles en aquesta vista de prova.',403);
  grant(ctx,'validate-receipts');const locks=new ResourceLockManager({rootDirectory:path.join(ctx.store.root,'.receiving-processing')});
  return locks.withLock(id,async lease=>{
    let s=await ctx.store.read<ReceivingState>('sage-receiving')??empty(),receipt=s.receipts.find(x=>x.id===id);requireProduct(receipt&&receipt.validator===ctx.actor,'Recepció no autoritzada.',403);requireProduct(receipt.state!=='pending','La recepció encara no està validada.',409);
    if(receipt.state==='complete')return receipt;
    if(provider.applyProvider!==true||provider.applyProduction!==true)return {...receipt,applyEnabled:false,blockedReason:'RECEIVING_APPLY_DISABLED',providerWrites:false,productionWrites:false};
    await provider.authorize?.();
    const binding=receipt.binding,production=await ctx.store.read<ProductionState>('production'),target=production?.orders.find(o=>o.rowNumber===binding.orderRow);requireProduct(target?.workOrder===receipt.binding.workOrder&&target.reference===receipt.binding.orderReference&&target.units===receipt.binding.orderUnits,'L’OF ha canviat; revisa la correspondència abans de qualsevol moviment.',409);
    // A process that died after persisting `sending` may already have changed SAGE.
    // Reconcile first; an unconfirmed send is never replayed.
    const documents=await deliveryNotes(provider,receipt),found=provider.reconcile(receipt,documents);
    if(found){receipt=await updateReceipt(ctx,id,r=>{r.provider=found;r.state='awaiting-provider';});}
    else if(receipt.state==='validated'&&receipt.providerAttempts===0){
      const current=await exactPurchase(provider,receipt.binding.purchase);requireProduct(String(current.header.VendorId)===receipt.binding.vendorId&&['ProductId','Quantity','QuantityMeasureUnit','Price','VATIncluded','VATTaxRate','ProductDiscountRate','ProductDiscount2Rate','ProductDiscount3Rate'].every(k=>JSON.stringify(current.line[k]??null)===JSON.stringify(receipt!.binding.sourceLine[k]??null)),'La línia de compra SAGE ha canviat; cal revisar-la abans d’enviar.',409);
      await lease.assertHeld();await provider.authorize?.();receipt=await updateReceipt(ctx,id,r=>{r.outbox??={payload:provider.prepare(r),sha256:''};r.outbox.sha256=fingerprint(r.outbox.payload);r.state='sending';r.providerAttempts+=1;});
      try{const result=await provider.send(receipt);receipt=await updateReceipt(ctx,id,r=>{r.provider=result;r.state='awaiting-provider';});}
      catch(error){receipt=await updateReceipt(ctx,id,r=>{r.state='unknown';r.lastError=providerError(error);});return receipt;}
      await lease.assertHeld();const confirmed=provider.reconcile(receipt,await deliveryNotes(provider,receipt));if(!confirmed)return receipt;receipt=await updateReceipt(ctx,id,r=>{r.provider=confirmed;});
    }else{return updateReceipt(ctx,id,r=>{r.state='unknown';r.lastError='SAGE_RECEIPT_NOT_CONFIRMED_NO_RESEND';});}
    await lease.assertHeld();await provider.authorize?.();
    if(!await provider.stockProof(receipt,receipt.provider??{}))return updateReceipt(ctx,id,r=>{r.state='awaiting-provider';r.lastError='SAGE_STOCK_EFFECT_UNCONFIRMED';});
    const pieces=receipt.quantity*receipt.binding.piecesPerUnit;requireProduct(Number.isFinite(pieces)&&pieces>0,'Conversió de material invàlida.',409);
    const committed=receipt;
    await ctx.store.mutate<ProductionState,void>('production',()=>{throw Error('Production missing');},production=>{
      if(production.audit.some(a=>a.action==='receiving.apply'&&a.target===id))return;
      const order=production.orders.find(x=>x.rowNumber===committed.binding.orderRow);requireProduct(order?.workOrder===committed.binding.workOrder&&order.reference===committed.binding.orderReference&&order.units===committed.binding.orderUnits,'L’OF ha canviat; cal revisar la correspondència abans de comptabilitzar.',409);
      const before=structuredClone(order); // Physical material metadata remains in the receipt ledger; never overwrite the sheet's original metadata.
      order.unitsReceivedTotal=(order.unitsReceivedTotal??0)+pieces;
      if(production.sourceVersion==='V7')Object.assign(order,recalculateV7(order));else{order.unitsAtG03=(order.unitsAtG03??0)+pieces;if(typeof order.units==='number')order.materialMissing=Math.max(0,order.units-order.unitsAtG03);}
      order.materialStatus=(order.materialMissing??0)<=0?'REBUT':'PARCIAL';if(production.sourceVersion==='V7')Object.assign(order,v7EditEffects(order,{materialStatus:order.materialStatus}));
      production.receipts.push({id,workOrder:committed.binding.workOrder,purchaseOrder:[committed.binding.purchase.period,committed.binding.purchase.serie,committed.binding.purchase.number,committed.binding.purchase.position].join('/'),reference:committed.binding.productId,quantity:committed.quantity,unit:committed.binding.unit,actor:committed.actor,status:'validated',validator:committed.validator});
      production.audit.push({at:new Date().toISOString(),actor:ctx.actor,action:'receiving.apply',target:id,before,after:{order,receipt:committed},reason:'Recepció validada, albarà SAGE confirmat; conversió explícita i comptabilització única'});
    });
    return updateReceipt(ctx,id,r=>{r.state='complete';r.completedAt=new Date().toISOString();r.productionQuantity=pieces;delete r.lastError;});
  });
}
