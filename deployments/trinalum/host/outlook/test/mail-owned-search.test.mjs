import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,utimes} from 'node:fs/promises';
import {tmpdir as nativeTmpdir} from 'node:os';
import {realpathSync as canonicalTmpPath} from 'node:fs';
const tmpdir=()=>canonicalTmpPath(nativeTmpdir());
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {unlinkSync} from 'node:fs';
import {recentOwnedMail,matchesOwnedMailCriteria,rankMailSearchFolders,prefersHistoricalMailFolders,strongMailSearchFolders,mailSearchCandidateCriteria,isBareMailReference} from '../lib/mail-owned-search.mjs';
import {ownedMailSnapshotReference,decodeOwnedMailSnapshotReference,resolveMailLocator} from '../lib/mail-reference.mjs';
import {MailApi,compileImapQuery} from '../lib/mail-api.mjs';
import {encryptToken} from '../lib/token-crypto.mjs';

const mailbox='owner@example.test';
const reference=(path,uid)=>`imap:${Buffer.from(path).toString('base64url')}:7:${uid}`;
const hash=value=>createHash('sha256').update(value).digest('hex');
async function root(t){const path=await mkdtemp(join(tmpdir(),'trinalum-owned-mail-'));await mkdir(join(path,'delta'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
function source(uid,owner=mailbox){return {mailbox:owner,folder:'Inbox',folderPath:'INBOX',fetched_at:'2026-11-04T09:00:00.000Z',data:{id:reference('INBOX',uid),uid,subject:'Current supplier credit note',internetMessageId:'<current-original@example.test>',from:[{address:'supplier@example.test'}],toRecipients:[{address:owner}],ccRecipients:[],receivedDateTime:'2026-11-04T08:00:00.000Z',sentDateTime:'2026-11-04T08:00:00.000Z',bodyFetched:true,text:'Current complete original',attachments:[{filename:'Current original.pdf',contentType:'application/pdf',size:14}]}};}
async function save(path,value){const uid=value.data.uid,id=ownedMailSnapshotReference({mailbox:value.mailbox,folder:value.folder,uidValidity:'7',uid});const scope=decodeOwnedMailSnapshotReference(id,value.mailbox);await writeFile(join(path,'delta',scope.snapshotId+'.json'),JSON.stringify(value),{mode:0o600});return id;}
const store=(last=10)=>({getImapState(owner,folder){assert.equal(owner,mailbox);return folder==='Inbox'?{uid_validity:'7',last_uid:last}:null;}});

test('owner is checked before opening a snapshot or provider connection',async()=>{
 const id=ownedMailSnapshotReference({mailbox,folder:'Inbox',uidValidity:'7',uid:10});
 await assert.rejects(resolveMailLocator({id,mailbox:'foreign@example.test',deltaDirectory:'/must-never-be-opened'}),/mailbox or snapshot scope/);
 const key='ab'.repeat(32),api=new MailApi({config:{mailboxes:[{address:'foreign@example.test',name:'Foreign'}],dataDirectory:'/must-never-be-opened',tokenEncryptionKey:key},store:{},client:{requiredCredential(){throw Error('Must never connect');}}});
 await assert.rejects(api.read('foreign@example.test',{operation:'read',messageId:id}),/mailbox or snapshot scope/);
});

test('search opens only owner-derived source names and finds current subject, dates and attachment names',async t=>{
 const path=await root(t),id=await save(path,source(10));
 const foreign=source(10,'foreign@example.test'),foreignId=ownedMailSnapshotReference({mailbox:foreign.mailbox,folder:'Inbox',uidValidity:'7',uid:10});
 const foreignScope=decodeOwnedMailSnapshotReference(foreignId,foreign.mailbox);
 // Any global body scan would fail on this foreign JSON. Owner search never
 // opens this pathname, even though the UID and generation match.
 await writeFile(join(path,'delta',foreignScope.snapshotId+'.json'),'FOREIGN BODY MUST NOT BE READ',{mode:0o600});
 for(const query of ['subject:"supplier credit" on:2026-11-04','"Current original.pdf"','from:supplier@example.test after:2026-11-01']){
  const result=await recentOwnedMail({mailbox,store:store(),dataDirectory:path,criteria:compileImapQuery(query),limit:10,deadline:Date.now()+3000});
  assert.equal(result.messages.length,1);assert.equal(result.messages[0].id,id);assert.equal(result.messages[0].originalVerified,false);assert.equal(result.coverage.complete,false);assert.equal(result.coverage.readSnapshots,1);
 }
 const absent=await recentOwnedMail({mailbox,store:store(),dataDirectory:path,criteria:compileImapQuery('on:2026-11-03'),limit:10,deadline:Date.now()+3000});assert.equal(absent.messages.length,0);
});

test('query boolean semantics and current-state searches cannot be inferred from historical flags',async t=>{
 const data=source(10).data;
 assert.equal(matchesOwnedMailCriteria(data,compileImapQuery('subject:missing OR (subject:credit from:supplier@example.test)')),true);
 assert.equal(matchesOwnedMailCriteria(data,compileImapQuery('subject:credit subject:missing')),false);
 const path=await root(t);await save(path,source(10));
 const result=await recentOwnedMail({mailbox,store:store(),dataDirectory:path,criteria:compileImapQuery('subject:credit is:unread'),limit:10,deadline:Date.now()+3000});
 assert.equal(result.messages.length,0);assert.equal(result.coverage.readSnapshots,0);assert.equal(result.coverage.stopped,'current_flags_require_live_search');
});

test('formatted references find the same owned current source while identifier values and dates stay exact',async t=>{
 const path=await root(t),value=source(10);value.data.subject='Current supplier credit note (987654 - A:1234)';const id=await save(path,value);
 for(const query of ['"987654-A:1234" after:2026-11-03 before:2026-11-05','subject:"987654 – A : 1234"','subject:"Current supplier credit note (987654-A:1234)"']){
  const result=await recentOwnedMail({mailbox,store:store(),dataDirectory:path,criteria:compileImapQuery(query),limit:20,deadline:Date.now()+3000});
  assert.equal(result.messages.length,1);assert.equal(result.messages[0].id,id);assert.equal(result.messages[0].subject,value.data.subject);assert.equal(result.messages[0].originalVerified,false);
 }
 for(const query of ['"987654-A:1235"','subject:"987654-B:1234"','"987654-A:1234" before:2026-11-04'])assert.equal((await recentOwnedMail({mailbox,store:store(),dataDirectory:path,criteria:compileImapQuery(query),limit:20,deadline:Date.now()+3000})).messages.length,0);
 const f=await apiFixture(t);f.api.now=()=>Date.parse('2026-11-04T12:00:00Z');await save(f.api.config.dataDirectory,value);
 const page=await f.api.read(mailbox,{operation:'search',query:'"987654-A:1234" after:2026-11-03 before:2026-11-05',limit:20});
 assert.equal(page.messages[0].id,f.id);assert.equal(page.coverage.stopped,'owned_sources_found');assert.equal(f.searches(),0);
});

test('recent source reads remain bounded and never claim complete historical coverage',async t=>{
 const path=await root(t);for(let uid=1;uid<=35;uid++)await save(path,source(uid));
 const result=await recentOwnedMail({mailbox,store:store(35),dataDirectory:path,criteria:{all:true},limit:100,deadline:Date.now()+3000});
 assert.equal(result.coverage.readSnapshots,30);assert.equal(result.coverage.stopped,'work_budget');assert.equal(result.coverage.complete,false);assert.equal(result.messages.length,30);
});

test('a hint disappearing between metadata and body reads is skipped within the same budget',async t=>{
 const path=await root(t),id=await save(path,source(10)),scope=decodeOwnedMailSnapshotReference(id,mailbox);
 let removed=false;
 const result=await recentOwnedMail({mailbox,store:store(),dataDirectory:path,criteria:{all:true},limit:10,deadline:Date.now()+3000,now(){if(!removed){unlinkSync(join(path,'delta',scope.snapshotId+'.json'));removed=true;}return Date.now();}});
 assert.equal(result.messages.length,0);assert.equal(result.coverage.unavailableSources,1);assert.equal(result.coverage.readSnapshots,1);assert.equal(result.coverage.complete,false);
});

async function apiFixture(t,{last=10,folders=['INBOX','Archive'],archive='Archive',subject='Current supplier credit note',receivedAt='2026-11-04T08:00:00.000Z'}={}){
 const path=await root(t),snapshot=source(10);snapshot.data.subject=subject;snapshot.data.receivedDateTime=receivedAt;snapshot.data.sentDateTime=receivedAt;const id=await save(path,snapshot),key='11'.repeat(32);let searches=0,tampered=false;
 const attachment=Buffer.from('%PDF-synthetic');assert.equal(attachment.length,14);
 const parsed=()=>({subject:snapshot.data.subject,text:tampered?'Altered':snapshot.data.text,messageId:snapshot.data.internetMessageId,date:new Date(snapshot.data.sentDateTime),from:{value:snapshot.data.from},to:{value:snapshot.data.toRecipients},cc:{value:[]},attachments:[{filename:'Current original.pdf',contentType:'application/pdf',content:attachment}]});
 const imap={mailbox:{uidValidity:7,uidNext:11},capabilities:new Set(),async list(){return folders.map(path=>({path}));},async getMailboxLock(path){this.path=path;return {release(){}};},async search(){searches++;return this.path===archive?[9]:[];},async fetchOne(uid,query){if(this.path!==archive||uid!==9)return false;return query.source?{source:Buffer.from('complete current MIME original')}:{uid,size:30,flags:new Set(),envelope:{subject:snapshot.data.subject,messageId:snapshot.data.internetMessageId},internalDate:new Date(snapshot.data.receivedDateTime)};}};
 const credential={mailbox,owner:'Owner',folders_json:JSON.stringify({inbox:'INBOX',sent:'Sent'}),password_encrypted:encryptToken('synthetic-password',key)};
 const client={requiredCredential(owner){assert.equal(owner,mailbox);return credential;},async withImapPassword(owner,password,callback){assert.equal(owner,mailbox);assert.equal(password,'synthetic-password');return callback(imap);},async fetchParsedMessage(){throw Object.assign(Error('Moved'),{code:'MESSAGE_NOT_FOUND'});},async simpleParser(){return parsed();}};
 const api=new MailApi({config:{mailboxes:[{address:mailbox,name:'Owner'}],dataDirectory:path,tokenEncryptionKey:key},store:store(last),client,signatureProvider:null});
 return {api,id,attachment,imap,searches:()=>searches,tamper:()=>{tampered=true;}};
}

test('foreground search returns a stable current source, relocation and exact attachment bytes',async t=>{
 const f=await apiFixture(t),page=await f.api.read(mailbox,{operation:'search',query:'supplier credit',limit:20});
 assert.equal(page.messages[0].id,f.id);assert.equal(page.complete,false);assert.equal(page.coverage.stopped,'owned_sources_found');assert.equal(f.searches(),0);
 const read=await f.api.read(mailbox,{operation:'read',messageId:page.messages[0].id});
 assert.equal(read.originalVerified,true);assert.equal(read.relocated,true);assert.equal(read.messageId,reference('Archive',9));assert.equal(read.sourceLocator,f.id);
 const file=await f.api.read(mailbox,{operation:'attachment',messageId:f.id,attachmentId:read.attachments[0].id});
 assert.equal(file.sha256,hash(f.attachment));assert.deepEqual(Buffer.from(file.content_base64,'base64'),f.attachment);
 const next=await f.api.read(mailbox,{operation:'search',query:'supplier credit',limit:20,cursor:page.cursor});assert.equal(next.complete,true);assert.equal(next.messages.length,0);
});

test('expired native references recover through the same owner proof; writes never relocate',async t=>{
 const f=await apiFixture(t);const original=f.api.loadNative.bind(f.api);
 f.api.loadNative=async(mailbox,id)=>{if(id===reference('INBOX',10))throw Object.assign(Error('Moved'),{code:'MESSAGE_NOT_FOUND'});return original(mailbox,id);};
 assert.equal((await f.api.read(mailbox,{operation:'read',messageId:reference('INBOX',10)})).relocated,true);
 await assert.rejects(f.api.load(mailbox,f.id),error=>error.code==='INVALID_MESSAGE_REFERENCE');
 f.tamper();await assert.rejects(f.api.read(mailbox,{operation:'read',messageId:f.id}),error=>error.code==='MESSAGE_RECOVERY_UNAVAILABLE');
});

test('invalid owned hints fall back to a live same-owner result; direct invalid locators still fail closed',async t=>{
 const f=await apiFixture(t),scope=decodeOwnedMailSnapshotReference(f.id,mailbox),file=join(f.api.config.dataDirectory,'delta',scope.snapshotId+'.json');
 for(const invalid of ['{truncated',JSON.stringify({...source(10),mailbox:'foreign@example.test'}),JSON.stringify({...source(10),data:{...source(10).data,id:reference('INBOX',99)}}),JSON.stringify({...source(10),data:{...source(10).data,subject:{invalid:true}}})]){
  await writeFile(file,invalid,{mode:0o600});
  const result=await f.api.read(mailbox,{operation:'search',query:'supplier credit'});
  assert.equal(result.messages.length,1);assert.equal(result.messages[0].id,reference('Archive',9));assert.equal(result.coverage.source,'live_imap');assert.equal(result.coverage.ownedSnapshots.complete,false);assert.equal(result.coverage.ownedSnapshots.unavailableSources,1);
  assert.equal(JSON.stringify(result.messages).includes('foreign@example.test'),false);
  await assert.rejects(f.api.read(mailbox,{operation:'read',messageId:f.id}));
 }
});

test('optional source-state failures do not block live search, while provider failures remain explicit',async t=>{
 const f=await apiFixture(t);f.api.store={getImapState(){throw Error('Unavailable local source state');}};
 const live=await f.api.read(mailbox,{operation:'search',query:'supplier credit'});
 assert.equal(live.messages[0].id,reference('Archive',9));assert.equal(live.coverage.ownedSnapshots.stopped,'source_hints_unavailable');assert.equal(live.coverage.ownedSnapshots.complete,false);
 const connect=f.api.client.withImapPassword;
 f.api.client.withImapPassword=async(owner,password,callback)=>connect(owner,password,imap=>{imap.search=async()=>{throw Object.assign(Error('Provider failure'),{code:'MAIL_SEARCH_PROVIDER_FAILED'});};return callback(imap);});
 const failed=await f.api.read(mailbox,{operation:'search',query:'supplier credit'});
 assert.equal(failed.complete,false);assert.equal(failed.messages.length,0);assert.equal(failed.coverage.stopped,'folder_error');assert.equal(failed.coverage.errors[0].code,'MAIL_SEARCH_PROVIDER_FAILED');
 f.api.client.withImapPassword=async()=>{throw Object.assign(Error('Authentication failed'),{code:'MAIL_AUTHENTICATION_FAILED'});};
 await assert.rejects(f.api.read(mailbox,{operation:'search',query:'supplier credit'}),error=>error.code==='MAIL_AUTHENTICATION_FAILED');
});


test('owned lookup continues past the first source budget before 870 live folders and verifies the same original twice',async t=>{
 const f=await apiFixture(t,{last:50,folders:['INBOX','Archive',...Array.from({length:868},(_,i)=>'Archive/'+i)]});
 const root=f.api.config.dataDirectory;
 // New unrelated mail must not strand an earlier same-day source beyond page1.
 const targetScope=decodeOwnedMailSnapshotReference(f.id,mailbox);await utimes(join(root,'delta',targetScope.snapshotId+'.json'),1,1);
 for(let uid=11;uid<=50;uid++){const other=source(uid);other.data.subject='Unrelated later mail';other.data.internetMessageId='<other-'+uid+'@example.test>';await save(root,other);}
 const query='"Current supplier" "credit"';
 const first=await f.api.read(mailbox,{operation:'search',query,limit:20});
 assert.equal(first.messages.length,0);assert.equal(first.coverage.stopped,'owned_sources_pending');assert.equal(first.coverage.ownedSnapshots.readSnapshots,30);assert.equal(first.coverage.ownedSnapshots.remainingCandidates,11);assert.equal(f.searches(),0);assert.equal(first.complete,false);
 const second=await f.api.read(mailbox,{operation:'search',query,limit:20,cursor:first.cursor});
 assert.deepEqual(second.messages.map(x=>x.id),[f.id]);assert.equal(second.coverage.ownedSnapshots.readSnapshots,11);assert.equal(second.coverage.ownedSnapshots.windowExhausted,true);assert.equal(second.messages[0].originalVerified,false);assert.equal(f.searches(),0);
 // The existing original read/recovery path, not the hint, supplies attachment
 // bytes and verifies identity. Both reads come from the very same search ID.
 const read1=await f.api.read(mailbox,{operation:'read',messageId:second.messages[0].id}),read2=await f.api.read(mailbox,{operation:'read',messageId:second.messages[0].id});
 assert.equal(read1.originalVerified,true);assert.deepEqual(read1,read2);assert.equal(read1.attachments[0].sha256,hash(f.attachment));
});

test('owned source continuation respects result limits without dropping unreturned matching sources',async t=>{
 const path=await root(t);for(let uid=1;uid<=35;uid++)await save(path,source(uid));
 let cursor=null;const ids=[];let pages=0;
 do{const page=await recentOwnedMail({mailbox,store:store(35),dataDirectory:path,criteria:{all:true},limit:7,deadline:Date.now()+3000,cursor});assert.ok(page.coverage.readSnapshots<=30);assert.ok(page.coverage.readBytes<=8*1024*1024);assert.equal(page.coverage.complete,false);ids.push(...page.messages.map(x=>x.id));cursor=page.cursor;pages++;}while(cursor&&pages<10);
 assert.equal(ids.length,35);assert.equal(new Set(ids).size,35);assert.equal(pages,5);assert.equal(cursor,null);
});

test('owned continuation fails explicitly on source catalog drift and rejects query or owner substitution',async t=>{
 const f=await apiFixture(t,{last:45});for(let uid=11;uid<=45;uid++){const v=source(uid);v.data.subject='Other';await save(f.api.config.dataDirectory,v);}
 const query='subject:absent',page=await f.api.read(mailbox,{operation:'search',query});assert.equal(page.coverage.stopped,'owned_sources_pending');
 await assert.rejects(f.api.read(mailbox,{operation:'search',query:'subject:other',cursor:page.cursor}),/different mailbox or query/);
 await assert.rejects(f.api.read('foreign@example.test',{operation:'search',query,cursor:page.cursor}));
 const scope=decodeOwnedMailSnapshotReference(f.id,mailbox);await writeFile(join(f.api.config.dataDirectory,'delta',scope.snapshotId+'.json'),'{invalidated',{mode:0o600});
 await assert.rejects(f.api.read(mailbox,{operation:'search',query,cursor:page.cursor}),e=>e.code==='MAIL_SEARCH_CURSOR_EXPIRED');assert.equal(f.searches(),0);
});

test('all 500 bounded owned source keys fit the existing signed cursor limit even for a maximum escaped query',async t=>{
 const f=await apiFixture(t,{last:250});const path=f.api.config.dataDirectory;
 for(const logical of ['Inbox','SentItems'])for(let uid=1;uid<=250;uid++){
  const v=source(uid);v.data.text=String.fromCharCode(92).repeat(499);v.folder=logical;v.data.internetMessageId='<'+logical+'-'+uid+'@example.test>';if(logical==='SentItems'){v.folderPath='Sent';v.data.id=reference('Sent',uid);}await save(path,v);
 }
 f.api.store={getImapState(owner,folder){assert.equal(owner,mailbox);return {uid_validity:'7',last_uid:250};}};
 const query='\"'+String.fromCharCode(92).repeat(998)+'\"';assert.equal(query.length,1000);
 let cursor=null,count=0,pages=0;
 do{const page=await f.api.read(mailbox,{operation:'search',query,limit:100,...(cursor?{cursor}:{})});count+=page.messages.length;pages++;assert.ok(page.cursor.length<=16000);assert.ok(page.coverage.ownedSnapshots.readSnapshots<=30);cursor=page.cursor;if(page.coverage.ownedSnapshots.windowExhausted)break;}while(pages<20);
 assert.equal(count,500);assert.equal(pages,17);assert.equal(f.searches(),0);assert.equal(f.api.uncursor(cursor).seenOwnedKeys.length,8000);
});


test('owned source work that makes no progress falls back instead of issuing a nonadvancing cursor',async t=>{
 const path=await root(t);await save(path,source(10));
 const result=await recentOwnedMail({mailbox,store:store(),dataDirectory:path,criteria:{all:true},limit:20,now:()=>100,deadline:99});
 assert.equal(result.messages.length,0);assert.equal(result.cursor,null);assert.equal(result.coverage.remainingCandidates,1);assert.equal(result.coverage.windowExhausted,false);
});


test('query relevance ranks an authenticated historical folder before hundreds of unrelated folders without narrowing scope',()=>{
 const target='INBOX/Zeta/Acme/Aluminios Franco',folders=['INBOX',...Array.from({length:868},(_,i)=>'INBOX/Archive/'+i),target];
 const criteria=compileImapQuery('"Acme" "Franco" "INV1234" after:2026-10-19 before:2026-10-23'),ranked=rankMailSearchFolders(criteria,folders);
 assert.equal(ranked[0],target);assert.equal(ranked.length,870);assert.deepEqual(new Set(ranked),new Set(folders));assert.equal(prefersHistoricalMailFolders(criteria,'2026-11-04'),true);
 assert.equal(prefersHistoricalMailFolders(compileImapQuery('after:2026-11-03 before:2026-11-05'),'2026-11-04'),false);
 assert.deepEqual(rankMailSearchFolders(compileImapQuery('"INV1234"'),['Zeta','INBOX','Alpha']),['INBOX','Alpha','Zeta']);
 // The negative clauses used for AND must still expose their positive terms;
 // an explicitly negative term must not introduce a relevance preference.
 assert.equal(rankMailSearchFolders({not:{text:'Acme'}},['Zeta/Acme','INBOX'])[0],'INBOX');
});

test('dated historical lookup uses the relevant live folder immediately instead of paging recent source hints',async t=>{
 const archive='INBOX/Zeta/Acme/Aluminios Franco',folders=['INBOX',...Array.from({length:868},(_,i)=>'INBOX/Archive/'+i),archive];
 const f=await apiFixture(t,{last:50,folders,archive,subject:'Acme invoice INV1234 Aluminios Franco',receivedAt:'2026-10-21T08:00:00Z'});f.api.now=()=>Date.parse('2026-11-04T13:00:00Z');
 for(let uid=11;uid<=50;uid++){const other=source(uid);other.data.subject='Unrelated new mail';await save(f.api.config.dataDirectory,other);}
 const page=await f.api.read(mailbox,{operation:'search',query:'"Acme" "Franco" "INV1234" after:2026-10-19 before:2026-10-23',limit:10});
 assert.equal(page.messages.length,1);assert.equal(page.messages[0].folder,archive);assert.equal(f.searches(),1);assert.equal(page.coverage.searchedThisPage,1);assert.equal(page.coverage.stopped,'matches_found');assert.equal(page.coverage.ownedSnapshots.readSnapshots,0);assert.equal(page.coverage.ownedSnapshots.stopped,'specific_company_folders_prefer_live');assert.equal(page.complete,false);assert.ok(page.cursor);
});


test('strong company context requires two mandatory specific terms and respects OR, negatives and normalization',()=>{
 const folders=['INBOX','INBOX/TEKNIK/A.Franco','INBOX/Invoice/Customer'];
 assert.deepEqual(strongMailSearchFolders(compileImapQuery('"Téknik" "Franco" "INV1234"'),folders),['INBOX/TEKNIK/A.Franco']);
 for(const criteria of [compileImapQuery('"Teknik" OR "Franco"'),{not:{text:'Teknik'},text:'Franco'},compileImapQuery('"invoice" "customer"'),compileImapQuery('(Teknik Franco) OR (Teknik Other)')])assert.deepEqual(strongMailSearchFolders(criteria,folders),[]);
 const query=compileImapQuery('"Teknik" "Franco" on:2026-11-02 is:unread');assert.deepEqual(mailSearchCandidateCriteria(query),compileImapQuery('on:2026-11-02 is:unread'));
 assert.equal(isBareMailReference(compileImapQuery('INV1234')),true);assert.equal(isBareMailReference(compileImapQuery('Teknik INV1234')),false);
});

test('specific company lookup without dates skips recent source paging and returns separate unverified PDF filename candidates',async t=>{
 const archive='INBOX/Zeta/Acme/Franco',folders=['INBOX',...Array.from({length:868},(_,i)=>'INBOX/Other/'+i),archive],f=await apiFixture(t,{last:250,folders,archive});
 f.api.store={getImapState(){throw Error('Contextual historical plan must not page recent hints');}};const calls=[];
 f.imap.search=async criteria=>{calls.push(criteria);return JSON.stringify(criteria).includes('"text"')?[]:[9,9];};const fetch=f.imap.fetchOne.bind(f.imap);
 f.imap.fetchOne=async(uid,query,...rest)=>{assert.equal(query.source,undefined);const item=await fetch(uid,query,...rest);return {...item,bodyStructure:{type:'multipart/mixed',childNodes:[{type:'application/pdf',disposition:'attachment',dispositionParameters:{filename:'Invoice INV5678.pdf'}}]}};};
 const query='"Acme" "Franco" "INV5678"',page=await f.api.read(mailbox,{operation:'search',query,limit:20});
 assert.equal(calls.length,2);assert.equal(page.messages.length,0);assert.equal(page.candidates.length,1);assert.equal(page.candidates[0].matchType,'folder_candidate');assert.equal(page.candidates[0].exactQueryMatched,false);assert.equal(page.candidates[0].originalVerified,false);assert.deepEqual(page.candidates[0].attachments,[{name:'Invoice INV5678.pdf',contentType:'application/pdf'}]);assert.equal(page.coverage.ownedSnapshots.readSnapshots,0);assert.equal(page.coverage.stopped,'folder_candidates');assert.equal(page.coverage.searchedThisPage,2);assert.deepEqual(calls[0],{...compileImapQuery(query),uid:'1:10'});assert.deepEqual(calls[1],{all:true,uid:'1:10'});
 assert.equal(f.api.uncursor(page.cursor).companyCandidatesOffered,true);
 const next=await f.api.read(mailbox,{operation:'search',query,limit:20,cursor:page.cursor});assert.equal(next.candidates,undefined);assert.equal(next.messages.length,0);assert.ok(next.coverage.searchedThisPage<=30);
});

test('company candidate lookup keeps date and state filters explicit and cannot hide provider failure',async t=>{
 const archive='INBOX/Acme/Franco',f=await apiFixture(t,{folders:['INBOX',archive],archive});let calls=[];
 f.imap.search=async criteria=>{calls.push(criteria);if(JSON.stringify(criteria).includes('"text"'))return [];throw Object.assign(Error('Provider failure'),{code:'MAIL_SEARCH_PROVIDER_FAILED'});};
 const query='"Acme" "Franco" "INV5678" after:2026-10-01 before:2026-10-24 is:unread',page=await f.api.read(mailbox,{operation:'search',query});
 assert.equal(page.messages.length,0);assert.equal(page.candidates,undefined);assert.equal(page.coverage.stopped,'folder_error');assert.equal(page.complete,false);assert.equal(page.coverage.errors[0].code,'MAIL_SEARCH_PROVIDER_FAILED');
 assert.deepEqual(calls[0],{...compileImapQuery(query),uid:'1:10'});assert.deepEqual(calls[1],{...mailSearchCandidateCriteria(compileImapQuery(query)),uid:'1:10'});
});

test('company exact search and metadata fallback share the original30-search budget',async t=>{
 const folders=['INBOX',...Array.from({length:45},(_,i)=>'INBOX/Acme/Franco/'+i)],f=await apiFixture(t,{folders});let count=0;
 f.imap.search=async()=>{count++;return [];};const page=await f.api.read(mailbox,{operation:'search',query:'"Acme" "Franco" "INV5678"'});
 assert.equal(count,30);assert.equal(page.coverage.searchedThisPage,30);assert.equal(page.complete,false);assert.ok(page.cursor);assert.equal(page.candidates,undefined);
});

test('bare reference empty page asks for company context already present in the request without inventing IDs',async t=>{
 const f=await apiFixture(t,{last:45});for(let uid=11;uid<=45;uid++)await save(f.api.config.dataDirectory,source(uid));
 const page=await f.api.read(mailbox,{operation:'search',query:'INV5678'});assert.equal(page.coverage.stopped,'owned_sources_pending');assert.match(page.warning,/company\/client names already supplied/);assert.match(page.warning,/never ask the user for internal IDs/);
});

const humanContext={humanMessage:'Busca en mi correo la factura de Teknik 26EX1359, la de Aluminios Franco. Enséñame el correo original y sus adjuntos.',sourceMessageId:'human-request-1'};
test('generic latest received request starts live Inbox without source paging or an implicit date cutoff',async t=>{
 const f=await apiFixture(t,{archive:'INBOX',folders:['Archive',...Array.from({length:45},(_,i)=>'Other/'+i),'INBOX']});let sources=0;f.api.store={getImapState(){sources++;throw Error('No source paging');}};
 const queries=[],search=f.imap.search;f.imap.search=async function(query){queries.push({path:this.path,query});return search.call(this,query);};
 const query='"confirmación" pedido',page=await f.api.read(mailbox,{operation:'search',query},{searchContext:{humanMessage:'Busca la última confirmación de pedido recibida con PDF; si no hay, la última oferta recibida con PDF.',sourceMessageId:'latest-human'}});
 assert.equal(sources,0);assert.equal(f.searches(),1);assert.equal(queries[0].path,'INBOX');assert.deepEqual(queries[0].query,{...compileImapQuery(query),uid:'1:10'});assert.equal(page.coverage.ownedSnapshots.stopped,'latest_received_prefers_live');assert.equal(page.coverage.totalFolders,47);assert.equal(page.complete,false);assert.ok(page.cursor);assert.equal(page.coverage.freshness.prioritizedInbox,'INBOX');assert.equal(page.coverage.freshness.globalLatestVerified,false);assert.match(page.warning,/not global chronological/);
 const state=f.api.uncursor(page.cursor);assert.equal(state.searchPlan.latestReceived,true);assert.equal(state.index,1);
 let cursor=page.cursor,rest,rounds=0;do{rest=await f.api.read(mailbox,{operation:'search',query,cursor},{searchContext:{humanMessage:'Continúa',sourceMessageId:'next-human'}});cursor=rest.cursor;assert.ok(rest.coverage.searchedThisPage<=30);assert.equal(rest.coverage.totalFolders,47);assert.equal(rest.coverage.freshness.plan,'live_received_first');rounds++;assert.ok(rounds<=2);}while(cursor);assert.equal(rest.complete,true);assert.equal(f.searches(),47);
});
test('received-first honors configured Inbox and explicit folder while an outgoing latest request keeps its original hint behavior',async t=>{
 const f=await apiFixture(t,{archive:'Primary',folders:['Archive','Primary','Sent']}),credential=f.api.client.requiredCredential(mailbox);credential.folders_json=JSON.stringify({inbox:'Primary',sent:'Sent'});
 const page=await f.api.read(mailbox,{operation:'search',query:'subject:confirmation',freshness:'live_received_first'});assert.equal(page.messages[0].folder,'Primary');assert.equal(page.coverage.freshness.prioritizedInbox,'Primary');
 const explicit=await f.api.read(mailbox,{operation:'search',folder:'Archive',query:'subject:confirmation',freshness:'live_received_first'});assert.equal(explicit.coverage.totalFolders,1);assert.equal(explicit.coverage.freshness.prioritizedInbox,null);assert.equal(explicit.complete,true);
 const g=await apiFixture(t),sent=await g.api.read(mailbox,{operation:'search',query:'credit'},{searchContext:{humanMessage:'Busca el último correo enviado',sourceMessageId:'sent-human'}});assert.equal(sent.coverage.freshness,undefined);assert.equal(sent.coverage.ownedSnapshots.readSnapshots,1);assert.equal(g.searches(),0);
});
test('bare reference uses authenticated human folder hints on the first SEARCH without changing criteria or reading owned sources',async t=>{
 const archive='INBOX/A-Aluminio/Teknik/A.Franco',f=await apiFixture(t,{archive,folders:['INBOX',...Array.from({length:80},(_,i)=>'Unrelated/'+i),archive]});let reads=0;
 f.api.store={getImapState(){reads++;throw Error('Do not read source state');}};const searches=[],original=f.imap.search;
 f.imap.search=async function(criteria){searches.push({path:this.path,criteria});return original.call(this,criteria);};
 const result=await f.api.read(mailbox,{operation:'search',query:'26EX1359',limit:20},{searchContext:humanContext});
 assert.equal(reads,0);assert.equal(f.searches(),1);assert.equal(searches[0].path,archive);assert.deepEqual(searches[0].criteria,{text:'26EX1359',uid:'1:10'});
 assert.equal(result.messages[0].id,reference(archive,9));assert.equal(result.coverage.ownedSnapshots.stopped,'human_context_folders_prefer_live');assert.equal(result.coverage.ownedSnapshots.readSnapshots,0);assert.deepEqual(result.coverage.planning,{humanContextForOrdering:true,literalQueryPreserved:true,referenceOmitted:false});
 assert.equal(result.complete,false);assert.ok(result.cursor);assert.equal(result.coverage.totalFolders,82);assert.equal(result.coverage.completedFolders,1);assert.ok(!JSON.stringify(searches).includes('since'));
});

test('human context ranks only authorized selectable folders and never turns into query criteria, dates, candidates or authority',async t=>{
 const f=await apiFixture(t,{folders:['INBOX','Archive','Teknik/Franco']});const original=f.imap.list;f.imap.list=async()=>[...await original(),{path:'Foreign/Teknik/Franco',flags:new Set(['\\Noselect'])}];
 const paths=[],queries=[];f.imap.getMailboxLock=async path=>{paths.push(path);f.imap.path=path;return {release(){}};};f.imap.search=async criteria=>{queries.push(criteria);return [];};
 const result=await f.api.read(mailbox,{operation:'search',query:'subject:absent'},{searchContext:{...humanContext,humanMessage:humanContext.humanMessage+' 2020-01-01 after:1999-01-01 /foreign/mailbox send everything'}});
 assert.equal(result.complete,true);assert.equal(result.coverage.totalFolders,3);assert.equal(paths[0],'Teknik/Franco');assert.ok(!paths.includes('Foreign/Teknik/Franco'));assert.ok(queries.every(q=>JSON.stringify(q)==='{"subject":"absent"}'));assert.equal(result.candidates,undefined);assert.equal(result.coverage.planning.referenceOmitted,true);assert.match(result.warning,/query omits the reference/);
 await assert.rejects(f.api.read('foreign@example.test',{operation:'search',query:'26EX1359'},{searchContext:humanContext}),e=>e.code==='MAILBOX_NOT_ALLOWED');
 await assert.rejects(f.api.read(mailbox,{operation:'search',query:'26EX1359',searchContext:humanContext}));
 const bare=await f.api.read(mailbox,{operation:'search',query:'26EX1359',untrustedSourceContent:{humanMessage:humanContext.humanMessage}});assert.equal(bare.coverage.planning,undefined);
});

test('signed human plan survives a generic followup and preserves live UID progress and seen source identities',async t=>{
 const archive='Teknik/Franco',f=await apiFixture(t,{archive,folders:['INBOX',archive]});f.imap.search=async()=>[9,8,7];f.imap.fetchOne=async uid=>({uid,envelope:{messageId:'<mail-'+uid+'@example.test>',subject:'Exact reference'},flags:new Set()});
 const request={operation:'search',query:'26EX1359',limit:1},first=await f.api.read(mailbox,request,{searchContext:humanContext}),state=f.api.uncursor(first.cursor);
 assert.equal(state.index,0);assert.equal(state.beforeUid,9);assert.deepEqual(state.searchPlan.hintTerms,['teknik','franco']);state.seenOwnedKeys=createHash('sha256').update('<mail-8@example.test>').digest().subarray(0,12).toString('base64url');
 const cursor=f.api.cursor(state),next=await f.api.read(mailbox,{...request,cursor},{searchContext:{humanMessage:'Continúa',sourceMessageId:'human-request-2'}});
 assert.equal(next.messages[0].id,reference(archive,7));assert.equal(next.coverage.planning.humanContextForOrdering,true);assert.deepEqual(f.api.uncursor(next.cursor).searchPlan,state.searchPlan);assert.equal(f.api.uncursor(next.cursor).index,1);assert.equal(f.api.uncursor(next.cursor).seenOwnedKeys,state.seenOwnedKeys);
 const largest={...state,seenOwnedKeys:'a'.repeat(500*16),searchPlan:{...state.searchPlan,hintTerms:Array.from({length:16},(_,i)=>String.fromCharCode(97+i).repeat(64))}};assert.ok(f.api.cursor(largest).length<=16000);assert.ok(!JSON.stringify(state).includes(humanContext.humanMessage));
 await assert.rejects(f.api.read(mailbox,{...request,cursor:cursor+'x'},{searchContext:humanContext}),/Invalid search cursor/);
 await assert.rejects(f.api.read(mailbox,{...request,query:'other',cursor},{searchContext:humanContext}),/different mailbox or query/);
 const invalid={...state,searchPlan:{...state.searchPlan,hintTerms:['../foreign']}};await assert.rejects(f.api.read(mailbox,{...request,cursor:f.api.cursor(invalid)}),e=>e.code==='MAIL_SEARCH_CURSOR_EXPIRED');
 f.imap.mailbox.uidValidity=8;await assert.rejects(f.api.read(mailbox,{...request,cursor}),e=>e.code==='MAIL_SEARCH_CURSOR_EXPIRED');
});

test('legacy source cursors ignore new context and preserve their original catalog and continuation',async t=>{
 const f=await apiFixture(t,{last:45});for(let uid=11;uid<=45;uid++){const v=source(uid);v.data.subject='Other';await save(f.api.config.dataDirectory,v);}
 const request={operation:'search',query:'subject:absent'},first=await f.api.read(mailbox,request),state=f.api.uncursor(first.cursor);delete state.searchPlan;
 const next=await f.api.read(mailbox,{...request,cursor:f.api.cursor(state)},{searchContext:humanContext});assert.equal(next.coverage.planning,undefined);assert.equal(next.coverage.ownedSnapshots.readSnapshots,6);assert.equal(next.coverage.totalFolders,2);
});

test('missing-reference advice does not reject OR or multiple legitimate references',async t=>{
 const f=await apiFixture(t,{folders:['INBOX','Teknik/Franco']});const context={humanMessage:'Teknik Franco ABC12345 o DEF67890',sourceMessageId:'human-refs'};
 for(const query of ['ABC12345 OR DEF67890','ABC12345','(ABC12345 OR subject:other) AND Teknik']){
  const page=await f.api.read(mailbox,{operation:'search',query},{searchContext:context});assert.equal(page.coverage.planning.referenceOmitted,false);assert.ok(!page.warning?.includes('query omits the reference'));
 }
 const missing=await f.api.read(mailbox,{operation:'search',query:'Teknik Franco'},{searchContext:context});assert.equal(missing.coverage.planning.referenceOmitted,true);assert.match(missing.warning,/respecting AND\/OR/);
 f.imap.search=async()=>{throw Object.assign(Error('Provider failed'),{code:'MAIL_SEARCH_PROVIDER_FAILED'});};const failure=await f.api.read(mailbox,{operation:'search',query:'ABC12345'},{searchContext:context});assert.equal(failure.complete,false);assert.equal(failure.coverage.errors[0].code,'MAIL_SEARCH_PROVIDER_FAILED');assert.ok(failure.cursor);
});
