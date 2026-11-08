import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthSession } from '@/auth/types';
import type { InstallationConfig } from '@/config/installation-schema';
import type { ResolvedPermissions } from '@/permissions';
import type { DynamicToolCallResponse } from '../../contracts/codex/0.162.1/types/v2/DynamicToolCallResponse';
import { DEFAULT_AUTOMATION_EXECUTION_CONTEXT, isAutomationExecutionContext, parseAutomationInput } from './contracts';
import { grantAutomationEffects, assertNewAutomationEffectGrant } from './effect-grant';
import { createAutomationEffectAuthorization, assertAutomationEffectAuthorization, effectForAutomationOperation } from './authorized-effects';
import { FileAutomationStore } from './store';

vi.mock('server-only',()=>({}));
const state = vi.hoisted(()=>({ enabled:true, project:true, execute:true }));
vi.mock('@/auth/local-user-store',()=>({FileLocalUserStore:class { async read(){ return {enabled:state.enabled,email:'trini@example.test'}; } }}));
vi.mock('@/workbench/store',()=>({getWritableProject:async()=>{ if(!state.project)throw Error('denied'); return {}; }}));
vi.mock('@/runtime/permission-turn',()=>({
  permissionAllowsGenericToolExecution:(permissions:{allow?:boolean})=>permissions.allow===true,
  resolveServerTurnPermissions:async()=>({allow:state.execute}),
}));
const userId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', turnId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const session:AuthSession={provider:'local',tenant:{id:'trinalum-production',name:'Trinalum'},user:{id:userId,email:'trini@example.test',name:'Trini'},expiresAt:'2035-01-01T00:00:00.000Z'};
const roots:string[]=[];
beforeEach(()=>Object.assign(state,{enabled:true,project:true,execute:true}));
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(paused=false,effects: ("attio-task" | "mail-draft" | "attio-note")[] = ["attio-task"]){
 const root=await mkdtemp(path.join(os.tmpdir(),'aibrain-automation-effects-'));roots.push(root);
 const installation={installationId:'trinalum-production',paths:{usersRoot:path.join(root,'users')}} as Readonly<InstallationConfig>;
 const base={name:'Task reminder',prompt:'Create the requested native follow-up task, without sending email.',projectId,projectName:'Client',timeZone:'Europe/Madrid',schedule:{kind:'interval' as const,minutes:60,anchorAt:new Date(Date.now()-60_000).toISOString()}};
 const executionContext=grantAutomationEffects({session,input:base,allowedEffects:effects,sourceThreadId:projectId,sourceTurnId:turnId,sourceMessage:'Cada día crea las tareas o notas de seguimiento solicitadas en Attio.'});
 const store=new FileAutomationStore({installationId:installation.installationId,userId,usersRoot:installation.paths.usersRoot});
 const created=await store.create({...base,executionContext});
 if(paused)await store.update(created.id,{state:'paused'});
 await store.runNow(created.id,turnId);
 const [claim]=await store.claimDue('worker-test',1);
 const permissions={allow:true,installationId:installation.installationId,userId,turnId} as unknown as ResolvedPermissions;
 const input={installation,session,task:claim.task,runKey:claim.runKey,localTurnId:turnId,permissions,signal:new AbortController().signal};
 return {input,store,executionContext};
}
const completed:DynamicToolCallResponse={success:true,contentItems:[{type:'inputText',text:JSON.stringify({outcome:'executed',data:{data:{status:'completed',readback:{id:{task_id:'native-id'}}}}})}]};

