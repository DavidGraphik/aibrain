import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MailApi,mailApiContract} from '../lib/mail-api.mjs';
import {encryptToken} from '../lib/token-crypto.mjs';
import {ownedMailSnapshotReference} from '../lib/mail-reference.mjs';
const mailbox='owner@example.test',other='other@example.test',key='11'.repeat(32);
const ref=(uid=42,generation=9)=>`imap:${Buffer.from('Archive').toString('base64url')}:${generation}:${uid}`;
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const attachments=[{filename:'actual.tmp',contentType:'application/octet-stream',content:Buffer.from('\xef\xbb\xbf \n%PDF-1.7\noriginal one','latin1')},{filename:'second.pdf',contentType:'application/pdf',content:Buffer.from('%PDF-2.0\noriginal two')},{filename:'logo.png',contentType:'image/png',contentDisposition:'inline',content:Buffer.from([137,80,78,71,0,10])}];
 const source=Buffer.from('From: sender@example.test\r\nTo: owner@example.test\r\nMessage-ID: <own@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="original-boundary"\r\n\r\n'+attachments.map(a=>'--original-boundary\r\nContent-Type: '+a.contentType+'\r\nContent-Disposition: '+(a.contentDisposition??'attachment')+'; filename="'+a.filename+'"\r\nContent-Transfer-Encoding: base64\r\n\r\n'+a.content.toString('base64')+'\r\n').join('')+'--original-boundary--\r\n');
 const parsed={messageId:'<own@example.test>',subject:'Original source',date:new Date('2026-01-01T00:00:00Z'),from:{value:[{address:'sender@example.test'}]},to:{value:[{address:mailbox}]},text:'Original message body',attachments};
 const calls=[],locks=[];let parses=0,connections=0;
 const imap={mailbox:{uidValidity:9},async getMailboxLock(path,options){assert.equal(path,'Archive');assert.equal(options.readOnly,true);locks.push('lock');return {release(){locks.push('release');}};},async fetchOne(uid,q,o){calls.push({uid,q,o});assert.equal(uid,42);assert.equal(o.uid,true);return q.source?{uid,source}:{uid,size:source.length,envelope:{messageId:parsed.messageId},flags:new Set(),internalDate:new Date('2026-01-01T00:00:02Z'),...(q.bodyStructure?{bodyStructure:{type:'multipart/mixed',childNodes:attachments.map(a=>({type:a.contentType,disposition:a.contentDisposition??'attachment',parameters:{name:a.filename}}))}}:{})};}};
 const client={requiredCredential(owner){assert.equal(owner,mailbox);return {password_encrypted:encryptToken('password',key)};},async withImapPassword(owner,password,callback){connections++;assert.equal(owner,mailbox);assert.equal(password,'password');return callback(imap);},async simpleParser(raw){parses++;assert.deepEqual(raw,source);return parsed;}};
 const api=new MailApi({config:{mailboxes:[{address:mailbox,name:'Owner'},{address:other,name:'Other'}],dataDirectory:'/nonexistent-own-store',tokenEncryptionKey:key},client,signatureProvider:null});
 return {api,imap,client,parsed,source,calls,locks,get parses(){return parses;},get connections(){return connections;}};
}

test('one owner-bound MIME source load and parse exports exact EML and every non-inline attachment',async()=>{
 const f=fixture(),r=await f.api.read(mailbox,{operation:'bundle',messageId:ref()});
 assert.equal(f.connections,1);assert.equal(f.parses,1);assert.equal(f.calls.filter(x=>x.q.source).length,1);assert.equal(f.calls.length,2); // Keep size/inventory preflight before source download.
 assert.deepEqual(f.locks,['lock','release']);assert.deepEqual(r.files.map(x=>x.filename),['message.eml','actual.tmp','second.pdf']);
 assert.equal(r.bundle.complete,true);assert.equal(r.bundle.inventoryVerified,true);assert.equal(r.bundle.contentAnalyzed,false);assert.equal(r.bundle.selection,'all_non_inline');assert.equal(r.bundle.attachmentCount,3);
 assert.equal(r.receivedDate,'2026-01-01T00:00:02.000Z');assert.equal(r.internetMessageId,'<own@example.test>');assert.equal(r.text,'Original message body');
 for(const [i,file]of r.files.entries()){
  const bytes=i?f.parsed.attachments[i-1].content:f.source;assert.deepEqual(Buffer.from(file.content_base64,'base64'),bytes);assert.equal(file.sha256,hash(bytes));assert.equal(file.bytes,bytes.length);assert.equal(file.messageId,ref());assert.equal(file.mailbox,mailbox);assert.equal(file.originalVerified,true);assert.equal('reading'in file,false);
 }
 assert.ok(r.files[1].pdfHeaderPresent);assert.ok(r.files[2].pdfHeaderPresent);assert.deepEqual(r.bundle.omittedAttachmentIds,[{id:r.attachments[2].id,reason:'inline_not_requested'}]);
 assert.equal(r.bundle.totalBytes,r.files.reduce((n,f)=>n+f.bytes,0));assert.equal(r.bundle.originalSha256,r.files[0].sha256);assert.ok(!JSON.stringify(r).includes('"path"'));
});

