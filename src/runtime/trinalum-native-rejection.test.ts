import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { FileApprovalStore, type ConnectorReconciliationProof } from './approval-store';
import { handleTrinalumTool, type TrinalumBridgeContext } from './trinalum-dynamic-tools';
import { TrinalumChatActions, type ChatAction } from './trinalum-chat-actions';
import { reconcileTrinalumConnectorDisposition } from './trinalum-connector-reconciliation';
import { connectorFingerprint as shaCanonical } from '@/connectors/canonical';
import { nativeAttioHashes, nativeAttioMutationTarget, nativeAttioComparableEffectHash, checkedNativeAttioObjectAlias } from './trinalum-native-disposition';
import type { DynamicToolCallParams } from '../../contracts/codex/0.162.1/types/v2/DynamicToolCallParams';

const userId='11111111-1111-4111-8111-111111111111';
const roots:string[]=[], cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.useRealTimers();vi.restoreAllMocks(); await Promise.all(cleanups.splice(0).map(fn=>fn())); await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const installationId='trinalum-production',threadId='thread';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const original={type:'create_person',request:{values:{name:'Synthetic Person',synthetic_attribute:'invalid'}}};
const fixed={type:'create_person',request:{values:{name:'Synthetic Person',synthetic_attribute:'valid'}}};
const peopleObjectId='12345678-1234-4234-8234-123456789abc',customObjectId='12345678-1234-4234-8234-123456789abd';
const objectMetadata=(objectId:string,api_slug:string)=>({id:{object_id:objectId,workspace_id:'33333333-3333-4333-8333-333333333333'},api_slug});
const decoded=(value:Awaited<ReturnType<typeof handleTrinalumTool>>)=>JSON.parse((value.contentItems[0] as {text:string}).text);
function proof(action:Pick<ChatAction,'id'|'input'>, rejected=true):ConnectorReconciliationProof {
 const now=Date.now();return {proofVersion:1,proofCategory:rejected?'definitive-rejection':'no-dispatch',installationId,userId,operation:'attio_action',actionId:action.id,
  requestedBy:'Miguel',...nativeAttioHashes(action,'Miguel'),nativeRecordSha256:sha(action.id+(rejected?'rejected':'prepared')),
  ...(rejected?{nativeStatus:'rejected',approvedAt:new Date(now-20).toISOString(),approvedBy:'Miguel',dispatchedAt:new Date(now-10).toISOString(),definitiveRejection:true,providerStatus:400,providerCode:'validation_type',error:{status:400,code:'validation_type'}}:
   {nativeStatus:'prepared',approvedAt:null,approvedBy:null,dispatchedAt:null,error:null,preparedProvenance:'strict-unapproved-prepared'}),
  executedAt:null,providerResultPresent:false,resultPresent:false,readbackPresent:false,otherClaimHeld:false,dispatchGuarantee:'attio-durable-before-mutation-v1',legacyHistoryCertified:false,
  checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+30_000).toISOString()} as ConnectorReconciliationProof;
}
async function fixture() {
 const root=await mkdtemp(path.join(tmpdir(),'attio-chat-rejection-'));roots.push(root);
 const usersRoot=path.join(root,'users');await mkdir(path.join(usersRoot,userId),{recursive:true,mode:0o700});
 const store=new FileApprovalStore({installationId,userId,usersRoot});const actions=new TrinalumChatActions(store.userRoot,{installationId,userId,threadId});
 const native=new Map<string,{input:Record<string,unknown>;status:string}>();const held=new Set<ServerResponse>();
 const counters={prepare:0,dispatch:0,effects:0,proofs:0,metadata:0};
 const state:{mutate?:(value:Record<string,unknown>)=>void;status?:number;dropProof?:boolean;unknown?:boolean;denyStatus?:boolean;endProof?:boolean;onProof?:()=>Promise<void>;metadata?:unknown;metadataStatus?:number;onMetadata?:()=>Promise<void>}={};
 const server=createServer((req,res)=>{void(async()=>{
  let bytes='';for await(const chunk of req)bytes+=chunk;const data=JSON.parse(bytes);
  if(req.headers.authorization!==`Bearer ${'a'.repeat(64)}`){res.writeHead(403);res.end('{}');return;}
  const reply=(value:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(req.url==='/read'){
   counters.metadata++;const request=data.input?.request;
   if(data.operation!=='attio_api'||data.input.command!=='read'||request?.method!=='GET'){reply({},400);return;}
   const id=String(request.path).split('/')[2];
   const metadata=state.metadata??(id===peopleObjectId?objectMetadata(id,'people'):id===customObjectId?objectMetadata(id,'synthetic_widgets'):null);
   if(state.onMetadata)await state.onMetadata();
   if(!metadata||state.metadataStatus){reply({},state.metadataStatus??404);return;}
   reply({source:'Trinalum connector broker',data:{source:'Attio API',request,data:{data:metadata}},untrustedSourceContent:true});return;
  }
  if(req.url==='/action-status'){
   counters.proofs++;if(state.denyStatus){reply({},409);return;}
   const saved=native.get(data.actionId);if(!saved||saved.status!==(data.phase==='status'?'prepared':'rejected')){reply({},409);return;}
   const p=proof({id:data.actionId,input:saved.input},data.phase==='rejection-status');state.mutate?.(p as unknown as Record<string,unknown>);
   if(state.onProof)await state.onProof();
   res.writeHead(200,{'Content-Type':'application/x-ndjson'});held.add(res);res.on('close',()=>held.delete(res));res.write(JSON.stringify(p)+'\n');if(state.endProof)res.end();return;
  }
  if(data.phase==='prepare'){counters.prepare++;native.set(data.actionId,{input:data.input,status:'prepared'});reply({data:{status:'prepared',preview:{synthetic:true}}});return;}
  const record=native.get(data.actionId)!;counters.dispatch++;
  const request=record.input.request as Record<string, unknown>;
  const values=(request.values ?? (request.body as {data?:{values?:unknown}} | undefined)?.data?.values) as Record<string,unknown> | undefined;
  if(values?.synthetic_attribute==='invalid' || (Array.isArray(values?.name) && typeof values.name[0]==='object' && Object.keys(values.name[0]).join()==='full_name')){
   record.status='rejected';if(state.unknown){reply({error:'CONNECTOR_UNAVAILABLE'},502);return;}
   const p=proof({id:data.actionId,input:record.input}) as unknown as Record<string,unknown>;state.mutate?.(p);
   reply({error:'PROVIDER_REQUEST_REJECTED',providerStatus:400,...(!state.dropProof?{nativeDisposition:p}:{})},state.status??502);return;
  }
  if(record.status==='completed'){reply({data:{status:'already_completed'}});return;}
  record.status='completed';counters.effects++;reply({data:{status:'completed',readback:{synthetic:true}}});
 })().catch(()=>{res.writeHead(500);res.end('{}');});});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as {port:number};
 cleanups.push(async()=>{for(const res of held)res.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const configPath=path.join(root,'bridge.json');const config={installationId,url:`http://127.0.0.1:${address.port}/read`,users:{[userId]:{token:'a'.repeat(64),status:'active'}}};await writeFile(configPath,JSON.stringify(config),{mode:0o600});
 const context:TrinalumBridgeContext={installationId,userId,runtimeThreadId:threadId,runtimeTurnId:'runtime-turn',sourceMessageId:'human-message',sourceTurnId:'assistant-turn',sourceMessage:'Crea este contacto Synthetic Person con el dato que te he dado.',authenticatedEmail:'sales@example.invalid',canMutate:true,permissionFingerprint:'b'.repeat(64),approvalStore:store,configPath,revalidateWrite:async()=>true};
 const call=async(tool:string,args:unknown,patch:Partial<TrinalumBridgeContext>={})=>{const ctx={...context,...patch};const p:DynamicToolCallParams={namespace:'trinalum_business',tool,arguments:args as DynamicToolCallParams['arguments'],threadId:ctx.runtimeThreadId,turnId:ctx.runtimeTurnId,callId:'call'};return decoded(await handleTrinalumTool(p,ctx));};
 const prepare=(args:unknown=original,patch:Partial<TrinalumBridgeContext>={})=>call('attio_action',args,patch);
 const execute=(id:string,patch:Partial<TrinalumBridgeContext>={})=>call('execute_action',{actionId:id},patch);
 const reject=async()=>{const p=await prepare();const before=await actions.read(p.actionId);const result=await execute(p.actionId);return {id:p.actionId,before:before!,result};};
 const correct=(id:string,input:{type:string;request:Record<string,unknown>}=fixed,patch:Partial<TrinalumBridgeContext>={})=>prepare({...input,request:{...input.request,_aibrainCorrection:{replacesActionId:id}}},patch);
 return {root,store,actions,context,config,configPath,state,counters,native,held,call,prepare,execute,reject,correct};
}

let legacy:{FileApprovalStore:typeof FileApprovalStore},oldActions:{TrinalumChatActions:typeof TrinalumChatActions},legacyRoot:string;
beforeAll(async()=>{
 legacyRoot=await mkdtemp(path.join(tmpdir(),'attio-old-reader-'));
 const source=await readFile('tests/fixtures/legacy/approval-store.ts.txt','utf8');
 const outfile=path.join(legacyRoot,'reader.mjs');await build({stdin:{contents:source,resolveDir:path.resolve('src/runtime'),loader:'ts'},outfile,bundle:true,platform:'node',format:'esm',conditions:['react-server'],alias:{'@':path.resolve('src')},logLevel:'silent'});legacy=await import(pathToFileURL(outfile).href);
 const actionSource=await readFile('tests/fixtures/legacy/trinalum-chat-actions.ts.txt','utf8');
 const actionsFile=path.join(legacyRoot,'actions.mjs');await build({stdin:{contents:actionSource,resolveDir:path.resolve('src/runtime'),loader:'ts'},outfile:actionsFile,bundle:true,platform:'node',format:'esm',conditions:['react-server'],alias:{'@':path.resolve('src')},logLevel:'silent'});oldActions=await import(pathToFileURL(actionsFile).href);
});
afterAll(async()=>{await rm(legacyRoot,{recursive:true,force:true});});

it('closes a fresh exact400, corrects in the SAME human turn and executes the new immutable action at most once',async()=>{
 const f=await fixture();const p=await f.prepare();const action=await f.actions.read(p.actionId);const prefix=await f.store.readConnectorApprovalEvents();
 const failed=await f.execute(p.actionId);expect(failed).toMatchObject({outcome:'failed',error:'ATTIO_VALIDATION_REJECTED'});expect(failed.instruction).toContain('SAME turn');
 const audit=await f.store.readConnectorNativeRejection(action!.locator);expect(audit!.before.status).toBe('executing');expect(audit!.after).toEqual({...audit!.before,status:'failed',completedAt:audit!.occurredAt});expect(audit!.after.approvedAt).toBe(audit!.before.approvedAt);expect(await f.actions.read(p.actionId)).toEqual(action);
 expect((await f.store.readConnectorApprovalEvents()).slice(0,prefix.length)).toEqual(prefix);
 expect((await f.execute(p.actionId)).outcome).toBe('failed');expect(f.counters.dispatch).toBe(1);
 const child=await f.correct(p.actionId);expect(child.outcome).toBe('prepared');expect(child.actionId).not.toBe(p.actionId);expect(f.counters.effects).toBe(0);
 const stored=await f.actions.read(child.actionId);expect(stored!.input).toEqual(fixed);expect(stored!.sourceMessageId).toBe(action!.sourceMessageId);expect(stored!.sourceTurnId).toBe(action!.sourceTurnId);
 expect(await f.actions.correctionForChild(child.actionId)).toMatchObject({parentId:p.actionId,childId:child.actionId});
 const oldActionStore=new oldActions.TrinalumChatActions(f.store.userRoot,{installationId,userId,threadId});expect(await oldActionStore.read(child.actionId)).toEqual(stored);
 const oldPendingStore=new legacy.FileApprovalStore({installationId,userId,usersRoot:path.join(f.root,'users')});expect((await oldPendingStore.readConnectorApproval(stored!.locator))?.status).toBe('approval_requested');
 const outcomes=await Promise.all([f.execute(child.actionId),f.execute(child.actionId)]);expect(outcomes.map(v=>v.outcome).sort()).toEqual(['executed','replayed']);expect(f.counters).toMatchObject({dispatch:2,effects:1,prepare:2,proofs:2});expect(await f.actions.read(p.actionId)).toEqual(action);
 const old=new legacy.FileApprovalStore({installationId,userId,usersRoot:path.join(f.root,'users')});expect((await old.readConnectorApproval(action!.locator))?.status).toBe('failed');let replays=0;
 expect((await old.executeConnectorApprovalByLocator(action!.locator,action!.fingerprint,{revalidate:()=>true,execute:()=>{replays++;}})).outcome).toBe('not-pending');expect(replays).toBe(0);
 expect(await old.readConnectorApprovalEvents()).toEqual(await f.store.readConnectorApprovalEvents());
});

it('preparation-only correction freezes/link-audits without dispatching the new action',async()=>{
 const f=await fixture();const p=await f.reject();const child=await f.correct(p.id,fixed,{sourceMessage:'Sólo prepara la corrección, no la ejecutes.'});expect(child.outcome).toBe('prepared');expect(child.instruction).toContain('stop here');expect(f.counters.dispatch).toBe(1);expect(f.counters.effects).toBe(0);expect((await f.store.readConnectorApproval((await f.actions.read(child.actionId))!.locator))!.status).toBe('approval_requested');
});

it('denies same-payload correction and competing/concurrent children, but exact preparation is idempotent',async()=>{
 const f=await fixture();const p=await f.reject();expect((await f.correct(p.id,original)).error).toBe('CORRECTION_REQUIRES_CHANGED_PAYLOAD');expect(f.counters.prepare).toBe(1);
 const children=await Promise.all([f.correct(p.id),f.correct(p.id)]);expect(children.map(v=>v.actionId)).toEqual([children[0].actionId,children[0].actionId]);
 const competing=await f.correct(p.id,{...fixed,request:{...fixed.request,values:{...fixed.request.values,synthetic_attribute:'other'}}});expect(competing.error).toBe('CORRECTION_ALREADY_PROPOSED');expect(f.counters.effects).toBe(0);
});

it.each([
 ['missing proof',undefined,true,502],['wrong transport status',undefined,false,500],['wrong actor',{requestedBy:'Trini',approvedBy:'Trini'},false,502],
 ['wrong user',{userId:'22222222-2222-4222-8222-222222222222'},false,502],['wrong ID',{actionId:`web-${'a'.repeat(64)}`},false,502],
 ['wrong request hash',{requestHash:'f'.repeat(64)},false,502],['wrong effect hash',{effectHash:'f'.repeat(64)},false,502],
 ['unknown result',{resultPresent:true},false,502],['5xx proof',{providerStatus:500},false,502],['forged extra',{message:'model claim'},false,502],
 ['expired',{checkedAt:new Date(Date.now()-60_000).toISOString(),expiresAt:new Date(Date.now()-30_000).toISOString()},false,502],
] as const)('keeps %s indeterminate with zero retries/corrective preparations',async(_name,patch,drop,status)=>{
 const f=await fixture();f.state.mutate=p=>Object.assign(p,patch);f.state.dropProof=drop;f.state.status=status;const p=await f.reject();expect(p.result.outcome).toBe('indeterminate');expect(await f.store.readConnectorNativeRejection(p.before.locator)).toBeNull();
 expect((await f.execute(p.id)).outcome).toBe('indeterminate');expect((await f.correct(p.id)).outcome).not.toBe('prepared');expect(f.counters).toMatchObject({dispatch:1,effects:0,prepare:1});
});

it.each([
 ['grant',{permissionFingerprint:'c'.repeat(64)}],['actor',{authenticatedEmail:'manager@example.invalid'}],['thread',{runtimeThreadId:'foreign'}],['missing human',{sourceMessage:''}],['revoked',{revalidateWrite:async()=>false}],
] satisfies [string,Partial<TrinalumBridgeContext>][])('denies %s mismatch without preparing/dispatching correction',async(_name,patch)=>{
 const f=await fixture();const p=await f.reject();expect((await f.correct(p.id,fixed,patch)).outcome).not.toBe('prepared');expect(f.counters.prepare).toBe(1);expect(f.counters.dispatch).toBe(1);
});

it('rejects a forged native error object instead of treating its properties as authoritative',async()=>{
 const f=await fixture();const p=await f.prepare();const action=(await f.actions.read(p.actionId))!;await f.store.approveConnectorApprovalByLocator(action.locator,action.fingerprint);
 const result=await f.store.executeConnectorApprovalByLocator(action.locator,action.fingerprint,{revalidate:()=>true,execute:()=>{throw Object.assign(Error('ATTIO_VALIDATION_REJECTED'),{nativeDisposition:proof(action)});}});expect(result.outcome).toBe('indeterminate');expect(await f.store.readConnectorNativeRejection(action.locator)).toBeNull();
});

it('recovers a crash from the durable exact rejection receipt without replay and preserves the audit bytes',async()=>{
 const f=await fixture();const p=await f.reject();const audit=(await f.store.readConnectorNativeRejection(p.before.locator))!;
 const files=await readdir(f.store.connectorRecordsRoot);const target=files.find(name=>name.endsWith('.json'))!;await writeFile(path.join(f.store.connectorRecordsRoot,target),JSON.stringify(audit.before));
 const dir=path.join(f.store.approvalsRoot,'native-rejections-v1');const file=path.join(dir,(await readdir(dir))[0]);const bytes=await readFile(file,'utf8');
 const restarted=new FileApprovalStore({installationId,userId,usersRoot:path.join(f.root,'users')});expect((await restarted.readConnectorApproval(p.before.locator))?.status).toBe('failed');expect(await readFile(file,'utf8')).toBe(bytes);expect((await f.execute(p.id)).outcome).toBe('failed');expect(f.counters.dispatch).toBe(1);
});

it('rejects payload/link tampering and revoked grant at execution of a prepared correction',async()=>{
 const f=await fixture();const p=await f.reject();const child=await f.correct(p.id);expect((await f.execute(child.actionId,{revalidateWrite:async()=>false})).outcome).not.toBe('executed');expect(f.counters.dispatch).toBe(1);
 const file=path.join(f.store.userRoot,'trinalum-chat-actions',sha(threadId),`correction-${child.actionId}.json`);const value=JSON.parse(await readFile(file,'utf8'));value.childEffectHash='f'.repeat(64);await writeFile(file,JSON.stringify(value));expect((await f.execute(child.actionId)).error).toBe('CORRECTION_LINK_CHANGED');expect(f.counters.dispatch).toBe(1);
});

it('requires fresh held original/native prepared proofs and current binding before making a correction executable',async()=>{
 const f=await fixture();const p=await f.reject();f.state.denyStatus=true;expect((await f.correct(p.id)).outcome).not.toBe('prepared');expect(f.counters.prepare).toBe(1);
 f.state.denyStatus=false;f.state.onProof=async()=>{await writeFile(f.configPath,JSON.stringify({...f.config,users:{[userId]:{token:'c'.repeat(64),status:'active'}}}));};expect((await f.correct(p.id)).outcome).not.toBe('prepared');expect(f.counters.prepare).toBe(1);expect(f.counters.effects).toBe(0);
});


it('gives a useful typed name hint, then closes a generic bad-name400 and links its exact-string correction without a second human turn',async()=>{
 const f=await fixture();const values={name:[{full_name:'Synthetic Person'}]};
 const hint=await f.prepare({type:'create_person',request:{values}});expect(hint).toMatchObject({error:'INVALID_ARGUMENTS',field:'request.values.name'});expect(hint.hint).toContain('exact human-supplied name as a string');expect(f.counters.prepare).toBe(0);
 const bad={type:'api_request',request:{method:'POST',path:'/objects/people/records',body:{data:{values}},readback:{method:'GET',path:'/objects/people/records'}}};
 const parent=await f.prepare(bad);expect((await f.execute(parent.actionId)).outcome).toBe('failed');
 const corrected={...bad,request:{...bad.request,body:{data:{values:{name:['Synthetic Person']}}},_aibrainCorrection:{replacesActionId:parent.actionId}}};
 const child=await f.prepare(corrected);expect(child.outcome).toBe('prepared');
 const saved=(await f.actions.read(child.actionId))!;const expected={...bad,request:{...bad.request,body:{data:{values:{name:['Synthetic Person']}}}}};expect(saved.input).toEqual(expected);expect(saved.input.request).not.toHaveProperty('_aibrainCorrection');
 const link=(await f.actions.correctionForChild(child.actionId))!;expect(nativeAttioHashes(saved,'Miguel')).toMatchObject({requestHash:link.childRequestHash,effectHash:link.childEffectHash});expect(f.native.get(child.actionId)!.input).toEqual(expected);
 const outcomes=await Promise.all([f.execute(child.actionId),f.execute(child.actionId)]);expect(outcomes.map(v=>v.outcome).sort()).toEqual(['executed','replayed']);expect(f.counters.effects).toBe(1);expect(f.counters.dispatch).toBe(2);
 const p=(await f.actions.read(parent.actionId))!;expect((await f.store.readConnectorNativeRejection(p.locator))!.proof).toMatchObject(nativeAttioHashes(p,'Miguel'));
});

it('keeps api_request readback outside the effect fence and rejects malformed correction metadata before any native freeze',async()=>{
 const f=await fixture();const bad={type:'api_request',request:{method:'POST',path:'/objects/people/records?b=2&a=1',body:{data:{values:{synthetic_attribute:'invalid'}}},readback:{method:'GET',path:'/objects/people/records'}}};
 const parent=await f.prepare(bad);expect((await f.execute(parent.actionId)).outcome).toBe('failed');
 expect((await f.prepare({...bad,request:{...bad.request,path:'/objects/people/records?a=1&b=2',readback:{method:'GET',path:'/objects/people/records/other'},_aibrainCorrection:{replacesActionId:parent.actionId}}})).error).toBe('CORRECTION_REQUIRES_CHANGED_PAYLOAD');
 for(const reference of [null,{}, {replacesActionId:'../../bad'}, {replacesActionId:parent.actionId,proof:'forged'}]) expect((await f.prepare({...bad,request:{...bad.request,_aibrainCorrection:reference}})).error).toBe('INVALID_CORRECTION_REFERENCE');
 expect(f.counters.prepare).toBe(1);expect(f.counters.effects).toBe(0);
});


it('retains existing PR49/operator failed v1 actions and permits a newly linked correction without rewriting their history',async()=>{
 const f=await fixture();f.state.unknown=true;const p=await f.reject();expect(p.result.outcome).toBe('indeterminate');f.state.unknown=false;
 const directory=path.join(f.store.userRoot,'trinalum-chat-actions',sha(threadId));const file=(await readdir(f.store.connectorRecordsRoot)).find(name=>name.endsWith('.json'))!;
 const chatBytes=await readFile(path.join(directory,`${p.id}.json`),'utf8');const recordBytes=await readFile(path.join(f.store.connectorRecordsRoot,file),'utf8');
 await reconcileTrinalumConnectorDisposition({store:f.store,actionId:p.id,runtimeThreadId:threadId,configPath:f.configPath,expectedChatActionSha256:sha(chatBytes),expectedRecordSha256:sha(recordBytes),operatorArtifactHash:'e'.repeat(64),proofCategory:'definitive-rejection',verifyCurrentGrant:async()=>({email:'sales@example.invalid',permissionFingerprint:f.context.permissionFingerprint!})});
 expect((await f.store.readConnectorDefinitiveRejection(p.before.locator))?.kind).toBe('operator');expect(await f.store.readConnectorNativeRejection(p.before.locator)).toBeNull();
 const auditPath=path.join(f.store.approvalsRoot,'connector-reconciliations-v1.jsonl');const audit=await readFile(auditPath,'utf8');const child=await f.correct(p.id);expect(child.outcome).toBe('prepared');expect((await f.execute(child.actionId)).outcome).toBe('executed');expect(f.counters.effects).toBe(1);
 expect(await readFile(auditPath,'utf8')).toBe(audit);expect(await readFile(path.join(directory,`${p.id}.json`),'utf8')).toBe(chatBytes);
});

it.each(['lost stream','changed original native receipt','changed child native request'] as const)('fails closed on %s before exposing an executable corrected action',async(kind)=>{
 const f=await fixture();const p=await f.reject();
 if(kind==='lost stream')f.state.endProof=true;
 else f.state.mutate=raw=>{if(kind==='changed original native receipt'&&raw.proofCategory==='definitive-rejection')raw.nativeRecordSha256='f'.repeat(64);if(kind==='changed child native request'&&raw.proofCategory==='no-dispatch')raw.requestHash='f'.repeat(64);};
 const child=await f.correct(p.id);expect(child.outcome).not.toBe('prepared');expect(f.counters.effects).toBe(0);expect(f.counters.dispatch).toBe(1);
 for(const [id] of f.native)if(id!==p.id){expect(await f.actions.read(id)).toBeNull();expect((await f.execute(id)).error).toBe('PREPARED_ACTION_REQUIRED');}
});

it('does not freeze any new native action for a forged or non-rejected parent reference',async()=>{
 const f=await fixture();const prepared=await f.prepare();expect((await f.correct(prepared.actionId)).outcome).not.toBe('prepared');expect((await f.correct(`web-${'f'.repeat(64)}`)).outcome).not.toBe('prepared');expect(f.counters).toMatchObject({prepare:1,dispatch:0,effects:0});
});


it('repairs the crash window after failed projection but before its terminal journal event, preserving the old prefix',async()=>{
 const f=await fixture();const p=await f.reject();
 const files=await readdir(f.store.approvalsRoot);const eventFile=files.find(name=>name.endsWith('.jsonl')&&!name.includes('reconciliation'))!;
 const file=path.join(f.store.approvalsRoot,eventFile);const lines=(await readFile(file,'utf8')).trimEnd().split('\n');const terminal=JSON.parse(lines.at(-1)!);expect(terminal.payload.eventType).toBe('failed');
 const prefix=lines.slice(0,-1).join('\n')+'\n';await writeFile(file,prefix);expect((await f.store.readConnectorApproval(p.before.locator))?.status).toBe('failed');
 expect((await readFile(file,'utf8')).startsWith(prefix)).toBe(true);expect((await f.store.readConnectorApprovalEvents()).at(-1)?.payload.eventType).toBe('failed');expect(f.counters.dispatch).toBe(1);
});


it('does not renew the original receipt when a later instruction requests a correction after expiry',async()=>{
 const f=await fixture();const p=await f.reject();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+86_400_001);
 expect((await f.correct(p.id,fixed,{runtimeTurnId:'later-runtime',sourceTurnId:'later-assistant',sourceMessageId:'later-human'})).outcome).not.toBe('prepared');expect(f.counters.prepare).toBe(1);expect(f.counters.effects).toBe(0);expect((await f.actions.read(p.id))!.expiresAt).toBe(p.before.expiresAt);
});


it.each([false,true])('does not grant unlinked retry eligibility from the same real human source (unknown=%s)',async unknown=>{
 const f=await fixture();f.state.unknown=unknown;const p=await f.reject();
 expect((await f.prepare(fixed)).error).toBe(unknown?'SOURCE_EFFECT_UNCERTAIN':'CORRECTION_REFERENCE_REQUIRED');expect(f.counters.prepare).toBe(1);expect(f.counters.dispatch).toBe(1);expect(f.counters.effects).toBe(0);
 if(!unknown)expect((await f.prepare(original)).error).toBe('CORRECTION_REQUIRES_CHANGED_PAYLOAD');expect((await f.actions.read(p.id))!.input).toEqual(original);
});


it('allows an independent bulk Task after a Person400 within the same human instruction',async()=>{
 const f=await fixture();f.context.sourceMessage='Crea el contacto indicado y una tarea independiente en el deal verificado.';const parent=await f.reject();expect(parent.result.outcome).toBe('failed');
 const task={type:'create_task',request:{parentObject:'deals',recordId:'12345678-1234-4234-8234-123456789abc',assigneeId:'12345678-1234-4234-8234-123456789abd',content:'Independent synthetic task',deadlineAt:'2026-10-20T09:00:00+02:00'}};
 const child=await f.prepare(task);expect(child.outcome).toBe('prepared');expect((await f.execute(child.actionId)).outcome).toBe('executed');expect(await f.actions.correctionForChild(child.actionId)).toBeNull();expect(f.counters).toMatchObject({prepare:2,dispatch:2,effects:1});
});

it('allows an independent Company after an uncertain Person within the same human instruction',async()=>{
 const f=await fixture();f.context.sourceMessage='Crea el contacto y la empresa independiente indicados.';f.state.unknown=true;const parent=await f.reject();expect(parent.result.outcome).toBe('indeterminate');
 const child=await f.prepare({type:'create_company',request:{values:{name:'Independent Synthetic Company'}}});expect(child.outcome).toBe('prepared');expect((await f.execute(child.actionId)).outcome).toBe('executed');expect(f.counters).toMatchObject({prepare:2,dispatch:2,effects:1});
});

it('blocks an unlinked typed Person after an uncertain generic People POST without blocking independent methods/paths',async()=>{
 const f=await fixture();f.state.unknown=true;
 const parent=await f.prepare({type:'api_request',request:{method:'POST',path:'/objects/people/records',body:{data:{values:{name:[{full_name:'Synthetic Person'}]}}}}});expect((await f.execute(parent.actionId)).outcome).toBe('indeterminate');
 expect((await f.prepare(fixed)).error).toBe('SOURCE_EFFECT_UNCERTAIN');expect(f.counters.prepare).toBe(1);
 const independent=await f.prepare({type:'api_request',request:{method:'POST',path:'/notes',body:{data:{title:'Independent synthetic note'}}}});expect(independent.outcome).toBe('prepared');
 const otherMethod=await f.prepare({type:'api_request',request:{method:'PUT',path:'/objects/people/records',body:{data:{values:{name:['Synthetic Person']}}}}});expect(otherMethod.outcome).toBe('prepared');expect(f.counters).toMatchObject({prepare:3,dispatch:1,effects:0});
});

it('blocks query/readback and generic-shape aliases of the uncertain typed Person operation',async()=>{
 const f=await fixture();f.state.unknown=true;await f.reject();
 for(const request of [
  {method:'POST',path:'/objects/people/records',body:{data:{values:{name:['Synthetic Person']}}}},
  {method:'POST',path:'/objects/people/records?b=2&a=1',body:{data:{values:{name:['Changed Synthetic Name']}}},readback:{method:'GET',path:'/notes'}},
  {method:'POST',path:'/objects/people/records?a=1&b=2',body:{data:{values:{name:[{first_name:'Synthetic',last_name:'Person',full_name:'Synthetic Person'}]}}},readback:{method:'GET',path:'/objects/people/records/other'}},
 ])expect((await f.prepare({type:'api_request',request})).error).toBe('SOURCE_EFFECT_UNCERTAIN');
 expect(f.counters).toMatchObject({prepare:1,dispatch:1,effects:0});
});

it('keys exposed typed mutations to actual native operationFor routes while keeping independent record IDs separate',async()=>{
 const native=await import(pathToFileURL(path.resolve('deployments/trinalum/host/attio/bin/attio-action.mjs')).href);
 const id='12345678-1234-4234-8234-123456789ABC';
 for(const [type,request] of [
  ['create_person',{values:{name:'Synthetic Person'}}],['create_company',{values:{name:'Synthetic Company'}}],
  ['create_deal',{values:{name:'Synthetic Deal',stage:'Verified Stage',owner:'Verified Owner',associated_company:[{target_record_id:id}]}}],
  ['create_task',{parentObject:'deals',recordId:id,assigneeId:id,content:'Synthetic task',deadlineAt:'2026-10-20T09:00:00+02:00'}],
  ['create_note',{parentObject:'people',recordId:id,title:'Synthetic Note',content:'Synthetic content'}],
  ['update_person',{recordId:id,values:{name:'Synthetic Person'}}],['update_company',{recordId:id,values:{name:'Synthetic Company'}}],['update_deal',{recordId:id,values:{name:'Synthetic Deal'}}],
  ['update_task',{taskId:id,isCompleted:true}],['delete_task',{taskId:id}],
 ] as const){
  const operation=native.operationFor({type,request});
  expect(nativeAttioMutationTarget({type,request})).toBe(nativeAttioMutationTarget({type:'api_request',request:{...operation,path:operation.path.toLowerCase()+'?ignored=query',readback:{path:'/other'}}}));
 }
 expect(nativeAttioMutationTarget({type:'update_person',request:{recordId:id}})).not.toBe(nativeAttioMutationTarget({type:'update_person',request:{recordId:'12345678-1234-4234-8234-123456789abd'}}));
});


it('does not use a definitive parent proof to relabel an independent API method/target as a correction',async()=>{
 const f=await fixture();const input={type:'api_request',request:{method:'POST',path:'/objects/people/records',body:{data:{values:{name:[{full_name:'Synthetic Person'}]}}}}};
 const parent=await f.prepare(input);expect((await f.execute(parent.actionId)).outcome).toBe('failed');
 for(const request of [
  {method:'POST',path:'/objects/companies/records',body:{data:{values:{name:['Independent Synthetic Company']}}}},
  {method:'PUT',path:'/objects/people/records',body:{data:{values:{name:['Synthetic Person']}}}},
 ])expect((await f.prepare({type:'api_request',request:{...request,_aibrainCorrection:{replacesActionId:parent.actionId}}})).error).toBe('CORRECTION_REQUIRES_CHANGED_PAYLOAD');
 expect(f.counters).toMatchObject({prepare:1,dispatch:1,effects:0});
});

it('resolves two definitive rejections through the executed correction chain before allowing another independent bulk Person',async()=>{
 const f=await fixture();f.context.sourceMessage='Crea los dos contactos indicados; corrige los datos verificados si la validación los rechaza.';
 const parent=await f.reject();const secondInput={...original,request:{values:{...original.request.values,verified_note:'Supplied synthetic correction'}}};
 const second=await f.correct(parent.id,secondInput);expect(second.outcome).toBe('prepared');expect((await f.execute(second.actionId)).outcome).toBe('failed');
 const third=await f.correct(second.actionId);expect(third.outcome).toBe('prepared');expect((await f.execute(third.actionId)).outcome).toBe('executed');
 const independent=await f.prepare({type:'create_person',request:{values:{name:'Other Supplied Synthetic Person',synthetic_attribute:'valid'}}});expect(independent.outcome).toBe('prepared');expect(await f.actions.correctionForChild(independent.actionId)).toBeNull();expect((await f.execute(independent.actionId)).outcome).toBe('executed');
 expect((await f.actions.correctionForParent(parent.id))?.childId).toBe(second.actionId);expect((await f.actions.correctionForParent(second.actionId))?.childId).toBe(third.actionId);expect(f.counters).toMatchObject({prepare:4,dispatch:4,effects:2});
});


it.each(['pending','unknown'] as const)('does not resolve a correction chain whose last child is %s',async terminal=>{
 const f=await fixture();const parent=await f.reject();
 const second=await f.correct(parent.id,{...original,request:{values:{...original.request.values,verified_note:'Supplied second shape'}}});expect((await f.execute(second.actionId)).outcome).toBe('failed');
 const third=await f.correct(second.actionId,terminal==='pending'?fixed:{...original,request:{values:{...original.request.values,verified_note:'Supplied third shape'}}});expect(third.outcome).toBe('prepared');
 if(terminal==='unknown'){f.state.unknown=true;expect((await f.execute(third.actionId)).outcome).toBe('indeterminate');}
 const before={...f.counters};const independent=await f.prepare({type:'create_person',request:{values:{name:'Other Supplied Synthetic Person',synthetic_attribute:'valid'}}});expect(independent.outcome).not.toBe('prepared');expect(f.counters).toEqual(before);
});

it('fails closed on an immutable-link cycle without native preparation or provider replay',async()=>{
 const f=await fixture();const parent=await f.reject();const second=await f.correct(parent.id,{...original,request:{values:{...original.request.values,verified_note:'Supplied second shape'}}});expect((await f.execute(second.actionId)).outcome).toBe('failed');
 const parentRecord=(await f.actions.read(parent.id))!,secondRecord=(await f.actions.read(second.actionId))!;
 const secondAudit=(await f.store.readConnectorDefinitiveRejection(secondRecord.locator))!;
 const existing=(await f.actions.correctionForChild(second.actionId))!;
 const cycle={...existing,parentId:second.actionId,childId:parent.id,parentSha256:shaCanonical(secondRecord),childFingerprint:parentRecord.fingerprint,parentNativeRecordSha256:secondAudit.proof.nativeRecordSha256,
  ...Object.fromEntries(Object.entries(nativeAttioHashes(parentRecord,'Miguel')).map(([key,value])=>[key==='requestHash'?'childRequestHash':'childEffectHash',value]))};
 const file=path.join(f.store.userRoot,'trinalum-chat-actions',sha(threadId),`correction-${parent.id}.json`);await writeFile(file,JSON.stringify(cycle));
 const before={...f.counters};expect((await f.prepare({type:'create_person',request:{values:{name:'Other Supplied Synthetic Person',synthetic_attribute:'valid'}}})).outcome).not.toBe('prepared');expect(f.counters).toEqual(before);
});

const apiPerson=(object:string,valid=true)=>({type:'api_request',request:{method:'POST',path:`/objects/${object}/records`,body:{data:{values:{name:['Synthetic Person'],synthetic_attribute:valid?'valid':'invalid'}}}}});

it.each(['typed-parent','uuid-parent'] as const)('blocks uncertain People retries through authenticated slug/UUID aliases (%s)',async direction=>{
 const f=await fixture();f.state.unknown=true;
 const parent=await f.prepare(direction==='typed-parent'?original:apiPerson(peopleObjectId,false));expect((await f.execute(parent.actionId)).outcome).toBe('indeterminate');
 const child=await f.prepare(direction==='typed-parent'?apiPerson(peopleObjectId):fixed);expect(child.error).toBe('SOURCE_EFFECT_UNCERTAIN');
 expect(f.counters).toMatchObject({prepare:1,dispatch:1,effects:0,metadata:direction==='typed-parent'?1:2});
});

it('keeps a native verified custom object UUID independent of an uncertain People creation',async()=>{
 const f=await fixture();f.state.unknown=true;await f.reject();
 const input=apiPerson(customObjectId),child=await f.prepare(input);expect(child.outcome).toBe('prepared');expect(await f.actions.correctionForChild(child.actionId)).toBeNull();
 expect((await f.actions.read(child.actionId))!.input).toEqual(input);expect((await f.execute(child.actionId)).outcome).toBe('executed');expect(f.counters).toMatchObject({prepare:2,dispatch:2,effects:1,metadata:1});
});

it('does not treat changing only the object UUID alias as a corrected payload',async()=>{
 const f=await fixture(),parent=await f.prepare(apiPerson('people',false));expect((await f.execute(parent.actionId)).outcome).toBe('failed');
 expect((await f.correct(parent.actionId,apiPerson(peopleObjectId,false))).error).toBe('CORRECTION_REQUIRES_CHANGED_PAYLOAD');expect(f.counters).toMatchObject({prepare:1,dispatch:1,effects:0,metadata:1});
 const alias=new Map([[peopleObjectId,'people']]);
 expect(nativeAttioComparableEffectHash(apiPerson('people',false),alias)).toBe(nativeAttioComparableEffectHash(apiPerson(peopleObjectId,false),alias));
 expect(nativeAttioHashes({id:'raw',input:apiPerson('people',false)},'Miguel').effectHash).not.toBe(nativeAttioHashes({id:'raw',input:apiPerson(peopleObjectId,false)},'Miguel').effectHash);
});

it('links a changed UUID-alias correction using ORIGINAL native hashes and resolves its immutable chain',async()=>{
 const f=await fixture(),parent=await f.prepare(apiPerson('people',false));expect((await f.execute(parent.actionId)).outcome).toBe('failed');
 const input=apiPerson(peopleObjectId),child=await f.correct(parent.actionId,input);expect(child.outcome).toBe('prepared');
 const saved=(await f.actions.read(child.actionId))!,link=(await f.actions.correctionForChild(child.actionId))!;
 expect(saved.input).toEqual(input);expect(f.native.get(child.actionId)!.input).toEqual(input);expect(nativeAttioHashes(saved,'Miguel')).toMatchObject({requestHash:link.childRequestHash,effectHash:link.childEffectHash});
 expect((await f.execute(child.actionId)).outcome).toBe('executed');
 const independent=await f.prepare({type:'create_person',request:{values:{name:'Other Exact Synthetic Person',synthetic_attribute:'valid'}}});expect(independent.outcome).toBe('prepared');expect(await f.actions.correctionForChild(independent.actionId)).toBeNull();
 expect(f.counters).toMatchObject({prepare:3,dispatch:2,effects:1});
});

it.each([
 ['wrong object ID',objectMetadata(customObjectId,'people'),undefined],['missing slug',{id:objectMetadata(peopleObjectId,'people').id},undefined],
 ['invalid workspace',{id:{object_id:peopleObjectId,workspace_id:'not-a-workspace'},api_slug:'people'},undefined],
 ['unsafe slug',objectMetadata(peopleObjectId,'people/../other'),undefined],['unknown object',undefined,404],['denied metadata',undefined,403],
] as const)('fails closed before native preparation on %s',async(_name,metadata,status)=>{
 const f=await fixture();f.state.metadata=metadata;f.state.metadataStatus=status;
 const prepared=await f.prepare(apiPerson(peopleObjectId));expect(prepared.outcome).not.toBe('prepared');expect(f.counters).toMatchObject({metadata:1,prepare:0,dispatch:0,effects:0});
});

it('revalidates the binding after metadata instead of freezing a proposal under revoked access',async()=>{
 const f=await fixture();f.state.onMetadata=async()=>{await writeFile(f.configPath,JSON.stringify({...f.config,users:{[userId]:{token:'c'.repeat(64),status:'active'}}}));};
 expect((await f.prepare(apiPerson(peopleObjectId))).outcome).not.toBe('prepared');expect(f.counters).toMatchObject({metadata:1,prepare:0,dispatch:0});
});

it('requires a checked metadata map for a UUID target; custom aliases stay separate and raw hashes never change',()=>{
 const people=apiPerson(peopleObjectId),custom=apiPerson(customObjectId),originalBytes=JSON.stringify(people);
 expect(()=>nativeAttioMutationTarget(people)).toThrow('ATTIO_OBJECT_ALIAS_UNRESOLVED');
 const aliases=new Map([[peopleObjectId,checkedNativeAttioObjectAlias(objectMetadata(peopleObjectId,'people'),peopleObjectId)],
  [customObjectId,checkedNativeAttioObjectAlias(objectMetadata(customObjectId,'synthetic_widgets'),customObjectId)]]);
 expect(nativeAttioMutationTarget(people,aliases)).toBe(nativeAttioMutationTarget(fixed));expect(nativeAttioMutationTarget(custom,aliases)).not.toBe(nativeAttioMutationTarget(fixed));
 expect(nativeAttioMutationTarget(apiPerson(peopleObjectId.toUpperCase()),aliases)).toBe(nativeAttioMutationTarget(fixed));expect(JSON.stringify(people)).toBe(originalBytes);
 expect(()=>nativeAttioMutationTarget(apiPerson(peopleObjectId.replace('-','%2D')),aliases)).toThrow('ATTIO_OBJECT_ALIAS_INVALID');
});
