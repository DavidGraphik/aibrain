import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, chmod, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("server-only",()=>({}));
vi.mock("./g03-sage-transport",()=>({sageServerFetch:(...args:Parameters<typeof fetch>)=>fetch(...args)}));
const state=vi.hoisted(()=>({allowed:true,enabled:true,dataRoot:""}));
vi.mock("@/auth/local-user-store",()=>({FileLocalUserStore:class {async read(id:string){return {userId:id,enabled:state.enabled};}}}));
vi.mock("@/catalog/access-service",()=>({catalogRuntimeEnforcer:vi.fn(async()=>({allowsConnector:()=>state.allowed}))}));
vi.mock("@/config/installation",()=>({loadInstallationConfig:async()=>({installationId:"g03-production",paths:{dataRoot:state.dataRoot}})}));
import { g03SageReadForIdentity, g03SageReadBatchForIdentity, g03SageHealth } from "./g03-sage-service";
const user="11111111-1111-4111-8111-111111111111";let directory:string|undefined;
afterEach(async()=>{if(directory)await rm(directory,{recursive:true,force:true});directory=undefined;vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();state.allowed=true;state.enabled=true;});
async function setup(){directory=await mkdtemp(path.join(tmpdir(),"sage-readonly-test-"));state.dataRoot=directory;await mkdir(path.join(directory,"g03-sage"));const file=path.join(directory,"g03-sage","config.json");await writeFile(file,JSON.stringify({installationId:"g03-production",companyCode:"1",baseUrl:"https://sage.example.test/api",username:directory,password:"private",appId:"synthetic",allowedQueries:["Products"],allowedUserIds:[user]}),{mode:0o600});vi.stubEnv("AIBRAIN_G03_SAGE_CONFIG",file);return file;}
it("requires same installation, catalog permission, explicitly bound user and private600 config before network",async()=>{
 const file=await setup();const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
 await expect(g03SageReadForIdentity("another-tenant",user,"discover",{})).rejects.toMatchObject({code:"SAGE_ACCESS_DENIED"});
 await expect(g03SageReadForIdentity("g03-production","22222222-2222-4222-8222-222222222222","discover",{})).rejects.toMatchObject({code:"SAGE_ACCESS_DENIED"});
 state.allowed=false;await expect(g03SageReadForIdentity("g03-production",user,"discover",{})).rejects.toMatchObject({code:"SAGE_ACCESS_DENIED"});state.allowed=true;
 await chmod(file,0o644);await expect(g03SageReadForIdentity("g03-production",user,"discover",{})).rejects.toMatchObject({code:"SAGE_ACCESS_DENIED"});expect(fetcher).not.toHaveBeenCalled();
});
it("default dataRoot config works without environment/Compose and health verifies live company/catalog",async()=>{
 await setup();vi.stubEnv("AIBRAIN_G03_SAGE_CONFIG","");let count=0;
 const f=vi.fn(async()=>{count++;if(count===1)return Response.json({publicToken:"synthetic-token-12345"});if(count===2)return Response.json({value:JSON.stringify([{Code:1,Name:"G03 MECANITZATS MALGRAT S.L."}])});return Response.json([{name:"Products",parameters:"CodigoEmpresa"}]);});vi.stubGlobal("fetch",f);
 expect(await g03SageHealth("g03-production",user)).toEqual({status:"connected",statusCode:"SAGE_READ_ONLY_VERIFIED",accessVerified:true});expect(f).toHaveBeenCalledTimes(3);
});
it("never calls a configured but unavailable provider connected",async()=>{
 await setup();vi.stubGlobal("fetch",vi.fn(async()=>new Response("private provider error",{status:500})));
 expect(await g03SageHealth("g03-production",user)).toMatchObject({status:"unavailable",statusCode:"SAGE_PROVIDER_UNAVAILABLE",accessVerified:true});
});
it("does not release provider data if the actor is revoked during a read",async()=>{
 await setup();let count=0;vi.stubGlobal("fetch",vi.fn(async()=>{count++;
  if(count===1)return Response.json({publicToken:"synthetic-token-12345"});
  if(count===2)return Response.json({value:JSON.stringify([{Code:1,Name:"G03 MECANITZATS MALGRAT S.L."}])});
  if(count===3)return Response.json([{name:"Products",parameters:"CodigoEmpresa"}]);
  state.allowed=false;return Response.json([{CompanyId:1,Code:"private-record"}]);
 }));await expect(g03SageReadForIdentity("g03-production",user,"read",{query:"Products"})).rejects.toMatchObject({code:"SAGE_ACCESS_DENIED"});
});
it('keeps every receiving write disabled with the existing read-only configuration before any provider call',async()=>{
 const {g03SageReceivingCapabilities,g03SageReceiptWriteForIdentity}=await import('./g03-sage-service');await setup();const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 expect(await g03SageReceivingCapabilities('g03-production',user)).toEqual({providerWrites:false,productionWrites:false});
 await expect(g03SageReceiptWriteForIdentity('g03-production',user,{tables:[]})).rejects.toMatchObject({code:'SAGE_RECEIVING_WRITES_DISABLED'});expect(fetcher).not.toHaveBeenCalled();
});
it('requires both private flags and an exact write-user binding; a read grant alone is insufficient',async()=>{
 const {g03SageReceivingCapabilities}=await import('./g03-sage-service');const file=await setup();const source=JSON.parse(await (await import('node:fs/promises')).readFile(file,'utf8'));
 for(const receiving of [{providerWrites:true,productionWrites:true,allowedWriteUserIds:[]},{providerWrites:true,productionWrites:false,allowedWriteUserIds:[user]}]){
  await writeFile(file,JSON.stringify({...source,receiving}),{mode:0o600});const result=await g03SageReceivingCapabilities('g03-production',user);expect(result.providerWrites&&result.productionWrites).toBe(false);
 }
});
it('revokes a disabled employee even when the shared connection and catalog still allow the actor',async()=>{
 const {g03SageAccess}=await import('./g03-sage-service');await setup();const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 expect(await g03SageAccess('g03-production',user)).toHaveProperty('reader');
 state.enabled=false;
 await expect(g03SageAccess('g03-production',user)).rejects.toMatchObject({code:'SAGE_ACCESS_DENIED'});
 expect(fetcher).not.toHaveBeenCalled();
});

