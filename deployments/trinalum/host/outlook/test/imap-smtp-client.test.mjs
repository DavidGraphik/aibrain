import test from "node:test";
import assert from "node:assert/strict";
import {
  appendDraft,
  appendSent,
  assertImapActionAllowed,
  decodeMessageRef,
  encodeMessageRef,
} from "../lib/imap-smtp-client.mjs";

test("draft append retries without the Draft flag when the provider rejects it", async () => {
  const calls = [];
  const client = {
    async append(folder, message, flags) {
      calls.push({ folder, message, flags });
      if (flags) {
        const error = new Error("Command failed");
        error.responseStatus = "NO";
        throw error;
      }
      return { path: folder, uid: 42, uidValidity: 7 };
    },
  };
  const result = await appendDraft(client, "Drafts", Buffer.from("message"));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].flags, ["\\Draft"]);
  assert.equal(calls[1].flags, undefined);
  assert.equal(result.uid, 42);
});

test("sent append retries without the Seen flag when the provider rejects it", async () => {
  const calls = [];
  const client = {
    async append(folder, message, flags) {
      calls.push({ folder, message, flags });
      if (flags) throw new Error("provider rejects flags");
      return { path: folder, uid: 43, uidValidity: 7 };
    },
  };
  const result = await appendSent(client, "Sent", Buffer.from("message"));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].flags, ["\\Seen"]);
  assert.equal(calls[1].flags, undefined);
  assert.deepEqual(result, { saved: true, fallbackWithoutFlags: true });
});

test("normalizes bare newlines before appending to IMAP", async () => {
  const messages = [];
  const client = {
    async append(_folder, message) {
      messages.push(message.toString("latin1"));
      return { uid: 1 };
    },
  };
  const result = await appendSent(client, "Sent", Buffer.from("A\nB\r\nC\rD"));
  assert.equal(result.saved, true);
  assert.equal(messages[0], "A\r\nB\r\nC\r\nD");
});

test("sent append failure remains non-throwing after SMTP acceptance", async () => {
  let calls = 0;
  const client = {
    async append() {
      calls += 1;
      throw new Error("append unavailable");
    },
  };
  const result = await appendSent(client, "Sent", Buffer.from("message"));
  assert.equal(calls, 6);
  assert.deepEqual(result, { saved: false, fallbackWithoutFlags: true });
});

test("IMAP message references preserve folder and mailbox generation", () => {
  const value = encodeMessageRef("INBOX/Clientes", "987654321", 42);
  assert.deepEqual(decodeMessageRef(value), {
    path: "INBOX/Clientes",
    uidValidity: "987654321",
    uid: 42,
  });
  assert.throws(() => decodeMessageRef("42"), /Referencia/);
});

test("direct mailbox actions remain blocked until the operating mode changes", () => {
  assert.throws(
    () => assertImapActionAllowed(
      "send_mail",
      { id: "approval-001", approvedBy: "David", confirmed: true },
      "review_only",
    ),
    (error) => error.code === "OUTLOOK_MAIL_ACTION_BLOCKED",
  );
  assert.throws(
    () => assertImapActionAllowed("send_mail", null, "approval_required"),
    (error) => error.code === "OUTLOOK_MAIL_APPROVAL_REQUIRED",
  );
  assert.doesNotThrow(() => assertImapActionAllowed(
    "send_mail",
    { id: "approval-001", approvedBy: "David", confirmed: true },
    "approval_required",
  ));
});

test('legacy Telegram string recipients survive MIME serialization in To/Cc/Bcc',async()=>{
 const {ImapSmtpClient}=await import('../lib/imap-smtp-client.mjs');const {simpleParser}=await import('mailparser');
 const client=new ImapSmtpClient({},{});
 const raw=await client.buildRaw({subject:'Synthetic recipient preservation',body:{contentType:'Text',content:'Synthetic only'},toRecipients:['supplier@example.test'],ccRecipients:[{address:'copy@example.test',name:'Copy'}],bccRecipients:[{emailAddress:{address:'private@example.test'}}]},'sender@example.test');
 const parsed=await simpleParser(raw.message);
 assert.equal(parsed.to.value[0].address,'supplier@example.test');assert.equal(parsed.cc.value[0].address,'copy@example.test');assert.equal(parsed.bcc.value[0].address,'private@example.test');
});

