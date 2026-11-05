import {beforeEach, afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
vi.mock('server-only', () => ({}));
import {validateDataset, type ProductionState} from './contracts';
import {ProductStore} from './persistence';
import {reconcileProductionSource, syncProductionSource} from './source-sync';
import type {ProductContext} from './access';
const hash = 'a'.repeat(64);
const base = () => validateDataset({sourceVersion:'V7', sourceHash:hash, capturedAt:'2026-10-15T10:00:00Z',lookups:{machines:['M1','M2'],productionStatuses:['PENDENT','EN CURS']},orders:[{rowNumber:29,workOrder:'OF1',reference:'REF1',client:'Client',description:'Peça',units:10,unitsDelivered:0,assignedMachine:'M1',statusComment:'Origen',productionStatus:'PENDENT'}],phases:[],catalog:[],tasks:[],intake:[],deliveredHistory:[]});
const current = (): ProductionState => ({...base(),revision:3,receipts:[],sageKeys:[],audit:[]});
let root:string, ctx:ProductContext;
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'g03-source-sync-'));ctx={installationId:'g03-qa',actor:'11111111-1111-4111-8111-111111111111',grants:['read','import'],store:new ProductStore(root,'g03-qa')};});
afterEach(async()=>rm(root,{recursive:true,force:true}));
it('merges distinct field edits and preserves the local row identity after a source reorder',()=>{
 const local=current(), remote=base();local.orders[0].statusComment='Local';remote.orders[0].assignedMachine='M2';remote.orders[0].rowNumber=37;
 const plan=reconcileProductionSource(local,base(),remote);
 expect(plan.conflicts).toEqual([]);expect(plan.dataset?.orders[0]).toMatchObject({rowNumber:29,assignedMachine:'M2',statusComment:'Local'});
});
it('blocks same-field conflicts, source removals with local edits, and receipt-linked removals',()=>{
 const local=current(),remote=base();local.orders[0].statusComment='Local';remote.orders[0].statusComment='Remot';
 expect(reconcileProductionSource(local,base(),remote).conflicts).toMatchObject([{field:'statusComment'}]);
 remote.orders=[];expect(reconcileProductionSource(local,base(),remote).conflicts.length).toBeGreaterThan(0);
 const withReceipt=current();withReceipt.receipts=[{id:'r',workOrder:'OF1',purchaseOrder:'p',reference:'REF1',quantity:1,unit:'u',actor:ctx.actor,status:'pending'}];
 expect(reconcileProductionSource(withReceipt,base(),remote).conflicts[0].reason).toContain('recepcions');
});
it('preserves new local and remote rows with non-colliding persistent row ids',()=>{
 const local=current(),remote=base();local.orders.push({...local.orders[0],rowNumber:30,workOrder:'LOCAL'});remote.orders.push({...remote.orders[0],rowNumber:30,workOrder:'REMOTE'});
 const plan=reconcileProductionSource(local,base(),remote);expect(plan.conflicts).toEqual([]);
 expect(plan.dataset?.orders.map(o=>[o.workOrder,o.rowNumber])).toEqual([['OF1',29],['REMOTE',31],['LOCAL',30]]);
});
it('retains legitimate duplicate historical and intake rows instead of collapsing them',()=>{
 const b=base();b.intake=[{rowNumber:2,reference:'R',client:'C',description:'D',status:null},{rowNumber:3,reference:'R',client:'C',description:'D',status:null}];
 const s={...b,revision:1,receipts:[],sageKeys:[],audit:[]};expect(reconcileProductionSource(s,b,b).dataset?.intake).toHaveLength(2);
});
it('commits through the existing versioned CAS store and resumes from a persisted source baseline',async()=>{
 await ctx.store.mutate('production',current,()=>{});
 const state=await ctx.store.read<ProductionState>('production');const incoming=base();incoming.sourceHash='b'.repeat(64);incoming.orders[0].assignedMachine='M2';
 const source={fileId:'SYNTHETIC_DRIVE_FILE',modifiedAt:'2026-10-20T10:00:00Z',version:'22'};
 expect(await syncProductionSource(ctx,{source,dataset:incoming,baseline:base(),revision:state!.revision,apply:true})).toMatchObject({applied:true,revision:5});
 expect((await ctx.store.read<ProductionState>('production'))?.orders[0].assignedMachine).toBe('M2');
 expect(await syncProductionSource(ctx,{source,dataset:incoming,revision:5,apply:true})).toMatchObject({applied:false,unchanged:true});
 await expect(syncProductionSource(ctx,{source:{...source,fileId:'OTHER_SYNTHETIC_FILE'},dataset:incoming,revision:5,apply:true})).rejects.toMatchObject({status:409});
 await expect(syncProductionSource(ctx,{source:{...source,modifiedAt:'2026-10-19T10:00:00Z'},dataset:incoming,revision:5,apply:true})).rejects.toMatchObject({status:409});
});
it('requires import permission, exact initial baseline provenance, and a fresh revision',async()=>{
 await ctx.store.mutate('production',current,()=>{});const source={fileId:'SYNTHETIC_DRIVE_FILE',modifiedAt:'2026-10-20T10:00:00Z',version:'22'};
 await expect(syncProductionSource({...ctx,grants:['read']},{source,dataset:base(),baseline:base(),revision:4,apply:true})).rejects.toMatchObject({status:403});
 await expect(syncProductionSource(ctx,{source,dataset:base(),revision:4,apply:true})).rejects.toMatchObject({status:409});
 await expect(syncProductionSource(ctx,{source,dataset:base(),baseline:base(),revision:3,apply:true})).rejects.toMatchObject({status:409});
});
it('keeps unresolved local fields pending after safely importing the rest, and accepts only an exact reviewed resolution',async()=>{
 const b=base(),local=current();local.orders[0].statusComment='Local';await ctx.store.mutate('production',()=>local,()=>{});
 const incoming=base();incoming.sourceHash='b'.repeat(64);incoming.orders[0].statusComment='Source';incoming.orders[0].assignedMachine='M2';
 const source={fileId:'SYNTHETIC_DRIVE_FILE',modifiedAt:'2026-10-20T10:00:00Z',version:'22'};
 const first=await syncProductionSource(ctx,{source,dataset:incoming,baseline:b,revision:4,apply:true,allowSafePartial:true});
 expect(first).toMatchObject({applied:true,revision:5,conflicts:[{field:'statusComment'}]});
 expect((await ctx.store.read<ProductionState>('production'))?.orders[0]).toMatchObject({statusComment:'Local',assignedMachine:'M2'});
 const retry=await syncProductionSource(ctx,{source,dataset:incoming,revision:5,apply:true,allowSafePartial:true});
 expect(retry).toMatchObject({applied:false,unchanged:true,conflicts:[{field:'statusComment'}]});
 const exact={collection:'orders',key:first.conflicts[0].key,field:'statusComment',take:'source' as const,expectedLocal:'Local',expectedSource:'Source',reason:'Explicit owner choice on these exact field values'};
 const resolved=await syncProductionSource(ctx,{source,dataset:incoming,revision:5,apply:true,allowSafePartial:true,resolutions:[exact]});
 expect(resolved).toMatchObject({applied:true,revision:6,conflicts:[]});expect((await ctx.store.read<ProductionState>('production'))?.orders[0].statusComment).toBe('Source');
});
it('archives unlinked source phases without weakening active phase validation',()=>{
 const b=base();const archived={rowNumber:4,workOrder:'DELIVERED1',phaseNumber:1,machine:'OLD MACHINE',state:'EN ESPERA',priority:null,observations:'Original record'};
 expect(()=>validateDataset({...b,phases:[archived]})).toThrow('Fase sense OF');
 const value=validateDataset({...b,sourcePhaseArchive:[archived]});expect(value.sourcePhaseArchive).toEqual([archived]);
 expect(reconcileProductionSource({...current(),sourcePhaseArchive:[archived]},base(),base()).dataset.sourcePhaseArchive).toEqual([archived]);
});

