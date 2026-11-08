import assert from "node:assert/strict";
import test from "node:test";
import { searchMessages, searchSnapshotDirectory } from "../bin/mail-search.mjs";
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir as nativeTmpdir} from 'node:os';
import {realpathSync as canonicalTmpPath} from 'node:fs';
const tmpdir=()=>canonicalTmpPath(nativeTmpdir());
import {join} from 'node:path';
import {compileMailSearchQuery} from '../lib/mail-search-query.mjs';
import {resolveMailLocator,mailSnapshotReference} from '../lib/mail-reference.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('snapshot CLI preserves an explicit configured state directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mail-search-cli-'));
 try{
  const {mkdir}=await import('node:fs/promises');
  await mkdir(join(root,'delta'));
  const mailbox='owner@example.test';
  await writeFile(join(root,'delta','synthetic.json'),JSON.stringify({mailbox,folder:'Inbox',fetched_at:new Date().toISOString(),data:{id:'synthetic-mail',subject:'Synthetic needle',text:'Owned fixture'}}));
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../bin/mail-search.mjs',import.meta.url)),'--mailbox',mailbox,'--query','needle'],{encoding:'utf8',timeout:10000,env:{OUTLOOK_PROVIDER:'imap_smtp',OUTLOOK_MAILBOXES_JSON:JSON.stringify([{name:'Owner',address:mailbox}]),OUTLOOK_TOKEN_ENCRYPTION_KEY:'a'.repeat(64),OUTLOOK_IMAP_HOST:'imap.example.test',OUTLOOK_SMTP_HOST:'smtp.example.test',OUTLOOK_DATA_DIR:root}});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).messages[0].message_id,'synthetic-mail');
 }finally{await rm(root,{recursive:true,force:true});}
});

test("searches only the selected mailbox and bounds text", () => {
  const now = new Date();
  const messages = [
    {
      snapshotId: "one",
      mailbox: "second.employee@example.invalid",
      folder: "Inbox",
      date: now,
      data: {
        id: "imap-source-one",
        subject: "ExampleCo",
        text: "Nueva carga de chatarra y próximos pasos",
        hasAttachments: false,
      },
      from: [{ name: "Cliente", address: "buyer@example.com" }],
      externalRecipients: [],
    },
    {
      snapshotId: "two",
      mailbox: "administracion@example.invalid",
      folder: "Inbox",
      date: now,
      data: { subject: "ExampleCo", text: "Privado", hasAttachments: false },
      from: [],
      externalRecipients: [],
    },
  ];
  const result = searchMessages(messages, {
    mailbox: "second.employee@example.invalid",
    query: "exampleco",
    limit: 10,
    sinceDays: 30,
    maxTextChars: 12,
  });
  assert.equal(result.count, 1);
  assert.equal(result.messages[0].message_id, "imap-source-one");
  assert.equal(result.messages[0].text.length, 12);
});

test('legacy snapshot search accepts reference presentation spaces and dashes without changing date or identifier values',()=>{
 const mailbox='first.employee@example.invalid';
 const message={snapshotId:'cd'.repeat(32),mailbox,folder:'Inbox',date:new Date('2026-11-04T08:00:00Z'),data:{id:'owned-current',subject:'Supplier credit (987654 - A:1234)',text:'Owned source'},from:[],externalRecipients:[]};
 const options={mailbox,limit:20,sinceDays:3650,maxTextChars:100};
 for(const query of ['"987654-A:1234" after:2026-11-03 before:2026-11-05','subject:"987654 – A : 1234"'])assert.equal(searchMessages([message],{...options,query}).count,1);
 for(const query of ['"987654-A:1235"','"987654-B:1234"','"987654-A:1234" before:2026-11-04'])assert.equal(searchMessages([message],{...options,query}).count,0);
 assert.throws(()=>searchMessages([message],{...options,query:'after:"2026 - 11 - 03"'}),error=>error.code==='MAIL_SEARCH_QUERY_INVALID');
});