test('bundle bytes and hashes equal the existing individual original/attachment export contracts',async()=>{
 const f=fixture(),bundle=await f.api.read(mailbox,{operation:'bundle',messageId:ref(),includeInline:true});
 assert.equal(bundle.files.length,4);assert.equal(bundle.bundle.selection,'all');assert.deepEqual(bundle.bundle.omittedAttachmentIds,[]);
 const original=await f.api.read(mailbox,{operation:'original',messageId:ref()});assert.deepEqual(bundle.files[0],original);
 for(const a of bundle.attachments){const single=await f.api.read(mailbox,{operation:'attachment',messageId:ref(),attachmentId:a.id});assert.deepEqual(bundle.files.find(x=>x.attachmentId===a.id),single);}
});

test('explicit selections preserve order, allow requested inline and list all intentional omissions',async()=>{
 const f=fixture(),read=await f.api.read(mailbox,{operation:'read',messageId:ref()}),ids=[read.attachments[2].id,read.attachments[0].id];
 const result=await f.api.read(mailbox,{operation:'bundle',messageId:ref(),attachmentIds:ids});assert.deepEqual(result.files.slice(1).map(x=>x.attachmentId),ids);assert.equal(result.files[1].isInline,true);assert.deepEqual(result.bundle.omittedAttachmentIds,[{id:read.attachments[1].id,reason:'not_requested'}]);
});

test('missing or duplicate selections fail without any successful partial bundle',async()=>{
 const f=fixture(),id='a0-'+'0'.repeat(24);
 for(const input of [{attachmentIds:[]},{attachmentIds:[id,id]},{attachmentIds:[id],includeInline:false},{includeInline:'true'},{attachmentIds:['filename.pdf']},{unexpected:true}])await assert.rejects(f.api.read(mailbox,{operation:'bundle',messageId:ref(),...input}));
 assert.equal(f.connections,0);await assert.rejects(f.api.read(mailbox,{operation:'bundle',messageId:ref(),attachmentIds:[id]}),e=>e.code==='ATTACHMENT_NOT_FOUND');
});

test('declared PDF without a PDF header remains exact malformed source bytes, never decoded or omitted',async()=>{
 const f=fixture();f.parsed.attachments[1].content=Buffer.from(Buffer.from('<html>not PDF</html>').toString('base64'));
 const r=await f.api.read(mailbox,{operation:'bundle',messageId:ref()});assert.equal(r.files.length,3);assert.equal(r.files[2].pdfHeaderPresent,false);assert.deepEqual(Buffer.from(r.files[2].content_base64,'base64'),f.parsed.attachments[1].content);assert.equal(r.bundle.contentAnalyzed,false);
});

test('invalid or omitted parsed MIME attachments and truncated provider inventory fail closed',async()=>{
 for(const mode of ['missing','truncated','count','bytes','parse']){
  const f=fixture(),fetch=f.imap.fetchOne.bind(f.imap);f.imap.fetchOne=async(uid,q,o)=>{const v=await fetch(uid,q,o);if(q.bodyStructure){if(mode==='missing')delete v.bodyStructure;if(mode==='truncated')v.bodyStructure={type:'multipart/mixed',childNodes:Array.from({length:101},()=>({type:'image/png',parameters:{name:'x'}}))};if(mode==='count')v.bodyStructure.childNodes.push({type:'application/pdf'});}return v;};
  if(mode==='bytes')f.parsed.attachments[1].content='not Buffer';if(mode==='parse')f.client.simpleParser=async()=>{throw Object.assign(Error('Invalid MIME parser source'),{code:'PARSER_FAILED'});};
  await assert.rejects(f.api.read(mailbox,{operation:'bundle',messageId:ref()}),e=>['MAIL_BUNDLE_MIME_INVALID','PARSER_FAILED'].includes(e.code));assert.deepEqual(f.locks,['lock','release']);
 }
});

test('aggregate original plus selected bytes is bounded; no truncation or silent files limit',async()=>{
 const f=fixture();f.parsed.attachments[0].content=Buffer.alloc(30*1024*1024);await assert.rejects(f.api.read(mailbox,{operation:'bundle',messageId:ref()}),e=>e.code==='MAIL_BUNDLE_TOO_LARGE');
 const count=fixture();count.parsed.attachments.splice(0,3,...Array.from({length:101},(_,i)=>({filename:`${i}.txt`,contentType:'text/plain',content:Buffer.from('x')})));await assert.rejects(count.api.read(mailbox,{operation:'bundle',messageId:ref()}),e=>e.code==='MAIL_BUNDLE_TOO_LARGE');
});

