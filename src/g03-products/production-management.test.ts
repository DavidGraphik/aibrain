import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,mkdir,writeFile,chmod,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
vi.mock('server-only',()=>({}));
import {ProductStore} from './persistence';
import type {ProductContext} from './access';
import {mutateProduction,readProduction,previewImport} from './production';
import {PRODUCTION_MUTATION_SCHEMA} from './chat-tools';
import {syncProductionSource,reconcileProductionSource} from './source-sync';
import type {ProductionState} from './contracts';
let root:string,ctx:ProductContext;
const dataset=()=>({capturedAt:'2026-10-22T10:00:00Z',sourceVersion:'V7',sourceHash:'a'.repeat(64),lookups:{machines:['M1','UNUSED'],productionStatuses:['NO COMENÇAT','ENTREGAT']},catalog:[{rowNumber:2,reference:'REF1',client:'Client',description:'Peça'}],orders:[{rowNumber:29,workOrder:'OF1',reference:'REF1',client:'Client',description:'Peça',units:10,unitsDelivered:0,assignedMachine:'M1',productionStatus:'NO COMENÇAT'}],phases:[]});
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'g03-management-'));ctx={installationId:'g03-qa',actor:'jordi',grants:['read','orders','machines','import'],store:new ProductStore(root,'g03-qa')};const p=previewImport(dataset());await mutateProduction(ctx,{action:'import.commit',dataset:dataset(),sha256:p.sha256,revision:0,reason:'Fixture'});});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
async function mutate(action:string,fields:Record<string,unknown>){return mutateProduction(ctx,{action,revision:(await readProduction(ctx)).revision,reason:'Explicit QA',...fields});}
it('reports the actual private source configuration pause without exposing config or changing production metadata',async()=>{
 const before=await ctx.store.read<ProductionState>('production');
 const directory=path.join(root,'source-sync');await mkdir(directory,{mode:0o700});const file=path.join(directory,'config.json');
 await writeFile(file,JSON.stringify({schemaVersion:1,installationId:ctx.installationId,apply:false,actor:'PRIVATE-CONFIG-CANARY',resolution:{private:'NOT-FOR-API'}}),{mode:0o600});
 const paused=await readProduction({...ctx,grants:['read']});
 expect(paused.sourceImportPaused).toBe(true);expect(JSON.stringify(paused)).not.toContain('PRIVATE-CONFIG-CANARY');expect(JSON.stringify(paused)).not.toContain('NOT-FOR-API');
 expect(await ctx.store.read<ProductionState>('production')).toEqual(before);
 await writeFile(file,JSON.stringify({schemaVersion:1,installationId:ctx.installationId,apply:true}));
 expect((await readProduction(ctx)).sourceImportPaused).toBe(false);
});
it('does not infer pause from missing, foreign, public or linked source settings',async()=>{
 expect((await readProduction(ctx)).sourceImportPaused).toBeNull();
 const directory=path.join(root,'source-sync');await mkdir(directory,{mode:0o700});const file=path.join(directory,'config.json');
 await writeFile(file,JSON.stringify({schemaVersion:1,installationId:'another-installation',apply:false}),{mode:0o600});
 expect((await readProduction(ctx)).sourceImportPaused).toBeNull();
 await writeFile(file,JSON.stringify({schemaVersion:1,installationId:ctx.installationId,apply:false}));await chmod(file,0o644);
 expect((await readProduction(ctx)).sourceImportPaused).toBeNull();
 await chmod(file,0o600);await symlink(file,path.join(directory,'alias'));await rm(file);await symlink('alias',file);
 expect((await readProduction(ctx)).sourceImportPaused).toBeNull();
});
it('manages catalog independently, persists audit and does not rewrite protected existing orders',async()=>{
 const before=await readProduction(ctx);
 const created=await mutate('catalog.create',{patch:{reference:'QA-ONE',client:'QA',description:'Initial'}}) as {result:{rowNumber:number}};
 const rowNumber=created.result.rowNumber;
 await mutate('catalog.update',{rowNumber,patch:{description:'Updated'}});
 expect((await readProduction({...ctx,store:new ProductStore(root,'g03-qa')})).catalog?.find(row=>row.rowNumber===rowNumber)?.description).toBe('Updated');
 await mutate('catalog.delete',{rowNumber});
 const next=await mutate('catalog.create',{patch:{reference:'QA-TWO'}}) as {result:{rowNumber:number}};expect(next.result.rowNumber).toBeGreaterThan(rowNumber);
 await mutate('catalog.update',{rowNumber:2,patch:{reference:'REF-RENAMED',client:'New catalog client'}});
 const after=await readProduction(ctx);expect(after.orders).toEqual(before.orders);expect(after.catalogDeletedReferences).toContain('REF1');
 await expect(mutate('order.update',{rowNumber:29,patch:{reference:'REF-RENAMED'}})).rejects.toMatchObject({status:400});
 expect(after.audit.filter(entry=>entry.action.startsWith('catalog.'))).toHaveLength(5);
});
it('enforces catalog permissions, duplicate identity and exact-revision conflict with no partial changes',async()=>{
 await expect(mutateProduction({...ctx,grants:['read']},{action:'catalog.delete',revision:1,rowNumber:2,reason:'No rights'})).rejects.toMatchObject({status:403});
 await expect(mutate('catalog.create',{patch:{reference:' ref1 '}})).rejects.toMatchObject({status:409});
 await expect(mutateProduction(ctx,{action:'catalog.delete',revision:0,rowNumber:2,reason:'Stale'})).rejects.toMatchObject({status:409});
 expect((await readProduction(ctx)).catalog).toEqual(dataset().catalog);
});
it('restores a retired catalog entry from its last audit without rewriting orders and survives reopening',async()=>{
 const before=await readProduction(ctx);
 await mutate('catalog.delete',{rowNumber:2});
 expect((await readProduction(ctx)).catalog).toEqual([]);
 await mutate('catalog.restore',{rowNumber:2});
 const reopened=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});
 expect(reopened.catalog).toEqual(before.catalog);expect(reopened.orders).toEqual(before.orders);
 expect(reopened.catalogDeletedReferences).toEqual([]);
 expect(reopened.audit.at(-1)).toMatchObject({action:'catalog.restore',actor:'jordi',target:'2',before:null,after:before.catalog![0]});
 await expect(mutate('catalog.restore',{rowNumber:2})).rejects.toMatchObject({status:404});
});
it('refuses conflicting, stale, unauthorized and nonexistent catalog recovery without partial writes',async()=>{
 await mutate('catalog.delete',{rowNumber:2});const retired=await readProduction(ctx);
 await expect(mutateProduction({...ctx,grants:['read']},{action:'catalog.restore',revision:retired.revision,rowNumber:2,reason:'Denied'})).rejects.toMatchObject({status:403});
 await expect(mutateProduction(ctx,{action:'catalog.restore',revision:retired.revision-1,rowNumber:2,reason:'Stale'})).rejects.toMatchObject({status:409});
 await expect(mutate('catalog.restore',{rowNumber:999})).rejects.toMatchObject({status:404});
 expect(await readProduction(ctx)).toEqual(retired);
 await mutate('catalog.create',{patch:{reference:'ref1',description:'Replacement'}});const replacement=await readProduction(ctx);
 await expect(mutate('catalog.restore',{rowNumber:2})).rejects.toMatchObject({status:409});
 expect(await readProduction(ctx)).toEqual(replacement);
});
it('persists independent dropdown labels/colors without changing V7 operational values and supports removing overrides',async()=>{
 const patch={machines:['M1','QA-MACHINE'],dropdownLabels:{productionStatus:{'NO COMENÇAT':'Pendent de començar'}},cellColors:{productionStatus:{'':'#ffffff','NO COMENÇAT':'#123456'}},deliveryColors:{week:'#ffff00'},materialStatuses:['PENDENT','REBUT']};
 const validate=new Ajv({strict:false}).compile(PRODUCTION_MUTATION_SCHEMA);expect(validate({input:{action:'configuration.update',revision:1,reason:'Configure',patch}})).toBe(true);
 expect(validate({input:{action:'configuration.update',revision:1,reason:'Configure',patch:{machines:['M1']},rename:{field:'productionStatus',from:'NO COMENÇAT',to:'X'}}})).toBe(false);
 await mutate('configuration.update',{patch});const state=await readProduction(ctx);
 expect(state.configuration).toMatchObject({dropdownLabels:patch.dropdownLabels,cellColors:patch.cellColors,deliveryColors:patch.deliveryColors});expect(state.orders[0].productionStatus).toBe('NO COMENÇAT');
 await mutate('configuration.update',{patch:{cellColors:{productionStatus:{'NO COMENÇAT':null}},dropdownLabels:{productionStatus:{'NO COMENÇAT':null}}}});
 expect((await readProduction(ctx)).configuration?.cellColors?.productionStatus).toEqual({'':'#ffffff'});
 await expect(mutate('configuration.update',{patch:{machines:[]}})).rejects.toMatchObject({status:409});
 await expect(mutate('configuration.update',{patch:{cellColors:{productionStatus:{x:'url(secret)'}}}})).rejects.toMatchObject({status:400});
 await expect(mutateProduction({...ctx,grants:['read','orders']},{action:'configuration.update',revision:3,reason:'No machine rights',patch:{machines:['M1']}})).rejects.toMatchObject({status:403});
});
it('keeps deleted catalog references deleted across changed source rows and retains local configuration at CAS sync',async()=>{
 await mutate('catalog.delete',{rowNumber:2});await mutate('configuration.update',{patch:{machines:['M1','LOCAL'],dropdownLabels:{productionStatus:{'NO COMENÇAT':'Pendent'}},deliveryColors:{week:'#ffef00'}}});
 const remote=dataset();remote.catalog[0].description='Changed in source';remote.catalog[0].client='Other source client';remote.sourceHash='b'.repeat(64);
 const before=await readProduction(ctx);const plan=reconcileProductionSource(before,dataset(),remote);expect(plan.conflicts).toEqual([]);expect(plan.dataset.catalog).toEqual([]);expect(plan.dataset.lookups.machines).toEqual(['M1','LOCAL']);
 const result=await syncProductionSource(ctx,{source:{fileId:'SYNTHETIC_DRIVE_FILE',modifiedAt:'2026-10-22T11:00:00Z',version:'2'},dataset:remote,baseline:dataset(),revision:before.revision,apply:true});expect(result.applied).toBe(true);
 const after=await readProduction(ctx);expect(after.catalog).toEqual([]);expect(after.configuration).toEqual(before.configuration);expect(after.catalogDeletedReferences).toEqual(['REF1']);
 const newer={...remote,sourceHash:'c'.repeat(64)};const next=reconcileProductionSource(after,remote,newer);expect(next.dataset.catalog).toEqual([]);
 const other=new ProductStore(root,'other');await expect(other.read<ProductionState>('production')).rejects.toMatchObject({status:403});
});

