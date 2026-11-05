import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('@/auth/session',()=>({getSigningSecret:()=> 'qa-signing-key'}));
const mocks=vi.hoisted(()=>({context:vi.fn(),read:vi.fn(),mutate:vi.fn(),appRead:vi.fn(),appList:vi.fn(),appMutate:vi.fn()}));
vi.mock('./access',()=>({productContext:mocks.context}));
vi.mock('./production',()=>({readProduction:mocks.read,mutateProduction:mocks.mutate}));
vi.mock('./apps',()=>({readApp:mocks.appRead,listApps:mocks.appList,mutateApp:mocks.appMutate}));
import { handleProductTool } from './chat-tools';
import { currentThreadToolsetRevision, CURRENT_THREAD_TOOLSET_REVISION } from '@/runtime/thread-token';
import { runtimeThreadIdForChatMessage } from '@/runtime/chat-thread-selection';
const context={session:{provider:'local' as const,user:{id:'11111111-1111-4111-8111-111111111111',email:'qa@example.test',name:'QA'},tenant:{id:'g03-qa',name:'QA'},expiresAt:'2099-01-01'},installation:{installationId:'g03-qa'} as never,runtimeThreadId:'t',runtimeTurnId:'u',sourceMessage:'Crea un registre de revisions'};
const params={threadId:'t',turnId:'u',callId:'c',namespace:'aibrain_g03_apps',tool:'create',arguments:{title:'Registre',html:'<h1>QA</h1>',fields:[],instruction:'Untrusted model text'}};
beforeEach(()=>{vi.clearAllMocks();mocks.context.mockResolvedValue({actor:context.session.user.id});mocks.appMutate.mockResolvedValue({id:'app',publishedVersion:null});});
it('denies mismatched installation, actor tenant, thread, turn and missing foreground session before any store read',async()=>{
 for(const change of [{runtimeThreadId:'foreign'},{runtimeTurnId:'foreign'},{session:undefined},{installation:{installationId:'arnall'}},{session:{...context.session,tenant:{id:'other',name:'Other'}}}])expect((await handleProductTool(params,{...context,...change} as never)).success).toBe(false);
 expect(mocks.context).not.toHaveBeenCalled();expect(mocks.appMutate).not.toHaveBeenCalled();
});
it('creates a draft under server actor and records the human instruction instead of model-supplied authorship',async()=>{expect((await handleProductTool(params,context)).success).toBe(true);expect(mocks.appMutate).toHaveBeenCalledWith({actor:context.session.user.id},expect.objectContaining({action:'create',instruction:context.sourceMessage}));});
it('cannot publish or irreversibly purge through data tool or arbitrary tool name',async()=>{for(const p of [{...params,tool:'publish'},{...params,tool:'data',arguments:{input:{action:'publish'}}},{...params,tool:'data',arguments:{input:{action:'row.purge'}}}])expect((await handleProductTool(p,context)).success).toBe(false);expect(mocks.appMutate).not.toHaveBeenCalled();});
it('shares the production service and returns conflict without hiding failed writes',async()=>{mocks.mutate.mockRejectedValue(Error('private-file-path'));const result=await handleProductTool({...params,namespace:'aibrain_g03_production',tool:'mutate',arguments:{input:{action:'order.update',revision:2}}},context);expect(result.success).toBe(false);expect(JSON.stringify(result)).not.toContain('private-file-path');expect(mocks.mutate).toHaveBeenCalledWith({actor:context.session.user.id},{action:'order.update',revision:2});});
it('upgrades G03 threads only and preserves other tenants toolset',()=>{expect(currentThreadToolsetRevision('arnall')).toBe(CURRENT_THREAD_TOOLSET_REVISION);expect(currentThreadToolsetRevision('g03-production')).not.toBe(CURRENT_THREAD_TOOLSET_REVISION);const token={threadId:'thread',toolsetRevision:CURRENT_THREAD_TOOLSET_REVISION};expect(runtimeThreadIdForChatMessage(token,'Create app','g03-production')).toBeNull();expect(runtimeThreadIdForChatMessage(token,'Create app','arnall')).toBe('thread');expect(runtimeThreadIdForChatMessage({...token,toolsetRevision:currentThreadToolsetRevision('g03-production')},'Edit app','g03-production')).toBe('thread');});

