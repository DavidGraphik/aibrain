import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir as nativeTmpdir} from 'node:os';
import {realpathSync as canonicalTmpPath} from 'node:fs';
const tmpdir=()=>canonicalTmpPath(nativeTmpdir());
import {join} from 'node:path';
import {MailApi,compileImapQuery} from '../lib/mail-api.mjs';
import {hasMandatoryOwnedMailSender,rankMailSearchFolders,MailLocatorHints} from '../lib/mail-owned-search.mjs';
import {encryptToken} from '../lib/token-crypto.mjs';

const mailbox='owner@example.test',query='from:owner@example.test on:2026-10-26';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ref=(folder,uid=7,generation='9')=>`imap:${Buffer.from(folder).toString('base64url')}:${generation}:${uid}`;
function fixture(){
 const folders=[{path:'INBOX'},...Array.from({length:39},(_,i)=>({path:'A-'+String(i).padStart(2,'0')})),{path:'Sent',specialUse:'\\Sent'},...Array.from({length:6},(_,i)=>({path:'Z-'+String(i).padStart(2,'0')}))];
 const searched=[],matches=new Map([['Sent',[7]]]),key='11'.repeat(32);let generation='9',seen=false,providerError=null,lists=0;
 const credential={password_encrypted:encryptToken('synthetic',key),folders_json:JSON.stringify({sent:'Sent',inbox:'INBOX'})};
 const imap={mailbox:{uidValidity:generation},async list(){lists++;return folders;},async getMailboxLock(path,options){assert.equal(options.readOnly,true);this.path=path;this.mailbox={uidValidity:generation};return {release(){}};},async search(criteria){searched.push({path:this.path,criteria:structuredClone(criteria)});if(providerError)throw Object.assign(Error('Provider search failed'),{code:providerError});return matches.get(this.path)??[];},async fetchOne(uid,request){assert.equal(request.source,undefined);return {uid,flags:new Set(seen?['\\Seen']:[]),size:123,envelope:{subject:'Synthetic original',from:[{address:mailbox}],messageId:'<synthetic@example.test>'},internalDate:new Date('2026-10-26T09:00:00Z')};}};
 const client={requiredCredential(owner){assert.equal(owner,mailbox);return credential;},async withImapPassword(owner,password,callback){assert.equal(owner,mailbox);assert.equal(password,'synthetic');return callback(imap);}};
 const config={mailboxes:[{address:mailbox,name:'Owner'}],tokenEncryptionKey:key};
 const api=new MailApi({config,client,actionDirectory:'/unused',signatureProvider:null,store:{getImapState(){throw Error('Do not page source bodies for a live Sent plan');}}});
 return {folders,searched,matches,credential,imap,config,api,listCount:()=>lists,providerError:code=>{providerError=code;},changeCurrent:()=>{generation='10';seen=true;}};
}

test('owned sender must be an exact mandatory positive clause, preserving Boolean and literal semantics',()=>{
 for(const q of [query,'from:OWNER@EXAMPLE.TEST (subject:alpha OR subject:beta)','(from:owner@example.test subject:alpha) OR (from:owner@example.test subject:beta)'])assert.equal(hasMandatoryOwnedMailSender(compileImapQuery(q),mailbox),true);
 for(const q of ['from:owner@example.test OR from:foreign@example.test','to:owner@example.test','body:owner@example.test','from:foreign@example.test','from:owner@example.test.invalid','from:"Owner <owner@example.test>"','from:"owner@example.test "','subject:Sent'])assert.equal(hasMandatoryOwnedMailSender(compileImapQuery(q),mailbox),false);
 assert.equal(hasMandatoryOwnedMailSender({not:{from:mailbox}},mailbox),false);
});

test('cold own-sender lookup starts in authenticated Sent with unmodified criteria and all47 folders retained',async t=>{
 const f=fixture(),before=rankMailSearchFolders(compileImapQuery(query),f.folders.map(x=>x.path));assert.equal(before.indexOf('Sent'),40);
 const page=await f.api.read(mailbox,{operation:'search',query,limit:1});
 assert.equal(f.searched.length,1);assert.equal(f.searched[0].path,'Sent');assert.deepEqual(f.searched[0].criteria,compileImapQuery(query));assert.equal(page.messages[0].id,ref('Sent'));
 assert.equal(page.complete,false);assert.equal(page.coverage.totalFolders,47);assert.equal(page.coverage.completedFolders,1);assert.equal(page.coverage.ownedSnapshots.readSnapshots,0);
 assert.deepEqual(page.coverage.ownedSenderFolderPriority,{source:'current_authenticated_sent_folder',prioritizedFolder:'Sent',liveQueryUnchanged:true,remainingFoldersPreserved:true});
 t.diagnostic(JSON.stringify({syntheticOldSearchesToFirstSent:before.indexOf('Sent')+1,syntheticNewSearchesToFirstSent:f.searched.length,allFolders:47,queryUnchanged:true}));
});