describe('bounded durable automation effects',()=>{
 it('keeps legacy schedules read-only and rejects public or forged grants',async()=>{
  const {input,executionContext}=await fixture();
  expect(await createAutomationEffectAuthorization({...input,task:{...input.task,executionContext:DEFAULT_AUTOMATION_EXECUTION_CONTEXT}})).toBeUndefined();
  expect(isAutomationExecutionContext(executionContext)).toBe(true);
  expect(()=>assertNewAutomationEffectGrant(executionContext)).not.toThrow();
  expect(()=>assertNewAutomationEffectGrant(JSON.parse(JSON.stringify(executionContext)))).toThrow('GRANT_REQUIRED');
  expect(parseAutomationInput({name:'X',prompt:'X',projectId,projectName:'X',timeZone:'UTC',schedule:{kind:'daily',hour:9,minute:0},executionContext})).toBeNull();
  expect(isAutomationExecutionContext({...executionContext,allowedEffects:['send-mail']})).toBe(false);
 });
 it('guards scope and each fresh lease, project, employee and permission check',async()=>{
  const {input,store}=await fixture();
  const authority=(await createAutomationEffectAuthorization(input))!;
  await expect(assertAutomationEffectAuthorization({...authority}, {installationId:input.task.installationId,userId})).rejects.toThrow('DENIED');
  await expect(assertAutomationEffectAuthorization(authority, {installationId:'another-tenant',userId})).rejects.toThrow('DENIED');
  await expect(assertAutomationEffectAuthorization(authority, {installationId:input.task.installationId,userId,projectId:turnId})).rejects.toThrow('DENIED');
  state.project=false;expect(await authority.revalidate()).toBe(false);state.project=true;
  state.enabled=false;expect(await authority.revalidate()).toBe(false);state.enabled=true;
  state.execute=false;expect(await authority.revalidate()).toBe(false);state.execute=true;
  await store.update(input.task.id,{state:'paused'});expect(await authority.revalidate()).toBe(false);
 });
 it('refuses a transplanted or modified task/fence before any dispatch',async()=>{
  const {input}=await fixture();
  await expect(createAutomationEffectAuthorization({...input,task:{...input.task,projectId:turnId}})).rejects.toThrow('DENIED');
  await expect(createAutomationEffectAuthorization({...input,task:{...input.task,prompt:'Send all email'}})).rejects.toThrow('DENIED');
  await expect(createAutomationEffectAuthorization({...input,task:{...input.task,lease:{...input.task.lease!,fenceToken:'new-fence'}}})).rejects.toThrow('DENIED');
  await expect(createAutomationEffectAuthorization({...input,task:{...input.task,installationId:'another'}})).rejects.toThrow('DENIED');
 });
 it('executes one exact effect across concurrent calls and a process-style authority reconstruction',async()=>{
  const {input}=await fixture();const first=(await createAutomationEffectAuthorization(input))!;
  const dispatch=vi.fn(async()=>completed);
  const body={type:'create_task',request:{recordId:projectId,content:'Call client',deadlineAt:'2026-11-02T08:00:00.000Z'}};
  const [one,two]=await Promise.all([first.runEffect('attio_action',body,dispatch),first.runEffect('attio_action',{request:body.request,type:'create_task'},dispatch)]);
  expect(one).toEqual(completed);expect(two).toEqual(completed);expect(dispatch).toHaveBeenCalledTimes(1);
  const restarted=(await createAutomationEffectAuthorization(input))!;await restarted.runEffect('attio_action',body,dispatch);expect(dispatch).toHaveBeenCalledTimes(1);
  await restarted.runEffect('attio_action',{...body,request:{...body.request,deadlineAt:'2026-12-02T08:00:00.000Z'}},dispatch);expect(dispatch).toHaveBeenCalledTimes(2);
 });
 it('deduplicates a saved draft across typed and generic tool aliases',async()=>{
  const {input,store}=await fixture();
  const executionContext=grantAutomationEffects({session,input:input.task,allowedEffects:['mail-draft'],sourceThreadId:projectId,sourceTurnId:turnId,sourceMessage:'Cada día guarda el borrador solicitado sin enviarlo.'});
  // Build a separate authorized task; existing grants cannot be expanded by update.
  const saved=await store.create({name:input.task.name,prompt:input.task.prompt,projectId:input.task.projectId,projectName:input.task.projectName,timeZone:input.task.timeZone,schedule:input.task.schedule,executionContext});
  await store.runNow(saved.id,projectId);
  const claims=await store.claimDue('draft-worker',2);
  const claim=claims.find(item=>item.task.id===saved.id)!;
  const authority=(await createAutomationEffectAuthorization({...input,task:claim.task,runKey:claim.runKey}))!;
  const dispatch=vi.fn(async()=>completed),body={type:'create_draft',request:{message:{subject:'Follow-up',toRecipients:[],body:{contentType:'Text',content:'Original content'}}}};
  await authority.runEffect('mail_draft',body,dispatch);
  await authority.runEffect('mail_action',body,dispatch);
  expect(dispatch).toHaveBeenCalledTimes(1);
 });
 it('does not replay an uncertain effect and requires actual completed readback',async()=>{
  const {input}=await fixture();const authority=(await createAutomationEffectAuthorization(input))!;
  const body={type:'create_task',request:{content:'Call'}};
  const lost=vi.fn(async()=>{throw Error('connection lost');});
  await expect(authority.runEffect('attio_action',body,lost)).rejects.toThrow('connection lost');
  await expect(authority.runEffect('attio_action',body,lost)).rejects.toThrow('UNCERTAIN');expect(lost).toHaveBeenCalledTimes(1);
  await expect(authority.runEffect('attio_action',{type:'create_task',request:{content:'Another'}},async()=>({success:true,contentItems:[{type:'inputText',text:'{"outcome":"executed"}'}]}))).rejects.toThrow('READBACK_REQUIRED');
 });
 it('never authorizes sends, deletions, ERP writes, generic APIs or an ungranted draft',async()=>{
  const {input}=await fixture();const authority=(await createAutomationEffectAuthorization(input))!;const dispatch=vi.fn(async()=>completed);
  for(const [operation,type]of [['mail_action','send_mail'],['mail_action','send_draft'],['attio_action','delete_task'],['attio_action','api_request'],['sibema_action','create_order'],['mail_draft','create_draft']])await expect(authority.runEffect(operation,{type},dispatch)).rejects.toThrow('NOT_ALLOWED');
  expect(dispatch).not.toHaveBeenCalled();expect(effectForAutomationOperation('mail_draft',{type:'create_draft'})).toBe('mail-draft');
 });
});


