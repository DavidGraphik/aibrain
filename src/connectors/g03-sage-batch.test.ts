import {describe,expect,it,vi} from 'vitest';
import {collectSagePages} from './g03-sage-batch';
import {SageError,type SageReader} from './g03-sage-api';

type Page = Awaited<ReturnType<SageReader['read']>>;
const range={FechaInicial:'1900-01-01',FechaFinal:'2026-11-05'};
function page(skip:number,take:number,count:number,nextOffset:number|null,limitReached=false): Page {
 return {source:'SAGE',companyCode:'1',companyName:'synthetic',query:'SalesOrders',items:Array.from({length:count},(_,n)=>({id:skip+n})),skip,take,nextOffset,limitReached,complete:nextOffset===null&&!limitReached,checkedAt:'2026-11-05T12:00:00.000Z'} as Page;
}
describe('bounded Sage read batches',()=>{
 it('follows the effective provider take without gaps and returns a resumable offset',async()=>{
  const read=vi.fn(async(_q:unknown,_p:unknown,skip:number,_take:number)=>page(skip,2,2,skip+2));
  const first=await collectSagePages(read,'SalesOrders',range,0,50);
  expect(first).toMatchObject({pages:12,fromOffset:0,nextOffset:24,complete:false,reason:'page_budget'});
  expect(first.items).toEqual(Array.from({length:24},(_,id)=>({id})));
  expect(read.mock.calls.map(call=>call[2])).toEqual(Array.from({length:12},(_,i)=>i*2));
  expect(read.mock.calls.map(call=>call[3])).toEqual([50,...Array(11).fill(2)]);
  const last=await collectSagePages(async(_q,_p,skip)=>page(skip,2,1,null),'SalesOrders',range,first.nextOffset,50);
  expect(last).toMatchObject({fromOffset:24,pages:1,nextOffset:null,complete:true,items:[{id:24}]});
 });
 it('yields before a likely oversized fetch and resumes without losing records',async()=>{
  const read=vi.fn(async(_q:unknown,_p:unknown,skip:number)=>({...page(skip,1,1,skip+1),items:[{id:skip,text:'x'.repeat(600_000)}]}));
  const result=await collectSagePages(read,'SalesOrders',range,0,1);
  expect(result).toMatchObject({pages:1,nextOffset:1,complete:false,reason:'response_budget'});
  expect(result.items).toHaveLength(1);
  expect(read.mock.calls.map(call=>call[2])).toEqual([0]);
  const resumed=await collectSagePages(read,'SalesOrders',range,result.nextOffset,1);
  expect(resumed).toMatchObject({pages:1,fromOffset:1,nextOffset:2,complete:false,reason:'response_budget'});
  expect([...result.items,...resumed.items].map(item=>(item as {id:number}).id)).toEqual([0,1]);
  expect(read.mock.calls.map(call=>call[2])).toEqual([0,1]);
 });
 it('retains the first unread offset when a later page grows unexpectedly',async()=>{
  const read=vi.fn(async(_q:unknown,_p:unknown,skip:number)=>({...page(skip,1,1,skip+1),items:[{id:skip,text:'x'.repeat(skip===0?50_000:1_000_000)}]}));
  const result=await collectSagePages(read,'SalesOrders',range,0,1);
  expect(result).toMatchObject({pages:1,nextOffset:1,complete:false,reason:'response_budget'});
  const resumed=await collectSagePages(read,'SalesOrders',range,result.nextOffset,1);
  expect(resumed).toMatchObject({pages:1,fromOffset:1,nextOffset:2,complete:false});
  expect([...result.items,...resumed.items].map(item=>(item as {id:number}).id)).toEqual([0,1]);
 });
 it('reports provider limits and partial recoverable errors without calling them complete',async()=>{
  const limited=await collectSagePages(async()=>page(5000,1,1,null,true),'SalesOrders',range,5000,1);
  expect(limited).toMatchObject({limitReached:true,complete:false,nextOffset:null});
  let n=0;const partial=await collectSagePages(async(_q,_p,skip)=>{if(n++)throw new SageError('SAGE_PROVIDER_UNAVAILABLE');return page(skip,1,1,skip+1);},'SalesOrders',range,0,1);
  expect(partial).toMatchObject({pages:1,nextOffset:1,complete:false,reason:'SAGE_PROVIDER_UNAVAILABLE'});
 });
 it('rejects malformed or forged offsets and never exposes unrestricted query arguments',async()=>{
  await expect(collectSagePages(async()=>page(0,5,1,100),'SalesOrders',range,0,5)).rejects.toMatchObject({code:'SAGE_PROVIDER_RESPONSE_INVALID'});
  const read=vi.fn();await expect(collectSagePages(read,'SalesOrders',{...range,CodigoEmpresa:'2'},0,5)).rejects.toMatchObject({code:'SAGE_ARGUMENTS_INVALID'});
  expect(read).not.toHaveBeenCalled();
 });
 it('does not release a pending page after cancellation',async()=>{
  const stop=new AbortController();let settle!: (value:Page)=>void;
  const result=collectSagePages(()=>new Promise<Page>(resolve=>{settle=resolve;}),'SalesOrders',range,0,1,stop.signal);
  stop.abort();settle(page(0,1,1,null));
  await expect(result).rejects.toBeDefined();
 });
 it('honours stop and a bounded timeout without inventing completeness',async()=>{
  const stop=new AbortController();stop.abort();const read=vi.fn();
  await expect(collectSagePages(read,'SalesOrders',range,0,5,stop.signal)).rejects.toBeDefined();expect(read).not.toHaveBeenCalled();
  vi.useFakeTimers();
  try {const result=collectSagePages(()=>new Promise(()=>{}),'SalesOrders',range,0,5);await vi.advanceTimersByTimeAsync(20_000);expect(await result).toMatchObject({pages:0,nextOffset:0,complete:false,reason:'time_budget'});}
  finally {vi.useRealTimers();}
 });
});

