import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('server-only',()=>({}));
import {ProductStore} from './persistence';
import type {ProductContext} from './access';
import type {ProductionState} from './contracts';
import {mutateProduction,previewImport,readProduction} from './production';

let root:string,ctx:ProductContext;
beforeEach(async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),'g03-color-values-'));
 ctx={installationId:'g03-qa',actor:'jordi',grants:['read','orders','machines','import'],store:new ProductStore(root,'g03-qa')};
 const dataset={capturedAt:'2026-10-28T00:00:00Z',sourceVersion:'V7',lookups:{machines:['M1'],productionStatuses:['EN PRODUCCIÓ','EXTERN']},orders:[{rowNumber:30,workOrder:'100/5',reference:'QA',units:10,unitsDelivered:0,assignedMachine:'M1',productionStatus:'EXTERN',materialStatus:'PENDENT'}],phases:[]};
 await mutateProduction(ctx,{action:'import.commit',dataset,sha256:previewImport(dataset).sha256,revision:0,reason:'Synthetic fixture'});
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
async function save(patch:Record<string,unknown>){return mutateProduction(ctx,{action:'configuration.update',revision:(await readProduction(ctx)).revision,reason:'Explicit cell color request',patch});}

it('stores a dropdown color by its canonical option and repairs only equivalent legacy keys',async()=>{
 await ctx.store.mutate<ProductionState,void>('production',()=>{throw Error('Missing fixture');},state=>{state.configuration={cellColors:{materialStatus:{'PENDENT ':'#ffff00',PENDENT:'#eeeeee',REBUT:'#00ff00','HISTÒRIC RETIRAT':'#123456'},reference:{'  QA  ':'#abcdef'}}};});
 const before=await readProduction(ctx);
 await save({cellColors:{materialStatus:{' pendent  ':'#ff0000'}}});
 const reopened=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});
 expect(reopened.configuration?.cellColors?.materialStatus).toEqual({PENDENT:'#ff0000',REBUT:'#00ff00','HISTÒRIC RETIRAT':'#123456'});
 expect(reopened.configuration?.cellColors?.reference).toEqual({'  QA  ':'#abcdef'});
 expect(reopened.orders).toEqual(before.orders);
 expect(reopened.audit.at(-1)).toMatchObject({action:'configuration.update',actor:'jordi',before:{configuration:{cellColors:{materialStatus:{'PENDENT ':'#ffff00',PENDENT:'#eeeeee'}}}}});
});

it('resolves saved and same-patch dropdown labels, historical options and machine case without changing data',async()=>{
 await save({dropdownLabels:{materialStatus:{PENDENT:'Material pendent'},productionStatus:{EXTERN:'Taller extern'},assignedMachine:{M1:'Torn principal'}}});
 await save({productionStatuses:['EN PRODUCCIÓ'],cellColors:{materialStatus:{' material pendent ':'#ff0000'},productionStatus:{' taller extern ':'#112233'},assignedMachine:{' m1 ':'#223344'}}});
 let next=await readProduction(ctx);
 expect(next.configuration?.cellColors).toMatchObject({materialStatus:{PENDENT:'#ff0000'},productionStatus:{EXTERN:'#112233'},assignedMachine:{M1:'#223344'}});
 expect(next.orders[0].productionStatus).toBe('EXTERN');
 await save({dropdownLabels:{materialStatus:{PENDENT:'Falta material'}},cellColors:{materialStatus:{'falta material':'#445566'}}});
 next=await readProduction(ctx);expect(next.configuration?.cellColors?.materialStatus).toEqual({PENDENT:'#445566'});
});

it('preserves blank matching and exact free-column keys and removes equivalent dropdown overrides',async()=>{
 await save({cellColors:{materialStatus:{' ':'#abcdef'},reference:{'  QA  ':'#123456'}}});
 const before=await readProduction(ctx);expect(before.configuration?.cellColors).toMatchObject({materialStatus:{'':'#abcdef'},reference:{'  QA  ':'#123456'}});
 await save({cellColors:{materialStatus:{'   ':null}}});expect((await readProduction(ctx)).configuration?.cellColors?.materialStatus).toEqual({});
});

it('rejects unknown or ambiguous dropdown values and conflicting aliases atomically',async()=>{
 await save({dropdownLabels:{materialStatus:{PENDENT:'Mateix',REBUT:'Mateix'}}});
 const before=await readProduction(ctx);
 for(const cellColors of [{materialStatus:{'No existeix':'#ff0000'}},{materialStatus:{Mateix:'#ff0000'}},{materialStatus:{PENDENT:'#ff0000','pendent ':'#0000ff'}},{materialStatus:{PENDENT:'#ff0000','pendent ':null}}])await expect(save({cellColors})).rejects.toMatchObject({status:400});
 expect(await readProduction(ctx)).toEqual(before);
 await save({cellColors:{materialStatus:{PENDENT:'#ff0000','pendent ':'#FF0000'}}});
 expect((await readProduction(ctx)).configuration?.cellColors?.materialStatus).toEqual({PENDENT:'#FF0000'});
});
