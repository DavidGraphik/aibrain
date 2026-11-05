import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, symlink, rename, stat } from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import type { AuthSession } from '@/auth/types';import type { InstallationConfig } from '@/config/installation-schema';
import { FileAutomationStore } from './store';
import { assertAutomationRunState, createAutomationRunState } from './run-state';
import { AUTOMATION_RUN_STATE_NAMESPACE, AUTOMATION_RUN_STATE_TOOLS, handleAutomationRunStateTool } from './run-state-tools';
vi.mock('server-only',()=>({}));
const access=vi.hoisted(()=>({enabled:true,project:true}));
vi.mock('@/auth/local-user-store',()=>({FileLocalUserStore:class{async read(){return{enabled:access.enabled,email:'employee@example.test'};}}}));
vi.mock('@/workbench/store',()=>({getWritableProject:async()=>{if(!access.project)throw Error('denied');return{};}}));
const userId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',projectId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const session:AuthSession={provider:'local',tenant:{id:'state-qa',name:'State QA'},user:{id:userId,email:'employee@example.test',name:'Employee'},expiresAt:'2035-01-01T00:00:00.000Z'};
const roots:string[]=[];
beforeEach(()=>Object.assign(access,{enabled:true,project:true}));afterEach(async()=>{for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
async function fixture(initialState:'active'|'paused'|'completed'='active'){
 const root=await mkdtemp(path.join(os.tmpdir(),'automation-state-'));roots.push(root);let clock=Date.now();
 const installation={installationId:'state-qa',paths:{usersRoot:path.join(root,'users')}}as Readonly<InstallationConfig>;
 const store=new FileAutomationStore({installationId:installation.installationId,userId,usersRoot:installation.paths.usersRoot,now:()=>clock});
 const task=await store.create({name:'Monitor',prompt:'Read only, remember one event.',projectId,projectName:'Own project',timeZone:'Europe/Madrid',schedule:initialState==='completed'
  ?{kind:'once',runAt:new Date(clock+1_000).toISOString()}
  :{kind:'interval',minutes:30,anchorAt:new Date(clock).toISOString()}});
 if(initialState==='paused')await store.update(task.id,{state:'paused'});
 if(initialState==='completed'){
  // Completion belongs to the scheduler, never the user-facing patch API.
  clock+=2_000;const[scheduled]=await store.claimDue('scheduled-completion-worker',1);
  expect(scheduled.task.id).toBe(task.id);
  expect((await store.settle(scheduled,{status:'succeeded'})).state).toBe('completed');
 }
 await store.runNow(task.id,requestId);const[claim]=await store.claimDue('first-worker',1);
 const input={installation,session,task:claim.task,runKey:claim.runKey,signal:new AbortController().signal};
 const state=await createAutomationRunState(input);
 const advance=async()=>{clock+=11*60_000;const[next]=await store.claimDue('recovered-worker',1);return{...input,task:next.task,runKey:next.runKey};};
 return{input,state,store,claim,advance,file:path.join(installation.paths.usersRoot,userId,'automations','private-state',task.id,'state.json')};
}
const resultHash='a'.repeat(64);
describe('private automation state and quiet outcomes',()=>{
 it('uses CAS under a lock, reconciles one call retry, and commits only after a terminal result',async()=>{
  const{input,state,file}=await fixture();expect(await state.get()).toEqual({revision:0,data:{},provisional:false,taskCreatedAt:input.task.createdAt,scheduledFor:input.task.lease!.scheduledFor});
  const writes=await Promise.allSettled([state.compareAndSet(0,{cursor:'first'},'one'),state.compareAndSet(0,{cursor:'second'},'two')]);
  expect(writes.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(writes.filter(x=>x.status==='rejected')).toHaveLength(1);
  const winner=writes[0].status==='fulfilled'?'one':'two',cursor=winner==='one'?'first':'second';
  expect(await state.compareAndSet(0,{cursor},winner)).toEqual({revision:1,provisional:true,replayed:true});
  const restarted=await createAutomationRunState(input);expect(await restarted.get()).toMatchObject({revision:1,data:{cursor},provisional:true});
  expect(JSON.parse(await readFile(file,'utf8')).committed.data).toEqual({});
  expect(await restarted.finalize(resultHash)).toMatchObject({revision:1,quiet:false});
  expect(JSON.parse(await readFile(file,'utf8')).committed.data).toEqual({cursor});
  expect(await restarted.finalize(resultHash)).toMatchObject({revision:1,quiet:false});
  await expect(restarted.compareAndSet(1,{cursor:'late'},'late')).rejects.toThrow('RUN_FINALIZED');
  await expect(restarted.finalize('b'.repeat(64))).rejects.toThrow('RESULT_CONFLICT');
 });
 it.each(['paused','completed'] as const)('admits only the durable manual occurrence while the recurrence stays %s',async initialState=>{
  const{input,state,store,claim}=await fixture(initialState);
  expect(input.runKey).toBe(`${input.task.id}:manual:${requestId}`);
  expect(await state.get()).toMatchObject({revision:0,data:{},scheduledFor:claim.scheduledFor});
  await state.compareAndSet(0,{reviewed:'synthetic'},'manual-state');
  expect(await state.finalize(resultHash)).toMatchObject({revision:1,quiet:false,runKey:input.runKey});
  const settled=await store.settle(claim,{status:'succeeded'});
  expect(settled).toMatchObject({state:initialState,lastRunStatus:'succeeded',manualRun:null,lease:null,retryAt:null});
  await expect(state.get()).rejects.toThrow('ACCESS_DENIED');
 });
 it('still fences a paused manual occurrence after cancellation, lease replacement or identity revocation',async()=>{
  const cancelled=await fixture('paused');
  await cancelled.store.update(cancelled.input.task.id,{state:'paused'});
  await expect(cancelled.state.compareAndSet(0,{bad:true},'cancelled')).rejects.toThrow('ACCESS_DENIED');
  await expect(createAutomationRunState(cancelled.input)).rejects.toThrow('ACCESS_DENIED');
  const recovered=await fixture('paused');
  const nextInput=await recovered.advance();
  await expect(recovered.state.finalize(resultHash)).rejects.toThrow('ACCESS_DENIED');
  const current=await createAutomationRunState(nextInput);
  expect(await current.get()).toMatchObject({revision:0,data:{}});
  access.enabled=false;
  await expect(current.get()).rejects.toThrow('ACCESS_DENIED');
 });
 it('does not consume a source or quiet marker from an interrupted attempt',async()=>{
  const{state,advance}=await fixture();await state.compareAndSet(0,{notified:true,source:'invoice-1'},'notified');await state.finishQuiet('already reviewed');
  const recovered=await createAutomationRunState(await advance());expect(await recovered.get()).toMatchObject({revision:0,data:{},provisional:false});
  expect(await recovered.finalize(resultHash)).toMatchObject({revision:0,quiet:false});expect((await recovered.get()).data).toEqual({});
  await expect(state.get()).rejects.toThrow('ACCESS_DENIED');
 });
 it('recovers pending state only when the executor has proven its existing terminal result',async()=>{
  const{state,advance,file}=await fixture();await state.compareAndSet(0,{notified:true,source:'invoice-1'},'notified');
  const recovered=await createAutomationRunState(await advance());await recovered.finalize(resultHash,{recoverPrepared:true});
  expect(JSON.parse(await readFile(file,'utf8')).committed).toMatchObject({revision:1,data:{notified:true,source:'invoice-1'},resultHash});
 });
 it('is visible by default; quiet is explicit and business activity prevents hiding the result',async()=>{
  const a=await fixture();expect(await a.state.finalize(resultHash)).toMatchObject({quiet:false});
  const b=await fixture();expect(await b.state.finishQuiet('No new actionable mail')).toEqual({quiet:true});expect(await b.state.finalize(resultHash)).toMatchObject({quiet:true});
  const c=await fixture();await c.state.finishQuiet('Nothing new');await c.state.requireVisible('business-action-attempt');expect(await c.state.finishQuiet('Do not hide')).toEqual({quiet:false});expect(await c.state.finalize(resultHash)).toMatchObject({quiet:false});
 });
 it('denies other tasks, tenants, users, projects, forged capability, revoked access and expired fences',async()=>{
  const{input,state,store}=await fixture();
  await expect(assertAutomationRunState({...state},{installationId:'state-qa',userId,projectId})).rejects.toThrow('ACCESS_DENIED');
  await expect(assertAutomationRunState(state,{installationId:'other',userId,projectId})).rejects.toThrow('ACCESS_DENIED');
  await expect(createAutomationRunState({...input,session:{...session,user:{...session.user,id:requestId}}})).rejects.toThrow('ACCESS_DENIED');
  await expect(createAutomationRunState({...input,task:{...input.task,id:requestId}})).rejects.toThrow();
  await expect(createAutomationRunState({...input,task:{...input.task,projectId:requestId}})).rejects.toThrow('ACCESS_DENIED');
  access.enabled=false;await expect(state.get()).rejects.toThrow('ACCESS_DENIED');access.enabled=true;
  access.project=false;await expect(state.compareAndSet(0,{cursor:'x'},'bad')).rejects.toThrow();access.project=true;
  await store.update(input.task.id,{state:'paused'});await expect(state.finishQuiet('no')).rejects.toThrow('ACCESS_DENIED');
 });
 it('rejects cross-scope or symlink records and oversized JSON without changing committed state',async()=>{
  const{state,file}=await fixture();await state.compareAndSet(0,{cursor:1},'ok');const original=await readFile(file,'utf8');
  await expect(state.compareAndSet(1,{x:'x'.repeat(65536)},'big')).rejects.toThrow('TOO_LARGE');
  await writeFile(file,JSON.stringify({...JSON.parse(original),userId:requestId}));await expect(state.get()).rejects.toThrow('ACCESS_DENIED');
  await rm(file);await writeFile(file+'.other',original);await symlink(file+'.other',file);await expect(state.get()).rejects.toThrow();
 });
 it('offers only current-run get/CAS/quiet with bound runtime ids; no target task or external effects argument',async()=>{
  const{state}=await fixture();const context={state,installationId:'state-qa',userId,projectId,runtimeThreadId:'runtime',runtimeTurnId:'turn'};
  const call={namespace:AUTOMATION_RUN_STATE_NAMESPACE,threadId:'runtime',turnId:'turn',callId:'call',tool:'get',arguments:{}};
  expect((await handleAutomationRunStateTool(call,context)).success).toBe(true);
  expect((await handleAutomationRunStateTool({...call,threadId:'foreign'},context)).success).toBe(false);
  expect((await handleAutomationRunStateTool({...call,arguments:{taskId:requestId}},context)).success).toBe(false);
  expect((await handleAutomationRunStateTool({...call,tool:'compare_and_set',arguments:{expectedRevision:0,data:{source:'one'}}},context)).success).toBe(true);
  for(const ns of AUTOMATION_RUN_STATE_TOOLS){expect(ns.description!.length).toBeLessThanOrEqual(1024);if(ns.type==='namespace')for(const tool of ns.tools)expect(tool.description!.length).toBeLessThanOrEqual(1024);}
 });
});


it("keeps all private files restricted and refuses a symlinked state directory ancestor",async()=>{
 const{state,file}=await fixture();await state.compareAndSet(0,{source:"one"},"save");await state.finalize(resultHash);
 expect((await stat(file)).mode&0o077).toBe(0);
 const parent=path.dirname(path.dirname(file));await rename(parent,parent+".original");await symlink(parent+".original",parent);
 await expect(state.get()).rejects.toThrow("STORAGE_INVALID");
});


it("reads quiet terminal authority without committing state and revalidates fence and visibility",async()=>{
 const f=await fixture();expect(await f.state.quietResult()).toBeNull();
 await f.state.compareAndSet(0,{source:"verified"},"one");await f.state.finishQuiet("No new actionable events");
 const before=await readFile(f.file,"utf8");expect(await f.state.quietResult()).toEqual({reason:"No new actionable events"});
 expect(await readFile(f.file,"utf8")).toBe(before);expect(JSON.parse(before).committed.data).toEqual({});
 const next=await createAutomationRunState(await f.advance());
 await expect(f.state.quietResult()).rejects.toThrow("ACCESS_DENIED");expect(await next.quietResult()).toBeNull();
 expect(await next.quietResult({recoverPrepared:true})).toEqual({reason:"No new actionable events"});
 await next.requireVisible("business-action-attempt");expect(await next.quietResult({recoverPrepared:true})).toBeNull();
 await f.store.update(f.input.task.id,{state:"paused"});await expect(next.quietResult()).rejects.toThrow("ACCESS_DENIED");
});

it('does not recover a prior or foreign occurrence quiet marker under a newer lease', async () => {
 const f=await fixture();await f.state.compareAndSet(0,{notified:true,source:'foreign-source'},'foreign');
 await f.state.finishQuiet('Reason belonging to a different occurrence');
 const snapshot=JSON.parse(await readFile(f.file,'utf8'));
 snapshot.pending.runKey=`${f.input.task.id}:2030-01-01T00:00:00.000Z`;
 await writeFile(f.file,JSON.stringify(snapshot));
 const recovered=await createAutomationRunState(await f.advance());
 expect(await recovered.quietResult({recoverPrepared:true})).toBeNull();
 expect(await recovered.finalize(resultHash,{recoverPrepared:true})).toMatchObject({quiet:false,revision:0});
 expect((await recovered.get()).data).toEqual({});
});


it('keeps the first review boundary at creation even when execution and recovery happen later',async()=>{
 const f=await fixture();const createdAt=f.input.task.createdAt;const scheduledFor=f.input.task.lease!.scheduledFor;
 const later=await f.advance();const recovered=await createAutomationRunState(later);
 expect(Date.parse(later.task.lease!.expiresAt)).toBeGreaterThan(Date.parse(f.input.task.lease!.expiresAt));
 expect(await recovered.get()).toMatchObject({revision:0,data:{},taskCreatedAt:createdAt,scheduledFor});
});


it('runs one exact manually claimed occurrence while recurrence remains paused and commits its state',async()=>{
 const f=await fixture('paused');
 expect(f.input.task.state).toBe('paused');expect(f.input.runKey).toBe(`${f.input.task.id}:manual:${requestId}`);
 expect(await f.state.get()).toMatchObject({revision:0,scheduledFor:f.input.task.manualRun!.scheduledFor});
 await f.state.compareAndSet(0,{reviewed:'sage-read-only'},'readback');
 expect(await f.state.finalize(resultHash)).toMatchObject({revision:1,quiet:false});
 expect((await f.store.get(f.input.task.id)).state).toBe('paused');
 expect(JSON.parse(await readFile(f.file,'utf8')).committed.data).toEqual({reviewed:'sage-read-only'});
});
it.each(['request','scheduledFor','leaseScheduledFor','preparation','recurrence','cancel','owner','fence','expired'] as const)('rejects a replaced or blocked paused manual claim: %s',async(change)=>{
 const f=await fixture('paused');
 const file=path.join(f.input.installation.paths.usersRoot,userId,'automations','tasks.json');
 const snapshot=JSON.parse(await readFile(file,'utf8')),task=snapshot.tasks[0];
 if(change==='request')task.manualRun.requestId=projectId;
 if(change==='scheduledFor')task.manualRun.scheduledFor=new Date(Date.now()+1000).toISOString();
 if(change==='leaseScheduledFor')task.lease.scheduledFor=new Date(Date.now()+1000).toISOString();
 if(change==='preparation')task.preparationBlock='Provider approval pending';
 if(change==='recurrence')task.manualRun=null;
 if(change==='cancel')task.cancellationRequestedAt=new Date().toISOString();
 if(change==='owner')task.lease.ownerId='other-worker';
 if(change==='fence')task.lease.fenceToken=projectId;
 if(change==='expired')task.lease.expiresAt=new Date(Date.now()-1000).toISOString();
 await writeFile(file,JSON.stringify(snapshot));
 await expect(f.state.get()).rejects.toThrow('ACCESS_DENIED');
 await expect(f.state.compareAndSet(0,{bad:true},'bad')).rejects.toThrow('ACCESS_DENIED');
});
it('keeps a paused manual occurrence cancellable through the ordinary pause action',async()=>{
 const f=await fixture('paused');await f.store.update(f.input.task.id,{state:'paused'});
 await expect(f.state.get()).rejects.toThrow('ACCESS_DENIED');
});


it('admits a genuinely scheduled recurring claim without a manual request and preserves its active schedule',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'automation-state-recurring-'));roots.push(root);let clock=Date.now();
 const installation={installationId:'state-qa',paths:{usersRoot:path.join(root,'users')}} as Readonly<InstallationConfig>;
 const store=new FileAutomationStore({installationId:installation.installationId,userId,usersRoot:installation.paths.usersRoot,now:()=>clock});
 const task=await store.create({name:'Daily source review',prompt:'Read the current source; report internally.',projectId,projectName:'Own project',timeZone:'Europe/Madrid',schedule:{kind:'interval',minutes:30,anchorAt:new Date(clock).toISOString()}});
 clock=Date.parse(task.nextRunAt!);
 const [claim]=await store.claimDue('recurring-worker',1);
 expect(claim.task.manualRun).toBeNull();expect(claim.runKey).toBe(`${task.id}:${claim.scheduledFor}`);
 const input={installation,session,task:claim.task,runKey:claim.runKey,signal:new AbortController().signal};
 const authority=await createAutomationRunState(input);
 expect(await authority.get()).toMatchObject({revision:0,scheduledFor:claim.scheduledFor});
 await authority.compareAndSet(0,{sourceReviewed:true},'recurring-source');
 expect(await authority.finalize(resultHash)).toMatchObject({revision:1,runKey:claim.runKey});
 expect((await store.get(task.id)).state).toBe('active');
 // A matching lease/input key alone cannot turn an arbitrary key into a scheduled occurrence.
 const file=path.join(installation.paths.usersRoot,userId,'automations','tasks.json');
 const snapshot=JSON.parse(await readFile(file,'utf8'));
 const malformedKey=`${task.id}:not-a-scheduled-instant`;
 snapshot.tasks[0].lease.runKey=malformedKey;await writeFile(file,JSON.stringify(snapshot));
 await expect(createAutomationRunState({...input,runKey:malformedKey,task:{...claim.task,lease:{...claim.task.lease!,runKey:malformedKey}}})).rejects.toThrow('ACCESS_DENIED');
});


