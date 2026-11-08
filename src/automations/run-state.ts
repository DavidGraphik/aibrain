import 'server-only';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AuthSession } from '@/auth/types';
import { FileLocalUserStore } from '@/auth/local-user-store';
import type { InstallationConfig } from '@/config/installation-schema';
import { readRegularFileWithin } from '@/security/safe-file';
import { atomicWriteJson, ResourceLockManager, type StorageSchema } from '@/storage';
import { getWritableProject } from '@/workbench/store';
import type { AutomationTask } from './contracts';
import { FileAutomationStore } from './store';
import { automationRunIdentities, isAutomationResultThread } from './run-identities';
import { automationOccurrenceStillEligible } from './run-eligibility';

export type AutomationStateData = Record<string, unknown>;
type Pending = { runKey:string; fence:string; revision:number; data:AutomationStateData; quiet:boolean; reason:string; visible:boolean; calls:{id:string; hash:string; revision:number}[] };
type Commit = { revision:number; data:AutomationStateData; runKey:string|null; resultHash:string|null; quiet:boolean };
type State = { schemaVersion:1; installationId:string; userId:string; taskId:string; committed:Commit; pending:Pending|null };
export type AutomationStateOutcome = { schemaVersion:1; installationId:string; userId:string; taskId:string; runKey:string; threadId:string; resultHash:string; revision:number; quiet:boolean; reason:string };
export type AutomationRunState = Readonly<{
 installationId:string;userId:string;projectId:string;taskId:string;runKey:string;
 get:()=>Promise<{revision:number;data:AutomationStateData;provisional:boolean;taskCreatedAt:string;scheduledFor:string}>;
 compareAndSet:(expectedRevision:number,data:AutomationStateData,callId:string)=>Promise<{revision:number;provisional:true;replayed:boolean}>;
 finishQuiet:(reason:string)=>Promise<{quiet:boolean}>;
 quietResult:(options?:{recoverPrepared?:boolean})=>Promise<{reason:string}|null>;
 requireVisible:(reason:string)=>Promise<void>;
 finalize:(resultHash:string,options?:{recoverPrepared?:boolean})=>Promise<AutomationStateOutcome>;
}>;
const MAX_STORED_DATA_BYTES=64*1024,MAX_LOGICAL_DATA_BYTES=256*1024,MAX_STATE_FILE_BYTES=512*1024;
const issued=new WeakSet<object>();
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
function object(v:unknown):v is Record<string,unknown>{return Boolean(v&&typeof v==='object'&&!Array.isArray(v));}
function normalize(v:unknown):unknown{
 if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;
 if(Array.isArray(v))return v.map(normalize);
 if(object(v)&&Object.getPrototypeOf(v)===Object.prototype)return Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalize(v[k])]));
 throw Error('AUTOMATION_STATE_JSON_INVALID');
}
function dataValue(value:unknown,limit=MAX_LOGICAL_DATA_BYTES):AutomationStateData{
 if(!object(value))throw Error('AUTOMATION_STATE_OBJECT_REQUIRED');
 const encoded=JSON.stringify(normalize(value));if(Buffer.byteLength(encoded)>limit)throw Error('AUTOMATION_STATE_TOO_LARGE');
 return JSON.parse(encoded);
}
const stateSchema:StorageSchema<State>={name:'AutomationPrivateState',parse(v){
 if(!object(v)||Object.keys(v).sort().join()!=='committed,installationId,pending,schemaVersion,taskId,userId'||v.schemaVersion!==1||typeof v.installationId!=='string'||typeof v.userId!=='string'||typeof v.taskId!=='string'||!object(v.committed))throw Error('AUTOMATION_STATE_CORRUPT');
 const c=v.committed;
 if(!Number.isSafeInteger(c.revision)||Number(c.revision)<0||!(c.runKey===null||typeof c.runKey==='string')||!(c.resultHash===null||typeof c.resultHash==='string'&&/^[a-f0-9]{64}$/.test(c.resultHash))||typeof c.quiet!=='boolean')throw Error('AUTOMATION_STATE_CORRUPT');
 dataValue(c.data);
 if(v.pending!==null){const p=v.pending;if(!object(p)||typeof p.runKey!=='string'||typeof p.fence!=='string'||!Number.isSafeInteger(p.revision)||Number(p.revision)<Number(c.revision)||typeof p.quiet!=='boolean'||typeof p.visible!=='boolean'||typeof p.reason!=='string'||p.reason.length>500||!Array.isArray(p.calls)||p.calls.length>64||p.calls.some(x=>!object(x)||typeof x.id!=='string'||typeof x.hash!=='string'||!/^[a-f0-9]{64}$/.test(x.hash)||!Number.isSafeInteger(x.revision)))throw Error('AUTOMATION_STATE_CORRUPT');dataValue(p.data);}
 return v as unknown as State;
}};
// Version 1 remains ordinary JSON. Version 2 has an explicit storage-only
// envelope for every data record; runtime values and CAS hashes stay logical.
type DataEnvelope={encoding:'json-v1';bytes:number;sha256:string;value:AutomationStateData}|{encoding:'gzip-json-v1';bytes:number;sha256:string;gzip:string};
type StoredRecord<T extends {data:AutomationStateData}>=Omit<T,'data'>&{data:AutomationStateData|DataEnvelope};
type StoredState=Omit<State,'schemaVersion'|'committed'|'pending'>&{schemaVersion:1|2;dataEncoding?:'bounded-json-v1';committed:StoredRecord<Commit>;pending:StoredRecord<Pending>|null};
function envelopeBytes(data:DataEnvelope){return Buffer.byteLength(JSON.stringify(data));}
function encodeRecord<T extends {data:AutomationStateData}>(record:T):StoredRecord<T>{
 const raw=Buffer.from(JSON.stringify(normalize(record.data)));
 if(raw.length>MAX_LOGICAL_DATA_BYTES)throw Error('AUTOMATION_STATE_TOO_LARGE');
 const plain:DataEnvelope={encoding:'json-v1',bytes:raw.length,sha256:hash(raw),value:JSON.parse(raw.toString('utf8'))};
 if(envelopeBytes(plain)<=MAX_STORED_DATA_BYTES)return {...record,data:plain};
 const data:DataEnvelope={encoding:'gzip-json-v1',bytes:raw.length,sha256:hash(raw),gzip:gzipSync(raw).toString('base64')};
 if(envelopeBytes(data)>MAX_STORED_DATA_BYTES)throw Error('AUTOMATION_STATE_TOO_LARGE');
 return {...record,data};
}
function decodeRecord(value:unknown,version:1|2):Record<string,unknown>{
 if(!object(value))throw Error('AUTOMATION_STATE_CORRUPT');
 if(version===1){dataValue(value.data,MAX_STORED_DATA_BYTES);return value;}
 const data=value.data;
 if(!object(data)||!Number.isSafeInteger(data.bytes)||Number(data.bytes)<2||Number(data.bytes)>MAX_LOGICAL_DATA_BYTES||
  typeof data.sha256!=='string'||!/^[a-f0-9]{64}$/.test(data.sha256)||envelopeBytes(data as DataEnvelope)>MAX_STORED_DATA_BYTES)throw Error('AUTOMATION_STATE_CORRUPT');
 try{
  let raw:Buffer,logical:AutomationStateData;
  if(data.encoding==='json-v1'&&Object.keys(data).sort().join()==='bytes,encoding,sha256,value'){
   logical=dataValue(data.value,MAX_STORED_DATA_BYTES);raw=Buffer.from(JSON.stringify(logical));
  }else if(data.encoding==='gzip-json-v1'&&Object.keys(data).sort().join()==='bytes,encoding,gzip,sha256'&&typeof data.gzip==='string'){
   const compressed=Buffer.from(data.gzip,'base64');
   if(!compressed.length||compressed.toString('base64')!==data.gzip)throw Error('base64');
   raw=gunzipSync(compressed,{maxOutputLength:MAX_LOGICAL_DATA_BYTES});
   const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);logical=dataValue(JSON.parse(text));
   if(JSON.stringify(logical)!==text)throw Error('noncanonical JSON');
  }else throw Error('encoding');
  if(raw.length!==data.bytes||hash(raw)!==data.sha256)throw Error('integrity');
  return {...value,data:logical};
 }catch{throw Error('AUTOMATION_STATE_CORRUPT');}
}
function decodeState(value:unknown):State{
 if(!object(value)||(value.schemaVersion!==1&&value.schemaVersion!==2))throw Error('AUTOMATION_STATE_CORRUPT');
 if(value.schemaVersion===2&&value.dataEncoding!=='bounded-json-v1')throw Error('AUTOMATION_STATE_CORRUPT');
 const decoded={...value};if(value.schemaVersion===2)delete decoded.dataEncoding;
 return stateSchema.parse({...decoded,schemaVersion:1,committed:decodeRecord(value.committed,value.schemaVersion),pending:value.pending===null?null:decodeRecord(value.pending,value.schemaVersion)});
}
function encodeState(state:State):StoredState{
 if(![state.committed,state.pending].some(record=>record&&Buffer.byteLength(JSON.stringify(normalize(record.data)))>MAX_STORED_DATA_BYTES))return state;
 return {...state,schemaVersion:2,dataEncoding:'bounded-json-v1',committed:encodeRecord(state.committed),pending:state.pending===null?null:encodeRecord(state.pending)};
}
const storedStateSchema:StorageSchema<StoredState>={name:'AutomationPrivateStoredState',parse(value){
 decodeState(value);
 // Match atomicWriteJson's layout, including metadata and both data copies.
 // Never create a file the existing bounded reader cannot reopen.
 if(Buffer.byteLength(JSON.stringify(value,null,2)+'\n')>MAX_STATE_FILE_BYTES)throw Error('AUTOMATION_STATE_TOO_LARGE');
 return value as StoredState;
}};
const outcomeSchema:StorageSchema<AutomationStateOutcome>={name:'AutomationStateOutcome',parse(v){
 const r=v as AutomationStateOutcome;
 if(!r||r.schemaVersion!==1||typeof r.taskId!=='string'||typeof r.userId!=='string'||typeof r.installationId!=='string'||typeof r.runKey!=='string'||typeof r.threadId!=='string'||!/^[a-f0-9]{64}$/.test(r.resultHash)||!Number.isSafeInteger(r.revision)||r.revision<0||typeof r.quiet!=='boolean'||typeof r.reason!=='string')throw Error('AUTOMATION_STATE_OUTCOME_CORRUPT');return r;
}};
export async function assertAutomationRunState(value:AutomationRunState|undefined,identity:{installationId:string;userId:string;projectId:string}){
 if(!value||!issued.has(value)||value.installationId!==identity.installationId||value.userId!==identity.userId||value.projectId!==identity.projectId)throw Error('AUTOMATION_STATE_ACCESS_DENIED');
 return value;
}
/** State is metadata of one admitted automation, never an external-write grant.
 * CAS writes are durable proposals; only a persisted successful turn commits them. */
