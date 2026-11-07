import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Ajv from 'ajv';
vi.mock('server-only',()=>({}));
import {ProductStore} from './persistence';
import {mutateProduction,readProduction} from './production';
import {PRODUCTION_MUTATION_SCHEMA} from './chat-tools';
import type {ProductContext} from './access';
import {defaultProductionView,normalizeProductionView,productionColumns,type ProductionView} from './production-columns';
let root:string,ctx:ProductContext;
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'g03-view-'));ctx={installationId:'g03-qa',actor:'jordi',grants:['read'],store:new ProductStore(root,'g03-qa')};});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
it('saves personal layout via the production chat contract, survives restart and preserves order data/revision',async()=>{
  const before=await readProduction(ctx);
  const input={action:'view.update',revision:before.view.revision,reason:'Amplia màquina i comentari',columnWidths:{assignedMachine:320,statusComment:400}};
  expect(new Ajv({strict:false}).compile(PRODUCTION_MUTATION_SCHEMA)({input})).toBe(true);
  expect(await mutateProduction(ctx,input)).toMatchObject({revision:1,columnWidths:input.columnWidths});
  const after=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});
  expect(after.view).toMatchObject({revision:1,columnWidths:input.columnWidths});
  expect({...after,view:before.view,capturedAt:before.capturedAt}).toEqual(before);
  expect((await readProduction({...ctx,actor:'lidia'})).view).toEqual(before.view);
  await expect(mutateProduction(ctx,input)).rejects.toMatchObject({status:409});
});
it('requires read permission and rejects unknown columns, fractional/out-of-range sizes and foreign stores',async()=>{
  const base={action:'view.update',revision:0,reason:'Ajustar'};
  await expect(mutateProduction({...ctx,grants:[]},{...base,columnWidths:{assignedMachine:200}})).rejects.toMatchObject({status:403});
  for(const columnWidths of [{foreign:200},{assignedMachine:10},{assignedMachine:1001},{assignedMachine:100.5},{}])await expect(mutateProduction(ctx,{...base,columnWidths})).rejects.toMatchObject({status:400});
  await mutateProduction(ctx,{...base,columnWidths:{assignedMachine:250}});
  await expect(readProduction({...ctx,store:new ProductStore(root,'other-tenant')})).rejects.toMatchObject({status:403});
});
it('compacts only untouched legacy defaults, preserves personal sizes and persists the migration with the next resize',async()=>{
  const key=`production-view-${createHash('sha256').update(ctx.actor).digest('hex')}`;
  const legacyWidths={client:150,reference:160,description:280,readyStock:85,deliveryDate:155,salesOrder:140,workOrder:120,printStatus:140,units:90,unitsDelivered:90,unitsPending:90,materialEta:155,unitsReceivedTotal:100,unitsAtG03:90,materialMissing:90,priority:85};
  const legacy:ProductionView={revision:0,columnWidths:{...defaultProductionView().columnWidths,...legacyWidths,assignedMachine:320,productionStatus:300,statusComment:400,materialStatus:250,reference:185}};
  await ctx.store.mutate(key,()=>legacy,()=>{});
  const before=await readProduction(ctx);
  expect(before.view).toMatchObject({revision:1,layoutVersion:2,columnWidths:{client:120,reference:185,description:180,units:72,deliveryDate:136,assignedMachine:320,productionStatus:300,statusComment:400,materialStatus:250}});
  // Readback itself does not write or change the user's optimistic revision.
  expect((await ctx.store.read<ProductionView>(key))?.layoutVersion).toBeUndefined();
  await mutateProduction(ctx,{action:'view.update',revision:1,reason:'Ajust personal',columnWidths:{client:150}});
  const after=await readProduction({...ctx,store:new ProductStore(root,'g03-qa')});
  expect(after.view).toMatchObject({revision:2,layoutVersion:2,columnWidths:{client:150,reference:185,description:180,assignedMachine:320}});
  expect((await ctx.store.read<ProductionView>(key))?.layoutVersion).toBe(2);
  expect({...after,view:before.view,capturedAt:before.capturedAt}).toEqual(before);
  expect((await readProduction({...ctx,actor:'lidia'})).view).toEqual(defaultProductionView());
});
it('keeps the four requested expanded defaults and preserves intentional old-default widths after migration',()=>{
  const defaults=defaultProductionView();
  expect(defaults.columnWidths).toMatchObject({assignedMachine:210,productionStatus:230,statusComment:280,materialStatus:190,client:120,description:180,units:72});
  expect(productionColumns.every(column=>column.width>=72)).toBe(true);
  const personal={...defaults,columnWidths:{...defaults.columnWidths,client:150,description:280,units:90}};
  expect(normalizeProductionView(personal)).toEqual(personal);
});
it('persists Arial 10 points separately from widths and production data, isolated to the authenticated actor',async()=>{
  await mutateProduction(ctx,{action:'view.update',revision:0,reason:'Amplada pròpia',columnWidths:{assignedMachine:188}});
  const before=await readProduction(ctx);
  const input={action:'view.update',revision:before.view.revision,reason:'Arial 10 demanat per Jordi',fontFamily:'Arial',fontSizePt:10};
  expect(new Ajv({strict:false}).compile(PRODUCTION_MUTATION_SCHEMA)({input})).toBe(true);
  expect(await mutateProduction(ctx,input)).toMatchObject({revision:2,fontFamily:'Arial',fontSizePt:10,columnWidths:{assignedMachine:188}});
  const restarted={...ctx,store:new ProductStore(root,'g03-qa')};
  const after=await readProduction(restarted);
  expect(after.view).toMatchObject({revision:2,fontFamily:'Arial',fontSizePt:10,columnWidths:before.view.columnWidths});
  expect({...after,view:before.view,capturedAt:before.capturedAt}).toEqual(before);
  expect((await readProduction({...restarted,actor:'rafa'})).view).toEqual(defaultProductionView());
  await expect(mutateProduction(ctx,input)).rejects.toMatchObject({status:409});
  await mutateProduction(ctx,{action:'view.update',revision:2,reason:'Amplada sense canviar la lletra',columnWidths:{client:150}});
  expect((await readProduction(ctx)).view).toMatchObject({fontFamily:'Arial',fontSizePt:10,columnWidths:{client:150,assignedMachine:188}});
});
it('rejects unsafe fonts/sizes, missing changes, foreign actor inputs and font writes without read permission',async()=>{
  const base={action:'view.update',revision:0,reason:'Tipografia pròpia'};
  const validator=new Ajv({strict:false}).compile(PRODUCTION_MUTATION_SCHEMA);
  for(const patch of [{fontFamily:'Arial; color:red'},{fontFamily:'Other font'},{fontSizePt:7},{fontSizePt:25},{fontSizePt:10.1},{fontSizePt:NaN},{fontSizePt:Infinity},{fontFamily:'Arial',userId:'foreign'},{}]) {
    expect(validator({input:{...base,...patch}})).toBe(false);
    await expect(mutateProduction(ctx,{...base,...patch})).rejects.toMatchObject({status:400});
  }
  await expect(mutateProduction({...ctx,grants:[]},{...base,fontFamily:'Arial',fontSizePt:10})).rejects.toMatchObject({status:403});
  expect((await readProduction(ctx)).view.revision).toBe(0);
});
it('keeps the existing 13px equivalent for legacy views and normalizes unsafe saved typography',()=>{
  expect(defaultProductionView()).toMatchObject({fontFamily:'Arial',fontSizePt:9.75});
  expect(normalizeProductionView({revision:4,columnWidths:{assignedMachine:333}})).toMatchObject({fontFamily:'Arial',fontSizePt:9.75,columnWidths:{assignedMachine:333}});
  expect(normalizeProductionView({revision:4,columnWidths:{},fontFamily:'url(https://example.test)' as never,fontSizePt:100})).toMatchObject({fontFamily:'Arial',fontSizePt:9.75});
});
it('advertises recoverable catalog restoration with the original row identity and no fabricated patch',()=>{
  const validator=new Ajv({strict:false}).compile(PRODUCTION_MUTATION_SCHEMA);
  const input={action:'catalog.restore',revision:25,reason:'Restaurar referència retirada',rowNumber:9};
  expect(validator({input})).toBe(true);
  expect(validator({input:{...input,patch:{reference:'replacement'}}})).toBe(false);
  expect(validator({input:{...input,rowNumber:'9'}})).toBe(false);
});