it('binds new recurring outcomes to the stable conversation and rejects foreign conversation IDs',async()=>{
 const{input}=await fixture();const{automationTaskThreadId}=await import('./run-identities');
 const threadId=automationTaskThreadId(input.task)!;
 const authority=await createAutomationRunState({...input,threadId});
 expect(await authority.finalize(resultHash)).toMatchObject({threadId,runKey:input.runKey});
 await expect(createAutomationRunState({...input,threadId:requestId})).rejects.toThrow('ACCESS_DENIED');
});


// Independent version-2 fixture producer: the reader release never generates
// a new large CAS payload just to prepare its compatibility test inputs.
function canonicalFixture(v:unknown):unknown{
 if(Array.isArray(v))return v.map(canonicalFixture);
 if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonicalFixture((v as Record<string,unknown>)[k])]));
 return v;
}
const digestFixture=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
function frameFixture(value:Record<string,unknown>){
 const raw=Buffer.from(JSON.stringify(canonicalFixture(value)));
 return raw.length>65536?{encoding:'gzip-json-v1',bytes:raw.length,sha256:digestFixture(raw),gzip:gzipSync(raw).toString('base64')}:{encoding:'json-v1',bytes:raw.length,sha256:digestFixture(raw),value};
}
const largeFixture=()=>({complete:true,tasksById:Object.fromEntries(Array.from({length:247},(_,i)=>[`task-${i}`,{text:`Revisión de tarea ${i}, responsable y fecha. `.repeat(8),owner:`member-${i%3}`,deadline:'2030-11-06T08:00:00Z',complete:false}]))});
async function readerFixture(){
 const f=await fixture();await f.state.compareAndSet(0,{},'seed');const data=largeFixture();
 const snapshot=JSON.parse(await readFile(f.file,'utf8'));
 snapshot.schemaVersion=2;snapshot.dataEncoding='bounded-json-v1';snapshot.committed.data=frameFixture({});snapshot.pending.data=frameFixture(data);
 snapshot.pending.calls=[{id:'existing-large-call',hash:digestFixture(JSON.stringify({expectedRevision:0,data:canonicalFixture(data)})),revision:1}];
 await writeFile(f.file,JSON.stringify(snapshot));return {...f,data};
}
it('reader phase decodes an existing full snapshot, replays its original CAS without a write, and preserves it through metadata/finalize',async()=>{
 const f=await readerFixture();const before=await readFile(f.file);expect((await f.state.get()).data).toEqual(f.data);expect(await readFile(f.file)).toEqual(before);
 expect(await f.state.compareAndSet(0,f.data,'existing-large-call')).toMatchObject({revision:1,replayed:true});expect(await readFile(f.file)).toEqual(before);
 await expect(f.state.compareAndSet(1,{...f.data,complete:false},'new-large')).rejects.toThrow('TOO_LARGE');expect(await readFile(f.file)).toEqual(before);
 await f.state.finishQuiet('Existing snapshot remains intact');expect((await f.state.get()).data).toEqual(f.data);expect(JSON.parse(await readFile(f.file,'utf8')).schemaVersion).toBe(2);
 await f.state.finalize(resultHash);const reopened=await createAutomationRunState(f.input);
 expect((await reopened.get()).data).toEqual(f.data);expect(await reopened.finalize(resultHash)).toMatchObject({revision:1,quiet:true});
});
it('reader phase retains the exact old64KiB write boundary and format1 while rejecting new compressible large snapshots',async()=>{
 const f=await fixture(),data={x:'x'.repeat(65536-8)};expect(Buffer.byteLength(JSON.stringify(data))).toBe(65536);
 await f.state.compareAndSet(0,data,'legacy-limit');expect(JSON.parse(await readFile(f.file,'utf8')).schemaVersion).toBe(1);
 const before=await readFile(f.file);await expect(f.state.compareAndSet(1,largeFixture(),'new-large')).rejects.toThrow('TOO_LARGE');
 expect(await readFile(f.file)).toEqual(before);expect((await f.state.get()).data).toEqual(data);
});
it('reader phase permits a small replacement while preserving a preexisting large committed baseline until finalize',async()=>{
 const f=await readerFixture(),stored=JSON.parse(await readFile(f.file,'utf8'));
 stored.committed.data=frameFixture(f.data);stored.pending=null;await writeFile(f.file,JSON.stringify(stored));
 await f.state.compareAndSet(0,{cursor:'small-new'},'small');
 const pending=JSON.parse(await readFile(f.file,'utf8'));expect(pending.schemaVersion).toBe(2);expect(pending.committed.data).toEqual(stored.committed.data);
 await f.state.finalize(resultHash);expect((await f.state.get()).data).toEqual({cursor:'small-new'});expect(JSON.parse(await readFile(f.file,'utf8')).schemaVersion).toBe(1);
});
it.each(['hash','codec','bomb','foreign-owner'] as const)('reader phase refuses corrupted or foreign version2 state without rewriting it: %s',async(change)=>{
 const f=await readerFixture(),stored=JSON.parse(await readFile(f.file,'utf8')),packed=stored.pending.data;
 if(change==='hash')packed.sha256='0'.repeat(64);
 if(change==='codec')packed.encoding='unknown';
 if(change==='foreign-owner')stored.userId=requestId;
 if(change==='bomb'){
  const raw=Buffer.from(JSON.stringify({x:'x'.repeat(256*1024)}));packed.gzip=gzipSync(raw).toString('base64');packed.bytes=256*1024;packed.sha256=digestFixture(raw);
 }
 await writeFile(f.file,JSON.stringify(stored));const before=await readFile(f.file);
 await expect(f.state.get()).rejects.toThrow(change==='foreign-owner'?'ACCESS_DENIED':'CORRUPT');expect(await readFile(f.file)).toEqual(before);
});
