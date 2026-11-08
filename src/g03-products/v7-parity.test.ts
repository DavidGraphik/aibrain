import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {ProductStore} from './persistence';import {mutateProduction,previewImport,readProduction,summarizeProductionAudit} from './production';import {machineQueue,validateDataset,type Grant} from './contracts';import {recalculateV7,v7FormulaFields} from './v7-logic';import type {ProductContext} from './access';
let root:string,ctx:ProductContext;
const fixture=()=>({sourceVersion:'V7',capturedAt:'2026-10-07T13:00:00Z',lookups:{machines:['M1'],productionStatuses:['NO COMENÇAT','LLEST PER SERVIR','ENTREGAT']},catalog:[{rowNumber:2,reference:'REF',client:'Client',description:'Peça'}],orders:[{rowNumber:30,workOrder:'10/5',client:'Client',reference:'REF',description:'Peça',units:10,unitsDelivered:2,unitsPending:8,unitsReceivedTotal:5,unitsAtG03:3,materialMissing:3,assignedMachine:'M1',priority:null,productionStatus:'NO COMENÇAT',deliveryDate:'2026-10-10',formulaFields:[...v7FormulaFields]}],phases:[]});
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'g03-v7-parity-'));ctx={installationId:'g03-qa',actor:'synthetic',grants:['read','orders','machines','import'] as Grant[],store:new ProductStore(root,'g03-qa')};const d=fixture(),p=previewImport(d);await mutateProduction(ctx,{action:'import.commit',dataset:d,sha256:p.sha256,revision:0,reason:'Synthetic copy'});});afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const create=(patch:unknown,mode='catalog',revision=1)=>mutateProduction(ctx,{action:'order.create',revision,referenceMode:mode,patch,reason:'Test reference flow'});
describe('V7 reference flow, formulas and source exceptions',()=>{
 it('resolves catalog reference, fills metadata and persists an audited OF after reopening',async()=>{await create({workOrder:'NEW',reference:'REF',units:20});const state=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});expect(state.orders.at(-1)).toMatchObject({client:'Client',description:'Peça',unitsPending:20,unitsAtG03:0,materialMissing:20});expect(state.catalog).toHaveLength(1);expect(state.audit.at(-1)?.action).toBe('order.create');});
 it('adds new reference and order atomically and prevents contradictory catalog metadata',async()=>{await expect(create({workOrder:'NEW',reference:'REF',client:'Wrong'})).rejects.toMatchObject({status:409});await expect(create({workOrder:'NEW',reference:'NEWREF',client:'Client'},'new')).rejects.toThrow();expect((await readProduction(ctx)).catalog).toHaveLength(1);await create({workOrder:'NEW',reference:'NEWREF',client:'Client',description:'Nova',units:5},'new');const state=await readProduction(ctx);expect(state.catalog).toHaveLength(2);expect(state.audit.slice(-2).map(a=>a.action)).toEqual(['catalog.create','order.create']);await expect(create({workOrder:'NEW2',reference:'NEWREF',client:'Client',description:'Nova'},'new',2)).rejects.toMatchObject({status:409});});
 it('recomputes dependent balances and load text when deliveries change, without clamping negative source results',async()=>{await mutateProduction(ctx,{action:'order.update',revision:1,rowNumber:30,patch:{unitsDelivered:8},reason:'Delivery in test copy'});expect((await readProduction(ctx)).orders[0]).toMatchObject({unitsPending:2,unitsAtG03:-3,materialMissing:-3,loadText:'OF10/5 Client REF Peça 2UT DLL10/10',loadKey:'M1|0000|30'});});
 it('preserves manual overrides and raw concatenation of references formatted as dates',()=>{const d=fixture();Object.assign(d.orders[0],{unitsPending:1,materialMissing:61,formulaFields:['unitsAtG03','showInLoad','loadText','loadKey'],sourceReferenceValue:'329267'});const source=validateDataset(d);const result=recalculateV7(source.orders[0]);expect(result).toMatchObject({unitsPending:1,materialMissing:61,loadText:'OF10/5 Client 329267 Peça 1UT DLL10/10'});});
 it('matches source queue filters, delivery fallback, duplicate OF first-match and stable equal-priority order',()=>{const d=validateDataset(fixture());d.orders[0].productionStatus='ENTREGAT';d.orders[0].showInLoad='NO';d.orders.push({...d.orders[0],rowNumber:31,deliveryDate:'2026-10-09'});d.phases=[{rowNumber:3,workOrder:'10/5',phaseNumber:2,machine:'M1',state:'',priority:0,observations:null},{rowNumber:4,workOrder:'10/5',phaseNumber:3,machine:'M1',state:'PREPARADA',priority:null,observations:'Revisar'}];expect(machineQueue(d,'M1').map(r=>r.id)).toEqual(['of-31','of-30','phase-4']);d.orders[0].productionStatus=' LLEST PER SERVIR ';expect(machineQueue(d,'M1').map(r=>r.id)).toEqual(['of-31']);});
 it('requires source formula provenance before editing dependencies in an older V7 import',async()=>{const d=fixture();delete (d.orders[0] as {formulaFields?:unknown}).formulaFields;const p=previewImport(d);await mutateProduction(ctx,{action:'import.commit',dataset:d,sha256:p.sha256,revision:1,reason:'Older copy'});await expect(mutateProduction(ctx,{action:'order.update',revision:2,rowNumber:30,patch:{units:50},reason:'No provenance'})).rejects.toMatchObject({status:409});await mutateProduction(ctx,{action:'order.update',revision:2,rowNumber:30,patch:{statusComment:'Allowed comment'},reason:'Comment only'});expect((await readProduction(ctx)).orders[0].units).toBe(10);});
});
it('archives ENTREGAT once, removes the matching last introduction, and keeps phases as the original script does',async()=>{
 await mutateProduction(ctx,{action:'order.update',revision:1,rowNumber:30,patch:{productionStatus:'ENTREGAT'},reason:'Delivered in a copy'});
 const state=await readProduction(ctx);expect(state.orders).toHaveLength(0);expect(state.deliveredHistory?.at(-1)).toMatchObject({workOrder:'10/5',productionStatus:'ENTREGAT',sourceOrderRowNumber:30});expect(state.audit.at(-1)?.action).toBe('order.archive');
 await expect(mutateProduction(ctx,{action:'order.update',revision:2,rowNumber:30,patch:{productionStatus:'ENTREGAT'},reason:'Repeated'})).rejects.toMatchObject({status:404});
});
it('permits an introduction before the OF, then resolves it durably at the same row',async()=>{
 await mutateProduction(ctx,{action:'order.create',revision:1,referenceMode:'catalog',referenceOnly:true,patch:{reference:'REF'},reason:'Reference now, OF later'});
 const state=await readProduction(ctx),order=state.orders.at(-1)!;expect(order.workOrder).toBeNull();expect(state.intake?.at(-1)).toMatchObject({reference:'REF',status:'AFEGIT AL CONTROL'});
 await mutateProduction(ctx,{action:'order.update',revision:2,rowNumber:order.rowNumber,patch:{workOrder:'NEW',units:5},reason:'Fill OF'});expect((await readProduction(ctx)).orders.at(-1)).toMatchObject({workOrder:'NEW',unitsPending:5});
});
it('applies source status effects and requires machine rights for clearing assignment',async()=>{
 const d=fixture();d.lookups.productionStatuses.push('PDT. RENTAR');const p=previewImport(d);await mutateProduction(ctx,{action:'import.commit',revision:1,dataset:d,sha256:p.sha256,reason:'Additional status in a copy'});
 await expect(mutateProduction({...ctx,grants:['read','orders']},{action:'order.update',revision:2,rowNumber:30,patch:{productionStatus:'PDT. RENTAR'},reason:'Cannot clear assigned machine'})).rejects.toMatchObject({status:403});
 await mutateProduction(ctx,{action:'order.update',revision:2,rowNumber:30,patch:{productionStatus:'PDT. RENTAR'},reason:'Clear machine as source script'});expect((await readProduction(ctx)).orders[0]).toMatchObject({assignedMachine:null,priority:null});
 await mutateProduction(ctx,{action:'order.update',revision:3,rowNumber:30,patch:{materialStatus:'REBUT'},reason:'Material arrived'});expect((await readProduction(ctx)).orders[0]).toMatchObject({productionStatus:'NO COMENÇAT',materialEta:null});
});

