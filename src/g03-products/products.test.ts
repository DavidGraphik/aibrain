import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('server-only',()=>({}));
import Ajv from 'ajv';
import { PRODUCTION_MUTATION_SCHEMA } from './chat-tools';
import { ProductStore } from './persistence';
import { readProduction, mutateProduction, previewImport } from './production';
import { mutateApp, readApp, listApps } from './apps';
import { machineQueue, validateDataset, type Grant } from './contracts';
import type { ProductContext } from './access';
let root:string,ctx:ProductContext;
const full:Grant[]=['read','orders','machines','receipts','validate-receipts','import','apps'];
const dataset=()=>({ capturedAt:'2026-10-06T12:00:00Z',sourceVersion:'V6 TEST SINTÈTIC',spreadsheet:{title:'Fixture'},lookups:{machines:['M1','M2'],productionStatuses:['NO COMENÇAT','EN PRODUCCIÓ','ENTREGAT AL CLIENT','PARAT']},orders:[{rowNumber:30,workOrder:'OF1',client:'Fixture',reference:'REF1',description:'Peça',salesOrder:'PV1',units:10,unitsDelivered:2,unitsPending:999,productionStatus:'NO COMENÇAT',assignedMachine:'M1',priority:20,materialReference:'MP1',materialUnit:'kg',materialRequired:5,unitsReceivedTotal:0,unitsAtG03:0,materialStatus:'PENDENT',deliveryDate:'2026-10-09'}],phases:[{rowNumber:1,workOrder:'OF1',phaseNumber:2,machine:'M1',state:'EN ESPERA',priority:10,observations:null}]});
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'g03-products-test-'));ctx={installationId:'g03-qa',actor:'jordi',grants:full,store:new ProductStore(root,'g03-qa')};});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
async function seed(){const p=previewImport(dataset());await mutateProduction(ctx,{action:'import.commit',dataset:dataset(),sha256:p.sha256,revision:0,reason:'Fixture explicit'});}
const act=(action:string,patch:Record<string,unknown>,revision=1)=>mutateProduction(ctx,{action,...patch,revision,reason:'Canvi de prova'});
describe('Producció persistent i permisos',()=>{
 it('advertises a complete chat comment edit that preserves quantities and rejects guessed targets',async()=>{
  await seed();
  const before=await readProduction(ctx);
  const validate=new Ajv({strict:false}).compile(PRODUCTION_MUTATION_SCHEMA);
  const input={action:'order.update',revision:before.revision,rowNumber:before.orders[0].rowNumber,patch:{statusComment:'Revisat per Jordi'},reason:'Canvi explícit del comentari'};
  expect(validate({input})).toBe(true);
  const {rowNumber: omitted, ...missingTarget}=input; void omitted;
  expect(validate({input:missingTarget})).toBe(false);
  expect(validate({input:{...missingTarget,target:{workOrder:'OF1'}}})).toBe(false);
  expect(validate({input:{...input,patch:{statusComment:'Revisat',quantity:10}}})).toBe(false);
  await mutateProduction(ctx,input);
  const after=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});
  expect(after.orders[0]).toEqual({...before.orders[0],statusComment:'Revisat per Jordi'});
  expect(after.revision).toBe(before.revision+1);
  await expect(mutateProduction(ctx,input)).rejects.toMatchObject({status:409});
 });

 it('normalizes pending units and combines phases and OF priority, excluding completed jobs',()=>{const d=validateDataset(dataset());expect(d.orders[0].unitsPending).toBe(8);expect(machineQueue(d,'M1').map(o=>o.kind)).toEqual(['FASE','OF']);d.orders[0].productionStatus='ENTREGAT AL CLIENT';expect(machineQueue(d,'M1')).toEqual([]);});
 it('retains durable state, backups and before/after audit across fresh service instances',async()=>{await seed();await act('order.update',{rowNumber:30,patch:{unitsDelivered:4}});const copy={...ctx,store:new ProductStore(root,'g03-qa')};const d=await readProduction(copy);expect(d.orders[0].unitsPending).toBe(6);expect(d.revision).toBe(2);expect(d.audit.at(-1)?.actor).toBe('jordi');expect((await copy.store.readVersion<import('./contracts').ProductionState>('production',1)).orders[0].unitsDelivered).toBe(2);});
 it('admits one concurrent write and rejects stale edits without lost updates',async()=>{await seed();const results=await Promise.allSettled([act('order.update',{rowNumber:30,patch:{priority:2}}),act('order.update',{rowNumber:30,patch:{priority:3}})]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect((await readProduction(ctx)).revision).toBe(2);});
 it('separates machine rights from order rights and denies derived/unknown fields',async()=>{await seed();const lidia={...ctx,actor:'lidia',grants:['read','machines'] as Grant[]};await expect(mutateProduction(lidia,{action:'order.update',rowNumber:30,patch:{client:'foreign'},revision:1,reason:'No'})).rejects.toMatchObject({status:403});await mutateProduction(lidia,{action:'order.update',rowNumber:30,patch:{priority:1},revision:1,reason:'Sí'});await expect(act('order.update',{rowNumber:30,patch:{unitsPending:0}},2)).rejects.toMatchObject({status:400});expect((await readProduction(ctx)).orders[0].client).toBe('Fixture');});
 it('validates receipts once, preserves quantities and rejects incompatible unit/reference',async()=>{await seed();await act('receipt.submit',{workOrder:'OF1',purchaseOrder:'PC1',reference:'MP1',quantity:5,unit:'kg'});const receipt=(await readProduction(ctx)).receipts[0];const victor={...ctx,actor:'victor',grants:['read','receipts'] as Grant[]};await expect(mutateProduction(victor,{action:'receipt.validate',id:receipt.id,revision:2,reason:'No'})).rejects.toMatchObject({status:403});const rosalia={...ctx,actor:'rosalia',grants:['read','validate-receipts'] as Grant[]};await mutateProduction(rosalia,{action:'receipt.validate',id:receipt.id,revision:2,reason:'Rebut'});expect((await readProduction(ctx)).orders[0]).toMatchObject({unitsAtG03:5,materialMissing:0,materialStatus:'REBUT'});await expect(act('receipt.validate',{id:receipt.id},3)).rejects.toMatchObject({status:409});await act('receipt.submit',{workOrder:'OF1',purchaseOrder:'PC2',reference:'MP1',quantity:1,unit:'m'},3);await expect(act('receipt.validate',{id:(await readProduction(ctx)).receipts[1].id},4)).rejects.toMatchObject({status:400});});
 it('imports SAGE lines idempotently and rolls back whole invalid batches',async()=>{await seed();const row={salesOrder:'PV2',line:'1',reference:'REF2',workOrder:'OF2',client:'Fixture',units:5,deliveryDate:'2026-10-10'};await act('sage.import',{rows:[row]});const result=await act('sage.import',{rows:[row]},2);expect(result).toMatchObject({result:{imported:0,skipped:1}});await expect(act('sage.import',{rows:[{...row,workOrder:'OF3',line:'2'},{...row,workOrder:'OF1',line:'3'}]},3)).rejects.toMatchObject({status:400});expect((await readProduction(ctx)).orders.map(o=>o.workOrder)).toEqual(['OF1','OF2']);});
 it('rejects foreign installation, bad dates, duplicate OF and orphan phases',async()=>{await seed();await expect(readProduction({...ctx,store:new ProductStore(root,'arnall')})).rejects.toMatchObject({status:403});const d=dataset();d.orders[0].deliveryDate='2026-02-30';expect(()=>validateDataset(d)).toThrow();d.orders[0].deliveryDate='2026-10-09';d.phases[0].workOrder='OTHER';expect(()=>validateDataset(d)).toThrow();expect((await readProduction(ctx)).revision).toBe(1);});
});
describe('Miniaplicacions amb versions, publicació i dades',()=>{
 const schema=[{name:'title',type:'text',required:true}];
 async function create(){return await mutateApp(ctx,{action:'create',title:'Revisions',html:'<h1>Revisions</h1>',fields:schema,instruction:'Crear registre'}) as {id:string;revision:number};}
 it('keeps shared applications readable while denying all record writes for a configured viewer',async()=>{
  const a=await create();
  await mutateApp(ctx,{action:'publish',id:a.id,revision:1,version:1,shared:true});
  await mutateApp(ctx,{action:'row.create',id:a.id,revision:2,values:{title:'Conservar'}});
  const viewer={...ctx,actor:'viewer',grants:[] as Grant[],appRecordsWritable:false};
  expect((await listApps(viewer)).map(app=>app.id)).toEqual([a.id]);
  const before=await readApp(viewer,a.id,true);
  expect(before.canWriteRecords).toBe(false);
  const mutation=vi.spyOn(ctx.store,'mutate');
  await expect(mutateApp(viewer,{action:'row.create',id:a.id,revision:3,published:true,values:{title:'No'}})).rejects.toMatchObject({status:403});
  await expect(mutateApp(viewer,{action:'row.update',id:a.id,revision:3,published:true,rowId:before.rows[0].id,rowRevision:1,values:{title:'No'}})).rejects.toMatchObject({status:403});
  await expect(mutateApp(viewer,{action:'create',title:'No',html:'x',fields:schema,instruction:'No'})).rejects.toMatchObject({status:403});
  expect(mutation).not.toHaveBeenCalled();
  expect(await readApp(viewer,a.id,true)).toEqual(before);
 });
 it('creates private drafts, publishes shared version and rejects foreign-owner source edits',async()=>{const a=await create();const rafa={...ctx,actor:'rafa'};expect(await listApps(rafa)).toEqual([]);await expect(readApp(rafa,a.id,true)).rejects.toMatchObject({status:403});await mutateApp(ctx,{action:'publish',id:a.id,revision:1,version:1,shared:true});expect((await readApp(rafa,a.id,true)).version.version).toBe(1);await expect(mutateApp(rafa,{action:'update',id:a.id,revision:2,html:'bad',fields:[],instruction:'No'})).rejects.toMatchObject({status:403});await mutateApp(ctx,{action:'update',id:a.id,revision:2,html:'<h1>New</h1>',fields:schema,instruction:'Modificar'});expect((await readApp(ctx,a.id)).version.version).toBe(2);expect((await readApp(rafa,a.id,true)).version.html).toBe('<h1>Revisions</h1>');});
 it('supports shared persistent records with schema validation and optimistic concurrency',async()=>{const a=await create();await mutateApp(ctx,{action:'publish',id:a.id,revision:1,version:1,shared:true});const user={...ctx,actor:'rafa',grants:['read'] as Grant[]};await mutateApp(user,{action:'row.create',id:a.id,revision:2,published:true,values:{title:'Equip 1'}});const app=await readApp(user,a.id,true);expect(app.rows[0].values.title).toBe('Equip 1');await expect(mutateApp(user,{action:'row.create',id:a.id,revision:3,published:true,values:{unknown:'X'}})).rejects.toMatchObject({status:400});await expect(mutateApp(user,{action:'row.update',id:a.id,revision:3,published:true,rowId:app.rows[0].id,rowRevision:0,values:{title:'Lost'}})).rejects.toMatchObject({status:409});});
 it('preserves populated columns across schema extension and published old-version writes',async()=>{const a=await create();await mutateApp(ctx,{action:'publish',id:a.id,revision:1,version:1,shared:true});await mutateApp(ctx,{action:'row.create',id:a.id,revision:2,values:{title:'Equip'}});await expect(mutateApp(ctx,{action:'update',id:a.id,revision:3,html:'x',fields:[],instruction:'No'})).rejects.toMatchObject({status:400});await mutateApp(ctx,{action:'update',id:a.id,revision:3,html:'new',fields:[...schema,{name:'extra',type:'text'}],instruction:'Afegir camp'});const row=(await readApp(ctx,a.id)).rows[0];await mutateApp(ctx,{action:'row.update',id:a.id,revision:4,rowId:row.id,rowRevision:1,values:{title:'Equip',extra:'Conservar'}});await mutateApp({...ctx,actor:'rafa'},{action:'row.update',id:a.id,revision:5,published:true,rowId:row.id,rowRevision:2,values:{title:'Canvi publicat'}});expect((await readApp(ctx,a.id)).rows[0].values.extra).toBe('Conservar');expect((await readApp({...ctx,actor:'rafa'},a.id,true)).rows[0].values).toEqual({title:'Canvi publicat'});});
 it('rejects traversal and foreign stores; unpublication removes shared access without deleting data',async()=>{const a=await create();const missing='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';await expect(mutateApp(ctx,{action:'unpublish',id:missing,revision:0})).rejects.toMatchObject({status:404});expect(await ctx.store.read(`app-${missing}`)).toBeNull();await expect(readApp(ctx,'../../foreign')).rejects.toMatchObject({status:400});await mutateApp(ctx,{action:'publish',id:a.id,revision:1,version:1,shared:true});await mutateApp(ctx,{action:'unpublish',id:a.id,revision:2});expect(await listApps({...ctx,actor:'rafa'})).toEqual([]);expect((await readApp(ctx,a.id)).version.html).toBe('<h1>Revisions</h1>');await expect(readApp({...ctx,store:new ProductStore(root,'foreign')},a.id)).rejects.toMatchObject({status:403});});
});
it('restores a previous program as a new owner draft without losing data or changing publication, with row before/after audit',async()=>{
 const schema=[{name:'title',type:'text',required:true}];const a=await mutateApp(ctx,{action:'create',title:'Restore test',html:'<h1>Original</h1>',fields:schema,instruction:'Original'}) as {id:string};
 await mutateApp(ctx,{action:'publish',id:a.id,revision:1,version:1,shared:true});await mutateApp(ctx,{action:'row.create',id:a.id,revision:2,values:{title:'Kept'}});
 await mutateApp(ctx,{action:'update',id:a.id,revision:3,html:'<h1>Changed</h1>',fields:schema,instruction:'Changed logic'});
 await expect(mutateApp({...ctx,actor:'other'},{action:'restore',id:a.id,revision:4,version:1,instruction:'Forbidden'})).rejects.toMatchObject({status:403});
 await mutateApp(ctx,{action:'restore',id:a.id,revision:4,version:1,instruction:'Recover original source'});const restored=await readApp({...ctx,store:new ProductStore(root,'g03-qa')},a.id);
 expect(restored.version).toMatchObject({version:3,html:'<h1>Original</h1>'});expect(restored.rows[0].values.title).toBe('Kept');expect(restored.publishedVersion).toBe(1);expect(restored.versions).toHaveLength(3);
 await mutateApp(ctx,{action:'row.update',id:a.id,revision:5,rowId:restored.rows[0].id,rowRevision:1,values:{title:'Changed data'}});const raw=await ctx.store.read<import('./contracts').MiniApp>(`app-${a.id}`);expect(raw?.audit.at(-1)).toMatchObject({before:{values:{title:'Kept'}},after:{values:{title:'Changed data'}}});
});
