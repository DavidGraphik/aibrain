import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('server-only',()=>({}));
import {ProductStore} from './persistence';
import type {ProductContext} from './access';
import {mutateProduction,previewImport,readProduction} from './production';
import {machineQueue} from './contracts';
import {v7FormulaFields} from './v7-logic';

const statuses=['PDT LLIMAR','PDT. ROSCAR','PDT. OLI','PDT. PROVA DE PRESSIO','PDT. OK CONTROL DE QUALITAT','PDT. RECTIFICAT','PDT. ENCAIXAR','PDT. POSAR PASSADOR','PDT. ENVIAR A PINTURA','PDT. MUNTATGE HELICOIS','PDT. TORN MANUAL UF'];
let root:string,ctx:ProductContext;
beforeEach(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),'g03-manual-task-'));
  ctx={installationId:'g03-qa',actor:'jordi',grants:['read','orders','machines','import'],store:new ProductStore(root,'g03-qa')};
  const dataset={sourceVersion:'V7',capturedAt:'2026-10-26T00:00:00Z',lookups:{machines:['M1'],productionStatuses:['EN PRODUCCIÓ',...statuses]},orders:[{rowNumber:30,workOrder:'181/5',reference:'REF',client:'Client',description:'Peça',units:10,unitsDelivered:0,assignedMachine:'M1',priority:5,productionStatus:'EN PRODUCCIÓ',formulaFields:[...v7FormulaFields]}],phases:[]};
  const preview=previewImport(dataset);
  await mutateProduction(ctx,{action:'import.commit',dataset,sha256:preview.sha256,revision:0,reason:'Synthetic isolated fixture'});
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});

it.each(statuses)('clears machine and calculated load atomically for %s and persists the result',async status=>{
  expect(machineQueue(await readProduction(ctx),'M1')).toHaveLength(1);
  await mutateProduction(ctx,{action:'order.update',revision:1,rowNumber:30,patch:{productionStatus:status},reason:'Requested manual task'});
  const after=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});
  expect(after.orders[0]).toMatchObject({productionStatus:status,assignedMachine:null,priority:null,showInLoad:'',loadKey:''});
  expect(machineQueue(after,'M1')).toEqual([]);
  expect(after.audit.at(-1)).toMatchObject({actor:'jordi',before:{assignedMachine:'M1'},after:{assignedMachine:null}});
});

it('allows a manual blank machine and removes its OF from load without changing status',async()=>{
  await mutateProduction(ctx,{action:'order.update',revision:1,rowNumber:30,patch:{assignedMachine:null},reason:'Clear machine manually'});
  const after=await readProduction(ctx);
  expect(after.orders[0]).toMatchObject({productionStatus:'EN PRODUCCIÓ',assignedMachine:null,showInLoad:'',loadKey:''});
  expect(machineQueue(after,'M1')).toEqual([]);
});

it('does not clear scheduling without machine rights or from unrelated comment edits',async()=>{
  await expect(mutateProduction({...ctx,grants:['read','orders']},{action:'order.update',revision:1,rowNumber:30,patch:{productionStatus:'PDT. ENCAIXAR'},reason:'Insufficient scheduling rights'})).rejects.toMatchObject({status:403});
  await mutateProduction(ctx,{action:'order.update',revision:1,rowNumber:30,patch:{statusComment:'PDT. ENCAIXAR'},reason:'A comment is not a status transition'});
  expect((await readProduction(ctx)).orders[0]).toMatchObject({assignedMachine:'M1',priority:5,productionStatus:'EN PRODUCCIÓ'});
});


it.each(statuses)('hides existing phase load for %s, preserves history, and restores it when machining resumes',async status=>{
  await mutateProduction(ctx,{action:'phase.create',revision:1,patch:{workOrder:'181/5',phaseNumber:1,machine:'M1',state:'EN ESPERA',priority:3,observations:'Preserve phase history'},reason:'Schedule a synthetic phase'});
  const originalPhase=(await readProduction(ctx)).phases[0];
  expect(machineQueue(await readProduction(ctx),'M1').map(row=>row.kind)).toEqual(['FASE','OF']);
  await mutateProduction(ctx,{action:'order.update',revision:2,rowNumber:30,patch:{productionStatus:status},reason:'Manual work removes machine load'});
  const manual=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});
  expect(manual.orders[0]).toMatchObject({productionStatus:status,assignedMachine:null,priority:null});
  expect(manual.phases).toEqual([originalPhase]);
  expect(machineQueue(manual,'M1')).toEqual([]);
  await mutateProduction(ctx,{action:'order.update',revision:3,rowNumber:30,patch:{productionStatus:'EN PRODUCCIÓ'},reason:'Resume machining with preserved phase scheduling'});
  const resumed=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});
  expect(resumed.orders[0]).toMatchObject({assignedMachine:null,priority:null});
  expect(resumed.phases).toEqual([originalPhase]);
  expect(machineQueue(resumed,'M1').map(row=>row.id)).toEqual([`phase-${originalPhase.rowNumber}`]);
});