it('requires machine rights to clear priority even when the machine is already blank',async()=>{
 await mutateProduction(ctx,{action:'order.update',revision:1,rowNumber:30,patch:{assignedMachine:null,priority:7},reason:'Priority without assignment'});
 const d=await readProduction(ctx);d.lookups.productionStatuses.push('PDT. RENTAR');const p=previewImport(d);
 await mutateProduction(ctx,{action:'import.commit',revision:2,dataset:d,sha256:p.sha256,reason:'Synthetic status'});
 await expect(mutateProduction({...ctx,grants:['read','orders']},{action:'order.update',revision:3,rowNumber:30,patch:{productionStatus:'PDT. RENTAR'},reason:'Must not erase scheduling priority'})).rejects.toMatchObject({status:403});
 expect((await readProduction(ctx)).orders[0].priority).toBe(7);
});
it('preserves original manual balances when validating a piece-unit receipt',async()=>{
 const d=fixture();Object.assign(d.orders[0],{unitsPending:1,materialMissing:61,formulaFields:['unitsAtG03','showInLoad','loadText','loadKey'],materialReference:'MAT',materialRequired:10,materialUnit:'unitats'});
 const p=previewImport(d);await mutateProduction(ctx,{action:'import.commit',revision:1,dataset:d,sha256:p.sha256,reason:'Manual original balances'});
 const full={...ctx,grants:[...ctx.grants,'receipts','validate-receipts'] as Grant[]};
 const receipt=await mutateProduction(full,{action:'receipt.submit',revision:2,workOrder:'10/5',purchaseOrder:'PO',reference:'MAT',quantity:2,unit:'unitats',reason:'Piece receipt'}) as {result:{id:string}};
 await mutateProduction(full,{action:'receipt.validate',revision:3,id:receipt.result.id,reason:'Validate once'});
 expect((await readProduction(ctx)).orders[0]).toMatchObject({unitsPending:1,materialMissing:61,unitsReceivedTotal:7,unitsAtG03:5,productionStatus:'NO COMENÇAT'});
});

