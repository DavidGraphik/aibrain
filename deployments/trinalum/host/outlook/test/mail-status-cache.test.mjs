import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir as nativeTmpdir} from 'node:os';
import {realpathSync as canonicalTmpPath} from 'node:fs';
const tmpdir=()=>canonicalTmpPath(nativeTmpdir());import {join} from 'node:path';
import {MailApi} from '../lib/mail-api.mjs';import {encryptToken} from '../lib/token-crypto.mjs';import {listWithOptionalStatus,validFolderStatus} from '../lib/mail-status-list.mjs';
const key='11'.repeat(32),a='owner@example.test',b='other@example.test';
async function fixture(t,{status=true,uidNext=8,validity=7,messages=2,afterSearch=null,selectNext=null,searchUids=[]}={}){
 const root=await mkdtemp(join(tmpdir(),'mail-empty-cache-'));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0,listed=0;
 const current={uidNext,validity,messages},imap={capabilities:new Set(status?['LIST-STATUS']:[]),mailbox:{},run:async()=>{throw Error('unexpected fallback')},async list(options){listed++;return [{path:'INBOX',flags:new Set(),...(options?.statusQuery?{status:{messages:current.messages,uidNext:current.uidNext,uidValidity:current.validity}}:{})}];},async getMailboxLock(){calls++;this.mailbox={uidValidity:current.validity,uidNext:selectNext??current.uidNext};return {release(){}};},async search(){if(afterSearch){afterSearch(current,this);afterSearch=null;}return searchUids;},async fetchOne(uid){return {uid,envelope:{subject:'needle',messageId:`<${uid}@example.test>`},internalDate:new Date('2026-01-01T00:00:00Z'),flags:new Set(),bodyStructure:{type:'multipart/mixed',childNodes:[]}};}};
 const credential={password_encrypted:encryptToken('pw',key),folders_json:'{}'},client={requiredCredential:()=>credential,withImapPassword:async(_m,_p,fn)=>fn(imap)};
 const api=new MailApi({config:{dataDirectory:root,mailboxes:[{address:a,name:'A'},{address:b,name:'B'}],tokenEncryptionKey:key},client,signatureProvider:null});
 return {api,current,imap,get calls(){return calls},get listed(){return listed}};
}
test('LIST-STATUS never sends STATUS fallback or LSUB',async()=>{
 let sent=0;const imap={capabilities:new Set(['LIST-STATUS']),skipLsub:false,async run(){sent++;},async list(options){assert.deepEqual(options.statusQuery,{messages:true,uidNext:true,uidValidity:true});assert.equal(this.skipLsub,true);try{await this.run('STATUS','folder');}catch{}return [];}};
 const r=await listWithOptionalStatus(imap);assert.equal(sent,0);assert.equal(r.fallbackBlocked,1);assert.equal(imap.skipLsub,false);assert.equal(validFolderStatus({uidNext:1,uidValidity:1,messages:0}).messages,'0');assert.equal(validFolderStatus({uidNext:1,uidValidity:1,messages:null}),null);
});
test('fully searched empty query cache is isolated by owner, query and fresh UID status',async t=>{
 const f=await fixture(t),request={operation:'search',query:'subject:needle'};
 await f.api.read(a,request);assert.equal(f.calls,1);let x=await f.api.read(a,request);assert.equal(f.calls,1);assert.equal(x.coverage.folderStatusSnapshot.cachedEmptySkipped,1);
 await f.api.read(b,request);assert.equal(f.calls,2);await f.api.read(a,{...request,query:'subject:other'});assert.equal(f.calls,3);
 f.current.uidNext=9;await f.api.read(a,request);assert.equal(f.calls,4);f.current.validity=8;await f.api.read(a,request);assert.equal(f.calls,5);
});
test('physical emptiness is a point-in-time provider status, not a cached positive',async t=>{
 const f=await fixture(t,{messages:0});const p=await f.api.read(a,{operation:'search',query:'subject:needle'});assert.equal(f.calls,0);assert.equal(p.coverage.folderStatusSnapshot.emptySkipped,1);assert.equal(p.coverage.folderStatusSnapshot.pointInTimeOnly,true);
 f.current.messages=1;f.current.uidNext=9;await f.api.read(a,{operation:'search',query:'subject:needle'});assert.equal(f.calls,1);
});
test('mutable flags and missing status cannot use a negative cache',async t=>{
 const f=await fixture(t),q={operation:'search',query:'is:unread'};await f.api.read(a,q);await f.api.read(a,q);assert.equal(f.calls,2);
 const missing=await fixture(t,{status:false});await missing.api.read(a,{operation:'search',query:'subject:needle'});await missing.api.read(a,{operation:'search',query:'subject:needle'});assert.equal(missing.calls,2);
});
test('UIDNEXT recorded before search invalidates the empty cache when a new message arrives',async t=>{
 const f=await fixture(t,{afterSearch:(state,imap)=>{state.uidNext=9;imap.mailbox.uidNext=9;}}),q={operation:'search',query:'subject:needle'};
 await f.api.read(a,q);assert.equal(f.calls,1);await f.api.read(a,q);assert.equal(f.calls,2);
});
test('UID change between LIST and SELECT is never recorded as matching empty proof',async t=>{
 const f=await fixture(t,{selectNext:9}),q={operation:'search',query:'subject:needle'};await f.api.read(a,q);await f.api.read(a,q);assert.equal(f.calls,2);
});
test('continued partial folder cannot be cached as entirely empty',async t=>{
 const f=await fixture(t,{searchUids:[7,6]}),q={operation:'search',query:'subject:needle',limit:1};const first=await f.api.read(a,q);assert.equal(first.messages.length,1);assert.equal(first.complete,false);
 await f.api.read(a,{...q,cursor:first.cursor});await f.api.read(a,q);assert.equal(f.calls,3);
});