it("keeps canonical access distinct from a two-second provider probe timeout",async()=>{
 await setup();
 const {SageReader}=await import("./g03-sage-api");
 const discover=vi.spyOn(SageReader.prototype,"discover").mockImplementation(()=>new Promise(()=>{}));
 vi.useFakeTimers();
 const pending=g03SageHealth("g03-production",user);
 await vi.waitFor(()=>expect(discover).toHaveBeenCalled());
 await vi.advanceTimersByTimeAsync(2000);
 expect(await pending).toEqual({status:"unavailable",statusCode:"SAGE_HEALTH_PENDING",accessVerified:true});
});
it("never supplies a canonical access proof after a catalog denial",async()=>{
 await setup();state.allowed=false;
 const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
 expect(await g03SageHealth("g03-production",user)).toEqual({status:"not_configured",statusCode:"G03_SAGE_API_PENDING",accessVerified:false});
 expect(fetcher).not.toHaveBeenCalled();
});

it('uses the Madrid day as the default order end date and keeps the actual interval in the receipt',async()=>{
 const file=await setup();const contents=JSON.parse(await (await import('node:fs/promises')).readFile(file,'utf8'));
 await writeFile(file,JSON.stringify({...contents,allowedQueries:['SalesOrders']}),{mode:0o600});
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-05T23:30:00Z'));
 const {SageReader}=await import('./g03-sage-api');
 const read=vi.spyOn(SageReader.prototype,'read').mockResolvedValue({source:'SAGE',companyCode:'1',companyName:'synthetic',query:'SalesOrders',items:[],skip:0,take:50,nextOffset:null,limitReached:false,complete:true,checkedAt:'2026-11-05T23:30:00Z'} as never);
 const result=await g03SageReadBatchForIdentity('g03-production',user,{query:'SalesOrders'});
 expect(result).toMatchObject({parameters:{FechaInicial:'1900-01-01',FechaFinal:'2026-11-06'},complete:true,coverage:{globalComplete:false,reachedEndOfQuery:true,completeFromBeginning:true}});
 expect(read).toHaveBeenCalledWith('SalesOrders',{FechaInicial:'1900-01-01',FechaFinal:'2026-11-06'},0,50,expect.any(AbortSignal));
});
it('suppresses all batched results when a user grant is revoked mid-query',async()=>{
 await setup();const {SageReader}=await import('./g03-sage-api');
 vi.spyOn(SageReader.prototype,'read').mockImplementation(async()=>{state.allowed=false;return {source:'SAGE',companyCode:'1',companyName:'synthetic',query:'Products',items:[{CompanyId:1}],skip:0,take:1,nextOffset:null,limitReached:false,complete:true,checkedAt:'2026-11-05T12:00:00Z'} as never;});
 await expect(g03SageReadBatchForIdentity('g03-production',user,{query:'Products',take:1})).rejects.toMatchObject({code:'SAGE_ACCESS_DENIED'});
});