it('retains only the existing granted effect for an exact paused manual occurrence',async()=>{
 const {input,store}=await fixture(true),authority=(await createAutomationEffectAuthorization(input))!;
 expect(await authority.revalidate()).toBe(true);expect((await store.get(input.task.id)).state).toBe('paused');
 const dispatch=vi.fn(async()=>completed);
 await authority.runEffect('attio_action',{type:'create_task',request:{content:'Already authorized follow-up'}},dispatch);
 expect(dispatch).toHaveBeenCalledTimes(1);
 await expect(authority.runEffect('mail_action',{type:'send_mail'},dispatch)).rejects.toThrow('NOT_ALLOWED');
 expect(dispatch).toHaveBeenCalledTimes(1);
 await store.update(input.task.id,{state:'paused'});expect(await authority.revalidate()).toBe(false);
});
it.each(['request','scheduledFor','leaseScheduledFor','preparation','recurrence'] as const)('denies effects for a changed paused manual occurrence: %s',async(change)=>{
 const {input}=await fixture(true),authority=(await createAutomationEffectAuthorization(input))!;
 const file=path.join(input.installation.paths.usersRoot,userId,'automations','tasks.json');
 const snapshot=JSON.parse(await readFile(file,'utf8')),task=snapshot.tasks[0];
 if(change==='request')task.manualRun.requestId=projectId;
 if(change==='scheduledFor')task.manualRun.scheduledFor=new Date(Date.now()+1000).toISOString();
 if(change==='leaseScheduledFor')task.lease.scheduledFor=new Date(Date.now()+1000).toISOString();
 if(change==='preparation')task.preparationBlock='Provider approval pending';
 if(change==='recurrence')task.manualRun=null;
 await writeFile(file,JSON.stringify(snapshot));
 expect(await authority.revalidate()).toBe(false);
 const dispatch=vi.fn(async()=>completed);
 await expect(authority.runEffect('attio_action',{type:'create_task'},dispatch)).rejects.toThrow('DENIED');expect(dispatch).not.toHaveBeenCalled();
});

