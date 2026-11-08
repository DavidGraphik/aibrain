import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
vi.mock('server-only',()=>({}));
import {ProductStore} from './persistence';
import type {ProductContext} from './access';
import {mutateProduction,previewImport,readProduction} from './production';
import {PRODUCTION_MUTATION_SCHEMA} from './chat-tools';

let root:string,ctx:ProductContext;
const dataset=()=>({capturedAt:'2026-10-28T00:00:00Z',sourceVersion:'V7',lookups:{machines:['M1'],productionStatuses:['EN PRODUCCIÓ']},orders:[{rowNumber:30,workOrder:'100/5',reference:'QA',units:10,unitsDelivered:0}],phases:[],tasks:[{rowNumber:6,owner:'Arturo',description:'Tasca original',done:true},{rowNumber:9,owner:'Lola',description:'Segona tasca',done:false}]});
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'g03-task-crud-'));ctx={installationId:'g03-qa',actor:'jordi',grants:['read','machines','import'],store:new ProductStore(root,'g03-qa')};const raw=dataset();await mutateProduction(ctx,{action:'import.commit',dataset:raw,sha256:previewImport(raw).sha256,revision:0,reason:'Isolated synthetic fixture'});});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const read=()=>readProduction(ctx);
async function mutate(action:string,body:Record<string,unknown>={}){return mutateProduction(ctx,{action,revision:(await read()).revision,reason:'Explicit task request',...body}) as Promise<{result:{rowNumber:number};revision:number}>;}

it('creates, edits, retires and restores only the selected task with durable identity and before-images',async()=>{
 const original=await read();
 const created=await mutate('task.create',{patch:{owner:'Rafa',description:'Revisar calibració'}});const rowNumber=created.result.rowNumber;
 expect(rowNumber).toBe(10);
 await mutate('task.update',{rowNumber,patch:{owner:'Jordi',description:'Revisar calibració actual',done:true}});
 const edited=(await read()).tasks!.find(task=>task.rowNumber===rowNumber)!;
 expect(edited).toEqual({rowNumber,owner:'Jordi',description:'Revisar calibració actual',done:true});
 await mutate('task.delete',{rowNumber});expect((await read()).tasks).toEqual(original.tasks);
 const next=await mutate('task.create',{patch:{owner:'Rafa',description:'Una altra tasca'}});expect(next.result.rowNumber).toBe(11);
 await mutate('task.restore',{rowNumber});
 const reopened=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});
 expect(reopened.tasks!.find(task=>task.rowNumber===rowNumber)).toEqual(edited);
 expect(reopened.orders).toEqual(original.orders);expect(reopened.phases).toEqual(original.phases);expect(reopened.sheets).toEqual(original.sheets);
 expect(reopened.tasks!.filter(task=>[6,9].includes(task.rowNumber))).toEqual(original.tasks);
 expect(reopened.audit.filter(entry=>entry.action.startsWith('task.')).map(entry=>({action:entry.action,target:entry.target}))).toEqual([{action:'task.create',target:'10'},{action:'task.update',target:'10'},{action:'task.delete',target:'10'},{action:'task.create',target:'11'},{action:'task.restore',target:'10'}]);
 expect(reopened.audit.find(entry=>entry.action==='task.create')?.after).toMatchObject({owner:'Rafa',done:false});
 expect(reopened.audit.find(entry=>entry.action==='task.delete')).toMatchObject({actor:'jordi',before:edited,after:null});
 expect(reopened.audit.at(-1)).toMatchObject({actor:'jordi',before:null,after:edited});
});

it('keeps the deployed done checkbox contract and rejects unsupported fields, blank text and invalid identities atomically',async()=>{
 await mutate('task.update',{rowNumber:9,done:true});expect((await read()).tasks![1].done).toBe(true);
 const before=await read();
 for(const body of [{rowNumber:9,patch:{}},{rowNumber:9,patch:{description:'  '}},{rowNumber:9,patch:{rowNumber:100}},{rowNumber:9,patch:{done:'true'}},{rowNumber:9.5,done:false},{rowNumber:9,done:false,patch:{done:true}},{rowNumber:999,patch:{description:'Absent'}}])await expect(mutate('task.update',body)).rejects.toBeDefined();
 for(const patch of [{description:'No owner'},{owner:'QA',description:' '},{owner:'QA',description:'QA',extra:'field'},{owner:2,description:'QA'}])await expect(mutate('task.create',{patch})).rejects.toMatchObject({status:400});
 await expect(mutate('task.delete',{rowNumber:999})).rejects.toMatchObject({status:404});
 expect(await read()).toEqual(before);
});

