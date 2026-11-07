import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('server-only',()=>({}));
import {ProductStore} from './persistence';
import type {ProductContext} from './access';
import type {Order,ProductionState} from './contracts';
import {mutateReceiving,readReceiving,processReceivingReceipt,type ReceivingProvider,type ReceivingReceipt} from './receiving';
let root:string,ctx:ProductContext,provider:ReceivingProvider,documents:Record<string,unknown>[],sends:number;
const actor='11111111-1111-4111-8111-111111111111',validator='22222222-2222-4222-8222-222222222222';
const order:Order={rowNumber:2,client:'QA',description:null,readyStock:0,statusComment:null,deliveryDate:null,salesOrder:null,unitsPending:10,materialEta:null,materialStatus:null,showInLoad:null,loadText:null,loadKey:null,legacyFlag:null,workOrder:'OF-QA',reference:'PIECE',units:10,unitsDelivered:0,unitsReceivedTotal:0,unitsAtG03:0,materialMissing:10,productionStatus:'NO COMENÇAT',assignedMachine:null,priority:null};
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'receiving-isolated-'));ctx={installationId:'g03-qa',actor,grants:['read','orders','receipts','validate-receipts'],store:new ProductStore(root,'g03-qa')};
 await ctx.store.mutate('production',()=>({revision:0,capturedAt:'2026-10-27',sourceVersion:'QA',lookups:{machines:[],productionStatuses:['NO COMENÇAT']},orders:[order],phases:[],receipts:[],sageKeys:[],audit:[]}),()=>{});
 documents=[];sends=0;provider={applyProvider:true,applyProduction:true,authorize:async()=>{},prepare:r=>({id:r.id,company:'1',quantity:r.quantity}),read:async query=>({items:query==='PurchaseOrder'?[{CompanyId:1,Period:2026,Serie:'P',Number:5,VendorId:'V',Lines:[{Position:1,ProductId:'BAR',Quantity:10}]}]:query==='Stores'?[{CompanyId:1,Id:'GUID',Code:'A'}]:documents,complete:true,nextOffset:null}),send:async r=>{sends++;const document={id:r.id,CompanyId:1};documents.push(document);return document;},reconcile:(r,rows)=>rows.find(d=>d.id===r.id)??null,stockProof:async()=>true};
});
afterEach(async()=>rm(root,{recursive:true,force:true}));
const command=async(action:string,args:Record<string,unknown>={},who=ctx)=>mutateReceiving(who,{action,revision:(await readReceiving(ctx)).revision,reason:'Isolated QA explicit instruction',...args},provider);
async function seed(){const binding=await command('configure',{binding:{orderRow:2,purchase:{period:'2026',serie:'P',number:'5',position:1},vendorId:'V',productId:'BAR',storeId:'A',receiptSerie:'R',unit:'barres',sageUnitCode:'BAR',materialRequired:10,piecesPerUnit:2}}) as {id:string};return command('submit',{bindingId:binding.id,quantity:3,supplierDeliveryNote:'REAL-NOTE-QA',issueDate:'2026-10-27'})as Promise<ReceivingReceipt>;}
it('executes register→different validator→immutable outbox→provider confirmation→Production once, preserving unrelated rows',async()=>{
 const receipt=await seed(),before=await ctx.store.read<ProductionState>('production');
 const done=await command('validate',{id:receipt.id},{...ctx,actor:validator})as ReceivingReceipt;
 expect(done.state).toBe('complete');expect(sends).toBe(1);expect(done.outbox?.sha256).toMatch(/^[a-f0-9]{64}$/);expect(done.productionQuantity).toBe(6);
 const after=await ctx.store.read<ProductionState>('production');expect(after!.orders[0]).toMatchObject({reference:'PIECE',workOrder:'OF-QA',unitsReceivedTotal:6,unitsAtG03:6,materialMissing:4});expect(Object.hasOwn(after!.orders[0],'materialReference')).toBe(false);expect(Object.hasOwn(after!.orders[0],'materialUnit')).toBe(false);expect(Object.hasOwn(after!.orders[0],'materialRequired')).toBe(false);expect(after!.phases).toEqual(before!.phases);expect(after!.audit.filter(a=>a.action==='receiving.apply')).toHaveLength(1);
 expect((await command('sync',{id:receipt.id},{...ctx,actor:validator})as ReceivingReceipt).state).toBe('complete');expect(sends).toBe(1);expect(await ctx.store.read('production')).toEqual(after);
});
it('keeps both provider and Production unchanged by default, with a complete read-only preview',async()=>{
 delete provider.applyProvider;delete provider.applyProduction;const receipt=await seed(),before=await ctx.store.read('production');
 const preview=await command('preview',{id:receipt.id});expect(preview).toMatchObject({mode:'preview',providerWrites:false,productionWrites:false,production:{plannedPieces:6},applyEnabled:false});
 const result=await command('validate',{id:receipt.id},{...ctx,actor:validator});expect(result).toMatchObject({state:'validated',applyEnabled:false,blockedReason:'RECEIVING_APPLY_DISABLED'});expect(sends).toBe(0);expect(await ctx.store.read('production')).toEqual(before);
});
it('reconciles a send timeout after provider committed and never dispatches the same receipt twice',async()=>{
 const receipt=await seed();provider.send=async r=>{sends++;documents.push({id:r.id,CompanyId:1});throw Error('SAGE_PROVIDER_UNAVAILABLE');};
 expect(await command('validate',{id:receipt.id},{...ctx,actor:validator})).toMatchObject({state:'unknown',providerAttempts:1});
 expect(await processReceivingReceipt({...ctx,actor:validator},receipt.id,provider)).toMatchObject({state:'complete'});expect(sends).toBe(1);
 const before=await ctx.store.read('production');await processReceivingReceipt({...ctx,actor:validator},receipt.id,provider);expect(await ctx.store.read('production')).toEqual(before);expect(sends).toBe(1);
});
it('does not replay an unconfirmed send, and an unchanged poll does not accumulate revisions/backups',async()=>{
 const receipt=await seed();provider.send=async()=>{sends++;throw Error('SAGE_PROVIDER_UNAVAILABLE');};await command('validate',{id:receipt.id},{...ctx,actor:validator});
 expect(await processReceivingReceipt({...ctx,actor:validator},receipt.id,provider)).toMatchObject({state:'unknown',lastError:'SAGE_RECEIPT_NOT_CONFIRMED_NO_RESEND'});const before=await readReceiving(ctx);await processReceivingReceipt({...ctx,actor:validator},receipt.id,provider);expect(await readReceiving(ctx)).toMatchObject({revision:before.revision,receipts:before.receipts});expect(sends).toBe(1);expect((await ctx.store.read<ProductionState>('production'))!.orders[0].unitsReceivedTotal).toBe(0);
});
it('does not count a visible provider document as proof of stock effect',async()=>{
 const receipt=await seed();provider.stockProof=async()=>false;const before=await ctx.store.read('production');expect(await command('validate',{id:receipt.id},{...ctx,actor:validator})).toMatchObject({state:'awaiting-provider',lastError:'SAGE_STOCK_EFFECT_UNCONFIRMED'});expect(await ctx.store.read('production')).toEqual(before);expect(sends).toBe(1);
});
it('enforces the current actor, separate validation, explicit exact mapping and immutable supplier-note deduplication',async()=>{
 const receipt=await seed();await expect(command('validate',{id:receipt.id})).rejects.toMatchObject({status:403});
 await expect(command('submit',{bindingId:receipt.binding.id,quantity:4,supplierDeliveryNote:'REAL-NOTE-QA',issueDate:'2026-10-27'})).rejects.toMatchObject({status:409});
 const repeated=await command('submit',{bindingId:receipt.binding.id,quantity:3,supplierDeliveryNote:'REAL-NOTE-QA',issueDate:'2026-10-27'})as ReceivingReceipt;expect(repeated.id).toBe(receipt.id);expect((await readReceiving(ctx)).receipts).toHaveLength(1);
 await expect(command('configure',{binding:{...receipt.binding,productId:'SIMILAR'} })).rejects.toMatchObject({status:409});
 await expect(command('validate',{id:receipt.id},{...ctx,actor:validator,grants:['read','receipts']})).rejects.toMatchObject({status:403});
});