it('creates only an explicitly granted native note once, with fresh identity/lease checks', async()=>{
 const {input,store}=await fixture(false,['attio-note']);
 const authority=(await createAutomationEffectAuthorization(input))!;
 const note={type:'create_note',request:{parentObject:'companies',recordId:projectId,title:'Reply from customer',content:'Verified reply source Internet-Message-ID: <synthetic@example.test>'}};
 const dispatch=vi.fn(async()=>completed);
 await Promise.all([authority.runEffect('attio_action',note,dispatch),authority.runEffect('attio_action',note,dispatch)]);
 const recovered=(await createAutomationEffectAuthorization(input))!;
 await recovered.runEffect('attio_action',note,dispatch);
 expect(dispatch).toHaveBeenCalledTimes(1);
 for(const type of ['create_task','update_task','create_company','update_company','delete_note','update_note','api_request'])await expect(authority.runEffect('attio_action',{type},dispatch)).rejects.toThrow('NOT_ALLOWED');
 await expect(authority.runEffect('attio_api',{type:'create_note'},dispatch)).rejects.toThrow('NOT_ALLOWED');
 await expect(authority.runEffect('mail_action',{type:'send_mail'},dispatch)).rejects.toThrow('NOT_ALLOWED');
 await store.update(input.task.id,{state:'paused'});
 await expect(authority.runEffect('attio_action',note,dispatch)).rejects.toThrow('DENIED');
 expect(dispatch).toHaveBeenCalledTimes(1);
});
it('does not infer a note grant from a schedule, task permission or unknown outcomes',async()=>{
 const taskOnly=await fixture();const restricted=(await createAutomationEffectAuthorization(taskOnly.input))!;
 await expect(restricted.runEffect('attio_action',{type:'create_note'},async()=>completed)).rejects.toThrow('NOT_ALLOWED');
 const {input}=await fixture(false,['attio-note']),allowed=(await createAutomationEffectAuthorization(input))!;
 const dispatch=vi.fn(async()=>{throw Error('note response lost');});const note={type:'create_note',request:{recordId:projectId,title:'Reply',content:'Source message42'}};
 await expect(allowed.runEffect('attio_action',note,dispatch)).rejects.toThrow('note response lost');
 await expect(allowed.runEffect('attio_action',note,dispatch)).rejects.toThrow('UNCERTAIN');expect(dispatch).toHaveBeenCalledTimes(1);
});
it('passes an issued note capability through the ordinary immutable broker and replays once',async()=>{
 const {input}=await fixture(false,['attio-note']);
 const authority=(await createAutomationEffectAuthorization(input))!;
 const {FileApprovalStore}=await import('@/runtime/approval-store');
 const {handleTrinalumTool}=await import('@/runtime/trinalum-dynamic-tools');
 const configPath=path.join(path.dirname(input.installation.paths.usersRoot),'bridge.json');
 await writeFile(configPath,JSON.stringify({installationId:'trinalum-production',url:'http://127.0.0.1:18931/read',users:{[userId]:{token:'a'.repeat(64),status:'active'}}}),{mode:0o600});
 const phases:string[]=[];
 const fetcher=vi.fn<typeof fetch>(async(_url,init)=>{const body=JSON.parse(String(init?.body));phases.push(body.phase);return Response.json({data:body.phase==='prepare'?{status:'prepared',preview:{title:'Verified reply'}}:{status:'completed',readback:{id:{note_id:turnId},parent_object:'companies',parent_record_id:projectId,title:'Verified reply',content_plaintext:'Original mail source42'}}});});
 const context={installationId:input.installation.installationId,userId,projectId,runtimeThreadId:'runtime-thread',runtimeTurnId:'runtime-turn',admitOperation:async()=>true,configPath,fetcher,approvalStore:new FileApprovalStore({installationId:input.installation.installationId,userId,usersRoot:input.installation.paths.usersRoot}),canMutate:true,permissionFingerprint:'b'.repeat(64),backgroundExecution:true,automationEffects:authority,sourceMessage:'Create the previously requested note',sourceMessageId:projectId,sourceTurnId:turnId};
 const note={type:'create_note',request:{parentObject:'companies',recordId:projectId,title:'Verified reply',content:'Original mail source42'}};
 const params={namespace:'trinalum_business',tool:'attio_action',arguments:note,threadId:context.runtimeThreadId,turnId:context.runtimeTurnId,callId:'note-call'};
 const created=await handleTrinalumTool(params,context);
 expect(created.success).toBe(true);expect(phases).toEqual(['prepare']);
 const prepared=JSON.parse((created.contentItems[0] as {text:string}).text);
 const execute={...params,tool:'execute_action',arguments:{actionId:prepared.actionId}};
 expect((await handleTrinalumTool(execute,context)).success).toBe(true);
 expect((await handleTrinalumTool(execute,context)).success).toBe(true);
 expect(phases).toEqual(['prepare','execute']);
 const read=await handleTrinalumTool({...params,tool:'attio_notes',arguments:{recordId:projectId}},context);
 expect(read.success).toBe(true);
});