test('moved sent originals remain reachable through the same cursor without duplicate or omitted folders',async()=>{
 const f=fixture();f.matches.set('Z-05',[8]);let p=await f.api.read(mailbox,{operation:'search',query,limit:100});const ids=p.messages.map(m=>m.id);let pages=1;
 while(p.cursor){p=await f.api.read(mailbox,{operation:'search',query,limit:100,cursor:p.cursor});ids.push(...p.messages.map(m=>m.id));assert.ok(++pages<=3);}
 assert.deepEqual(ids,[ref('Sent'),ref('Z-05',8)]);assert.equal(p.complete,true);assert.equal(f.searched.length,47);assert.equal(new Set(f.searched.map(x=>x.path)).size,47);
 assert.ok(f.searched.every(x=>JSON.stringify(x.criteria)===JSON.stringify(compileImapQuery(query))));
});

test('signed Sent ordering is frozen across new human context and changed configuration/special-use metadata',async()=>{
 const f=fixture(),first=await f.api.read(mailbox,{operation:'search',query,limit:1}),before=f.api.uncursor(first.cursor);assert.equal(before.index,1);
 f.folders.find(x=>x.path==='Sent').specialUse=null;f.folders.find(x=>x.path==='Z-05').specialUse='\\Sent';f.credential.folders_json=JSON.stringify({sent:'Z-05'});f.matches.set('Z-05',[8]);f.searched.length=0;
 const next=await f.api.read(mailbox,{operation:'search',query,cursor:first.cursor},{searchContext:{humanMessage:'continúa',sourceMessageId:'new-human'}}),after=f.api.uncursor(next.cursor);
 assert.deepEqual(after.sentPlan,before.sentPlan);assert.deepEqual(after.seenKeys,before.seenKeys);assert.equal(after.index,31);assert.equal(f.searched[0].path,'INBOX');assert.equal(next.messages.length,0);
 f.searched.length=0;const fresh=await f.api.read(mailbox,{operation:'search',query,limit:1});assert.equal(f.searched[0].path,'Z-05');assert.equal(fresh.messages[0].id,ref('Z-05',8));
});

test('legacy cursors without a Sent plan keep their exact old catalog, index and remaining work',async()=>{
 const f=fixture(),first=await f.api.read(mailbox,{operation:'search',query,limit:1}),legacy=f.api.uncursor(first.cursor);delete legacy.sentPlan;delete legacy.seenKeys;legacy.index=30;legacy.catalog=digest(rankMailSearchFolders(compileImapQuery(query),f.folders.map(x=>x.path)));f.searched.length=0;
 const next=await f.api.read(mailbox,{operation:'search',query,limit:1,cursor:f.api.cursor(legacy)});assert.equal(f.searched[0].path,'A-29');assert.equal(f.searched.length,11);assert.equal(next.messages[0].folder,'Sent');assert.equal(f.api.uncursor(next.cursor).index,41);assert.equal(f.api.uncursor(next.cursor).sentPlan,undefined);assert.equal(next.coverage.ownedSenderFolderPriority,undefined);
});

test('explicit folders and latest received retain their existing live plan; foreign or ambiguous senders do not gain priority',async()=>{
 const f=fixture();let p=await f.api.read(mailbox,{operation:'search',query,folder:'INBOX'});assert.equal(f.searched[0].path,'INBOX');assert.equal(p.coverage.totalFolders,1);assert.equal(p.coverage.ownedSenderFolderPriority,undefined);
 f.searched.length=0;p=await f.api.read(mailbox,{operation:'search',query,freshness:'live_received_first'});assert.equal(f.searched[0].path,'INBOX');assert.equal(p.coverage.ownedSenderFolderPriority,undefined);assert.equal(p.coverage.freshness.globalLatestVerified,false);
 f.searched.length=0;p=await f.api.read(mailbox,{operation:'search',query},{searchContext:{humanMessage:'Find the latest received mail',sourceMessageId:'latest-human'}});assert.equal(f.searched[0].path,'INBOX');assert.equal(p.coverage.ownedSenderFolderPriority,undefined);
 for(const q of ['from:foreign@example.test on:2026-10-26','(from:owner@example.test OR from:foreign@example.test) on:2026-10-26']){f.searched.length=0;p=await f.api.read(mailbox,{operation:'search',query:q});assert.equal(f.searched[0].path,'INBOX');assert.equal(p.coverage.ownedSenderFolderPriority,undefined);}
});

