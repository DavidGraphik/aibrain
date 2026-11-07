import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AutomationAdmissionPoller, type AutomationAdmissionSource } from './admission-poller';
import { FileAutomationStore, type ClaimedAutomation } from './store';
import { backgroundModelConcurrency } from '@/runtime/model-turn-queue';
import { runClaimedAutomation } from './runner';

const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return {promise, resolve}; };
const flush = async () => { for (let n=0;n<8;n++) await Promise.resolve(); };
const roots: string[]=[];
afterEach(async()=>{vi.useRealTimers();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

describe('bounded automation admission without a global execution barrier',()=>{
 it('admits host mail arriving at23s on the30s poll while Trini runs294s',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);let triniPending=true,hostPending=false,active=0,peak=0;const starts:Record<string,number>={};const results:string[]=[];
  const execute=(who:string,duration:number)=>async()=>{starts[who]=Date.now();active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,duration));active--;return who;};
  const sources:AutomationAdmissionSource<string,string>[]=[
   {userId:'trini',claim:async slots=>{expect(slots).toBe(1);if(!triniPending)return[];triniPending=false;return['mail'];},execute:execute('trini',294_000)},
   {userId:'host',claim:async()=>{if(!hostPending)return[];hostPending=false;return['host-request'];},execute:execute('host',1000)},
  ];
  const poller=new AutomationAdmissionPoller<string,string>({concurrency:1,onResult:r=>results.push(r),onError:vi.fn()});
  await poller.poll(sources);await vi.advanceTimersByTimeAsync(23_000);hostPending=true;await vi.advanceTimersByTimeAsync(7000);await poller.poll(sources);await flush();
  expect(starts).toEqual({trini:0,host:30_000});expect(starts.host).toBeLessThan(60_000);expect(active).toBe(2);expect(peak).toBe(2);
  await vi.advanceTimersByTimeAsync(1000);expect(results).toEqual(['host']);expect(active).toBe(1);
  const stopping=poller.stop();await vi.advanceTimersByTimeAsync(263_000);await stopping;expect(results).toEqual(['host','trini']);
 });

 it('claims only free user slots and holds a slot through durable finalization',async()=>{
  const terminal=defer<string>();const claim=vi.fn(async slots=>{expect(slots).toBe(1);return['first'];});const result=vi.fn();
  const source={userId:'trini',claim,execute:()=>terminal.promise};const poller=new AutomationAdmissionPoller<string,string>({concurrency:1,onResult:result,onError:vi.fn()});
  await poller.poll([source]);await flush();await poller.poll([source]);expect(claim).toHaveBeenCalledTimes(1);expect(result).not.toHaveBeenCalled();
  terminal.resolve('committed');await flush();await poller.poll([{...source,claim:async slots=>{expect(slots).toBe(1);return[];}}]);expect(result).toHaveBeenCalledWith('committed');await poller.stop();
 });

 it('overlapping polls reserve claims once, while another user remains eligible',async()=>{
  const admission=defer<string[]>(),terminal=defer<string>();const claim=vi.fn(()=>admission.promise),execute=vi.fn(()=>terminal.promise);const results:string[]=[];
  const poller=new AutomationAdmissionPoller<string,string>({concurrency:1,onResult:r=>results.push(r),onError:vi.fn()});
  const slow={userId:'trini',claim,execute};const first=poller.poll([slow]);await flush();
  await poller.poll([slow,{userId:'host',claim:async()=>['host'],execute:async()=>'host'}]);await flush();expect(claim).toHaveBeenCalledTimes(1);expect(results).toEqual(['host']);
  admission.resolve(['trini']);await first;await flush();expect(execute).toHaveBeenCalledTimes(1);terminal.resolve('trini');await poller.stop();
 });

 it('reports genuine runtime capacity rejection without releasing another user slot',async()=>{
  const terminal=defer<string>();const errors=vi.fn(),results:string[]=[];let busyClaims=0;
  const poller=new AutomationAdmissionPoller<string,string>({concurrency:1,onResult:r=>results.push(r),onError:errors});
  const busy={userId:'trini',claim:async()=>{busyClaims++;return['trini'];},execute:()=>terminal.promise};
  await poller.poll([busy,{userId:'host',claim:async()=>['host'],execute:async()=>{throw Error('RUNTIME_CAPACITY_EXHAUSTED');}}]);await flush();
  expect(errors).toHaveBeenCalledWith(expect.objectContaining({message:'RUNTIME_CAPACITY_EXHAUSTED'}),'host');expect(results).toEqual([]);await poller.poll([busy]);expect(busyClaims).toBe(1);
  terminal.resolve('trini');await poller.stop();expect(results).toEqual(['trini']);
 });

 it('does not let a failed principal/claim block eligible users or a later poll',async()=>{
  const error=vi.fn(),results:string[]=[];const poller=new AutomationAdmissionPoller<string,string>({concurrency:1,onResult:r=>results.push(r),onError:error});
  await poller.poll([{userId:'denied',claim:async()=>{throw Error('ACTOR_DISABLED');},execute:async()=>'forbidden'}, {userId:'nerea',claim:async()=>['ok'],execute:async()=>'nerea'}]);await flush();
  expect(error).toHaveBeenCalledWith(expect.objectContaining({message:'ACTOR_DISABLED'}),'denied');expect(results).toEqual(['nerea']);await poller.stop();
 });

 it('shutdown stops new admission immediately and waits for already fenced claims',async()=>{
  const admission=defer<string[]>(),terminal=defer<string>();const claim=vi.fn(()=>admission.promise),executed=vi.fn(()=>terminal.promise);
  const poller=new AutomationAdmissionPoller<string,string>({concurrency:1,onResult:vi.fn(),onError:vi.fn()});const source={userId:'host',claim,execute:executed};
  const first=poller.poll([source]);await flush();let stopped=false;const stopping=poller.stop().then(()=>{stopped=true;});await poller.poll([source]);expect(claim).toHaveBeenCalledTimes(1);
  admission.resolve(['admitted-before-stop']);await first;await flush();expect(executed).toHaveBeenCalledOnce();expect(stopped).toBe(false);terminal.resolve('done');await stopping;expect(stopped).toBe(true);
 });

 it('retains restart fencing: successor recovers the same run, stale execution cannot overwrite it',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'automation-poller-'));roots.push(root);const user='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',project='11111111-1111-4111-8111-111111111111';await mkdir(path.join(root,user),{mode:0o700});
  let clock=Date.parse('2026-10-26T15:00:00Z');const store=new FileAutomationStore({installationId:'tenant',userId:user,usersRoot:root,leaseMs:10_000,now:()=>clock});
  const task=await store.create({name:'Synthetic restart',prompt:'Synthetic',projectId:project,projectName:'Internal',timeZone:'UTC',schedule:{kind:'once',runAt:new Date(clock).toISOString()}});const held=defer<void>(),started=defer<void>();
  const first=new AutomationAdmissionPoller<ClaimedAutomation,unknown>({concurrency:1,onResult:vi.fn(),onError:vi.fn()});
  await first.poll([{userId:user,claim:n=>store.claimDue('first',n),execute:claim=>runClaimedAutomation({store,claim,now:()=>clock,execute:async(_claim,_thread,prepared)=>{await prepared(project);started.resolve();await held.promise;return{threadId:project};}})}]);
  // Wait for the durable prepared callback, not a 200ms wall-clock filesystem race.
  await started.promise;
  const successorExecute=vi.fn(async(_claim:ClaimedAutomation,thread:string|null)=>{expect(thread).toBe(project);return{threadId:project};});const second=new AutomationAdmissionPoller<ClaimedAutomation,unknown>({concurrency:1,onResult:vi.fn(),onError:vi.fn()});
  const next={userId:user,claim:(n:number)=>store.claimDue('second',n),execute:(claim:ClaimedAutomation)=>runClaimedAutomation({store,claim,now:()=>clock,execute:successorExecute})};
  await second.poll([next]);expect(successorExecute).not.toHaveBeenCalled();clock+=10_001;await second.poll([next]);await second.stop();expect(successorExecute).toHaveBeenCalledOnce();
  held.resolve();await first.stop();const run=await store.latestRun(`${task.id}:${new Date(clock-10_001).toISOString()}`);expect(run).toMatchObject({status:'succeeded',attempt:2,threadId:project});expect((await store.get(task.id)).lease).toBeNull();
 });
});