export async function createAutomationRunState(input:{installation:Readonly<InstallationConfig>;session:AuthSession;task:AutomationTask;runKey:string;signal:AbortSignal;threadId?:string}):Promise<AutomationRunState>{
 const {task,session,installation}=input;
 const resultThreadId=input.threadId??automationRunIdentities(input.runKey).threadId;
 if(!isAutomationResultThread(task,input.runKey,resultThreadId))throw Error('AUTOMATION_STATE_ACCESS_DENIED');
 if(session.provider!=='local'||session.tenant.id!==installation.installationId||task.installationId!==installation.installationId||task.userId!==session.user.id||task.schedule.kind==='external'||!task.lease?.fenceToken||task.lease.runKey!==input.runKey||!input.runKey.startsWith(task.id+':'))throw Error('AUTOMATION_STATE_ACCESS_DENIED');
 const tasks=new FileAutomationStore({installationId:installation.installationId,userId:session.user.id,usersRoot:installation.paths.usersRoot});
 const assertCurrent=async()=>{
  if(input.signal.aborted)throw Error('AUTOMATION_STATE_ACCESS_DENIED');
  const [fresh,user]=await Promise.all([tasks.get(task.id),new FileLocalUserStore(installation.paths.usersRoot).read(session.user.id)]);
  if(!user?.enabled||user.email!==session.user.email.toLowerCase()||!automationOccurrenceStillEligible(fresh,task,input.runKey)||fresh.projectId!==task.projectId||fresh.prompt!==task.prompt||!fresh.lease||fresh.lease.runKey!==input.runKey||fresh.lease.fenceToken!==task.lease!.fenceToken||fresh.lease.ownerId!==task.lease!.ownerId||Date.parse(fresh.lease.expiresAt)<=Date.now())throw Error('AUTOMATION_STATE_ACCESS_DENIED');
  await getWritableProject(session,task.projectId);
 };
 await assertCurrent();
 const userRoot=path.join(installation.paths.usersRoot,session.user.id),root=path.join(userRoot,'automations','private-state',task.id);
 const directories=[userRoot,path.join(userRoot,'automations'),path.join(userRoot,'automations','private-state'),root];
 const assertDirectories=async(create=false)=>{for(const dir of directories){if(create)await mkdir(dir,{mode:0o700}).catch(error=>{if(error.code!=="EEXIST")throw error;});const meta=await lstat(dir);if(!meta.isDirectory()||meta.isSymbolicLink()||meta.mode&0o077)throw Error('AUTOMATION_STATE_STORAGE_INVALID');}};
 await assertDirectories(true);
 const locks=new ResourceLockManager({rootDirectory:path.join(root,'locks')}),file=path.join(root,'state.json');
 const empty=():State=>({schemaVersion:1,installationId:installation.installationId,userId:session.user.id,taskId:task.id,committed:{revision:0,data:{},runKey:null,resultHash:null,quiet:false},pending:null});
 const read=async()=>{let s:State;try{s=decodeState(JSON.parse((await readRegularFileWithin(root,'state.json',MAX_STATE_FILE_BYTES)).toString('utf8')));}catch(e){if(!e||typeof e!=='object'||!('code'in e)||e.code!=='ENOENT')throw e;s=empty();}if(s.installationId!==installation.installationId||s.userId!==session.user.id||s.taskId!==task.id)throw Error('AUTOMATION_STATE_ACCESS_DENIED');return s;};
 const pending=(s:State):Pending=>s.pending?.runKey===input.runKey&&s.pending.fence===task.lease!.fenceToken?s.pending:{runKey:input.runKey,fence:task.lease!.fenceToken,revision:s.committed.revision,data:s.committed.data,quiet:false,reason:'',visible:false,calls:[]};
 const save=(s:State)=>atomicWriteJson(file,encodeState(s),storedStateSchema,{mode:0o600});
 const locked=<T>(fn:(s:State)=>Promise<T>)=>locks.withLock('state',async()=>{await assertCurrent();await assertDirectories();return fn(await read());});
 const authority:AutomationRunState=Object.freeze({installationId:installation.installationId,userId:session.user.id,projectId:task.projectId,taskId:task.id,runKey:input.runKey,
  get:()=>locked(async s=>{const p=pending(s);return{revision:p.revision,data:structuredClone(p.data),provisional:s.pending?.runKey===input.runKey&&s.pending.fence===task.lease!.fenceToken,taskCreatedAt:task.createdAt,scheduledFor:task.lease!.scheduledFor};}),
  compareAndSet:(expectedRevision:number,value:AutomationStateData,callId:string)=>locked(async s=>{
   if(s.committed.runKey===input.runKey)throw Error("AUTOMATION_STATE_RUN_FINALIZED");
   const data=dataValue(value),p=pending(s);if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||typeof callId!=='string'||!callId||callId.length>256)throw Error('AUTOMATION_STATE_ARGUMENTS_INVALID');
   const digest=hash(JSON.stringify({expectedRevision,data})),old=p.calls.find(c=>c.id===callId);
   if(old){if(old.hash!==digest)throw Error('AUTOMATION_STATE_CALL_CONFLICT');return{revision:old.revision,provisional:true as const,replayed:true};}
   // Reader phase: only replay existing large calls; new CAS payloads retain the legacy write ceiling.
   if(Buffer.byteLength(JSON.stringify(data))>MAX_STORED_DATA_BYTES)throw Error('AUTOMATION_STATE_TOO_LARGE');
   if(p.revision!==expectedRevision)throw Error('AUTOMATION_STATE_REVISION_CONFLICT');if(p.calls.length>=64)throw Error('AUTOMATION_STATE_WRITE_LIMIT');
   p.revision+=1;p.data=data;p.calls.push({id:callId,hash:digest,revision:p.revision});s.pending=p;await save(s);return{revision:p.revision,provisional:true as const,replayed:false};
  }),
  finishQuiet:(reason:string)=>locked(async s=>{if(s.committed.runKey===input.runKey)throw Error('AUTOMATION_STATE_RUN_FINALIZED');if(typeof reason!=='string'||!reason.trim()||reason.length>500)throw Error('AUTOMATION_STATE_QUIET_REASON_REQUIRED');const p=pending(s);p.quiet=true;p.reason=reason.trim();s.pending=p;await save(s);return{quiet:!p.visible};}),
  // Server-only read: tool projections or model text cannot authorize an empty
  // terminal. Recovery may inspect an earlier fence only after terminal proof.
  quietResult:(options:{recoverPrepared?:boolean}={})=>locked(async s=>{
   const p=s.pending;
   if(!p||p.runKey!==input.runKey||p.fence!==task.lease!.fenceToken&&options.recoverPrepared!==true||!p.quiet||p.visible||!p.reason.trim())return null;
   return{reason:p.reason};
  }),
  requireVisible:(reason:string)=>locked(async s=>{if(s.committed.runKey===input.runKey)throw Error('AUTOMATION_STATE_RUN_FINALIZED');const p=pending(s);p.visible=true;p.reason=String(reason).slice(0,500);s.pending=p;await save(s);}),
  finalize:(resultHash:string,options:{recoverPrepared?:boolean}={})=>locked(async s=>{
   if(!/^[a-f0-9]{64}$/.test(resultHash))throw Error('AUTOMATION_STATE_RESULT_INVALID');
   const outcomeName=`outcome-${hash(input.runKey)}.json`,threadId=resultThreadId;
   let prior:AutomationStateOutcome|undefined;try{prior=outcomeSchema.parse(JSON.parse((await readRegularFileWithin(root,outcomeName,8192)).toString('utf8')));}catch(e){if(!e||typeof e!=='object'||!('code'in e)||e.code!=='ENOENT')throw e;}
   if(prior){if(prior.taskId!==task.id||prior.installationId!==installation.installationId||prior.userId!==session.user.id||prior.runKey!==input.runKey||prior.threadId!==threadId||prior.resultHash!==resultHash)throw Error('AUTOMATION_STATE_RESULT_CONFLICT');return prior;}
   if(s.committed.runKey===input.runKey&&s.committed.resultHash!==resultHash)throw Error('AUTOMATION_STATE_RESULT_CONFLICT');
   const p=s.pending?.runKey===input.runKey&&(s.pending.fence===task.lease!.fenceToken||options.recoverPrepared===true)?s.pending:null;
   const quiet=s.committed.runKey===input.runKey?s.committed.quiet:Boolean(p?.quiet&&!p.visible);
   const revision=p?.revision??s.committed.revision;
   const outcome:AutomationStateOutcome={schemaVersion:1,installationId:installation.installationId,userId:session.user.id,taskId:task.id,runKey:input.runKey,threadId,resultHash,revision,quiet,reason:p?.reason??''};
   if(s.committed.runKey!==input.runKey){s.committed={revision,data:p?.data??s.committed.data,runKey:input.runKey,resultHash,quiet};s.pending=null;await save(s);}
   await atomicWriteJson(path.join(root,outcomeName),outcome,outcomeSchema,{mode:0o600});return outcome;
  }),
 });
 issued.add(authority);return authority;
}