test('a search result preserves its owned original identity after the IMAP locator expires',async()=>{
 const root=await mkdtemp(join(tmpdir(),'trinalum-mail-search-anchor-'));
 try{
  const snapshotId='ab'.repeat(32),mailbox='second.employee@example.invalid';
  const data={id:'imap:SU5CT1g:old:123',subject:'Original requested ANL',text:'Owned original body',internetMessageId:'<original@example.com>',hasAttachments:true,attachments:[{filename:'anl.pdf',contentType:'application/pdf',size:1024}]};
  await writeFile(join(root,snapshotId+'.json'),JSON.stringify({mailbox,folder:'Inbox',fetched_at:new Date().toISOString(),data}));
  const result=await searchSnapshotDirectory(root,{mailbox,query:'requested ANL',limit:1,sinceDays:30,maxTextChars:100});
  assert.equal(result.messages[0].message_id,mailSnapshotReference(snapshotId));
  assert.equal(result.messages[0].original_message_id,data.id);
  const locator=await resolveMailLocator({id:result.messages[0].message_id,mailbox,proposalDirectory:root,deltaDirectory:root});
  assert.deepEqual(locator,{messageId:data.id,snapshot:data});
  await assert.rejects(resolveMailLocator({id:result.messages[0].message_id,mailbox:'administracion@example.invalid',proposalDirectory:root,deltaDirectory:root}),/mailbox/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('disk search limits results, excludes other mailboxes and does not return attachment bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'trinalum-mail-search-'));
 try {
  for(let i=0;i<8;i++)await writeFile(join(root,`${i}.json`),JSON.stringify({mailbox:i===7?'administracion@example.invalid':'second.employee@example.invalid',folder:'Inbox',fetched_at:new Date(Date.now()-i*1000).toISOString(),data:{id:`mail-${i}`,subject:'Cotización',text:'Texto de la oferta',hasAttachments:true,attachments:[{filename:'offer.pdf',contentBase64:'SECRET-ATTACHMENT-PAYLOAD'}]}}));
  const result=await searchSnapshotDirectory(root,{mailbox:'second.employee@example.invalid',query:'cotizacion',limit:2,sinceDays:30,maxTextChars:10});
  assert.deepEqual(result.messages.map(m=>m.message_id),['mail-0','mail-1']);
  assert.equal(JSON.stringify(result).includes('SECRET-ATTACHMENT-PAYLOAD'),false);
  assert.equal(result.messages[0].text.length,10);
 } finally {await rm(root,{recursive:true,force:true});}
});


test('quoted ANL subjects and references find the same owned source as literal queries', () => {
 const mailbox='first.employee@example.invalid';
 const base={snapshotId:'cd'.repeat(32),mailbox,folder:'Inbox',date:new Date(),data:{id:'imap-source',subject:'ANL 002026013923 20261008',text:'Contract 7654321098',hasAttachments:true,attachments:[{filename:'anl.pdf',contentBase64:'NEVER_RETURN_ORIGINAL_BYTES'}]},from:[{name:'Example Sender',address:'vendor@example.com'}],externalRecipients:[]};
 const messages=[base,{...base,snapshotId:'ef'.repeat(32),mailbox:'administracion@example.invalid'}];
 for(const query of ['ANL 002026013923 20261008','"ANL 002026013923 20261008"','“ANL 002026013923 20261008”',"'7654321098'"]){
  const result=searchMessages(messages,{mailbox,query,limit:10,sinceDays:30,maxTextChars:100});
  assert.equal(result.count,1);assert.equal(result.messages[0].message_id,mailSnapshotReference(base.snapshotId));
  assert.equal(JSON.stringify(result).includes('NEVER_RETURN_ORIGINAL_BYTES'),false);
 }
 for(const query of ['""','“ ”'])assert.throws(()=>searchMessages(messages,{mailbox,query,limit:10,sinceDays:30,maxTextChars:100}),/Invalid or unsupported/);
 assert.equal(searchMessages(messages,{mailbox,query:'"ANL 999999"',limit:10,sinceDays:30,maxTextChars:100}).count,0);
});


test('documented subject/sender/date and OR searches preserve mailbox boundaries and disclose truncation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'trinalum-mail-query-'));
 try{
  for(const [i,mailbox,subject,text,from,date]of [[1,'first.employee@example.invalid','ANL 002026013923 20261008','Contract 7654321098','Example Sender','2026-10-08T05:46:51Z'],[2,'first.employee@example.invalid','Oferta de julio','quotation','Proveedor','2026-07-02T10:00:00Z'],[3,'first.employee@example.invalid','Pedido de agosto','order','Cliente','2026-08-02T10:00:00Z'],[4,'administracion@example.invalid','Oferta privada','quotation','Proveedor','2026-07-03T10:00:00Z']]){
   await writeFile(join(root,String(i)+'.json'),JSON.stringify({mailbox,folder:'Inbox',fetched_at:date,data:{id:'mail-'+i,subject,text,toRecipients:[{emailAddress:{name:'Trini',address:'first.employee@example.invalid'}}],from:[{name:from,address:'vendor@example.com'}]}}));
  }
  const options={mailbox:'first.employee@example.invalid',limit:20,sinceDays:3650,maxTextChars:100};
  assert.equal((await searchSnapshotDirectory(root,{...options,query:'to:first.employee@example.invalid'})).count,3);
  for(const query of ['subject:"ANL 002026013923 20261008"','from:example ANL','"7654321098"'])assert.equal((await searchSnapshotDirectory(root,{...options,query})).count,1);
  const r=await searchSnapshotDirectory(root,{...options,query:'after:2026-07-01 before:2026-09-01 (oferta OR pedido OR quotation)',limit:1});
  assert.equal(r.count,1);assert.equal(r.total_matches,2);assert.equal(r.truncated,true);assert.equal(r.messages[0].subject,'Pedido de agosto');
  for(const query of ['after:2026-02-30','has:attachment','(oferta OR)','subject:"unterminated'])await assert.rejects(searchSnapshotDirectory(root,{...options,query}),error=>error.code==='MAIL_SEARCH_QUERY_INVALID');
 }finally{await rm(root,{recursive:true,force:true});}
});


test('snapshot field groups match their actual subject rather than body and keep nested scopes local',()=>{
 const mailbox='owner@example.test',date=new Date('2026-01-02T12:00:00Z');
 const row=(id,subject,text,from='other@example.test',owner=mailbox)=>({snapshotId:id,mailbox:owner,folder:'INBOX',date,data:{id,subject,text},from:[{address:from}],externalRecipients:[]});
 const messages=[row('subject-match','Order confirmation','irrelevant'),row('body-only','Other','order confirmation'),row('nested-match','order urgent','irrelevant'),row('explicit-match','Other','irrelevant','alice@example.test'),row('other-owner','Order confirmation','irrelevant','alice@example.test','else@example.test')];
 const query='subject:("order confirmation" OR (order urgent) OR from:(alice@example.test OR bob@example.test)) after:2026-01-01 before:2026-01-03';
 const result=searchMessages(messages,{mailbox,query,limit:20,sinceDays:36500,maxTextChars:100});
 assert.deepEqual(result.messages.map(x=>x.message_id),['subject-match','nested-match','explicit-match']);
 const match=compileMailSearchQuery('subject:(alpha OR from:(alice OR bob)) text:outside');
 assert.equal(match(row('a','alpha','outside')),true);
 assert.equal(match(row('b','nothing','outside','alice')),true);
 assert.equal(match(row('c','nothing','alpha outside')),false);
 assert.equal(match(row('d','alpha','nothing')),false);
 assert.equal(compileMailSearchQuery('subject:(alpha) outside')(row('f','alpha','outside')),true);
 assert.equal(compileMailSearchQuery('subject:("from:literal")')(row('e','from:literal','nothing')),true);
});

test('snapshot field groups retain malformed, unknown-field and bounded-query rejection',()=>{
 for(const query of ['subject:()','subject:(OR x)','subject:(x AND)','subject:(x','subject:(x))','foo:(x)','after:(2026-01-01)','subject:("unclosed)','subject:('.repeat(6)+'x'+')'.repeat(6),'subject:('+Array(65).fill('x').join(' ')+')','subject:('+ 'x'.repeat(500)+')'])assert.throws(()=>compileMailSearchQuery(query),error=>error.code==='MAIL_SEARCH_QUERY_INVALID',query);
 assert.equal(compileMailSearchQuery('"subject:"')({data:{subject:'subject:'},from:[],externalRecipients:[]}),true);
});
