import { expect, it, vi } from "vitest";
const read=vi.hoisted(()=>vi.fn(async()=>({items:[],companyCode:"1"})));
const batch=vi.hoisted(()=>vi.fn(async()=>({items:[],complete:true})));
const operations=vi.hoisted(()=>vi.fn(async()=>({tables:[],companyCode:"1"})));
vi.mock("@/connectors/g03-sage-service",()=>({g03SageReadForIdentity:read,g03SageReadBatchForIdentity:batch}));
vi.mock("@/connectors/g03-sage-operation-service",()=>({g03SageOperation:operations}));
import { SAGE_QUERIES } from "@/connectors/g03-sage-api";
import { AppServerRpcRouter } from "@/runtime/transport/app-server-rpc-router";
import type { AppServerEvent, AppServerRequest, AppServerTransport } from "@/runtime/transport/contracts";
import { handleG03SageTool, G03_SAGE_NAMESPACE, G03_SAGE_DYNAMIC_TOOLS } from "./g03-sage-dynamic-tools";
const context={installationId:"g03-production",userId:"actor",session:{provider:"local",tenant:{id:"g03-production"},user:{id:"actor"},expiresAt:"2099-01-01T00:00:00Z"},runtimeThreadId:"thread",runtimeTurnId:"turn",selected:true,executeAllowed:true,requestId:"stable-human-request"} as Parameters<typeof handleG03SageTool>[1];
const params={namespace:G03_SAGE_NAMESPACE,tool:"discover",threadId:"thread",turnId:"turn",arguments:{},callId:"call"};
it("exposes typed company reads and controlled import tools and uses server identity",async()=>{
 expect(G03_SAGE_DYNAMIC_TOOLS[0]).toMatchObject({tools:[{name:"discover"},{name:"read"},{name:"read_batch"},{name:"operations"},{name:"schema"},{name:"prepare"},{name:"execute"},{name:"operation"}]});
 expect(await handleG03SageTool(params,context)).toMatchObject({success:true});expect(read).toHaveBeenLastCalledWith("g03-production","actor","discover",{},expect.any(AbortSignal));
});
it("rejects import plans/dispatch in read-only turns, even when generic tool execution is allowed",async()=>{
 for(const tool of ["prepare","execute"]){operations.mockClear();expect(await handleG03SageTool({...params,tool,arguments:tool==="execute"?{operationId:"a".repeat(64)}:{table:"TmpIME_Articulos",action:"create",values:{CodigoArticulo:"A"},reason:"User request"}},context)).toMatchObject({success:false});expect(operations).not.toHaveBeenCalled();}
});
it("passes exact authenticated turn authority to controlled imports and denies injected actor/URL fields",async()=>{
 operations.mockClear();const args={operationId:"a".repeat(64)};
 expect(await handleG03SageTool({...params,tool:"execute",arguments:args},{...context,allowWrites:true})).toMatchObject({success:true});
 expect(operations).toHaveBeenLastCalledWith("g03-production","actor","execute",args,{threadId:"thread",turnId:"turn",requestId:"stable-human-request"});
 for(const injected of [{userId:"foreign"},{url:"https://other.example.test"},{companyCode:2}]){operations.mockClear();expect(await handleG03SageTool({...params,tool:"execute",arguments:{...args,...injected}},{...context,allowWrites:true})).toMatchObject({success:false});expect(operations).not.toHaveBeenCalled();}
});
it("never reports no-change after a failed dispatch",async()=>{
 operations.mockRejectedValueOnce(new Error("private upstream response"));
 const response=await handleG03SageTool({...params,tool:"execute",arguments:{operationId:"a".repeat(64)}},{...context,allowWrites:true});
 expect(response.success).toBe(false);expect(JSON.stringify(response)).toContain('effectUnconfirmed');expect(JSON.stringify(response)).not.toContain('private upstream');expect(JSON.stringify(response)).not.toContain('No se ha modificado');
});
it("denies foreign thread/turn/tenant/user and execution policy before service",async()=>{
 for(const override of [{runtimeThreadId:"foreign"},{runtimeTurnId:"foreign"},{installationId:"foreign"},{userId:"another"},{executeAllowed:false},{selected:false},{session:null}]){
  read.mockClear();expect(await handleG03SageTool(params,{...context,...override})).toMatchObject({success:false});expect(read).not.toHaveBeenCalled();
 }
});
it("rejects writes, URL and company parameters at the appropriate boundary",async()=>{
 for(const p of [{...params,tool:"PutData"},{...params,arguments:{url:"https://other.test"}},{...params,tool:"read",arguments:{query:"Products",parameters:{},companyCode:2}}]){
  read.mockClear();expect(await handleG03SageTool(p,context)).toMatchObject({success:false});expect(read).not.toHaveBeenCalled();
 }
});