it('keeps a locally archived order retired when the source only reorders its formula-owned load key',()=>{
 const b=base();Object.assign(b.orders[0],{formulaFields:['loadKey'],loadKey:'M1|0000|29'});
 const local={...current(),orders:[],deliveredHistory:[{...b.orders[0],rowNumber:1,productionStatus:'ENTREGAT'}]};
 const incoming=structuredClone(b);Object.assign(incoming.orders[0],{rowNumber:37,loadKey:'M1|0000|37'});
 const plan=reconcileProductionSource(local,b,incoming);
 expect(plan.conflicts).toEqual([]);expect(plan.dataset.orders).toEqual([]);expect(plan.dataset.deliveredHistory).toEqual(validateDataset(local).deliveredHistory);
 // Literal values and business edits must still conflict with local removal.
 for(const changed of [{formulaFields:[]},{statusComment:'Real source business edit'},{assignedMachine:'M2'}]){
  const remote=structuredClone(incoming);Object.assign(remote.orders[0],changed);
  expect(reconcileProductionSource(local,b,remote).conflicts).toMatchObject([{field:'*'}]);
 }
 const literal=structuredClone(b);delete literal.orders[0].formulaFields;
 expect(reconcileProductionSource(local,literal,incoming).conflicts).toMatchObject([{field:'*'}]);
});