it('rejects stale/repeated/concurrent writes and duplicate content without creating another task or audit',async()=>{
 const revision=(await read()).revision;
 const input={action:'task.create',revision,reason:'Repeated user request',patch:{owner:'Rafa',description:'Revisió única'}};
 const results=await Promise.allSettled([mutateProduction(ctx,input),mutateProduction(ctx,input)]);
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
 expect(results.find(result=>result.status==='rejected')).toMatchObject({reason:{status:409}});
 const before=await read();
 await expect(mutate('task.create',{patch:{owner:' rafa ',description:' revisió única '}})).rejects.toMatchObject({status:409});
 await expect(mutate('task.update',{rowNumber:6,patch:{owner:'Rafa',description:'Revisió única'}})).rejects.toMatchObject({status:409});
 expect(await read()).toEqual(before);
 await mutate('task.delete',{rowNumber:10});const retired=await read();
 await expect(mutateProduction(ctx,{action:'task.delete',revision:before.revision,rowNumber:10,reason:'Repeated delete'})).rejects.toMatchObject({status:409});
 await expect(mutate('task.delete',{rowNumber:10})).rejects.toMatchObject({status:404});
 expect(await read()).toEqual(retired);
});

it('requires machine rights for every task operation and rejects conflicting or repeated restoration',async()=>{
 const before=await read();
 for(const action of ['task.create','task.update','task.delete','task.restore'])await expect(mutateProduction({...ctx,grants:['read','orders']},{action,revision:before.revision,rowNumber:6,patch:{owner:'QA',description:'QA'},reason:'Denied actor'})).rejects.toMatchObject({status:403});
 expect(await read()).toEqual(before);
 await mutate('task.delete',{rowNumber:6});await mutate('task.create',{patch:{owner:'Arturo',description:'Tasca original'}});
 const duplicate=await read();await expect(mutate('task.restore',{rowNumber:6})).rejects.toMatchObject({status:409});expect(await read()).toEqual(duplicate);
 await mutate('task.delete',{rowNumber:10});await mutate('task.restore',{rowNumber:6});const restored=await read();
 await expect(mutate('task.restore',{rowNumber:6})).rejects.toMatchObject({status:404});expect(await read()).toEqual(restored);
});

it('exposes all task operations through the normal chat schema and validates import task identities',()=>{
 const validate=new Ajv({strict:false}).compile(PRODUCTION_MUTATION_SCHEMA);
 const base={revision:1,reason:'User requested task change'};
 for(const body of [{action:'task.create',patch:{owner:'QA',description:'New'}},{action:'task.update',rowNumber:6,patch:{owner:'QA',description:'Updated',done:true}},{action:'task.update',rowNumber:6,done:true},{action:'task.delete',rowNumber:6},{action:'task.restore',rowNumber:6}])expect(validate({input:{...base,...body}})).toBe(true);
 for(const body of [{action:'task.create',patch:{description:'No owner'}},{action:'task.update',rowNumber:6,patch:{}},{action:'task.update',rowNumber:6,done:true,patch:{done:false}},{action:'task.delete',rowNumber:6,patch:{done:true}}])expect(validate({input:{...base,...body}})).toBe(false);
 expect(()=>previewImport({...dataset(),tasks:[dataset().tasks[0],dataset().tasks[0]]})).toThrow('Fila de tasca duplicada');
 expect(()=>previewImport({...dataset(),tasks:[{...dataset().tasks[0],rowNumber:6.5}]})).toThrow('Fila de tasca duplicada');
});


it('allows done changes on distinct original task identities even when their legacy content is duplicated',async()=>{
 const raw=dataset();raw.tasks=[{rowNumber:6,owner:'Arturo',description:'Original duplicada',done:false},{rowNumber:9,owner:'Arturo',description:'Original duplicada',done:false}];
 await mutateProduction(ctx,{action:'import.commit',dataset:raw,sha256:previewImport(raw).sha256,revision:(await read()).revision,reason:'Synthetic legacy duplicate fixture'});
 await mutate('task.update',{rowNumber:6,done:true});
 await mutate('task.update',{rowNumber:9,patch:{owner:'Arturo',description:'Original duplicada',done:true}});
 expect((await read()).tasks).toEqual(raw.tasks.map(task=>({...task,done:true})));
});