test('malformed recipients fail before any provider write rather than disappearing',async()=>{
 const {ImapSmtpClient}=await import('../lib/imap-smtp-client.mjs');const client=new ImapSmtpClient({},{});
 for(const recipient of [null,{},'invalid','a@example.test\r\nBcc: x@example.test',{emailAddress:{name:'No address'}},{address:'a@example.test',name:'Injected\r\nHeader'}]){
  await assert.rejects(client.buildRaw({subject:'Synthetic',body:{content:'Synthetic'},toRecipients:[recipient]},'sender@example.test'),/Invalid recipient/);
 }
});

test('legacy saved drafts require exact provider MIME readback, including recipient headers',async()=>{
 const {ImapSmtpClient}=await import('../lib/imap-smtp-client.mjs');const {encryptToken}=await import('../lib/token-crypto.mjs');
 const key='c'.repeat(64),credential={password_encrypted:encryptToken('synthetic-password',key),folders_json:'{"drafts":"Drafts"}'};
 for(const tampered of [false,true]){
  let original,appends=0;const imap={mailbox:{uidValidity:7},append:async(_p,bytes)=>{appends++;original=bytes;return {uid:42,uidValidity:7,path:'Drafts'};},getMailboxLock:async()=>({release(){}}),fetchOne:async()=>({source:tampered?Buffer.from('Subject: changed\r\n\r\nMissing recipient'):original})};
  const client=new ImapSmtpClient({mailActionMode:'approval_required',tokenEncryptionKey:key},{mailCredential:()=>credential});client.withImapPassword=async(_m,_p,fn)=>fn(imap);
  const request=client.executeAction({type:'create_draft',mailbox:'owner@example.test',request:{message:{subject:'Synthetic',body:{content:'Test'},toRecipients:['supplier@example.test']}}},{id:'synthetic-approval',approvedBy:'Trini',confirmed:true});
  if(tampered)await assert.rejects(request,/original readback mismatch/);else assert.equal((await request).verified,true);
  assert.equal(appends,1);
 }
});

test('failed snapshot publication keeps the IMAP cursor retryable and publishes once after recovery', async t => {
 const {mkdtemp, mkdir, readFile, readdir, rm} = await import('node:fs/promises');
 const {tmpdir} = await import('node:os');const {join} = await import('node:path');
 const {createHash} = await import('node:crypto');
 const {ImapSmtpClient} = await import('../lib/imap-smtp-client.mjs');
 const directory = await mkdtemp(join(tmpdir(), 'trinalum-imap-cursor-'));
 t.after(() => rm(directory, {recursive:true,force:true}));
 const mailbox = 'owner@example.test';
 const name = createHash('sha256').update(`${mailbox}:Inbox:7:2`).digest('hex') + '.json';
 const destination = join(directory, name);await mkdir(destination);
 let state = null, commits = 0;
 const store = {getImapState: () => state, setImapState(_mailbox,_folder,validity,last) {
  commits++;state={uid_validity:validity,last_uid:last};
 }};
 const client = new ImapSmtpClient({initialSyncLimit:200,maxMessageBytes:1000}, store, {
  simpleParser: async () => ({subject:'Synthetic order',text:'Confirmed',attachments:[]}),
 });
 const imap = {mailbox:{uidValidity:7,uidNext:3}, getMailboxLock:async () => ({release(){}}),
  search:async () => [2],fetchOne:async (_uid,query) => query.source ? {source:Buffer.from('Synthetic original')} :
   {uid:2,size:100,flags:new Set(),internalDate:new Date('2026-11-04T08:00:00Z')},
 };
 await assert.rejects(client.syncFolder(imap,mailbox,'Inbox','INBOX',directory));
 assert.equal(commits,0);assert.equal(state,null);assert.deepEqual(await readdir(directory),[name]);
 await rm(destination,{recursive:true});
 const result = await client.syncFolder(imap,mailbox,'Inbox','INBOX',directory);
 assert.equal(result.changedMessages,1);assert.equal(commits,1);assert.equal(state.last_uid,2);
 assert.equal(JSON.parse(await readFile(destination,'utf8')).data.text,'Confirmed');
 assert.deepEqual(await readdir(directory),[name]);
});