it('bounds completeness to the actual date range and retained pages, including future ranges',async()=>{
 const future={FechaInicial:'2026-01-01',FechaFinal:'2027-12-31'};
 const first=await collectSagePages(async()=>page(0,50,0,null),'SalesOrders',future,0,50);
 expect(first).toMatchObject({parameters:future,complete:true,coverage:{globalComplete:false,reachedEndOfQuery:true,completeFromBeginning:true}});
 expect(first.notice).toMatch(/no acredita cobertura global ni fechas fuera del intervalo/);
 const resumed=await collectSagePages(async()=>page(50,50,0,null),'SalesOrders',future,50,50);
 expect(resumed).toMatchObject({complete:true,fromOffset:50,coverage:{globalComplete:false,reachedEndOfQuery:true,completeFromBeginning:false}});
});
it('aborts the active provider page at deadline before starting a later independent batch',async()=>{
 vi.useFakeTimers();
 try {
  let active=0;let aborts=0;
  const slow=vi.fn((_q:unknown,_p:unknown,_s:number,_t:number,signal:AbortSignal)=>new Promise<Page>((_resolve,reject)=>{
   active++;signal.addEventListener('abort',()=>{active--;aborts++;reject(new Error('aborted'));},{once:true});
  }));
  const pending=collectSagePages(slow,'SalesOrders',range,0,1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await pending).toMatchObject({complete:false,reason:'time_budget',nextOffset:0});
  expect({active,aborts}).toEqual({active:0,aborts:1});
  const next=await collectSagePages(async()=>{expect(active).toBe(0);return page(0,1,0,null);},'SalesOrders',range,0,1);
  expect(next).toMatchObject({complete:true,items:[]});
 } finally {vi.useRealTimers();}
});
it('propagates explicit stop to the active provider page',async()=>{
 const stop=new AbortController();let observed=false;
 const pending=collectSagePages((_q,_p,_s,_t,signal)=>new Promise<Page>((_resolve,reject)=>{
  signal.addEventListener('abort',()=>{observed=true;reject(new Error('aborted'));},{once:true});
 }),'SalesOrders',range,0,1,stop.signal);
 stop.abort();await expect(pending).rejects.toBeDefined();expect(observed).toBe(true);
});

it('retains a serialized prefix including metadata below1MiB before twelve maximum-size pages',async()=>{
 const read=vi.fn(async(_q:unknown,_p:unknown,skip:number,_take:number)=>({...page(skip,25,25,skip+25),items:Array.from({length:25},(_,i)=>({id:skip+i,text:'x'.repeat(Math.floor((128*1024-1000)/25))})),nativeLineFields:{subquery:'Lines',requested:['LineasPosicion','UnidadesPendientes','UnidadesServidas'],returnedLineCount:25,documentsMissingLines:0,linesMissingRequestedFields:0,linesWithNullRequestedFields:0,notice:'Native source line metadata'}}));
 const result=await collectSagePages(read,'SalesOrders',range,0,50);
 expect(result).toMatchObject({pages:7,nextOffset:175,reason:'response_budget',complete:false,coverage:{maxBytes:1024*1024,atMostPages:12,maxMilliseconds:20000}});
 expect(read.mock.calls.map(call=>call[3])).toEqual([50,...Array(6).fill(25)]);
 expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024*1024);
});
it('retains further effective take reductions and rejects a page exceeding its requested take',async()=>{
 const takes:number[]=[];const result=await collectSagePages(async(_q,_p,skip,take)=>{takes.push(take);const effective=skip===0?25:12;return page(skip,effective,effective,skip+effective);},'SalesOrders',range,0,50);
 expect(takes).toEqual([50,25,25,...Array(9).fill(12)]);expect(result.nextOffset).toBe(145);
 expect(result).toMatchObject({pages:11,coverage:{pageRequests:12}});
 expect((result.items as {id:number}[]).map(x=>x.id)).toEqual(Array.from({length:145},(_,id)=>id));
 await expect(collectSagePages(async()=>page(0,50,50,50),'SalesOrders',range,0,25)).rejects.toMatchObject({code:'SAGE_PROVIDER_RESPONSE_INVALID'});
});