it('denies product writes from a scheduled read-only turn',async()=>{expect((await handleProductTool(params,{...context,readOnly:true})).success).toBe(false);expect(mocks.appMutate).not.toHaveBeenCalled();});

it('reads fresh production on every query, with revision, pagination and live read time distinct from import time',async()=>{
 const state={revision:5,sourceVersion:'V7',capturedAt:'2026-10-07T13:17:00Z',grants:['read'],lookups:{},orders:[{workOrder:'OF1',client:'A'},{workOrder:'OF2',client:'B'}],phases:[],receipts:[],catalog:[{reference:'R1'},{reference:'R2'}],tasks:[{description:'Revisar',done:false}],deliveredHistory:[{workOrder:'OLD'}],audit:[]};
 mocks.read.mockResolvedValue(state);
 const read=(args:Record<string,string|number>)=>handleProductTool({...params,namespace:'aibrain_g03_production',tool:'read',arguments:args},context);
 const value=(r:Awaited<ReturnType<typeof read>>)=>JSON.parse((r.contentItems[0] as {text:string}).text);
 const first=value(await read({limit:1}));
 expect(first).toMatchObject({revision:5,totalOrders:2,nextOffset:1,orders:[{workOrder:'OF1'}]});
 expect(first.readOnlyOrderFields).toEqual(['client','reference','description']);
 expect(Date.parse(first.readAt)).toBeGreaterThan(Date.parse(first.capturedAt));
 expect(value(await read({offset:1,limit:1}))).toMatchObject({orders:[{workOrder:'OF2'}],nextOffset:null});
 expect(value(await read({section:'catalog',limit:1,offset:1}))).toMatchObject({section:'catalog',totalRecords:2,records:[{reference:'R2'}],nextOffset:null});
 mocks.read.mockResolvedValue({...state,revision:6,tasks:[{description:'Revisar',done:true}]});
 expect(value(await read({section:'tasks',query:'revisar'}))).toMatchObject({revision:6,records:[{done:true}]});
 expect(value(await read({section:'deliveredHistory'}))).toMatchObject({records:[{workOrder:'OLD'}]});
 expect((await read({section:'private-files'})).success).toBe(false);
 expect((await read({limit:101})).success).toBe(false);
 expect(mocks.mutate).not.toHaveBeenCalled();
});

it.each([
 ['Jordi',['read','orders','machines','receipts','validate-receipts','import','apps'],true,[true,true,true,true,true,true,true]],
 ['Maria',['read','orders','apps'],true,[true,false,false,false,false,true,true]],
 ['Rafa',['read','apps'],true,[false,false,false,false,false,true,true]],
 ['Arturo',['read'],false,[false,false,false,false,false,false,false]],
 ['Rosalia',['read','orders','machines','receipts'],false,[true,true,true,false,false,false,false]],
 ['Lidia',['read','orders','machines','receipts'],false,[true,true,true,false,false,false,false]],
] as const)('reports distinct receipt registration and validation rights for %s',async(_name,grants,writer,expected)=>{
 mocks.context.mockResolvedValue({actor:context.session.user.id,appRecordsWritable:writer});
 mocks.read.mockResolvedValue({revision:16,sourceVersion:'V7',capturedAt:'2026-10-14T00:12:07Z',grants,lookups:{},orders:[],phases:[],receipts:[]});
 const result=await handleProductTool({...params,namespace:'aibrain_g03_production',tool:'read',arguments:{}},context);
 expect(result.success).toBe(true);
 const read=JSON.parse((result.contentItems[0] as {text:string}).text);
 expect(read.permissions).toEqual({productionRead:true,catalogEdit:(grants as readonly string[]).includes('orders'),configurationEdit:(grants as readonly string[]).includes('orders')&&(grants as readonly string[]).includes('machines'),orderEdit:expected[0],machineAndPhaseEdit:expected[1],receiptSubmit:expected[2],receiptValidate:expected[3],productionImport:expected[4],appCreate:expected[5],appRecordEdit:expected[6],applicationDesignEdit:false});
 expect(read.permissionNotes).toContain('receiptSubmit does not grant receiptValidate');
 expect(mocks.mutate).not.toHaveBeenCalled();
 expect(mocks.appMutate).not.toHaveBeenCalled();
});