it("advertises the same expanded queries as the validated reader with string parameters",()=>{
 const namespace=G03_SAGE_DYNAMIC_TOOLS[0];
 expect(namespace.type).toBe("namespace");
 if(namespace.type!=="namespace")throw new Error("Expected namespace");
 const spec=namespace.tools.find(tool=>tool.name==="read")!;
 expect(spec.inputSchema).toMatchObject({properties:{query:{enum:Object.keys(SAGE_QUERIES)},parameters:{additionalProperties:false,properties:{CodigosArticulo:{type:"string",maxLength:128},Ejercicio:{type:"string"},Serie:{type:"string"},Numero:{type:"string"}}}}});
});
it("passes document reads through the existing identity-bound service",async()=>{
 const arguments_={query:"PurchaseOrder",parameters:{Ejercicio:"2026",Serie:"",Numero:"123"},take:1};
 expect(await handleG03SageTool({...params,tool:"read",arguments:arguments_},context)).toMatchObject({success:true});
 expect(read).toHaveBeenLastCalledWith("g03-production","actor","read",arguments_,expect.any(AbortSignal));
});

it('keeps native field selection server-owned and explains direct balances/exact links',async()=>{
 const namespace=G03_SAGE_DYNAMIC_TOOLS[0];
 if(namespace.type!=='namespace')throw new Error('Expected namespace');
 const spec=namespace.tools.find(tool=>tool.name==='read')!;
 expect(spec.description).toContain('Lines.UnidadesPendientes');
 expect(spec.description).toContain('origin-line UUID');
 expect(spec.inputSchema).toMatchObject({additionalProperties:false,properties:{parameters:{additionalProperties:false}}});
 for(const override of [{extraFields:[{subqueryName:'Lines',fields:'*'}]},{extraFilter:'1=1'},{sql:'SELECT *'}]){
  read.mockClear();
  expect(await handleG03SageTool({...params,tool:'read',arguments:{query:'SalesOrder',parameters:{Ejercicio:'2026',Serie:'',Numero:'42'},...override}},context)).toMatchObject({success:false});
  expect(read).not.toHaveBeenCalled();
 }
});

it("settles a stuck read on Stop without replaying it, preserving uncertain writes", async () => {
 const stop = new AbortController();
 read.mockClear();
 read.mockImplementationOnce(() => new Promise(() => {}));
 const result = handleG03SageTool(params, {...context,signal:stop.signal});
 stop.abort();
 expect(await result).toMatchObject({success:false});
 expect(JSON.stringify(await result)).toContain("SAGE_READ_CANCELLED");
 expect(read).toHaveBeenCalledTimes(1);
});
it("settles an unresponsive read after a bounded time", async () => {
 vi.useFakeTimers();
 try {
  read.mockImplementationOnce(() => new Promise(() => {}));
  const result=handleG03SageTool(params,context);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(JSON.stringify(await result)).toContain("SAGE_READ_TIMEOUT");
 } finally { vi.useRealTimers(); }
});
it("does not dispatch a read after Stop was already requested", async () => {
 const stop = new AbortController();stop.abort();read.mockClear();
 const result=await handleG03SageTool(params,{...context,signal:stop.signal});
 expect(JSON.stringify(result)).toContain("SAGE_READ_CANCELLED");
 expect(read).not.toHaveBeenCalled();
});
it("does not abandon an in-flight write when the turn is stopped", async () => {
 const stop = new AbortController();
 let settle!: (value: { tables: never[]; companyCode: string }) => void;
 operations.mockImplementationOnce(() => new Promise(resolve => {settle=resolve;}));
 let completed=false;
 const pending=handleG03SageTool({...params,tool:"execute",arguments:{operationId:"a".repeat(64)}},{...context,allowWrites:true,signal:stop.signal}).then(value=>{completed=true;return value;});
 stop.abort();
 await Promise.resolve();
 expect(completed).toBe(false);
 settle({tables:[],companyCode:"1"});
 expect(await pending).toMatchObject({success:true});
});

