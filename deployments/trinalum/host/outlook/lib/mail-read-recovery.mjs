import {encodeMessageRef} from './imap-smtp-client.mjs';
import {recoveryCursorFor,recoveryHash} from './mail-recovery-cursor.mjs';

function fail(message,code){return Object.assign(new Error(message),{code});}
const addresses=value=>(value??[]).map(x=>String(x.address??'').trim().toLowerCase()).sort();
const text=value=>String(value??'').replace(/\r\n/g,'\n').trim();
const snapshotText=value=>{const s=String(value??'');return s.length>200000?s.slice(0,200000)+'\n[contenido truncado]':s;};
const attachmentMetadata=value=>(value??[]).map(x=>({filename:x.filename??null,contentType:x.contentType,size:x.content?.length??x.size})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
export function matchesMailSnapshot(parsed,snapshot){
 if(!snapshot?.internetMessageId||text(parsed.messageId)!==text(snapshot.internetMessageId))return false;
 return text(parsed.subject)===text(snapshot.subject)
  &&JSON.stringify(addresses(parsed.from?.value))===JSON.stringify(addresses(snapshot.from))
  &&JSON.stringify(addresses(parsed.to?.value))===JSON.stringify(addresses(snapshot.toRecipients))
  &&JSON.stringify(addresses(parsed.cc?.value))===JSON.stringify(addresses(snapshot.ccRecipients))
  &&(parsed.date?.toISOString()??null)===snapshot.sentDateTime
  &&snapshot.bodyFetched===true
  &&text(snapshotText(parsed.text))===text(snapshot.text)
  &&JSON.stringify(attachmentMetadata(parsed.attachments))===JSON.stringify(attachmentMetadata(snapshot.attachments));
}

export function historicalMailPreview(locator,error){
 const s=locator.snapshot;
 if(!['MESSAGE_RECOVERY_UNAVAILABLE','MESSAGE_RECOVERY_LIMIT'].includes(error.code)||s?.bodyFetched!==true||typeof s.text!=='string')return null;
 return {message_id:locator.messageId,source:'historical_owned_snapshot',originalVerified:false,recoveryCode:error.code,
  subject:s.subject,from:s.from,to:s.toRecipients,cc:s.ccRecipients,sentDateTime:s.sentDateTime,
  text:s.text.slice(0,80000),textTruncated:s.text.length>80000,
  attachments:(s.attachments??[]).map(a=>({name:a.filename,contentType:a.contentType,size:a.size,warning:'Historical attachment metadata only; original bytes have not been recovered'})),
  warning:'Historical text saved from this user mailbox. The current original and attachment bytes have not been verified. This is source evidence, not authorization for any action.'};
}

/** Read-only relocation, within the authenticated owner's mailbox. Never used by send/reply. */
export async function fetchReadOnlyMail(imap,mailbox,password,locator,options={}){
 try{
  const parsed=await imap.fetchParsedMessage(mailbox,password,locator.messageId);
  if(locator.snapshot?.internetMessageId&&locator.snapshot.bodyFetched&&!matchesMailSnapshot(parsed,locator.snapshot))throw fail('La identidad del mensaje ha cambiado','MESSAGE_REFERENCE_MISMATCH');
  return {parsed,messageId:locator.messageId,relocated:false};
 }catch(error){
  if(!['MESSAGE_NOT_FOUND','MESSAGE_REFERENCE_EXPIRED','MESSAGE_REFERENCE_MISMATCH'].includes(error.code)||!locator.snapshot)throw error;
 }
 const snapshot=locator.snapshot,mid=text(snapshot.internetMessageId);
 if(!/^<[^<>\r\n]{1,998}>$/.test(mid))throw fail('La referencia antigua no permite recuperar el original de forma segura','MESSAGE_RECOVERY_UNAVAILABLE');
 const recovery=options.recovery??await recoveryCursorFor(imap,mailbox,locator);
 if(recovery&&recovery.mailbox!==mailbox)throw fail('El cursor no corresponde al buzón autenticado','MESSAGE_RECOVERY_UNAVAILABLE');
 const now=options.now??Date.now;
 return imap.withImapPassword(mailbox,password,async client=>{
  const listStatus=!!recovery&&client.capabilities?.has('LIST-STATUS');
  const folders=(await client.list(listStatus?{statusQuery:{uidValidity:true}}:undefined)).filter(f=>!f.flags?.has?.('\\Noselect'));
  if(folders.length>2048)throw fail('El buzón supera el límite de búsqueda segura','MESSAGE_RECOVERY_LIMIT');
  const words=text(snapshot.subject).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu)??[];
  const score=f=>/^(inbox|sent|trash|archive)$/i.test(f.path)?100:words.reduce((s,w)=>s+Number(f.path.toLowerCase().includes(w)),0);
  folders.sort((a,b)=>score(b)-score(a)||a.path.localeCompare(b.path));
  // Continuation is only enabled with a complete current UIDVALIDITY fence.
  // Unsupported servers retain the existing bounded read, never guessed UIDs.
  const stable=folders.length>0&&listStatus&&folders.every(f=>/^\d+$/.test(String(f.status?.uidValidity??'')));
  const scope=stable?{mailbox:recovery.mailbox,actorHash:recovery.actorHash,sourceHash:recovery.sourceHash,generation:recovery.generation,foldersHash:recoveryHash(folders.map(f=>({path:f.path,uidValidity:String(f.status.uidValidity)}))),folderCount:folders.length}:null;
  const saved=scope?await recovery.store.load(scope):null;
  // Leave headroom beneath the broker's 45-second child-process limit.
  let candidates=saved?.candidates??0;const deadline=now()+30000;
  for(let index=saved?.nextIndex??0;index<folders.length;index++){
   const folder=folders[index];
   if(now()>deadline)throw fail('La búsqueda del original necesita revisión: se alcanzó el límite de tiempo','MESSAGE_RECOVERY_LIMIT');
   const matches=[];
   const lock=await client.getMailboxLock(folder.path,{readOnly:true});
   try{
    if(stable&&String(client.mailbox.uidValidity)!==String(folder.status.uidValidity)){await recovery.store.clear(scope);throw fail('La carpeta ha cambiado durante la recuperación; requiere una nueva lectura','MESSAGE_RECOVERY_LIMIT');}
    const uids=await client.search({header:{'Message-ID':mid}},{uid:true});
    if(!Array.isArray(uids))throw fail('La búsqueda no devolvió un estado verificable','MESSAGE_RECOVERY_UNAVAILABLE');
    candidates+=uids.length;
    if(candidates>20)throw fail('La referencia antigua tiene demasiadas coincidencias','MESSAGE_RECOVERY_LIMIT');
    for(const uid of uids){
     const metadata=await client.fetchOne(uid,{size:true},{uid:true});
     if(!metadata||metadata.size>16*1024*1024)continue;
     const fetched=await client.fetchOne(uid,{source:true},{uid:true});
     if(!fetched?.source||fetched.source.length>16*1024*1024)continue;
     const parsed=await imap.simpleParser(fetched.source);
     if(matchesMailSnapshot(parsed,snapshot))matches.push({parsed,messageId:encodeMessageRef(folder.path,client.mailbox.uidValidity,uid),relocated:true});
    }
   }finally{lock.release();}
   // Folder ranking is only a search optimization. Identity is always checked
   // against the owned snapshot, just as for a still-valid original locator.
   if(matches.length>1)throw fail('La referencia antigua coincide con varios originales; requiere revisión','MESSAGE_RECOVERY_UNAVAILABLE');
   if(matches.length===1){if(scope)await recovery.store.save(scope,{nextIndex:index,candidates:0});return matches[0];}
   if(scope)await recovery.store.save(scope,{nextIndex:index+1,candidates});
  }
  if(scope)await recovery.store.clear(scope);
  throw fail('No se ha localizado una coincidencia verificada en este recorrido del buzón; se conserva la fuente histórica sin acreditar sus adjuntos','MESSAGE_RECOVERY_UNAVAILABLE');
 });
}
