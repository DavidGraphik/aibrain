import {constants} from 'node:fs';
import {lstat,realpath,mkdir,open,rename,unlink,readdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export const RECOVERY_CURSOR_TTL_MS=24*60*60*1000;
const HASH=/^[a-f0-9]{64}$/;
const invalid=()=>{throw Object.assign(Error('Unsafe original recovery cursor'),{code:'MESSAGE_RECOVERY_LIMIT'});};
async function pidStart(pid){try{const s=await readFile('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).split(' ')[19];}catch{return null;}}
export const recoveryHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Position metadata only; all provider bytes still require exact owned identity. */
export class MailRecoveryCursor{
 constructor(dataRoot,{now=Date.now}={}){this.dataRoot=resolve(dataRoot);this.root=join(this.dataRoot,'original-recovery');this.now=now;}
 async directory(){
  const p=await lstat(this.dataRoot);if(!p.isDirectory()||p.isSymbolicLink()||await realpath(this.dataRoot)!==this.dataRoot||(p.mode&0o077))invalid();
  let created=false;try{await mkdir(this.root,{mode:0o700});created=true;}catch(e){if(e.code!=='EEXIST')throw e;}
  let s=await lstat(this.root);const rootCreated=created&&process.getuid()===0&&s.uid===0;
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==p.uid&&!rootCreated||(s.mode&0o077)||await realpath(this.root)!==this.root)invalid();
  if(s.uid!==p.uid||s.gid!==p.gid){
   if(![0,p.uid].includes(process.getuid()))invalid();
   const handle=await open(this.root,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);
   try{const named=await handle.stat();if(named.ino!==s.ino||named.dev!==s.dev)invalid();await handle.chown(p.uid,p.gid);}finally{await handle.close();}
   const after=await lstat(this.root);if(after.ino!==s.ino||after.dev!==s.dev)invalid();s=after;
  }
  if(s.uid!==p.uid||s.gid!==p.gid||(s.mode&0o077))invalid();this.owner={uid:p.uid,gid:p.gid};
 }
 key(scope){if(typeof scope?.mailbox!=='string'||scope.mailbox.length>320||/[\r\n\0]/.test(scope.mailbox)||!['actorHash','sourceHash','generation','foldersHash'].every(k=>HASH.test(scope[k]))||!Number.isSafeInteger(scope.folderCount)||scope.folderCount<1||scope.folderCount>2048)invalid();return recoveryHash(scope);}
 async json(file,scope){
  const h=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const s=await h.stat();if(!s.isFile()||s.nlink!==1||s.uid!==this.owner.uid||(s.mode&0o077)||s.size>8192)invalid();
   const b=await h.readFile(),after=await h.stat();if(b.length!==s.size||s.ino!==after.ino||s.dev!==after.dev||s.size!==after.size||s.mtimeMs!==after.mtimeMs||s.ctimeMs!==after.ctimeMs||s.uid!==after.uid||s.gid!==after.gid||s.mode!==after.mode||after.nlink!==1)invalid();const value=JSON.parse(b);
   if(s.gid!==this.owner.gid){
    // Older broker children inherited a supplementary service group as their
    // primary GID. Repair only this private owned inode after its exact current
    // owner/source/generation scope is verified; never scan/repair foreign keys.
    const key=scope&&this.key(scope);
    if(!key||file!==join(this.root,key+'.json')||!this.valid(value,key,scope)||(s.mode&0o777)!==0o600||![0,this.owner.uid].includes(process.getuid()))invalid();
    const named=await lstat(file);if(named.ino!==s.ino||named.dev!==s.dev||named.nlink!==1||named.ctimeMs!==s.ctimeMs)invalid();
    await h.chown(this.owner.uid,this.owner.gid);
    const normalized=await h.stat(),current=await lstat(file);
    if(normalized.uid!==this.owner.uid||normalized.gid!==this.owner.gid||normalized.mode!==s.mode||normalized.size!==s.size||normalized.mtimeMs!==s.mtimeMs||normalized.nlink!==1||current.ino!==s.ino||current.dev!==s.dev)invalid();
   }
   return value;
  }finally{await h.close();}
 }
 valid(value,key,scope){return value?.schemaVersion===1&&value.key===key&&JSON.stringify(value.scope)===JSON.stringify(scope)&&Number.isSafeInteger(value.createdAt)&&value.createdAt<=this.now()&&value.expiresAt===value.createdAt+RECOVERY_CURSOR_TTL_MS&&Number.isSafeInteger(value.nextIndex)&&value.nextIndex>=0&&value.nextIndex<=scope.folderCount&&Number.isSafeInteger(value.candidates)&&value.candidates>=0&&value.candidates<=20;}
 async load(scope){await this.directory();const key=this.key(scope);let v;try{v=await this.json(join(this.root,key+'.json'),scope);}catch(e){if(e.code==='ENOENT')return null;throw e;}if(!this.valid(v,key,scope))invalid();return this.now()<v.expiresAt?v:null;}
 async save(scope,{nextIndex,candidates=0}){
  await this.directory();const key=this.key(scope),file=join(this.root,key+'.json'),lock=join(this.root,key+'.lock');let handle;
  try{handle=await open(lock,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(e){
   if(e.code!=='EEXIST')throw e;
   const s=await lstat(lock);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||![0,this.owner.uid].includes(s.uid)||(s.mode&0o077)||s.size>256)invalid();
   let owner;try{owner=JSON.parse(await readFile(lock,'utf8'));}catch{if(this.now()-s.mtimeMs<120000)return false;}
   let alive=false;
   if(Number.isSafeInteger(owner?.pid)&&owner.pid>1){try{process.kill(owner.pid,0);alive=!owner.start||owner.start===await pidStart(owner.pid);}catch(error){if(error.code!=='ESRCH')alive=true;}}
   if(alive)return false;
   const current=await lstat(lock);if(current.ino!==s.ino||current.dev!==s.dev)return false;await unlink(lock);
   try{handle=await open(lock,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(error){if(error.code==='EEXIST')return false;throw error;}
  }
  try{
   await handle.chown(this.owner.uid,this.owner.gid);
   await handle.writeFile(JSON.stringify({pid:process.pid,start:await pidStart(process.pid)}));
   let old;try{old=await this.json(file,scope);}catch(e){if(e.code!=='ENOENT')throw e;}
   if(old&&!this.valid(old,key,scope))invalid();
   const current=old&&this.now()<old.expiresAt?old:null;
   const value={schemaVersion:1,key,scope,createdAt:current?.createdAt??this.now(),expiresAt:current?.expiresAt??this.now()+RECOVERY_CURSOR_TTL_MS,nextIndex,candidates};
   if(!this.valid(value,key,scope))invalid();
   // Concurrent reads may revisit a folder, but cannot move durable progress
   // backwards. A found folder is retained so later reads can locate it quickly.
   if(current&&nextIndex<current.nextIndex)return false;
   if(!old){
    const names=(await readdir(this.root)).filter(x=>/^[a-f0-9]{64}\.json$/.test(x));
    if(names.length>=128){for(const name of names){const p=join(this.root,name),entry=await this.json(p);if(entry?.schemaVersion===1&&HASH.test(entry.key)&&name===entry.key+'.json'&&Number.isSafeInteger(entry.expiresAt)&&entry.expiresAt<this.now())await unlink(p);}if((await readdir(this.root)).filter(x=>/^[a-f0-9]{64}\.json$/.test(x)).length>=128)invalid();}
   }
   const temp=join(this.root,'.'+key+'.'+randomUUID()+'.tmp');let output;
   try{output=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await output.chown(this.owner.uid,this.owner.gid);await output.writeFile(JSON.stringify(value));await output.sync();await output.close();output=null;await rename(temp,file);}finally{await output?.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
   return true;
  }finally{await handle.close();await unlink(lock);}
 }
 async clear(scope){await this.directory();const key=this.key(scope),file=join(this.root,key+'.json');try{const v=await this.json(file,scope);if(!this.valid(v,key,scope))invalid();await unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}}
}

/** Caller already authenticated to this mailbox. Never stores password/token. */
export async function recoveryCursorFor(imap,mailbox,locator){
 if(!imap.config?.dataDirectory||!imap.store?.getImapState||typeof imap.requiredCredential!=='function')return null;
 const account=imap.config.mailboxes?.find(x=>x.address===mailbox);if(!account)invalid();const credential=imap.requiredCredential(mailbox);if(credential.mailbox!==mailbox)invalid();
 const uid=(folder)=>imap.store.getImapState(mailbox,folder)?.uid_validity??null;
 return {store:new MailRecoveryCursor(imap.config.dataDirectory),mailbox,actorHash:recoveryHash({mailbox,owner:credential.owner,account:account.name}),sourceHash:recoveryHash({reference:locator.messageId,snapshot:locator.snapshot}),generation:recoveryHash({mailbox,folderMap:credential.folders_json,Inbox:uid('Inbox'),SentItems:uid('SentItems')})};
}