it("advances the ordered journal after a stopped stuck read so the next turn can be admitted", async () => {
 read.mockClear(); read.mockImplementationOnce(() => new Promise(() => {}));
 const stop = new AbortController();
 const sent: AppServerRequest[] = [], acked: AppServerEvent[] = [];
 let resolveNext!: (value: IteratorResult<AppServerEvent>) => void;
 let closed=false;
 const transport = {
  connect: async () => {},
  send: async (request: AppServerRequest) => { sent.push(request); },
  deliverySequenceStart: () => 1,
  projectionSequenceTarget: () => 1,
  acknowledge: async (event: AppServerEvent) => { acked.push(event); },
  events: () => ({[Symbol.asyncIterator]: () => ({next: () => closed
   ? Promise.resolve({done:true as const,value:undefined})
   : new Promise<IteratorResult<AppServerEvent>>(resolve => {resolveNext=resolve;})})}),
  close: async () => {closed=true;resolveNext?.({done:true,value:undefined});},
 } as unknown as AppServerTransport;
 const router = new AppServerRpcRouter(transport);
 router.registerTurn("thread","local",{onNotification:vi.fn(),onFailure:vi.fn(),
  onServerRequest:async request => handleG03SageTool(request.params as typeof params,{...context,signal:stop.signal})}).bindRuntimeTurn("turn");
 await router.start();
 resolveNext({done:false,value:{eventId:"one",sequence:1,occurredAt:"2026-11-05T00:00:00Z",
  message:{kind:"rpc-request",rpc:{id:"read",method:"item/tool/call",params}}}});
 await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());
 await expect(router.assertProjectionReady()).rejects.toMatchObject({name:"RuntimeProjectionAdmissionDeferred"});
 stop.abort();
 await vi.waitFor(()=>expect(acked).toHaveLength(1));
 await expect(router.assertProjectionReady()).resolves.toBeUndefined();
 expect(sent).toHaveLength(1);expect(JSON.stringify(sent[0])).toContain("SAGE_READ_CANCELLED");
 expect(read).toHaveBeenCalledOnce();
 await router.close();
});

it("binds batched reads to the authenticated turn and rejects injected authority",async()=>{
 batch.mockClear();const args={query:"SalesOrders",parameters:{},take:50};
 expect(await handleG03SageTool({...params,tool:"read_batch",arguments:args},context)).toMatchObject({success:true});
 expect(batch).toHaveBeenCalledWith("g03-production","actor",args,expect.any(AbortSignal));
 batch.mockClear();
 for(const override of [{userId:"foreign"},{companyCode:2},{extraFilter:"Status=0"}]) {
  expect(await handleG03SageTool({...params,tool:"read_batch",arguments:{...args,...override}},context)).toMatchObject({success:false});
 }
 expect(await handleG03SageTool({...params,tool:"read_batch",arguments:args},{...context,userId:"foreign"})).toMatchObject({success:false});
 expect(batch).not.toHaveBeenCalled();
});

it("rejects an expired or malformed session before provider access", async () => {
 read.mockClear(); batch.mockClear(); operations.mockClear();
 for (const expiresAt of ["2000-01-01T00:00:00Z", "invalid"]) {
  const response = await handleG03SageTool(params, {...context, session:{...context.session!, expiresAt}});
  expect(response.success).toBe(false);
 }
 expect(read).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled(); expect(operations).not.toHaveBeenCalled();
});
