import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { mkdtemp,rm,readFile } from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
vi.mock('server-only',()=>({}));
import { ProductStore } from './persistence';import type { ProductContext } from './access';
import { readProductionDesign,mutateProductionDesign } from './production-design';
import { mutateApp,readApp } from './apps';import { appBridge } from './app-bridge';
import { readProduction,mutateProduction } from './production';import type { ProductionState } from './contracts';
import { defaultProductionTabs } from './production-design-contract';
let root:string,ctx:ProductContext;
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'g03-design-'));ctx={installationId:'g03-qa',actor:'jordi',appDesigner:true,appRecordsWritable:true,grants:['read','apps','orders','machines'],store:new ProductStore(root,'g03-qa')};});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const program=`<input id="n" type="number"><button id="save">Desar doble</button><output id="result"></output><script>save.onclick=async()=>{const data=await aibrain.data('list');const saved=await aibrain.data('create',{revision:data.revision,values:{double:Number(n.value)*2}});result.textContent='Desat';};</script>`;
async function create(activate=true){return await mutateApp(ctx,{action:'create',title:'Calculador',html:program,fields:[{name:'double',type:'number'}],instruction:'Crear calculador programable amb dades persistents',activate}) as {id:string;revision:number};}
it('leaves the existing working sheet and design unchanged until an explicit request',async()=>{
 const a=await readProduction(ctx),b=await readProductionDesign(ctx);expect(b.tabs).toEqual(defaultProductionTabs());expect(b.rules).toEqual([]);expect(b.revision).toBe(0);
 expect(await ctx.store.read('production')).toBeNull();expect(await ctx.store.read('production-design')).toBeNull();expect((await readProduction(ctx)).orders).toEqual(a.orders);
});
it('creates arbitrary functional tabs, activates source directly and persists program data across source edits and rollback',async()=>{
 const app=await create();expect((await readApp(ctx,app.id,true)).version.html).toBe(program);
 const tabs=[...defaultProductionTabs(),{key:'calculator',label:'Calculador',appId:app.id}];
 await mutateProductionDesign(ctx,{action:'apply',revision:0,instruction:'Afegir una pestanya amb programa',tabs});
 const records=await appBridge(ctx,{id:app.id,operation:'create',input:{revision:1,values:{double:24}}}) as {revision:number};
 const read=await readApp(ctx,app.id);expect(read.rows[0].values).toEqual({double:24});
 await mutateApp(ctx,{action:'update',id:app.id,revision:records.revision,html:program.replace('*2','*3'),fields:read.version.fields,instruction:'Canviar càlcul a triple',activate:true});
 const revised=await readApp(ctx,app.id,true);expect(revised.version.html).toContain('*3');expect(revised.rows).toEqual(read.rows);
 await mutateApp(ctx,{action:'restore',id:app.id,revision:revised.revision,version:1,instruction:'Recuperar doble',activate:true});
 const reopened={...ctx,store:new ProductStore(root,'g03-qa')};expect((await readApp(reopened,app.id,true)).version.html).toBe(program);expect((await readProductionDesign(reopened)).tabs).toEqual(tabs);expect((await readApp(reopened,app.id)).rows[0].values.double).toBe(24);
});
it('replaces an existing view with a program and restores navigation without modifying rows',async()=>{
 const app=await create(),tabs=defaultProductionTabs();await mutateProductionDesign(ctx,{action:'apply',revision:0,instruction:'Guardar disposició actual',tabs});
 const replacement=tabs.map(t=>t.builtin==='Producció'?{...t,appId:app.id,label:'Producció personalitzada'}:t);
 await mutateProductionDesign(ctx,{action:'apply',revision:1,instruction:'Canviar el funcionament de la vista existent',tabs:replacement});
 expect((await readProduction(ctx)).design.tabs.find(t=>t.builtin==='Producció')?.appId).toBe(app.id);
 await mutateProductionDesign(ctx,{action:'restore',revision:2,version:1,instruction:'Recuperar vista anterior'});
 expect((await readProductionDesign(ctx)).tabs).toEqual(tabs);expect((await readProduction(ctx)).orders).toEqual([]);
});
it('previews persistent records and normal order rules in a separate synthetic store, never touching working production',async()=>{
 const app=await create(false),call=(operation:string,input?:unknown)=>appBridge(ctx,{id:app.id,sandbox:true,operation,input});
 await mutateProduction(ctx,{action:'order.create',revision:0,reason:'Original sintètic que cal preservar',patch:{workOrder:'ORIGINAL',units:25,unitsDelivered:0}});const originalBytes=await readFile(path.join(root,'production.json'));
 const before=await readProduction(ctx);const demo=await call('production.read') as {revision:number};
 const result=await call('production.mutate',{action:'order.create',revision:demo.revision,reason:'Prova aïllada',patch:{workOrder:'QA1',units:10,unitsDelivered:0,productionStatus:'NO COMENÇAT'}}) as {revision:number};
 const design=await call('design.read') as {revision:number;tabs:unknown[]};
 await call('design.apply',{action:'apply',revision:design.revision,instruction:'Calcular prioritat al full de prova',tabs:design.tabs,rules:[{id:'prioritat',when:{op:'>',args:[{field:'next.units'},5]},set:{priority:1,statusComment:{op:'concat',args:['Unitats: ',{field:'next.units'}]}}}]});
 const rows=await call('production.read') as {orders:{rowNumber:number}[]};
 await call('production.mutate',{action:'order.update',revision:result.revision,rowNumber:rows.orders[0].rowNumber,reason:'Provar regla',patch:{units:12}});
 const after=await call('production.read') as {orders:{priority:number;statusComment:string}[]};expect(after.orders[0]).toMatchObject({priority:1,statusComment:'Unitats: 12'});
 expect((await readProduction(ctx)).orders).toEqual(before.orders);expect((await readFile(path.join(root,'production.json'))).equals(originalBytes)).toBe(true);expect(await ctx.store.read('production-design')).toBeNull();
 const state=await call('list') as {revision:number};await call('create',{revision:state.revision,values:{double:8}});expect((await call('list') as {rows:unknown[]}).rows).toHaveLength(1);expect((await readApp(ctx,app.id)).rows).toEqual([]);
 const original=await readApp(ctx,app.id);await mutateApp(ctx,{action:'update',id:app.id,revision:original.revision,html:program.replace('*2','*3'),fields:original.version.fields,instruction:'Canviar càlcul només al preview'});
 expect((await call('list')as {rows:{values:{double:number}}[]}).rows[0].values.double).toBe(8);
 const changed=await readApp(ctx,app.id);await mutateApp(ctx,{action:'restore',id:app.id,revision:changed.revision,version:1,instruction:'Recuperar preview'});expect((await readApp(ctx,app.id)).publishedVersion).toBeNull();expect((await call('list')as {rows:unknown[]}).rows).toHaveLength(1);
});
it('enforces designer rights, exact design revisions, private app ownership and cross-installation isolation',async()=>{
 const app=await create(),reader={...ctx,actor:'other',appDesigner:false,grants:['read','apps'] as ProductContext['grants']};
 await expect(mutateProductionDesign(reader,{action:'apply',revision:0,tabs:defaultProductionTabs(),instruction:'No rights'})).rejects.toMatchObject({status:403});
 await expect(mutateApp(reader,{action:'update',id:app.id,revision:1,html:'x',fields:[],instruction:'Not a designer',activate:true})).rejects.toMatchObject({status:403});
 await expect(appBridge(reader,{id:app.id,sandbox:true,operation:'production.read'})).rejects.toMatchObject({status:403});
 await expect(appBridge(reader,{id:app.id,operation:'production.mutate',input:{action:'order.create',revision:0,reason:'No rights',patch:{workOrder:'DENIED'}}})).rejects.toMatchObject({status:403});
 await mutateProductionDesign(ctx,{action:'apply',revision:0,tabs:defaultProductionTabs(),instruction:'Current'});
 await expect(mutateProductionDesign(ctx,{action:'apply',revision:0,tabs:defaultProductionTabs(),instruction:'Stale'})).rejects.toMatchObject({status:409});
 const foreign={...ctx,store:new ProductStore(root,'other')};await expect(readProductionDesign(foreign)).rejects.toMatchObject({status:403});
 const privateApp=await mutateApp({...ctx,actor:'other'},{action:'create',title:'Private',html:'private',fields:[],instruction:'Private'}) as {id:string};await expect(readApp(ctx,privateApp.id)).rejects.toMatchObject({status:403});
});
it('validates program bindings and rejects unsafe rules without changing the design',async()=>{
 await expect(mutateProductionDesign(ctx,{action:'apply',revision:0,instruction:'Unsafe',tabs:[{key:'bad',label:'Bad',appId:'11111111-1111-4111-8111-111111111111'}]})).rejects.toMatchObject({status:404});
 await expect(mutateProductionDesign(ctx,{action:'apply',revision:0,instruction:'Unsafe',tabs:defaultProductionTabs(),rules:[{id:'bad',set:{unitsAtG03:999}}]})).rejects.toMatchObject({status:400});
 await expect(mutateProductionDesign(ctx,{action:'apply',revision:0,instruction:'Unsafe',tabs:defaultProductionTabs(),rules:[{id:'bad',set:{priority:{op:'eval',args:['process.env']}}}]})).rejects.toMatchObject({status:400});
 expect((await readProductionDesign(ctx)).revision).toBe(0);
});
it('deletes and restores program records recoverably, rejecting duplicate/stale requests',async()=>{
 const app=await create(),bridge=(operation:string,input?:unknown)=>appBridge(ctx,{id:app.id,operation,input});
 const created=await bridge('create',{revision:1,values:{double:18}})as {revision:number;rows:{id:string;revision:number;values:unknown}[]};const row=created.rows[0];
 const retired=await bridge('delete',{revision:created.revision,rowId:row.id,rowRevision:row.revision})as {revision:number;rows:unknown[];retiredRows:unknown[]};expect(retired.rows).toEqual([]);expect(retired.retiredRows).toEqual([row]);
 await expect(bridge('delete',{revision:retired.revision,rowId:row.id,rowRevision:row.revision})).rejects.toMatchObject({status:404});
 const restored=await bridge('restore',{revision:retired.revision,rowId:row.id,rowRevision:row.revision})as {revision:number;rows:typeof created.rows;retiredRows:unknown[]};expect(restored.rows[0]).toMatchObject({id:row.id,revision:2,values:{double:18}});expect(restored.retiredRows).toEqual([]);
});
it('changes functional rules in the isolated normal order flow, rolls them back and rejects invalid arithmetic atomically',async()=>{
 const app=await create(false),bridge=(operation:string,input?:unknown)=>appBridge(ctx,{id:app.id,sandbox:true,operation,input});
 await bridge('design.apply',{revision:0,instruction:'Versió original',tabs:defaultProductionTabs(),rules:[]});
 await bridge('design.apply',{revision:1,instruction:'Calcular prioritat',tabs:defaultProductionTabs(),rules:[{id:'calc',set:{priority:{op:'*',args:[{field:'next.units'},2]}}}]});
 const seed=await bridge('production.read')as {revision:number};await bridge('production.mutate',{action:'order.create',revision:seed.revision,reason:'Provar càlcul',patch:{workOrder:'QA1',units:3}});
 const before=await bridge('production.read')as {revision:number;orders:{rowNumber:number;priority:number}[]};expect(before.orders[0].priority).toBe(6);
 await bridge('design.apply',{revision:2,instruction:'Provar divisió invàlida',tabs:defaultProductionTabs(),rules:[{id:'bad',set:{priority:{op:'/',args:[1,0]}}}]});
 await expect(bridge('production.mutate',{action:'order.update',revision:before.revision,rowNumber:before.orders[0].rowNumber,reason:'Ha de fallar sense tocar dades',patch:{units:4}})).rejects.toMatchObject({status:400});
 const failed=await bridge('production.read')as typeof before;expect(failed.revision).toBe(before.revision);expect(failed.orders).toEqual(before.orders);
 await bridge('design.restore',{revision:3,version:1,instruction:'Recuperar regles originals'});
 await bridge('production.mutate',{action:'order.update',revision:failed.revision,rowNumber:before.orders[0].rowNumber,reason:'Sense regla',patch:{units:4}});
 expect((await bridge('production.read')as typeof before).orders[0].priority).toBe(6);expect(await ctx.store.read('production')).toBeNull();
});
it('paginates program production reads without transporting workbook cells or full audit snapshots',async()=>{
 const app=await create();await mutateProduction(ctx,{action:'order.create',revision:0,reason:'Synthetic source',patch:{workOrder:'ORIGINAL',units:25}});
 await ctx.store.mutate<ProductionState,void>('production',()=>{throw Error('Missing');},state=>{state.orders[0].sourceCells={private_workbook:'x'.repeat(1024*1024)};state.audit.push({at:new Date().toISOString(),actor:'jordi',action:'import.commit',target:'test',before:{orders:state.orders,sourceSheets:[{xml:'y'.repeat(1024*1024)}]},after:null,reason:'Synthetic large source'});});
 const original=await readFile(path.join(root,'production.json'));
 const read=await appBridge(ctx,{id:app.id,operation:'production.read',input:{limit:1}})as {complete:boolean;totalRecords:number};const text=JSON.stringify(read);
 expect(read).toMatchObject({complete:true,totalRecords:1});expect(text.length).toBeLessThan(10000);expect(text).not.toContain('private_workbook');expect(text).not.toContain('sourceSheets');expect(text).not.toContain('import.commit');
 expect((await readFile(path.join(root,'production.json'))).equals(original)).toBe(true);
});