it('bounds total claims to model capacity across six user slots, retaining durable backlog beyond the queue wait',async()=>{
 vi.useFakeTimers();vi.setSystemTime(0);
 const held=defer<string>();const counts=new Map<string,number>(),starts:string[]=[];
 const sources=['maria','jordi','rafa'].map(userId=>({userId,claim:vi.fn(async(n:number)=>{const left=2-(counts.get(userId)??0);const count=Math.min(n,left);counts.set(userId,(counts.get(userId)??0)+count);return Array.from({length:count},(_,i)=>userId+i);}),execute:async(claim:string)=>{starts.push(claim);return held.promise;}}));
 const poller=new AutomationAdmissionPoller<string,string>({concurrency:2,globalConcurrency:2,onResult:vi.fn(),onError:vi.fn()});
 await poller.poll(sources);await flush();expect(starts).toHaveLength(2);
 await vi.advanceTimersByTimeAsync(360_000);await poller.poll(sources);
 expect(starts).toHaveLength(2);expect(sources[1].claim).not.toHaveBeenCalled();expect(sources[2].claim).not.toHaveBeenCalled();
 held.resolve('done');await flush();await poller.poll(sources);await flush();expect(starts.slice(2)).toEqual(['jordi0','jordi1']);
 await poller.poll(sources);await flush();expect(starts.slice(4)).toEqual(['rafa0','rafa1']);await poller.stop();
});
it('reserves global slots while claims are unresolved and releases unused reservations after errors',async()=>{
 let rejectClaim!:(error:Error)=>void;const pendingClaim=new Promise<string[]>((_resolve,reject)=>{rejectClaim=reject;});const terminal=defer<string>();const error=vi.fn();const first={userId:'a',claim:()=>pendingClaim,execute:()=>terminal.promise};
 const next={userId:'b',claim:vi.fn(async()=>['b']),execute:()=>terminal.promise};
 const poller=new AutomationAdmissionPoller<string,string>({concurrency:2,globalConcurrency:2,onResult:vi.fn(),onError:error});
 const pending=poller.poll([first]);await flush();await poller.poll([next]);expect(next.claim).not.toHaveBeenCalled();
 rejectClaim(Error('PRINCIPAL_UNAVAILABLE'));await pending;await poller.poll([next]);expect(next.claim).toHaveBeenCalledOnce();terminal.resolve('done');await poller.stop();
});