test('deleting unmatched messages cannot invalidate an empty query proof when UIDNEXT is unchanged',async t=>{
 const f=await fixture(t,{messages:2}),q={operation:'search',query:'subject:needle'};await f.api.read(a,q);assert.equal(f.calls,1);f.current.messages=1;const p=await f.api.read(a,q);assert.equal(f.calls,1);assert.equal(p.coverage.folderStatusSnapshot.cachedEmptySkipped,1);
});

test('negative proof retention expires after 24 hours; every hit still needs fresh UIDNEXT and UIDVALIDITY',async t=>{
 const {EmptyFolderSearchCache}=await import('../lib/mail-owned-search.mjs');const root=await mkdtemp(join(tmpdir(),'negative-retention-'));t.after(()=>rm(root,{recursive:true,force:true}));let time=1_800_000_000_000;
 const cache=new EmptyFolderSearchCache(root,a,{now:()=>time}),criteria={subject:'needle'},status={uidNext:'8',uidValidity:'7',messages:'2'},map=new Map([['INBOX',status]]);
 await cache.remember(criteria,null,[{folder:'INBOX',status}]);time+=23*60*60*1000;assert.equal((await cache.matching(criteria,null,map)).has('INBOX'),true);
 assert.equal((await cache.matching(criteria,null,new Map([['INBOX',{...status,uidNext:'9'}]]))).size,0);time+=2*60*60*1000;assert.equal((await cache.matching(criteria,null,map)).size,0);
});

test('parallel skips a fresh empty folder and still commits later PDF matches',async t=>{
 const root=await mkdtemp(join(tmpdir(),'parallel-status-'));t.after(()=>rm(root,{recursive:true,force:true}));let searches=0;
 function connection(){return {usable:true,capabilities:new Set(['LIST-STATUS']),async connect(){},close(){this.usable=false;},run:async()=>{},async list(){return [{path:'INBOX',flags:new Set(),status:{messages:0,uidNext:1,uidValidity:7}},{path:'Archive',flags:new Set(),status:{messages:1,uidNext:2,uidValidity:7}}];},async getMailboxLock(p){this.path=p;this.mailbox={uidValidity:7,uidNext:2};return {release(){}};},async search(){searches++;return this.path==='Archive'?[1]:[];},async fetchOne(uid){return {uid,envelope:{subject:'needle'},internalDate:new Date('2026-01-01'),flags:new Set(),bodyStructure:{type:'multipart/mixed',childNodes:[{type:'application/pdf',disposition:'attachment',dispositionParameters:{filename:'test.pdf'}}]}};}};}
 const credential={password_encrypted:encryptToken('pw',key),folders_json:'{}'},client={requiredCredential:()=>credential,withImapPassword:async(_m,_p,fn)=>fn(connection()),createImapPassword:()=>connection()};
 const api=new MailApi({config:{dataDirectory:root,mailboxes:[{address:a,name:'A'}],tokenEncryptionKey:key},client,signatureProvider:null});const p=await api.read(a,{operation:'search',query:'subject:needle',freshness:'live_received_first',attachmentMime:'application/pdf'});
 assert.equal(p.messages.length,1);assert.equal(p.coverage.folderStatusSnapshot.emptySkipped,1);assert.equal(searches,1);assert.equal(p.coverage.freshness.globalLatestVerified,false);
});