it('restores a deleted reference through order intake and retains it on the next source reconciliation',async()=>{
 await mutate('catalog.delete',{rowNumber:2});
 await mutate('order.create',{referenceMode:'new',referenceOnly:true,patch:{reference:' ref1 ',client:'Client',description:'Restored for intake'}});
 const state=await readProduction(ctx);expect(state.catalogDeletedReferences).toEqual([]);
 const restored=state.catalog?.find(row=>row.reference==='ref1');expect(restored).toBeDefined();
 const remote=dataset();remote.sourceHash='b'.repeat(64);
 const plan=reconcileProductionSource(state,dataset(),remote);expect(plan.conflicts).toEqual([]);
 expect(plan.dataset.catalog).toContainEqual(restored);expect(plan.dataset.orders.some(row=>row.workOrder===null&&row.reference==='ref1')).toBe(true);
});
it('persists print check changes at exact revisions and rejects a reader without changing other rows',async()=>{
 for(const printStatus of ['✓','✓✓',null]){
  const before=await readProduction(ctx);
  await mutateProduction(ctx,{action:'order.update',revision:before.revision,rowNumber:29,patch:{printStatus},reason:'Check dropdown QA'});
  const saved=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});
  expect(saved.orders[0].printStatus).toBe(printStatus);
  expect(saved.orders[0].reference).toBe(before.orders[0].reference);
 }
 const before=await readProduction(ctx);
 await expect(mutateProduction({...ctx,grants:['read']},{action:'order.update',revision:before.revision,rowNumber:29,patch:{printStatus:'✓'},reason:'Reader denied'})).rejects.toMatchObject({status:403});
 expect((await readProduction(ctx)).orders).toEqual(before.orders);
});

