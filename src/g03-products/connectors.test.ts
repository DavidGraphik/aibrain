import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('server-only',()=>({}));
import { ProductStore } from './persistence';
import type { ProductContext } from './access';
import type { ProductionState } from './contracts';
import { productConnectorResources, internalConnectorsForIdentity } from './connectors';
import { mutateApp } from './apps';
import { connectorMentionDeveloperInstructions, projectConnectorMention } from '@/connectors/mentions-contract';
let root:string,ctx:ProductContext;
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'g03-connectors-'));ctx={installationId:'g03-qa',actor:'owner',grants:['read','apps'],store:new ProductStore(root,'g03-qa')};});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
it('only offers imported readable production, never grants production access to an app-only identity',async()=>{
 expect(await productConnectorResources(ctx)).toEqual([]);
 await ctx.store.mutate<ProductionState,void>('production',()=>({revision:0,capturedAt:'2026-10-27T12:00:00Z',sourceVersion:'V7',lookups:{machines:[],productionStatuses:[]},orders:[],phases:[],receipts:[],sageKeys:[],audit:[]}),()=>{});
 expect((await productConnectorResources(ctx)).map(r=>r.id)).toEqual(['g03-production']);
 expect(await productConnectorResources({...ctx,grants:['apps']})).toEqual([]);
 await writeFile(path.join(root,'production.json'),'invalid');
 expect(await productConnectorResources(ctx)).toEqual([]);
});
it('rechecks shared publication access and binds the selected connector to its published app',async()=>{
 const a=await mutateApp(ctx,{action:'create',title:'Qualitat',html:'<h1>Qualitat</h1>',fields:[],instruction:'Test'}) as {id:string};
 expect(await productConnectorResources(ctx)).toEqual([]);
 await mutateApp(ctx,{action:'publish',id:a.id,revision:1,version:1,shared:true});
 const other={...ctx,actor:'other',grants:[]};
 const [r]=await productConnectorResources(other);
 expect(r.id).toBe(`g03-app-${a.id}`);
 expect(r.appId).toBeNull(); // Internal apps must not configure external Codex apps.
 const mention=projectConnectorMention(r,new Map());
 expect(mention).toMatchObject({status:'connected',canRead:true});
 const instructions=connectorMentionDeveloperInstructions([{resource:r,mention}]);
 expect(instructions).toContain('"toolNamespace":"aibrain_g03_apps"');
 expect(instructions).toContain(`"readArguments":{"id":"${a.id}","published":true}`);
 await mutateApp(ctx,{action:'unpublish',id:a.id,revision:2});
 expect(await productConnectorResources(other)).toEqual([]);
});
it('fails closed outside G03 and when the product policy is absent',async()=>{
 expect(await internalConnectorsForIdentity({installationId:'arnall'} as never,'owner')).toEqual([]);
 vi.stubEnv('AIBRAIN_G03_PRODUCT_POLICY',path.join(root,'missing.json'));
 try {expect(await internalConnectorsForIdentity({installationId:'g03-qa'} as never,'owner')).toEqual([]);}finally{vi.unstubAllEnvs();}
});