it('keeps raw source cells in saved history but avoids repeating them in normal audit views',async()=>{
 const d={...fixture(),sheets:[{name:'BASE DE DADES',dimension:'A1',cells:{A1:{value:'Private snapshot',formula:null,format:'General'}}}]};
 const p=previewImport(d);await mutateProduction(ctx,{action:'import.commit',revision:1,dataset:d,sha256:p.sha256,reason:'Snapshot copy'});
 const state=await readProduction(ctx),compact=summarizeProductionAudit(state.audit);
 expect(compact.at(-1)!.after).not.toHaveProperty('sheets');expect(compact.at(-1)!.after).toHaveProperty('sourceSheets',[{name:'BASE DE DADES',dimension:'A1'}]);
 expect((await readProduction(ctx)).audit.at(-1)!.after).toHaveProperty('sheets.0.cells.A1.value','Private snapshot');
});

it('round-trips exact source sheet identifiers, formula text and number formats through durable import',async()=>{
 const d={...fixture(),sheets:[{name:'TASQUES ',dimension:'A1',cells:{A1:{value:'  source value  ',formula:' =1+1 ',format:'0.00 '}}}]};
 const p=previewImport(d);await mutateProduction(ctx,{action:'import.commit',dataset:d,sha256:p.sha256,revision:1,reason:'Exact source snapshot'});
 const state=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});
 expect(state.sheets).toEqual(d.sheets);
 expect(state.sheets?.find(s=>s.name==='TASQUES ')).toBeDefined();
});

it('allows the original V7 received-total input and persists its dependent balances with an audit',async()=>{
 await mutateProduction(ctx,{action:'order.update',revision:1,rowNumber:30,patch:{unitsReceivedTotal:9},reason:'Material count as in V7'});
 const state=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});
 expect(state.orders[0]).toMatchObject({unitsReceivedTotal:9,unitsPending:8,unitsAtG03:7,materialMissing:-1});
 expect(state.audit.at(-1)).toMatchObject({actor:'synthetic',reason:'Material count as in V7',before:{unitsReceivedTotal:5},after:{unitsReceivedTotal:9}});
 await expect(mutateProduction({...ctx,grants:['read','machines']},{action:'order.update',revision:2,rowNumber:30,patch:{unitsReceivedTotal:10},reason:'No material rights'})).rejects.toMatchObject({status:403});
 expect((await readProduction(ctx)).orders[0].unitsReceivedTotal).toBe(9);
});

it('preserves multiple references on one V7 OF while rejecting a duplicate OF/reference pair',async()=>{
 await create({workOrder:'10/5',reference:'REF-2',client:'Client',description:'Second line',units:5},'new');
 let state=await readProduction(ctx);expect(state.orders.filter(o=>o.workOrder==='10/5')).toHaveLength(2);
 await expect(create({workOrder:'10/5',reference:'REF',units:5},'catalog',2)).rejects.toMatchObject({status:400});
 const row=state.orders.find(o=>o.reference==='REF-2')!;
 await expect(mutateProduction(ctx,{action:'order.update',revision:2,rowNumber:row.rowNumber,patch:{reference:'REF'},reason:'Duplicate pair'})).rejects.toMatchObject({status:400});
 state=await readProduction(ctx);expect(state.orders.find(o=>o.rowNumber===row.rowNumber)?.reference).toBe('REF-2');
});

it('blocks manual material reconciliation once a validated receipt or SAGE owns the total',async()=>{
 await ctx.store.mutate<import('./contracts').ProductionState,void>('production',()=>{throw Error('Seed missing');},state=>{state.receipts.push({id:'validated',workOrder:'10/5',purchaseOrder:'PO',reference:'MAT',quantity:1,unit:'unitats',actor:'synthetic',status:'validated'});});
 await expect(mutateProduction(ctx,{action:'order.update',revision:2,rowNumber:30,patch:{unitsReceivedTotal:9},reason:'Would lose receipt provenance'})).rejects.toMatchObject({status:409,message:expect.stringContaining('recepcions validades')});
 expect((await readProduction(ctx)).orders[0].unitsReceivedTotal).toBe(5);
 await ctx.store.mutate<import('./contracts').ProductionState,void>('production',()=>{throw Error('Seed missing');},state=>{state.receipts=[];state.orders[0].sageKey='sage:line';});
 await expect(mutateProduction(ctx,{action:'order.update',revision:3,rowNumber:30,patch:{unitsReceivedTotal:9},reason:'Would lose SAGE provenance'})).rejects.toMatchObject({status:409,message:expect.stringContaining('dades SAGE')});
});