it('does not advertise foreground write grants in a read-only scheduled turn',async()=>{
 mocks.context.mockResolvedValue({actor:context.session.user.id,appRecordsWritable:true});
 mocks.read.mockResolvedValue({revision:16,sourceVersion:'V7',grants:['read','orders','machines','receipts','validate-receipts','import','apps'],lookups:{},orders:[],phases:[],receipts:[]});
 const result=await handleProductTool({...params,namespace:'aibrain_g03_production',tool:'read',arguments:{}},{...context,readOnly:true});
 const read=JSON.parse((result.contentItems[0] as {text:string}).text);
 expect(read.permissions.productionRead).toBe(true);
 expect(Object.entries(read.permissions).filter(([key])=>key!=='productionRead').every(([,allowed])=>allowed===false)).toBe(true);
});
it.each([true,false,null])('reports the actual Drive import pause value %s rather than inferring current sync from old metadata',async(sourceImportPaused)=>{
 mocks.read.mockResolvedValue({revision:30,sourceVersion:'V7',sourceSync:{checkedAt:'2026-10-01T00:00:00Z'},sourceImportPaused,grants:['read'],lookups:{},orders:[],phases:[],receipts:[]});
 const result=await handleProductTool({...params,namespace:'aibrain_g03_production',tool:'read',arguments:{}},context);
 expect(result.success).toBe(true);
 const read=JSON.parse((result.contentItems[0] as {text:string}).text);
 expect(read.sourceImportPaused).toBe(sourceImportPaused);
 expect(read.sourceSync.checkedAt).toBe('2026-10-01T00:00:00Z');
 expect(mocks.mutate).not.toHaveBeenCalled();
});
it('forwards requested typography and retired-row restoration to the same authenticated service and refuses scheduled writes',async()=>{
 for(const input of [{action:'view.update',revision:4,reason:'Arial 10',fontFamily:'Arial',fontSizePt:10},{action:'catalog.restore',revision:30,reason:'Restaurar referència QA',rowNumber:9}]) {
  const call={...params,namespace:'aibrain_g03_production',tool:'mutate',arguments:{input}};
  mocks.mutate.mockResolvedValue({revision:31});
  expect((await handleProductTool(call,context)).success).toBe(true);
  expect(mocks.mutate).toHaveBeenLastCalledWith({actor:context.session.user.id},input);
  const count=mocks.mutate.mock.calls.length;
  expect((await handleProductTool(call,{...context,readOnly:true})).success).toBe(false);
  expect(mocks.mutate.mock.calls).toHaveLength(count);
 }
});

it('allows recoverable program record retirement and restoration through the existing data tool',async()=>{
 for(const action of ['row.delete','row.restore']){const input={action,id:'program',revision:3,rowId:'record',rowRevision:1};expect((await handleProductTool({...params,tool:'data',arguments:{input}},context)).success).toBe(true);expect(mocks.appMutate).toHaveBeenLastCalledWith({actor:context.session.user.id},input);}
});

