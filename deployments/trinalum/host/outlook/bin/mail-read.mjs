#!/usr/bin/env node
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {outlookConfig} from '../lib/config.mjs';
import {OutlookStore} from '../lib/store.mjs';
import {ImapSmtpClient} from '../lib/imap-smtp-client.mjs';
import {decryptToken} from '../lib/token-crypto.mjs';
import {writePrivateAttachment} from '../lib/attachment-cache.mjs';
import {resolveMailLocator} from '../lib/mail-reference.mjs';
import {fetchReadOnlyMail,historicalMailPreview} from '../lib/mail-read-recovery.mjs';
import {pdfTextCoverage} from '../lib/pdf-text-coverage.mjs';
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,x)=>i%2?a:[...a,[v.replace(/^--/,''),x[i+1]]],[]));
const c=outlookConfig();const s=new OutlookStore(join(c.dataDirectory,'outlook.sqlite'));
async function main(){
 const mailbox=args.mailbox?.toLowerCase();if(!c.mailboxes.some(m=>m.address===mailbox))throw Error('Unknown mailbox');
 const locator=await resolveMailLocator({id:args['message-id'],mailbox,proposalDirectory:process.env.TRINALUM_MAIL_PROPOSAL_DIR?.trim()||'/opt/trinalum/data/notifications/mail-proposals',deltaDirectory:join(c.dataDirectory,'delta')});
 const imap=new ImapSmtpClient(c,s);const credential=imap.requiredCredential(mailbox);
 let loaded;
 try{loaded=await fetchReadOnlyMail(imap,mailbox,decryptToken(credential.password_encrypted,c.tokenEncryptionKey),locator);}catch(error){
  const preview=historicalMailPreview(locator,error);if(!preview)throw error;
  console.log(JSON.stringify({mailbox,...preview}));return;
 }
 const {parsed,messageId:id,relocated}=loaded;
 const attachments=[];const dir=join(c.dataDirectory,'attachments');
 for(const item of parsed.attachments??[]){const hash=createHash('sha256').update(mailbox).update(item.content).digest('hex');const isPdf=item.contentType==='application/pdf';const p=await writePrivateAttachment(dir,hash+(isPdf?'.pdf':'.bin'),item.content);let text=null;let warning=null;let coverage={};
 if(isPdf){const result=spawnSync('pdftotext',['-layout',p,'-'],{encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});const info=spawnSync('pdfinfo',[p],{encoding:'utf8',timeout:10000,maxBuffer:64*1024});const count=info.status===0?Number(info.stdout.match(/^Pages:\s+(\d+)\s*$/m)?.[1]):null;coverage=pdfTextCoverage(result.status===0?result.stdout:null,count);if(result.status===0&&result.stdout.trim())text=result.stdout.slice(0,80000);if(!text)warning='PDF requires visual/OCR review; no text extracted';else if(coverage.textCoverage!=='complete')warning='PDF text does not attest every page; visual review required';if(result.stdout?.length>80000){coverage.textCoverage='partial';warning='PDF extracted text truncated; full original review required';}}
 attachments.push({name:item.filename,contentType:item.contentType,size:item.content.length,path:p,sha256:hash,text,warning,...coverage});}
 console.log(JSON.stringify({mailbox,message_id:id,relocated,subject:parsed.subject,from:parsed.from?.value,to:parsed.to?.value,cc:parsed.cc?.value,text:parsed.text?.slice(0,80000),attachments}));
}
try{await main();}catch(e){console.error(JSON.stringify({status:'error',code:e.code??null,message:e.message}));process.exitCode=1;}finally{s.close();}