test('message size preflight rejects an oversized original before fetching its bytes',async()=>{
 const f=fixture(),fetch=f.imap.fetchOne.bind(f.imap);f.imap.fetchOne=async(uid,q,o)=>({...await fetch(uid,q,o),size:30*1024*1024+1});await assert.rejects(f.api.read(mailbox,{operation:'bundle',messageId:ref()}),e=>e.code==='MAIL_MESSAGE_TOO_LARGE');assert.equal(f.calls.filter(x=>x.q.source).length,0);assert.equal(f.parses,0);
});

test('UID reuse/generation changes, byte count and header identity cannot export a different message',async()=>{
 for(const mode of ['uid','generation','size','header']){
  const f=fixture(),fetch=f.imap.fetchOne.bind(f.imap);f.imap.fetchOne=async(uid,q,o)=>{const v=await fetch(uid,q,o);if(mode==='header'&&q.envelope)v.envelope.messageId='<different@example.test>';if(q.source){if(mode==='uid')v.uid=43;if(mode==='generation')f.imap.mailbox.uidValidity=10;if(mode==='size')v.source=Buffer.concat([v.source,Buffer.from('different')]);}return v;};
  await assert.rejects(f.api.read(mailbox,{operation:'bundle',messageId:ref()}),e=>['MESSAGE_REFERENCE_MISMATCH','MAIL_BUNDLE_MIME_INVALID'].includes(e.code));
 }
});

test('foreign owner-bound snapshot is rejected before source filesystem/provider access',async()=>{
 const f=fixture(),foreign=ownedMailSnapshotReference({mailbox:other,folder:'Inbox',uidValidity:9,uid:42});
 await assert.rejects(f.api.read(mailbox,{operation:'bundle',messageId:foreign}),/mailbox or snapshot scope mismatch/);assert.equal(f.connections,0);assert.equal(f.calls.length,0);
 await assert.rejects(f.api.read('foreign@example.test',{operation:'bundle',messageId:ref()}),e=>e.code==='MAILBOX_NOT_ALLOWED');assert.equal(f.connections,0);
});

test('bundle discovery is credential/dependency-free and declares exact limits/selection',()=>{
 const c=mailApiContract(mailbox);assert.equal(c.reads.bundle.input.additionalProperties,false);assert.deepEqual(c.reads.bundle.input.required,['operation','messageId']);assert.equal(c.reads.bundle.input.properties.attachmentIds.maxItems,100);assert.equal(c.limits.bundleBytes,30*1024*1024);assert.match(c.reads.bundle.effect,/export only/);
});


test('related signature images without inline disposition remain inside EML unless explicitly requested',async()=>{
 const f=fixture();delete f.parsed.attachments[2].contentDisposition;f.parsed.attachments[2].related=true;
 const r=await f.api.read(mailbox,{operation:'bundle',messageId:ref()});assert.equal(r.files.length,3);assert.equal(r.attachments[2].isInline,true);assert.equal(r.bundle.omittedAttachmentIds[0].id,r.attachments[2].id);
});

test('attached RFC822 exports intact as one attachment; nested files are never invented as outer attachments',async()=>{
 const f=fixture();f.parsed.attachments[1]={filename:'forwarded.eml',contentType:'message/rfc822',content:Buffer.from('From: nested@example.test\r\n\r\nNested original with PDF')};
 const fetch=f.imap.fetchOne.bind(f.imap);f.imap.fetchOne=async(uid,q,o)=>{const v=await fetch(uid,q,o);if(q.bodyStructure)v.bodyStructure.childNodes[1].childNodes=[{type:'application/pdf',parameters:{name:'nested.pdf'}}];return v;};
 const r=await f.api.read(mailbox,{operation:'bundle',messageId:ref()});assert.equal(r.attachments.length,3);assert.equal(r.files[2].mimeType,'message/rfc822');assert.deepEqual(Buffer.from(r.files[2].content_base64,'base64'),f.parsed.attachments[1].content);assert.equal(r.files.some(x=>x.filename==='nested.pdf'),false);
});

test('bundle replaces four independent original/attachment loads with one without weakening size preflight',async()=>{
 const old=fixture();const read=await old.api.read(mailbox,{operation:'read',messageId:ref()});await old.api.read(mailbox,{operation:'original',messageId:ref()});
 for(const a of read.attachments.filter(x=>!x.isInline))await old.api.read(mailbox,{operation:'attachment',messageId:ref(),attachmentId:a.id});
 const fresh=fixture();await fresh.api.read(mailbox,{operation:'bundle',messageId:ref()});
 assert.deepEqual({connections:old.connections,parses:old.parses,sourceFetches:old.calls.filter(x=>x.q.source).length},{connections:4,parses:4,sourceFetches:4});
 assert.deepEqual({connections:fresh.connections,parses:fresh.parses,sourceFetches:fresh.calls.filter(x=>x.q.source).length},{connections:1,parses:1,sourceFetches:1});assert.ok(fresh.calls[0].q.size);assert.ok(fresh.calls[0].q.bodyStructure);
});