it('rejects mixed batches if connection configuration changes while reading',async()=>{
 const file=await setup();const contents=JSON.parse(await (await import('node:fs/promises')).readFile(file,'utf8'));
 const {SageReader}=await import('./g03-sage-api');
 vi.spyOn(SageReader.prototype,'read').mockImplementation(async()=>{await writeFile(file,JSON.stringify({...contents,password:'changed-synthetic'}),{mode:0o600});return {source:'SAGE',companyCode:'1',companyName:'synthetic',query:'Products',items:[{CompanyId:1}],skip:0,take:1,nextOffset:null,limitReached:false,complete:true,checkedAt:'2026-11-05T12:00:00Z'} as never;});
 await expect(g03SageReadBatchForIdentity('g03-production',user,{query:'Products',take:1})).rejects.toMatchObject({code:'SAGE_CONNECTION_CHANGED'});
});

it('stops before another provider page when access is revoked during a batch', async () => {
 await setup(); const {SageReader} = await import('./g03-sage-api');
 const read = vi.spyOn(SageReader.prototype, 'read').mockImplementation(async () => {
  state.allowed = false;
  return {source:'SAGE', companyCode:'1', companyName:'synthetic', query:'Products', items:[{CompanyId:1}], skip:0, take:1, nextOffset:1, limitReached:false, complete:false, checkedAt:'2026-11-05T12:00:00Z'} as never;
 });
 await expect(g03SageReadBatchForIdentity('g03-production', user, {query:'Products', take:1})).rejects.toMatchObject({code:'SAGE_ACCESS_DENIED'});
 expect(read).toHaveBeenCalledTimes(1);
});

it('warms one reader before parallel pages and isolates every sibling session/catalog/login',async()=>{
 await setup();const {SageReader}=await import('./g03-sage-api');const readers:InstanceType<typeof SageReader>[]=[];
 type Session={token:string;catalog:Set<string>;expires:number;verifiedAt:string};
 vi.spyOn(SageReader.prototype,'read').mockImplementation(async function(this:InstanceType<typeof SageReader>,query,_parameters,skip,take){
  const own=this as unknown as {session:Session|null;login:unknown};const offset=Number(skip);readers.push(this);
  if(offset===0){await new Promise(resolve=>setTimeout(resolve,1));own.session={token:'synthetic-warm',catalog:new Set(['Products']),expires:Date.now()+120000,verifiedAt:new Date().toISOString()};}
  else {expect(this).not.toBe(readers[0]);expect(own.session?.token).toBe('synthetic-warm');expect(own.session?.catalog.has('Products')).toBe(true);expect(own.login).toBeNull();own.session!.catalog.clear();own.login=Promise.resolve('sibling-only');}
  return {source:'SAGE',companyCode:'1',companyName:'synthetic',query,items:[{id:offset}],skip:offset,take:Number(take),nextOffset:offset===5?null:offset+1,limitReached:false,complete:offset===5,checkedAt:new Date().toISOString()} as never;
 });
 const result=await g03SageReadBatchForIdentity('g03-production',user,{query:'Products',take:1});
 expect(result).toMatchObject({pages:6,complete:true});expect(new Set(readers).size).toBe(6);
});