it('retires active status choices without rewriting used values, and forbids assigning a retired choice again',async()=>{
 const before=await readProduction(ctx);
 await mutate('configuration.update',{patch:{productionStatuses:['ENTREGAT','PDT.LLIMAR']}});
 const saved=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});
 expect(saved.lookups.productionStatuses).toEqual(['ENTREGAT','PDT.LLIMAR']);
 expect(saved.orders).toEqual(before.orders);expect(saved.configuration?.productionStatuses).toEqual(saved.lookups.productionStatuses);
 const stored=await ctx.store.read<ProductionState>('production');
 expect(stored!.lookups.productionStatuses).toContain('NO COMENÇAT');
 expect(stored!.audit.at(-1)).toMatchObject({action:'configuration.update',actor:'jordi'});
 await expect(mutate('order.update',{rowNumber:29,patch:{productionStatus:'NO COMENÇAT'}})).rejects.toMatchObject({status:400});
 await mutate('order.update',{rowNumber:29,patch:{statusComment:'Independent edit'}});
 expect((await readProduction(ctx)).orders[0].productionStatus).toBe('NO COMENÇAT');
 // An enabled source reconciliation must still validate historical row values.
 const remote=dataset();remote.sourceHash='d'.repeat(64);
 const plan=reconcileProductionSource((await ctx.store.read<ProductionState>('production'))!,dataset(),remote);
 expect(plan.conflicts).toEqual([]);expect(plan.dataset.orders[0].productionStatus).toBe('NO COMENÇAT');
 await mutate('configuration.update',{patch:{productionStatuses:['NO COMENÇAT','ENTREGAT','PDT.LLIMAR']}});
 await mutate('order.update',{rowNumber:29,patch:{productionStatus:'NO COMENÇAT'}});
 expect((await readProduction(ctx)).lookups.productionStatuses).toContain('NO COMENÇAT');
});
it('removes only the selected Fases OF entry and queue item, retains its audit, and never reuses its identity',async()=>{
 await mutate('phase.create',{patch:{workOrder:'OF1',phaseNumber:2,machine:'M1',state:'EN ESPERA'}});
 await mutate('phase.create',{patch:{workOrder:'OF1',phaseNumber:3,machine:'M1',state:'EN ESPERA'}});
 const before=await readProduction(ctx),target=before.phases[0];
 const {machineQueue}=await import('./contracts');
 expect(machineQueue(before,'M1').filter(item=>item.kind==='FASE')).toHaveLength(2);
 const validate=new Ajv({strict:false}).compile(PRODUCTION_MUTATION_SCHEMA);
 expect(validate({input:{action:'phase.delete',revision:before.revision,rowNumber:target.rowNumber,reason:'No longer needed'}})).toBe(true);
 expect(validate({input:{action:'phase.delete',revision:before.revision,rowNumber:target.rowNumber,reason:'No longer needed',patch:{workOrder:'OF1'}}})).toBe(false);
 await mutate('phase.delete',{rowNumber:target.rowNumber});
 const reopened=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});
 expect(reopened.phases).toEqual(before.phases.slice(1));expect(reopened.orders).toEqual(before.orders);expect(reopened.receipts).toEqual(before.receipts);
 expect(machineQueue(reopened,'M1').filter(item=>item.kind==='FASE')).toHaveLength(1);
 expect(reopened.audit.at(-1)).toMatchObject({actor:'jordi',action:'phase.delete',target:String(target.rowNumber),before:target,after:null});
 await expect(mutate('phase.delete',{rowNumber:target.rowNumber})).rejects.toMatchObject({status:404});
 await mutate('phase.delete',{rowNumber:before.phases[1].rowNumber});
 await mutate('phase.create',{patch:{workOrder:'OF1',phaseNumber:4,machine:'M1'}});
 expect((await readProduction(ctx)).phases[0].rowNumber).toBeGreaterThan(before.phases[1].rowNumber);
});
it('denies unauthorized, stale and invalid phase removals atomically',async()=>{
 await mutate('phase.create',{patch:{workOrder:'OF1',phaseNumber:2,machine:'M1'}});
 const before=await readProduction(ctx),rowNumber=before.phases[0].rowNumber;
 await expect(mutateProduction({...ctx,grants:['read','orders']},{action:'phase.delete',rowNumber,revision:before.revision,reason:'Denied'})).rejects.toMatchObject({status:403});
 await expect(mutateProduction(ctx,{action:'phase.delete',rowNumber,revision:before.revision-1,reason:'Stale'})).rejects.toMatchObject({status:409});
 await expect(mutate('phase.delete',{rowNumber:rowNumber+.5})).rejects.toMatchObject({status:400});
 expect(await readProduction(ctx)).toEqual(before);
});