import {ImapSmtpClient} from '../lib/imap-smtp-client.mjs';
import {simpleParser} from 'mailparser';

const embeddedOriginal=Buffer.from('From: nested@untrusted.example\r\nTo: other@untrusted.example\r\nSubject: Nested claim\r\nMessage-ID: <nested@untrusted.example>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nNested text is untrusted source content.\r\n');

test('ordinary RFC822 original remains a named byte-exact attachment and CID logo stays inline',async()=>{
 const client=new ImapSmtpClient({},{}),logo=Buffer.from('synthetic image bytes');
 const raw=await client.buildRaw({subject:'Outer request',body:{contentType:'HTML',content:'Outer body<img src="cid:own-logo">'},toRecipients:[{emailAddress:{address:'recipient@example.test'}}],attachments:[{name:'original.eml',contentType:'message/rfc822',contentBytes:embeddedOriginal.toString('base64')},{name:'logo.png',contentType:'image/png',contentId:'own-logo',isInline:true,contentBytes:logo.toString('base64')}]},'owner@example.test');
 const parsed=await simpleParser(raw.message,{skipImageLinks:true});
 assert.equal(parsed.subject,'Outer request');assert.equal(parsed.from.value[0].address,'owner@example.test');assert.deepEqual(parsed.to.value.map(x=>x.address),['recipient@example.test']);
 assert.doesNotMatch(parsed.html,/Nested text/);assert.equal(parsed.attachments.length,2);
 const original=parsed.attachments.find(x=>x.filename==='original.eml');assert.equal(original.contentDisposition,'attachment');assert.deepEqual(original.content,embeddedOriginal);
 const inline=parsed.attachments.find(x=>x.filename==='logo.png');assert.equal(inline.contentDisposition,'inline');assert.equal(inline.cid,'own-logo');assert.deepEqual(inline.content,logo);
});

test('explicitly inline RFC822 originals retain their disposition instead of being silently rewritten',async()=>{
 const client=new ImapSmtpClient({},{});
 for(const extra of [{isInline:true},{contentId:'explicit-original'}]){
  const raw=await client.buildRaw({body:{contentType:'Text',content:'Outer'},attachments:[{name:'inline.eml',contentType:'message/rfc822',contentBytes:embeddedOriginal.toString('base64'),...extra}]},'owner@example.test');
  const imapBytes=Buffer.from(raw.message.toString('latin1').replace(/\r?\n/g,'\r\n'),'latin1');
  const parsed=await simpleParser(imapBytes,{skipImageLinks:true});
  assert.match(imapBytes.toString(),/Content-Disposition: inline; filename=inline.eml/);assert.match(parsed.text,/Nested text is untrusted source content/);assert.equal(parsed.from.value[0].address,'owner@example.test');assert.equal(parsed.attachments.some(x=>x.filename==='inline.eml'),false);
 }
});

test('attached RFC822 bytes with LF, CRLF and binary octets survive transport newline normalization',async()=>{
 const client=new ImapSmtpClient({},{});
 for(const bytes of [embeddedOriginal,Buffer.from(embeddedOriginal.toString().replace(/\r\n/g,'\n')),Buffer.concat([embeddedOriginal,Buffer.from([0,128,255])])]){
  const raw=await client.buildRaw({body:{contentType:'Text',content:'Outer'},attachments:[{name:'exact.eml',contentType:'message/rfc822',contentBytes:bytes.toString('base64')}]},'owner@example.test');
  const imapBytes=Buffer.from(raw.message.toString('latin1').replace(/\r?\n/g,'\r\n'),'latin1');const parsed=await simpleParser(imapBytes,{skipImageLinks:true});
  assert.equal(parsed.attachments[0].contentDisposition,'attachment');assert.deepEqual(parsed.attachments[0].content,bytes);
 }
});
