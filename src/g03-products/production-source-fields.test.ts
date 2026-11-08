import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
vi.mock('server-only',()=>({}));
import {ProductStore} from './persistence';
import {mutateProduction,previewImport,readProduction} from './production';
import {productionSourceFields,type Grant} from './contracts';
import {PRODUCTION_MUTATION_SCHEMA} from './chat-tools';
import type {ProductContext} from './access';
let root:string,ctx:ProductContext;
const full:Grant[]=['read','orders','machines','receipts','validate-receipts','import','apps'];
const dataset=(sourceVersion:string,description='Peça original')=>({sourceVersion,capturedAt:'2026-10-20T00:00:00Z',lookups:{machines:['M1'],productionStatuses:['NO COMENÇAT']},orders:[{rowNumber:30,workOrder:'OF1',client:'Client original',reference:'REF1',description,units:10,productionStatus:'NO COMENÇAT'}],phases:[]});
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'g03-source-fields-'));ctx={installationId:'g03-qa',actor:'jordi',grants:full,store:new ProductStore(root,'g03-qa')};});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
async function importSource(sourceVersion:string,revision=0,description?:string){const source=dataset(sourceVersion,description),preview=previewImport(source);return mutateProduction(ctx,{action:'import.commit',revision,dataset:source,sha256:preview.sha256,reason:'Reviewed source import'});}

it.each(['V7','V6 TEST SINTÈTIC'])('keeps the three source fields immutable for an existing %s order even with all Jordi grants',async(version)=>{
  await importSource(version);
  const before=await readProduction(ctx);
  for(const field of productionSourceFields){
    for(const value of ['Canvi',null,before.orders[0][field]]){
      await expect(mutateProduction(ctx,{action:'order.update',revision:1,rowNumber:30,patch:{[field]:value,statusComment:'Must not be partially saved'},reason:'Requested row edit'})).rejects.toMatchObject({status:400,message:expect.stringContaining('només lectura')});
      expect(await readProduction(ctx)).toEqual(before);
    }
  }
  await mutateProduction(ctx,{action:'order.update',revision:1,rowNumber:30,patch:{statusComment:'Comentari permès'},reason:'Requested operational edit'});
  expect((await readProduction(ctx)).orders[0]).toMatchObject({...before.orders[0],statusComment:'Comentari permès'});
});

it('still populates source fields on creation and accepts a reviewed source replacement without a readonly bypass flag',async()=>{
  await importSource('V6 TEST SINTÈTIC');
  await mutateProduction(ctx,{action:'order.create',revision:1,patch:{workOrder:'OF2',client:'Nou client',reference:'REF2',description:'Nova peça',units:4},reason:'New order entry'});
  expect((await readProduction(ctx)).orders[1]).toMatchObject({client:'Nou client',reference:'REF2',description:'Nova peça'});
  await importSource('V6 TEST SINTÈTIC',2,'Peça actualitzada al full');
  expect((await readProduction(ctx)).orders[0].description).toBe('Peça actualitzada al full');
});

it('exposes designer-capable source field edits in the chat schema while the server enforces source immutability for ordinary editors',()=>{
  const validate=new Ajv({strict:false}).compile(PRODUCTION_MUTATION_SCHEMA);
  const base={revision:1,reason:'User request'};
  for(const field of productionSourceFields){
    // The shared tool schema supports designers; the server-side tests above
    // still prove all ordinary editor grants cannot alter these source fields.
    expect(validate({input:{...base,action:'order.update',rowNumber:30,patch:{[field]:'Changed'}}})).toBe(true);
    expect(validate({input:{...base,action:'order.create',patch:{workOrder:'OF2',[field]:'Entered'}}})).toBe(true);
  }
  expect(validate({input:{...base,action:'order.update',rowNumber:30,patch:{statusComment:'Allowed',assignedMachine:'M1'}}})).toBe(true);
  expect(validate({input:{...base,action:'order.update',rowNumber:30,patch:{sourceVersion:'Changed'}}})).toBe(false);
  expect(validate({input:{...base,action:'import.commit',dataset:dataset('V7'),sha256:'reviewed'}})).toBe(true);
});