it('never clears an existing sticky row conflict without an exact explicit choice, even after its source baseline advances',async()=>{
 const b=base();Object.assign(b.orders[0],{formulaFields:['loadKey'],loadKey:'M1|0000|29'});
 const key=JSON.stringify(['OF1','REF1','Client']);
 const conflict={collection:'orders',key,field:'*',reason:'Previously recorded source deletion conflict'};
 const local={...current(),orders:[],deliveredHistory:[{...b.orders[0],rowNumber:1,productionStatus:'ENTREGAT'}]};
 await ctx.store.mutate('production',()=>local,()=>{});
 const incoming=structuredClone(b);Object.assign(incoming.orders[0],{rowNumber:37,loadKey:'M1|0000|37',statusComment:'Later source change'});incoming.sourceHash='b'.repeat(64);
 const source={fileId:'SYNTHETIC_DRIVE_FILE',modifiedAt:'2026-10-26T10:00:00Z',version:'24'};
 const first=await syncProductionSource(ctx,{source,dataset:incoming,baseline:b,revision:4,apply:true,allowSafePartial:true});
 expect(first).toMatchObject({applied:true,revision:5,conflicts:[{field:'*'}]});
 expect(reconcileProductionSource({...local,sourceSync:undefined},incoming,incoming,[],[conflict]).conflicts).toMatchObject([{field:'*'}]);
 const exact={collection:'orders',key,field:'*',take:'local' as const,expectedLocal:null,expectedSource:structuredClone(incoming.orders[0]),reason:'Reviewed archived order, exact source row and local absence'};
 const wrong=await syncProductionSource(ctx,{source,dataset:incoming,revision:5,apply:true,allowSafePartial:true,resolutions:[{...exact,expectedSource:{...exact.expectedSource,statusComment:'Older source'}}]});
 expect(wrong).toMatchObject({applied:false,unchanged:true,conflicts:[{field:'*'}]});
 const resolved=await syncProductionSource(ctx,{source,dataset:incoming,revision:5,apply:true,allowSafePartial:true,resolutions:[exact]});
 expect(resolved).toMatchObject({applied:true,revision:6,conflicts:[],resolved:[{field:'*',reason:exact.reason}]});
 const after=await ctx.store.read<ProductionState>('production');
 expect(after?.orders).toEqual([]);expect(after?.deliveredHistory).toEqual(validateDataset(local).deliveredHistory);
 expect(after?.audit.at(-1)).toMatchObject({action:'source.sync',after:{resolutions:[{field:'*',reason:exact.reason}],pendingConflicts:[]}});
});

it('supports an exact source removal choice but never drops receipt- or SAGE-linked local rows through row resolution',()=>{
 const local=current(),b=base(),incoming=base();local.orders[0].statusComment='Local edit';incoming.orders=[];
 const key=JSON.stringify(['OF1','REF1','Client']);
 const exact={collection:'orders',key,field:'*',take:'source' as const,expectedLocal:structuredClone(local.orders[0]),expectedSource:null,reason:'Reviewed exact source removal'};
 expect(reconcileProductionSource(local,b,incoming,[exact])).toMatchObject({conflicts:[],dataset:{orders:[]}});
 for(const protectedLocal of [{...local,receipts:[{id:'r',workOrder:'OF1',purchaseOrder:'p',reference:'REF1',quantity:1,unit:'u',actor:ctx.actor,status:'pending' as const}]},{...local,orders:[{...local.orders[0],sageKey:'sage-line'}]}]){
  const resolution={...exact,expectedLocal:structuredClone(protectedLocal.orders[0])};
  const blocked=reconcileProductionSource(protectedLocal,b,incoming,[resolution]);
  expect(blocked.conflicts.some(c=>c.reason.includes('recepcions'))).toBe(true);expect(blocked.dataset.orders).toEqual(protectedLocal.orders);
  const retained=reconcileProductionSource(protectedLocal,b,incoming,[{...resolution,take:'local'}]);
  expect(retained.conflicts).toEqual([]);expect(retained.dataset.orders).toEqual(protectedLocal.orders);
 }
});