it('keeps long background backlog unclaimed behind the reserved human slot',async()=>{
 vi.useFakeTimers();vi.setSystemTime(0);const held=defer<string>();const starts:string[]=[];
 const secondClaim=vi.fn(async()=>['second']);
 const poller=new AutomationAdmissionPoller<string,string>({concurrency:2,globalConcurrency:backgroundModelConcurrency(2),onResult:vi.fn(),onError:vi.fn()});
 const sources=[{userId:'first',claim:async()=>['first'],execute:async(x:string)=>{starts.push(x);return held.promise;}},{userId:'second',claim:secondClaim,execute:async(x:string)=>{starts.push(x);return x;}}];
 await poller.poll(sources);await flush();await vi.advanceTimersByTimeAsync(50*60_000);await poller.poll(sources);
 expect(starts).toEqual(['first']);expect(secondClaim).not.toHaveBeenCalled();held.resolve('first');await flush();
 await poller.poll(sources);await flush();expect(starts).toContain('second');await poller.stop();
});


describe('same-sweep admission after empty claims', () => {
 it('checks five users in one poll when the first four have no due work', async () => {
  const terminal=defer<string>();const claimed:string[]=[];const execute=vi.fn(()=>terminal.promise);
  const sources=Array.from({length:5},(_,i)=>({userId:`user-${i}`,claim:async(n:number)=>{expect(n).toBe(1);claimed.push(`user-${i}`);return i===4?['due']:[];},execute}));
  const poller=new AutomationAdmissionPoller<string,string>({concurrency:2,globalConcurrency:1,onResult:vi.fn(),onError:vi.fn()});
  await poller.poll(sources);await flush();
  expect(claimed).toEqual(['user-0','user-1','user-2','user-3','user-4']);expect(execute).toHaveBeenCalledOnce();
  terminal.resolve('done');await poller.stop();
 });

 it('waits for a delayed empty claim, fences overlapping polls, then admits due work without waiting for execution', async () => {
  const admission=defer<string[]>(),terminal=defer<string>();const claim=vi.fn(()=>admission.promise),nextClaim=vi.fn(async()=>['due']),execute=vi.fn(()=>terminal.promise);
  const sources=[{userId:'empty',claim,execute},{userId:'due',claim:nextClaim,execute}];
  const poller=new AutomationAdmissionPoller<string,string>({concurrency:1,globalConcurrency:1,onResult:vi.fn(),onError:vi.fn()});
  let complete=false;const first=poller.poll(sources).then(()=>{complete=true;});await flush();
  await poller.poll(sources);expect(claim).toHaveBeenCalledOnce();expect(nextClaim).not.toHaveBeenCalled();expect(complete).toBe(false);
  admission.resolve([]);await first;await flush();expect(nextClaim).toHaveBeenCalledOnce();expect(execute).toHaveBeenCalledOnce();expect(complete).toBe(true);
  await poller.poll(sources);expect(nextClaim).toHaveBeenCalledOnce();terminal.resolve('done');await poller.stop();
 });

 it('releases a failed claim in the same sweep and retains round-robin priority behind real work', async () => {
  const terminal=defer<string>();const calls:string[]=[];let failed=false;const errors=vi.fn();
  const sources=['denied','due','later'].map(userId=>({userId,claim:async()=>{calls.push(userId);if(userId==='denied'&&!failed){failed=true;throw Error('ACTOR_DISABLED');}return userId==='denied'?[]:[userId];},execute:()=>terminal.promise}));
  const poller=new AutomationAdmissionPoller<string,string>({concurrency:1,globalConcurrency:1,onResult:vi.fn(),onError:errors});
  await poller.poll(sources);expect(calls).toEqual(['denied','due']);expect(errors).toHaveBeenCalledWith(expect.objectContaining({message:'ACTOR_DISABLED'}),'denied');
  await poller.poll(sources);expect(calls).toEqual(['denied','due']);terminal.resolve('done');await flush();
  await poller.poll(sources);expect(calls[2]).toBe('later');await poller.stop();
 });

 it('does not turn spare global capacity into a serial claim barrier', async () => {
  const admission=defer<string[]>(),terminal=defer<string>();const first=vi.fn(()=>admission.promise),second=vi.fn(async()=>['second']);
  const poller=new AutomationAdmissionPoller<string,string>({concurrency:1,globalConcurrency:2,onResult:vi.fn(),onError:vi.fn()});
  const pending=poller.poll([{userId:'slow',claim:first,execute:()=>terminal.promise},{userId:'fast',claim:second,execute:()=>terminal.promise}]);await flush();
  expect(first).toHaveBeenCalledOnce();expect(second).toHaveBeenCalledOnce();admission.resolve([]);await pending;terminal.resolve('done');await poller.stop();
 });

 it('does not admit another user after shutdown while waiting for an empty claim', async () => {
  const admission=defer<string[]>();const next=vi.fn(async()=>['forbidden']);
  const poller=new AutomationAdmissionPoller<string,string>({concurrency:1,globalConcurrency:1,onResult:vi.fn(),onError:vi.fn()});
  const pending=poller.poll([{userId:'slow',claim:()=>admission.promise,execute:async()=>''},{userId:'next',claim:next,execute:async()=>''}]);await flush();
  const stopping=poller.stop();admission.resolve([]);await pending;await stopping;expect(next).not.toHaveBeenCalled();
 });
});