it.each(['QA','V7'])('preserves pre-existing material metadata exactly while counting only the approved piece equivalent (%s)',async version=>{
 await ctx.store.mutate<ProductionState,void>('production',()=>{throw Error('missing fixture');},s=>{s.sourceVersion=version;Object.assign(s.orders[0],{materialReference:'ORIGINAL-MATERIAL',materialUnit:'kg',materialRequired:777,formulaFields:['unitsPending','unitsAtG03','materialMissing']});});
 const receipt=await seed();const done=await command('validate',{id:receipt.id},{...ctx,actor:validator}) as ReceivingReceipt;
 expect(done.state).toBe('complete');expect(done.binding).toMatchObject({productId:'BAR',unit:'barres',materialRequired:10,piecesPerUnit:2});
 const state=await ctx.store.read<ProductionState>('production');expect(state!.orders[0]).toMatchObject({materialReference:'ORIGINAL-MATERIAL',materialUnit:'kg',materialRequired:777,unitsReceivedTotal:6,unitsAtG03:6,materialMissing:4});
 expect(state!.receipts[0]).toMatchObject({reference:'BAR',quantity:3,unit:'barres'});expect(state!.audit.filter(a=>a.action==='receiving.apply')).toHaveLength(1);
});
async function secondBinding(first:ReceivingReceipt,patch:Record<string,unknown>={}){
 await ctx.store.mutate<ProductionState,void>('production',()=>{throw Error('missing fixture');},s=>{if(!s.orders.some(o=>o.rowNumber===3))s.orders.push({...order,rowNumber:3,workOrder:'OF-QA-2'});});
 return command('configure',{binding:{...first.binding,orderRow:3,...patch}}) as Promise<{id:string}>;
}
it.each(['complete','unknown','validated'])('reserves the purchase-line total across separate OF bindings, including %s receipts',async state=>{
 const first=await seed();if(state==='unknown')provider.send=async()=>{sends++;throw Error('SAGE_PROVIDER_UNAVAILABLE');};if(state==='validated')provider.applyProvider=false;
 expect(await command('validate',{id:first.id},{...ctx,actor:validator})).toMatchObject({state});
 const binding=await secondBinding(first),second=await command('submit',{bindingId:binding.id,quantity:8,supplierDeliveryNote:'SECOND-NOTE-QA',issueDate:'2026-10-28'}) as ReceivingReceipt;
 const before=await ctx.store.read('production'),sent=sends;
 await expect(command('validate',{id:second.id},{...ctx,actor:validator})).rejects.toMatchObject({status:409});
 expect((await readReceiving(ctx)).receipts.find(r=>r.id===second.id)?.state).toBe('pending');expect(await ctx.store.read('production')).toEqual(before);expect(sends).toBe(sent);
});
it('does not reset purchase-line allocation when replacing a completed correspondence, and accepts the exact remainder',async()=>{
 const first=await seed();await command('validate',{id:first.id},{...ctx,actor:validator});
 const binding=await command('configure',{binding:first.binding}) as {id:string};expect(binding.id).not.toBe(first.binding.id);
 const second=await command('submit',{bindingId:binding.id,quantity:8,supplierDeliveryNote:'SECOND-NOTE-QA',issueDate:'2026-10-28'}) as ReceivingReceipt;
 await expect(command('validate',{id:second.id},{...ctx,actor:validator})).rejects.toMatchObject({status:409});
 const third=await command('submit',{bindingId:binding.id,quantity:7,supplierDeliveryNote:'THIRD-NOTE-QA',issueDate:'2026-10-28'}) as ReceivingReceipt;
 expect(await command('validate',{id:third.id},{...ctx,actor:validator})).toMatchObject({state:'complete'});expect(sends).toBe(2);
});
it('retains the explicit discrepancy override with an audit of the aggregate purchase-line excess',async()=>{
 const first=await seed();await command('validate',{id:first.id},{...ctx,actor:validator});const binding=await secondBinding(first);
 const second=await command('submit',{bindingId:binding.id,quantity:8,supplierDeliveryNote:'SECOND-NOTE-QA',issueDate:'2026-10-28'}) as ReceivingReceipt;
 await expect(command('validate',{id:second.id,allowOverReceipt:'true'},{...ctx,actor:validator})).rejects.toMatchObject({status:409});
 expect(await command('validate',{id:second.id,allowOverReceipt:true},{...ctx,actor:validator})).toMatchObject({state:'complete'});
 expect((await readReceiving(ctx)).audit.find(a=>a.action==='receiving.over-receipt')).toMatchObject({target:second.id,actor:validator,before:{ordered:10,prior:3},after:{quantity:8,total:11,allowOverReceipt:true}});
});
it('counts a different purchase line independently and rejects absent unit codes instead of defaulting them',async()=>{
 const first=await seed();await command('validate',{id:first.id},{...ctx,actor:validator});
 const originalRead=provider.read;provider.read=async(...args)=>{const page=await originalRead(...args);if(args[0]==='PurchaseOrder')(page.items[0].Lines as Record<string,unknown>[]).push({Position:2,ProductId:'BAR',Quantity:10});return page;};
 const invalid={...first.binding,orderRow:3};delete (invalid as Partial<typeof invalid>).sageUnitCode;
 await ctx.store.mutate<ProductionState,void>('production',()=>{throw Error('missing fixture');},s=>{s.orders.push({...order,rowNumber:3,workOrder:'OF-QA-2'});});
 await expect(command('configure',{binding:invalid})).rejects.toMatchObject({status:400});
 const binding=await secondBinding(first,{purchase:{...first.binding.purchase,position:2},sageUnitCode:''});
 const second=await command('submit',{bindingId:binding.id,quantity:8,supplierDeliveryNote:'SECOND-NOTE-QA',issueDate:'2026-10-28'}) as ReceivingReceipt;
 expect(await command('validate',{id:second.id},{...ctx,actor:validator})).toMatchObject({state:'complete'});expect(sends).toBe(2);
});
