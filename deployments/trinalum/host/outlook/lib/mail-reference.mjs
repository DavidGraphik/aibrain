import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');

// The source filename is derived from the authenticated owner BEFORE opening
// any snapshot. This locator is source identity, never authority to send/write.
export function ownedMailSnapshotReference({mailbox,folder,uidValidity,uid}){
 const scope={owner:hash(mailbox),folder,uidValidity:String(uidValidity),uid:Number(uid)};
 const id='imap:snapshot-v2:'+Buffer.from(JSON.stringify(scope)).toString('base64url');
 decodeOwnedMailSnapshotReference(id,mailbox);return id;
}
export function decodeOwnedMailSnapshotReference(id,mailbox){
 if(typeof id!=='string'||!id.startsWith('imap:snapshot-v2:')||id.length>1024)throw Error('Invalid owned mail snapshot reference');
 const encoded=id.slice('imap:snapshot-v2:'.length);
 if(!/^[A-Za-z0-9_-]+$/.test(encoded))throw Error('Invalid owned mail snapshot reference');
 const bytes=Buffer.from(encoded,'base64url');if(bytes.toString('base64url')!==encoded)throw Error('Invalid owned mail snapshot reference');
 let scope;try{scope=JSON.parse(bytes);}catch{throw Error('Invalid owned mail snapshot reference');}
 if(!scope||Object.keys(scope).sort().join(',')!=='folder,owner,uid,uidValidity'||scope.owner!==hash(mailbox)||!['Inbox','SentItems'].includes(scope.folder)||!/^\d+$/.test(scope.uidValidity??'')||!Number.isSafeInteger(scope.uid)||scope.uid<1)throw Error('Source mailbox or snapshot scope mismatch');
 return {...scope,snapshotId:hash(`${mailbox}:${scope.folder}:${scope.uidValidity}:${scope.uid}`)};
}

// An opaque public read locator is not an authentication token. The snapshot
// still has to belong to the selected mailbox when resolved.
export function mailSnapshotReference(snapshotId){
 if(typeof snapshotId!=='string'||! /^[a-f0-9]{64}$/.test(snapshotId))return null;
 return 'mail-snapshot:'+Buffer.from(snapshotId,'hex').toString('base64url');
}

async function readJson(file){
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await handle.stat();if(!s.isFile()||s.size>2*1024*1024)throw Error('Invalid mail reference source');return JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
}

/** A Telegram proposal is a locator, never permission to another mailbox. */
export async function resolveMailReference({id,mailbox,proposalDirectory,deltaDirectory}){
 return (await resolveMailLocator({id,mailbox,proposalDirectory,deltaDirectory})).messageId;
}

export async function resolveMailLocator({id,mailbox,proposalDirectory,deltaDirectory}){
 let snapshotId=id;
 if(typeof id!=='string'||!id.trim())throw Error('Message ID required');
 let ownedScope;
 if(id.startsWith('imap:snapshot-v2:')){
  ownedScope=decodeOwnedMailSnapshotReference(id,mailbox);snapshotId=ownedScope.snapshotId;
 }else if(id.startsWith('mail-snapshot:')){
  const encoded=id.slice('mail-snapshot:'.length);
  if(!/^[A-Za-z0-9_-]{43}$/.test(encoded))throw Error('Invalid mail snapshot reference');
  const bytes=Buffer.from(encoded,'base64url');
  if(bytes.length!==32||bytes.toString('base64url')!==encoded)throw Error('Invalid mail snapshot reference');
  snapshotId=bytes.toString('hex');
 }
 if(id.startsWith('MAIL-')){
  if(!/^MAIL-[A-F0-9]{10}$/.test(id))throw Error('Invalid mail proposal reference');
  const p=await readJson(join(proposalDirectory,id+'.json'));
  if(p.reference!==id||p.mailbox!==mailbox||typeof p.snapshot_id!=='string'||! /^[a-f0-9]{64}$/.test(p.snapshot_id)||'MAIL-'+p.snapshot_id.slice(0,10).toUpperCase()!==id)throw Error('Source mailbox or proposal reference mismatch');
  snapshotId=p.snapshot_id;
 }
 if(/^[a-f0-9]{64}$/.test(snapshotId)){
  const snap=await readJson(join(deltaDirectory,snapshotId+'.json'));
  if(snap.mailbox!==mailbox||typeof snap.data?.id!=='string'||!snap.data.id.trim())throw Error('Source mailbox mismatch');
  if(ownedScope){
   const [kind,,generation,uid,extra]=snap.data.id.split(':');
   if(kind!=='imap'||extra||snap.folder!==ownedScope.folder||generation!==ownedScope.uidValidity||String(ownedScope.uid)!==uid)throw Error('Owned snapshot generation or source identity mismatch');
  }
  return {messageId:snap.data.id,snapshot:snap.data};
 }
 return {messageId:id,snapshot:null};
}