test('BODY windows never prove a complete empty folder or enter the negative cache',async t=>{
 const f=await fixture(t,{uidNext:10000}),q={operation:'search',query:'body:needle'};const first=await f.api.read(a,q);assert.equal(first.complete,false);assert.ok(first.cursor);const before=f.calls;await f.api.read(a,q);assert.ok(f.calls>before);
});
test('complete MIME metadata with no PDF may be cached; unknown MIME cannot',async t=>{
 const f=await fixture(t,{searchUids:[7,6]}),q={operation:'search',query:'subject:needle',attachmentMime:'application/pdf'};
 const first=await f.api.read(a,q);assert.equal(first.messages.length,0);assert.equal(first.coverage.attachmentFilter.checkedMetadataThisPage,2);await f.api.read(a,q);assert.equal(f.calls,1);
 const g=await fixture(t,{searchUids:[7]});g.imap.fetchOne=async uid=>({uid,envelope:{subject:'needle'},internalDate:new Date('2026-01-01'),flags:new Set()});
 const uncertain=await g.api.read(a,q);assert.equal(uncertain.complete,false);assert.equal(uncertain.coverage.errors[0].code,'MAIL_ATTACHMENT_METADATA_UNAVAILABLE');await g.api.read(a,q);assert.equal(g.calls,2);
});
test('a previously cached query cannot skip a folder when fresh status fields disappear',async t=>{
 const f=await fixture(t),q={operation:'search',query:'subject:needle'};await f.api.read(a,q);assert.equal(f.calls,1);
 f.imap.list=async()=>[{path:'INBOX',flags:new Set(),status:{messages:2,uidValidity:7}}];await f.api.read(a,q);assert.equal(f.calls,2);
});

test('corrupt optional negative cache fails open to the live provider',async t=>{
 const {writeFile}=await import('node:fs/promises');const {EmptyFolderSearchCache}=await import('../lib/mail-owned-search.mjs');const f=await fixture(t),q={operation:'search',query:'subject:needle'};await f.api.read(a,q);assert.equal(f.calls,1);
 const cache=new EmptyFolderSearchCache(f.api.config.dataDirectory,a);await writeFile(cache.file,'{}',{mode:0o600});await f.api.read(a,q);assert.equal(f.calls,2);
});

test('native limit above 20 cannot exceed the per-page MIME metadata budget',async t=>{
 const f=await fixture(t,{uidNext:40,searchUids:Array.from({length:39},(_,i)=>39-i)});const q={operation:'search',query:'subject:needle',freshness:'live_received_first',attachmentMime:'application/pdf',limit:50};
 const p=await f.api.read(a,q);assert.equal(p.coverage.attachmentFilter.checkedMetadataThisPage,20);assert.equal(p.coverage.attachmentFilter.metadataLimit,20);assert.equal(p.complete,false);assert.equal(f.api.uncursor(p.cursor).beforeUid,20);
});

test('negative cache keeps a mailbox-scale set inside its strict entry and byte budget',async t=>{
 const {readFile,stat}=await import('node:fs/promises');const {EmptyFolderSearchCache}=await import('../lib/mail-owned-search.mjs');const root=await mkdtemp(join(tmpdir(),'negative-scale-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const cache=new EmptyFolderSearchCache(root,a),criteria={subject:'needle'},status={uidNext:'8',uidValidity:'7',messages:'2'},items=Array.from({length:870},(_,i)=>({folder:'folder-'+i,status}));
 await cache.remember(criteria,null,items);const raw=await readFile(cache.file,'utf8'),data=JSON.parse(raw);assert.equal(data.entries.length,870);assert.ok((await stat(cache.file)).size<=256*1024);assert.equal((await cache.matching(criteria,null,new Map(items.map(x=>[x.folder,x.status])))).size,870);assert.equal(raw.includes('folder-'),false);assert.equal(raw.includes('needle'),false);
});

test('status-shaped unsolicited metadata is ignored when LIST-STATUS was not requested',async t=>{
 const f=await fixture(t,{status:false});f.imap.list=async()=>[{path:'INBOX',flags:new Set(),status:{messages:0,uidNext:1,uidValidity:7}}];
 await f.api.read(a,{operation:'search',query:'subject:needle'});assert.equal(f.calls,1);
});

test('continued folder refuses changed UIDVALIDITY even when fresh status reports empty',async t=>{
 const f=await fixture(t,{searchUids:[7,6]}),q={operation:'search',query:'subject:needle',limit:1};const first=await f.api.read(a,q);assert.equal(first.complete,false);
 f.current.validity=8;f.current.messages=0;await assert.rejects(f.api.read(a,{...q,cursor:first.cursor}),{code:'MAIL_SEARCH_CURSOR_EXPIRED'});
});