it('reports the same full-sheet open-order KPI as Production, independent of pagination or search',async()=>{
 const open=[null,'',' ','PARAT','NO COMENÇAT','EN PRODUCCIÓ','entregat',...Array(79).fill('NO COMENÇAT')];
 const closed=['ENTREGAT','ENTREGAT AL CLIENT','PEÇA ACABADA','ESTOC FET','LLEST PER SERVIR','  ENTREGAT  ',...Array(11).fill('ENTREGAT')];
 const orders=[...open,...closed].map((productionStatus,index)=>({rowNumber:index+1,workOrder:index===0?null:index<3?'OF-DUP':`OF-${index}`,client:index===1?'MATCH':'OTHER',productionStatus}));
 mocks.read.mockResolvedValue({revision:905,sourceVersion:'V7',grants:['read'],lookups:{},orders,phases:[],receipts:[],audit:[]});
 const read=async(args:Record<string,string|number>)=>{
  const result=await handleProductTool({...params,namespace:'aibrain_g03_production',tool:'read',arguments:args},context);
  expect(result.success).toBe(true);return JSON.parse((result.contentItems[0] as {text:string}).text);
 };
 const first=await read({limit:100}),last=await read({offset:100,limit:100}),filtered=await read({query:'MATCH',limit:1});
 for(const result of [first,last,filtered])expect(result).toMatchObject({revision:905,productionOrderCounts:{scope:'all-production-order-rows',totalRows:103,openRows:86,completedRows:17,completedStatuses:['ENTREGAT','ENTREGAT AL CLIENT','PEÇA ACABADA','ESTOC FET','LLEST PER SERVIR']}});
 expect(first).toMatchObject({totalOrders:103,nextOffset:100});expect(last).toMatchObject({totalOrders:103,nextOffset:null});
 expect(filtered).toMatchObject({totalOrders:1,nextOffset:null,orders:[{client:'MATCH'}]});
 expect(mocks.mutate).not.toHaveBeenCalled();
});

it('reports overdue dashboard counts and per-row flags for the same Madrid date across pages and filtered subsets',async()=>{
 vi.useFakeTimers();
 try {
  vi.setSystemTime(new Date('2026-11-04T22:59:59.000Z'));
  const orders=[...Array(17).fill('NO COMENÇAT'),...Array(9).fill('LLEST PER SERVIR'),...Array(77).fill(null)].map((productionStatus,index)=>({
   rowNumber:index+1,workOrder:`OF-${index}`,client:index===0||index===17?'MATCH':'OTHER',productionStatus,
   deliveryDate:index<26?'2026-11-01':index===26?'2026-11-04':index===27?'2026-11-05':null,
  }));
  mocks.read.mockResolvedValue({revision:905,sourceVersion:'V7',grants:['read'],lookups:{},orders,phases:[],receipts:[]});
  const read=async(args:Record<string,string|number>)=>JSON.parse(((await handleProductTool({...params,namespace:'aibrain_g03_production',tool:'read',arguments:args},context)).contentItems[0] as {text:string}).text);
  const first=await read({limit:20}),last=await read({offset:100}),subset=await read({query:'MATCH'});
  for(const result of [first,last,subset])expect(result.productionOverdueCounts).toMatchObject({scope:'all-production-order-rows',referenceDate:'2026-11-04',timeZone:'Europe/Madrid',overdueRows:17});
  expect(first.orders.slice(0,17).every((o:{dashboardOverdue:boolean})=>o.dashboardOverdue)).toBe(true);
  expect(first.orders.slice(17).every((o:{dashboardOverdue:boolean})=>!o.dashboardOverdue)).toBe(true);
  expect(subset.orders.map((o:{dashboardOverdue:boolean})=>o.dashboardOverdue)).toEqual([true,false]);
  expect(subset.totalOrders).toBe(2);
  vi.setSystemTime(new Date('2026-11-04T23:00:00.000Z'));
  const afterMidnight=await read({limit:100});
  expect(afterMidnight.productionOverdueCounts).toMatchObject({referenceDate:'2026-11-05',overdueRows:18});
  expect(afterMidnight.orders[26].dashboardOverdue).toBe(true);
  expect(afterMidnight.orders[27].dashboardOverdue).toBe(false);
  expect(afterMidnight.readAt).toBe('2026-11-04T23:00:00.000Z');
 } finally {vi.useRealTimers();}
});