it('keeps an exact ordered prefix with only two reads active when later pages finish first',async()=>{
 let active=0,peak=0;const finished:number[]=[];
 const read=vi.fn(async(_q:unknown,_p:unknown,skip:number)=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,skip===1?20:1));active--;finished.push(skip);return page(skip,1,1,skip+1);});
 const result=await collectSagePages(read,'Products',{},0,1);
 expect(peak).toBe(2);expect(active).toBe(0);expect(finished.indexOf(2)).toBeLessThan(finished.indexOf(1));
 expect(result.items).toEqual(Array.from({length:12},(_,id)=>({id})));expect(result).toMatchObject({nextOffset:12,pages:12,complete:false,coverage:{pageRequests:12,maxParallelPages:2}});
});
it('discards an unused tail error when an earlier short page proves the end',async()=>{
 const read=vi.fn(async(_q:unknown,_p:unknown,skip:number)=>{if(skip===2)throw new SageError('SAGE_PROVIDER_UNAVAILABLE');if(skip===1){await new Promise(resolve=>setTimeout(resolve,2));return page(1,1,1,null);}return page(0,1,1,1);});
 const result=await collectSagePages(read,'Products',{},0,1);
 expect(result).toMatchObject({complete:true,nextOffset:null,pages:2,items:[{id:0},{id:1}],coverage:{pageRequests:3}});
});
it('never commits a speculative success beyond the first needed failed page',async()=>{
 const result=await collectSagePages(async(_q,_p,skip)=>{if(skip===1){await new Promise(resolve=>setTimeout(resolve,2));throw new SageError('SAGE_PROVIDER_UNAVAILABLE');}return page(skip,1,1,skip+1);},'Products',{},0,1);
 expect(result).toMatchObject({items:[{id:0}],nextOffset:1,pages:1,complete:false,reason:'SAGE_PROVIDER_UNAVAILABLE',coverage:{pageRequests:3}});
});
it('cancels both active sibling reads and releases no data after parent cancellation',async()=>{
 const stop=new AbortController();let active=0;
 const pending=collectSagePages(async(_q,_p,skip,_take,signal)=>{if(skip===0)return page(0,1,1,1);active++;return new Promise<Page>((_resolve,reject)=>signal.addEventListener('abort',()=>{active--;reject(new Error('mock cancelled'));},{once:true}));},'Products',{},0,1,stop.signal);
 const rejected=expect(pending).rejects.toBeDefined();await vi.waitFor(()=>expect(active).toBe(2));stop.abort();await rejected;expect(active).toBe(0);
});
it('crosses the former5000 cap preserving bounded prefix until real short page',async()=>{
 const read=vi.fn(async(_q:unknown,_p:unknown,skip:number)=>page(skip,50,skip===5050?7:50,skip===5050?null:skip+50));
 const result=await collectSagePages(read,'Products',{},4900,50);
 expect(result).toMatchObject({pages:4,nextOffset:null,complete:true,limitReached:false});
 expect(result.items).toEqual(Array.from({length:157},(_,i)=>({id:4900+i})));
 expect(read.mock.calls.map(c=>c[2])).toEqual([4900,4950,5000,5050,5100]);
 expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1048576);
});

it('charges retained line metadata and envelope before advancing a continuation',async()=>{
 const result=await collectSagePages(async(_q,_p,skip)=>({...page(skip,1,1,skip+1),nativeLineFields:{subquery:'Lines',requested:[],returnedLineCount:0,documentsMissingLines:0,linesMissingRequestedFields:0,linesWithNullRequestedFields:0,notice:'x'.repeat(550_000)}}),'Products',{},0,1);
 expect(result).toMatchObject({pages:1,nextOffset:1,reason:'response_budget',complete:false});
 expect(Buffer.byteLength(JSON.stringify({success:true,data:result}))).toBeLessThan(1024*1024);
});
it('amortizes setup across twelve small pages within unchanged time/byte/concurrency limits',async()=>{
 let active=0,peak=0;const result=await collectSagePages(async(_q,_p,skip)=>{active++;peak=Math.max(peak,active);await Promise.resolve();active--;return page(skip,25,25,skip+25);},'SalesOrders',range,0,25);
 expect(result).toMatchObject({pages:12,nextOffset:300,coverage:{pageRequests:12,maxParallelPages:2,maxBytes:1048576,maxMilliseconds:20000}});
 expect(peak).toBe(2);expect((result.items as {id:number}[]).map(x=>x.id)).toEqual(Array.from({length:300},(_,id)=>id));
});

it('preserves an unfinished prefix at numeric precision boundary without dispatching unsafe arithmetic',async()=>{
 const start=Number.MAX_SAFE_INTEGER-2;const read=vi.fn(async(_q:unknown,_p:unknown,skip:number)=>page(skip,1,1,skip+1));
 const result=await collectSagePages(read,'Products',{},start,1);
 expect(read.mock.calls.map(x=>x[2])).toEqual([start,start+1]);
 expect(result).toMatchObject({pages:2,nextOffset:Number.MAX_SAFE_INTEGER,complete:false,limitReached:false,reason:'offset_precision'});
});