test('Sent comes only from current selectable LIST or a current configured path, never a guessed folder',async()=>{
 const f=fixture(),sent=f.folders.find(x=>x.path==='Sent');sent.path='Gesendet';delete sent.specialUse;f.matches.delete('Sent');f.matches.set('Gesendet',[7]);f.credential.folders_json=JSON.stringify({sent:'Gesendet'});
 let p=await f.api.read(mailbox,{operation:'search',query});assert.equal(f.searched[0].path,'Gesendet');assert.equal(p.messages[0].folder,'Gesendet');
 f.searched.length=0;sent.flags=new Set(['\\Noselect']);p=await f.api.read(mailbox,{operation:'search',query});assert.equal(f.searched[0].path,'INBOX');assert.equal(p.coverage.ownedSenderFolderPriority.prioritizedFolder,null);assert.equal(p.coverage.totalFolders,46);assert.equal(f.searched.some(x=>x.path==='Gesendet'),false);
 f.credential.folders_json='{"sent":"foreign/path"}';f.searched.length=0;await f.api.read(mailbox,{operation:'search',query});assert.equal(f.searched.some(x=>x.path==='foreign/path'),false);
});

test('specific current advertised Sent wins stale configuration; learned exact-live hints still precede the cold preference',async t=>{
 const f=fixture();f.folders.find(x=>x.path==='Sent').path='Outgoing';f.credential.folders_json=JSON.stringify({sent:'Sent'});f.matches.set('Outgoing',[7]);f.matches.delete('Sent');
 let p=await f.api.read(mailbox,{operation:'search',query});assert.equal(f.searched[0].path,'Outgoing');assert.equal(p.messages[0].folder,'Outgoing');
 const directory=await realpath(await mkdtemp(join(tmpdir(),'sent-order-')));t.after(()=>rm(directory,{recursive:true,force:true}));f.config.dataDirectory=directory;f.matches.set('Z-05',[8]);await new MailLocatorHints(directory,mailbox).remember(compileImapQuery(query),[{id:ref('Z-05',8),folder:'Z-05'}],f.folders.map(x=>x.path));f.searched.length=0;
 p=await f.api.read(mailbox,{operation:'search',query});assert.equal(f.searched[0].path,'Z-05');assert.equal(p.coverage.locatorFolderPriority.foldersPrioritized,1);assert.equal(p.coverage.ownedSenderFolderPriority.prioritizedFolder,'Outgoing');
});

test('fresh provider flags/generation and provider errors are not cached or hidden by ordering',async()=>{
 const f=fixture();await f.api.read(mailbox,{operation:'search',query});f.changeCurrent();const fresh=await f.api.read(mailbox,{operation:'search',query});assert.equal(fresh.messages[0].id,ref('Sent',7,'10'));assert.equal(fresh.messages[0].isRead,true);assert.equal(fresh.messages[0].originalVerified,false);
 f.providerError('LIVE_SEARCH_FAILED');const failed=await f.api.read(mailbox,{operation:'search',query});assert.equal(failed.complete,false);assert.equal(failed.coverage.errors[0].code,'LIVE_SEARCH_FAILED');assert.equal(failed.coverage.stopped,'folder_error');
 const lists=f.listCount();await assert.rejects(f.api.read('foreign@example.test',{operation:'search',query}),{code:'MAILBOX_NOT_ALLOWED'});assert.equal(f.listCount(),lists);
});

test('invalid or substituted signed plans fail closed instead of changing order or advancing a cursor',async()=>{
 const f=fixture(),p=await f.api.read(mailbox,{operation:'search',query}),state=f.api.uncursor(p.cursor);
 for(const patch of [{indices:[0,1]},{indices:[-1]},{indices:['0']},{baseCatalog:'0'.repeat(64)},{version:2}])await assert.rejects(f.api.read(mailbox,{operation:'search',query,cursor:f.api.cursor({...state,sentPlan:{...state.sentPlan,...patch}})}),{code:'MAIL_SEARCH_CURSOR_EXPIRED'});
 await assert.rejects(f.api.read(mailbox,{operation:'search',query:query+' subject:changed',cursor:p.cursor}),/different mailbox or query/);
 await assert.rejects(f.api.read(mailbox,{operation:'search',query,cursor:p.cursor.slice(0,-2)+'xx'}),/Invalid search cursor/);
});
