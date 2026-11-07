import {constants} from 'node:fs';
import {open,lstat,mkdir,rename,rmdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {assertOperatorAccess,type OperatorActor,type OperatorConfiguration} from './operator-runtime.ts';
import type {TemporaryReviewDocuments} from './outreach-workflow.ts';
const DAY=86400000,MAX_BYTES=32*1024*1024;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const canonicalDate=(value:string)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const safeId=(value:string)=>typeof value==='string'&&/^[-a-zA-Z0-9_:]{1,100}$/.test(value);
type Envelope={schemaVersion:1;installationId:string;actorId:string;key:string;body:string;bodySha256:string;createdAt:string;expiresAt:string};
/** Server-owned private temporary documents. No contact/CRM index or outbound port. */
export class OutreachReviewDocuments implements TemporaryReviewDocuments {
 readonly kind='private-brain-documents' as const;
 private readonly directory:string;
 private readonly actor:OperatorActor;
 private readonly configuration:OperatorConfiguration;
 private readonly now:()=>number;
 constructor(configuration:OperatorConfiguration,actor:OperatorActor,now:()=>number=Date.now){
  assertOperatorAccess(configuration,actor);
  if(!path.isAbsolute(configuration.storageRoot)||path.resolve(configuration.storageRoot)!==configuration.storageRoot||!safeId(actor.actorId))throw Error('PRIVATE_REVIEW_PATH_DENIED');
  this.configuration=structuredClone(configuration);this.actor={...actor};this.now=now;
  this.directory=path.join(configuration.storageRoot,'users',actor.actorId,'insijets-outreach-reviews');
 }
 private async directories(){
  assertOperatorAccess(this.configuration,this.actor);
  const parsed=path.parse(this.directory);let current=parsed.root;
  for(const segment of this.directory.slice(parsed.root.length).split(path.sep)){
   current=path.join(current,segment);let stat;
   try{stat=await lstat(current);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;try{await mkdir(current,{mode:0o700});}catch(failure){if((failure as NodeJS.ErrnoException).code!=='EEXIST')throw failure;}stat=await lstat(current);}
   if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('PRIVATE_REVIEW_PATH_DENIED');
   // Existing general data roots may be shared. The actor-owned review directory is private.
   if(current===this.directory&&(stat.mode&0o077)!==0)throw Error('PRIVATE_REVIEW_PERMISSIONS_DENIED');
  }
 }
 private files(key:string){
  if(typeof key!=='string'||!/^insijets-demo:outreach-(?:review|contact):[-a-zA-Z0-9_:]{1,100}$/.test(key))throw Error('PRIVATE_REVIEW_KEY_DENIED');
  const base=path.join(this.directory,sha(key));return {document:base+'.json',lock:base+'.lock'};
 }
 private async locked<T>(key:string,operation:(file:string)=>Promise<T>){
  await this.directories();const {document,lock}=this.files(key);let acquired=false;
  for(let attempt=0;attempt<100;attempt++){
   try{await mkdir(lock,{mode:0o700});acquired=true;break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;let state;try{state=await lstat(lock);}catch(missing){if((missing as NodeJS.ErrnoException).code==='ENOENT')continue;throw missing;}if(!state.isDirectory()||state.isSymbolicLink())throw Error('PRIVATE_REVIEW_LOCK_DENIED');await new Promise(resolve=>setTimeout(resolve,10));}
  }
  if(!acquired)throw Error('PRIVATE_REVIEW_LOCK_RECONCILIATION_REQUIRED');
  try{return await operation(document);}finally{await rmdir(lock);}
 }
 private async envelope(file:string,key:string):Promise<Envelope|null>{
  let descriptor;
  try{descriptor=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw Error('PRIVATE_REVIEW_DOCUMENT_DENIED');}
  let value:Envelope;
  try{
   const stat=await descriptor.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_BYTES||stat.mode&0o077)throw Error('PRIVATE_REVIEW_DOCUMENT_DENIED');
   const bytes=await descriptor.readFile({encoding:'utf8'});try{value=JSON.parse(bytes) as Envelope;}catch{throw Error('PRIVATE_REVIEW_INTEGRITY_DENIED');}
  }finally{await descriptor.close();}
  if(!value||Object.keys(value).sort().join(',')!==['schemaVersion','installationId','actorId','key','body','bodySha256','createdAt','expiresAt'].sort().join(',')||value.schemaVersion!==1||value.installationId!==this.actor.installationId||value.actorId!==this.actor.actorId||value.key!==key||typeof value.body!=='string'||sha(value.body)!==value.bodySha256||!canonicalDate(value.createdAt)||!canonicalDate(value.expiresAt)||Date.parse(value.expiresAt)<=Date.parse(value.createdAt)||Date.parse(value.expiresAt)-Date.parse(value.createdAt)>7*DAY)throw Error('PRIVATE_REVIEW_INTEGRITY_DENIED');
  if(Date.parse(value.expiresAt)<=this.now())throw Error('PRIVATE_REVIEW_EXPIRED_RECONCILIATION_REQUIRED');
  return value;
 }
 private async persist(file:string,value:Envelope){
  const serialized=JSON.stringify(value);if(Buffer.byteLength(serialized)>MAX_BYTES)throw Error('PRIVATE_REVIEW_SIZE_DENIED');
  const temporary=path.join(this.directory,`.write-${randomUUID()}`);let created=false;
  try{
   const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true;
   try{await handle.writeFile(serialized,'utf8');await handle.sync();}finally{await handle.close();}
   await rename(temporary,file);created=false;
   const directory=await open(this.directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
  }finally{if(created)await unlink(temporary);}
 }
 private expiry(expiresAt:string){
  if(!canonicalDate(expiresAt)||Date.parse(expiresAt)<=this.now()||Date.parse(expiresAt)>this.now()+7*DAY)throw Error('PRIVATE_REVIEW_EXPIRY_DENIED');
 }
 async create(key:string,body:string,expiresAt:string){
  this.expiry(expiresAt);if(typeof body!=='string'||Buffer.byteLength(body)>MAX_BYTES/2)throw Error('PRIVATE_REVIEW_SIZE_DENIED');
  return this.locked(key,async file=>{
   if(await this.envelope(file,key))return false;
   await this.persist(file,{schemaVersion:1,installationId:this.actor.installationId,actorId:this.actor.actorId,key,body,bodySha256:sha(body),createdAt:new Date(this.now()).toISOString(),expiresAt});
   const stored=await this.envelope(file,key);if(stored?.body!==body||stored.expiresAt!==expiresAt)throw Error('PRIVATE_REVIEW_PERSISTED_READBACK_FAILED');return true;
  });
 }
 async read(key:string){return this.locked(key,async file=>{const value=await this.envelope(file,key);return value?{body:value.body,expiresAt:value.expiresAt}:null;});}
 async replace(key:string,expectedBody:string,body:string,expiresAt:string){
  this.expiry(expiresAt);if(typeof body!=='string'||Buffer.byteLength(body)>MAX_BYTES/2)throw Error('PRIVATE_REVIEW_SIZE_DENIED');
  return this.locked(key,async file=>{const old=await this.envelope(file,key);if(!old||old.body!==expectedBody)return false;if(old.expiresAt!==expiresAt)throw Error('PRIVATE_REVIEW_EXPIRY_EXTENSION_DENIED');await this.persist(file,{...old,body,bodySha256:sha(body)});const stored=await this.envelope(file,key);if(stored?.body!==body||stored.expiresAt!==expiresAt)throw Error('PRIVATE_REVIEW_PERSISTED_READBACK_FAILED');return true;});
 }
}