it('surfaces abbreviated client codes as unverified candidates and filters explicit codes exactly',async()=>{
 const orders=[
  {rowNumber:1,workOrder:'OF-1',client:'GL',reference:'QA-1'},
  {rowNumber:2,workOrder:'OF-2',client:'GL',reference:'QA-2'},
  {rowNumber:3,workOrder:'OF-3',client:'GA',reference:'QA-3'},
  {rowNumber:4,workOrder:'OF-4',client:'GL OTHER',reference:'QA-4'},
  {rowNumber:5,workOrder:'OF-5',client:'OTHER',description:'GL',reference:'QA-5'},
  {rowNumber:6,workOrder:'OF-2',client:'OTHER',reference:'QA-6'},
 ];
 mocks.read.mockResolvedValue({revision:905,sourceVersion:'V7',grants:['read'],lookups:{},orders,phases:[{workOrder:'OF-1',phaseNumber:1},{workOrder:'OF-2',phaseNumber:2}],receipts:[{workOrder:'OF-2',id:'ambiguous'}]});
 const read=async(query:string,extra:Record<string,number>={})=>{
  const result=await handleProductTool({...params,namespace:'aibrain_g03_production',tool:'read',arguments:{query,...extra}},context);
  expect(result.success).toBe(true);return JSON.parse((result.contentItems[0] as {text:string}).text);
 };
 const unresolved=await read('Gali');
 expect(unresolved.totalOrders).toBe(0);
 expect(unresolved.queryMode).toBe('literal-substring');
 expect(unresolved.clientCodeCandidates).toMatchObject({status:'unverified_candidates',evidence:'letter_subsequence_only',truncated:false,
  candidates:[{code:'GA',orderRows:1},{code:'GL',orderRows:2}]});
 expect(unresolved.clientCodeCandidates.warning).toContain('not verified client identities');
 expect(unresolved.clientSearchGuidance).toContain('explicitly mention the candidate codes as possible, NOT verified');
 expect(Object.keys(unresolved).indexOf('clientSearchGuidance')).toBeLessThan(Object.keys(unresolved).indexOf('productionOrderCounts'));
 expect(Object.keys(unresolved).indexOf('clientCodeCandidates')).toBeLessThan(Object.keys(unresolved).indexOf('productionOrderCounts'));
 const exact=await read('client-code:GL',{limit:1});
 expect(exact).toMatchObject({queryMode:'exact-client-code',totalOrders:2,nextOffset:1,orders:[{client:'GL'}]});
 expect(exact).not.toHaveProperty('clientCodeCandidates');
 expect(exact).not.toHaveProperty('clientSearchGuidance');
 expect(await read('Zorro')).not.toHaveProperty('clientSearchGuidance');
 expect(await read('client-code:GL',{offset:1})).toMatchObject({totalOrders:2,nextOffset:null,orders:[{workOrder:'OF-2',client:'GL'}],ambiguousWorkOrders:['OF-2'],phases:[],receipts:[]});
 expect(await read('client-code:gl')).toMatchObject({totalOrders:0,orders:[]});
 expect((await read('GL')).totalOrders).toBe(4); // legacy substring lookup is unchanged
 expect(mocks.mutate).not.toHaveBeenCalled();
});

it('does not merge similar literal clients with unverified abbreviation candidates',async()=>{
 const orders=[{rowNumber:1,workOrder:'OF-1',client:'GL',reference:'R1'},{rowNumber:2,workOrder:'OF-2',client:'GALI INDUSTRIAL',reference:'R2'}];
 mocks.read.mockResolvedValue({revision:6,sourceVersion:'V7',grants:['read'],lookups:{},orders,phases:[],receipts:[]});
 const result=await handleProductTool({...params,namespace:'aibrain_g03_production',tool:'read',arguments:{query:'Gali'}},context);
 expect(result.success).toBe(true);
 const answer=JSON.parse((result.contentItems[0] as {text:string}).text);
 expect(answer).toMatchObject({queryMode:'literal-substring',totalOrders:1,orders:[{client:'GALI INDUSTRIAL'}],clientCodeCandidates:{status:'unverified_candidates',candidates:[{code:'GL',orderRows:1}]}});
 expect(answer).not.toHaveProperty('clientSearchGuidance');
});
