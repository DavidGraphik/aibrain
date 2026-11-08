import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath,lstat,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail=()=>{throw Object.assign(Error('Prepared draft does not match this exact action'),{code:'FROZEN_DRAFT_MISMATCH'});};
async function existing(file,source,hash){
 let stat;try{stat=await lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.size>22*1024*1024)fail();
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const opened=await handle.stat();if(opened.dev!==stat.dev||opened.ino!==stat.ino)fail();
  const action=JSON.parse(await handle.readFile('utf8'));
  if(action.compositionSourceSha256!==hash||action.id!==source.id||action.type!=='create_draft'||action.mailbox!==source.mailbox||action.requestedBy!==source.requestedBy)fail();
  const {compositionSourceSha256:sourceHash,compositionSha256:composedHash,...composed}=action;
  if(sourceHash!==hash||composedHash!==digest(composed))fail();
  assertResolvedDraftAttachments(action.request?.message);
  return action;
 }finally{await handle.close();}
}
// Prepare once, then execute these exact bytes. Source attachments and the
// signature must not be re-read and changed after the employee's approval.
export async function freezeComposedDraft(source,output,compose){
 if(source.type!=='create_draft'||!isAbsolute(output)||await realpath(dirname(output))!==dirname(output))fail();
 const hash=digest(source);
 const frozen=await existing(output,source,hash);if(frozen)return frozen;
 const action=await compose(JSON.parse(JSON.stringify(source)));
 if(action.id!==source.id||action.type!==source.type||action.mailbox!==source.mailbox||action.requestedBy!==source.requestedBy)fail();
 assertResolvedDraftAttachments(action.request?.message);
 const result={...action,compositionSourceSha256:hash,compositionSha256:digest(action)},bytes=JSON.stringify(result,null,2);
 if(Buffer.byteLength(bytes)>22*1024*1024)fail();
 try{await writeFile(output,bytes,{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;return await existing(output,source,hash);}
 return result;
}
export function draftReview(action){
 const preview=value=>Array.isArray(value)?value.map(preview):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,['contentBytes','content_base64'].includes(k)&&typeof v==='string'?{bytes:Buffer.from(v,'base64').length,sha256:createHash('sha256').update(Buffer.from(v,'base64')).digest('hex')}:preview(v)])):value;
 return {id:action.id,type:action.type,mailbox:action.mailbox,requestedBy:action.requestedBy,request:preview(action.request)};
}

// The legacy editable-draft path must freeze the same verified attachment bytes
// as MailApi, rather than passing mailbox references to the MIME builder.
export async function resolveDraftMessage(action, api) {
 const message=action.request?.message;
 if(!message?.body)throw Error('Draft body required');
 action.request.message=await api.validateMessage(action.mailbox,message);
 assertResolvedDraftAttachments(action.request.message);
 return action;
}

export function assertResolvedDraftAttachments(message) {
 if(message?.attachments===undefined)return;
 if(!Array.isArray(message.attachments))throw Object.assign(Error('Draft attachment bytes required'),{code:'ATTACHMENT_CONTENT_REQUIRED'});
 for(const item of message.attachments){
  const bytes=item?.contentBytes;
  if(item?.sourceMessageId!==undefined||item?.attachmentId!==undefined||typeof bytes!=='string'||!bytes.length||Buffer.from(bytes,'base64').toString('base64')!==bytes)
   throw Object.assign(Error('Draft attachment bytes required'),{code:'ATTACHMENT_CONTENT_REQUIRED'});
 }
}
