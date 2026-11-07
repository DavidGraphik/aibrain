#!/usr/bin/env node
// Draft creation only. Dispatch is handled by the authenticated mail action API.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {outlookConfig} from '../lib/config.mjs';
import {OutlookStore} from '../lib/store.mjs';
import {ImapSmtpClient} from '../lib/imap-smtp-client.mjs';
import {decryptToken} from '../lib/token-crypto.mjs';
import {resolveMailLocator} from '../lib/mail-reference.mjs';
import {fetchReadOnlyMail} from '../lib/mail-read-recovery.mjs';
import {MailApi} from '../lib/mail-api.mjs';
import {freezeComposedDraft,draftReview,resolveDraftMessage} from '../lib/frozen-draft.mjs';
import {applyMailSignature} from '../lib/mail-signature.mjs';
const args=process.argv.slice(2);const get=k=>args[args.indexOf(k)+1];
const c=outlookConfig();const s=new OutlookStore(join(c.dataDirectory,'outlook.sqlite'));
try{
 if(!args.includes('--input')||!args.includes('--output'))throw Error('--input and --output required');
 const original=JSON.parse(await readFile(get('--input'),'utf8'));
 if(original.type!=='create_draft')throw Error('This command only creates drafts; it never sends');
 const account=c.mailboxes.find(m=>m.address===original.mailbox);
 if(!account||account.name.toLowerCase()!==String(original.requestedBy).toLowerCase())throw Error('Draft owner must match mailbox');
 const action=await freezeComposedDraft(original,get('--output'),async action=>{
  const message=action.request?.message;if(!message?.body)throw Error('Draft body required');
  if(action.request.sourceMessageId){const imap=new ImapSmtpClient(c,s);const cr=imap.requiredCredential(action.mailbox);const locator=await resolveMailLocator({id:action.request.sourceMessageId,mailbox:action.mailbox,proposalDirectory:process.env.TRINALUM_MAIL_PROPOSAL_DIR?.trim()||'/opt/trinalum/data/notifications/mail-proposals',deltaDirectory:join(c.dataDirectory,'delta')});const {parsed:source}=await fetchReadOnlyMail(imap,action.mailbox,decryptToken(cr.password_encrypted,c.tokenEncryptionKey),locator);message.attachments=[...(source.attachments??[]).map(x=>({name:x.filename,contentType:x.contentType,contentId:x.contentId??x.cid,contentBytes:x.content.toString('base64')})),...(message.attachments??[])];}
  await resolveDraftMessage(action,new MailApi({config:c,store:s,client:new ImapSmtpClient(c,s),signatureProvider:null}));
  const signatures=JSON.parse(await readFile(c.signaturesFile??join(c.dataDirectory,'email-signatures.json'),'utf8'));
  applyMailSignature(action.request.message,signatures[action.mailbox]);
  return action;
 });
 const cli=fileURLToPath(new URL('./mail-action.mjs',import.meta.url));
 const commands=[['prepare','--input',get('--output')],...(args.includes('--save')?[['execute','--action-id',action.id,'--approved-by',account.name,'--confirmed-exact-action']]:[])];
 for(const cmd of commands){
   const r=spawnSync(process.execPath,[cli,...cmd],{encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024});if(r.status!==0)throw Error(r.stderr||r.stdout);if(args.includes('--save'))console.log(r.stdout.trim());
 }
 if(!args.includes('--save'))console.log(JSON.stringify({status:'prepared',action:draftReview(action)}));
}catch(e){console.error(JSON.stringify({status:'error',message:e.message}));process.exitCode=1;}finally{s.close();}
