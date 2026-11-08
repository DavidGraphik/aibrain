import test from 'node:test';
import assert from 'node:assert/strict';
import {MailApi,compileImapQuery} from '../lib/mail-api.mjs';
import {MailLocatorHints} from '../lib/mail-owned-search.mjs';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encryptToken} from '../lib/token-crypto.mjs';

function fixture(parallel=true,{delay=30,failFolder=null,budget=12000,count=20,targetIndex=11,prefix='Archive',secondaryHang=false,connectTimeout=2000,pdf=false,uidsPerMatch=1,secondaryDelay=null,targetIndices=null}={}){
 const mailbox='owner@example.test',key='11'.repeat(32),folders=['INBOX',...Array.from({length:count-1},(_,i)=>`${prefix}/${String(i).padStart(4,'0')}`)],target=folders[targetIndex],targets=new Set(targetIndices?.map(i=>folders[i])??[target]),searches=[],fetches=[];let active=0,max=0,opened=0;
 function connection(secondary=false){
  let pending=null;return {usable:true,mailbox:{uidValidity:7,uidNext:8},async connect(){opened++;if(secondary&&secondaryHang)return new Promise(()=>{});},async list(){return folders.map(path=>({path}));},async getMailboxLock(path){this.path=path;this.mailbox={uidValidity:7,uidNext:8};return {release(){}};},async search(query){const path=this.path;searches.push({path,query});active++;max=Math.max(max,active);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending=null;active--;if(path===failFolder)reject(Object.assign(Error('provider'),{code:'MAIL_SEARCH_PROVIDER_FAILED'}));else resolve(targets.has(path)?Array.from({length:uidsPerMatch},(_,i)=>7-i):[]);},secondary&&secondaryDelay!==null?secondaryDelay:delay);pending=()=>{clearTimeout(timer);pending=null;active--;reject(Error('closed'));};});},async fetchOne(uid){fetches.push({path:this.path,uid});return {uid,envelope:{subject:'needle',messageId:'<own@example.test>'},internalDate:new Date('2026-11-04T00:00:00Z'),flags:new Set(),bodyStructure:pdf?{type:'multipart/mixed',childNodes:[{type:'application/pdf',disposition:'attachment',dispositionParameters:{filename:'test.pdf'}}]}:{type:'multipart/mixed',childNodes:[]}};},close(){this.usable=false;pending?.();}};
 }
 const credential={password_encrypted:encryptToken('synthetic',key),folders_json:'{}'},client={requiredCredential(owner){assert.equal(owner,mailbox);return credential;},async withImapPassword(owner,password,fn){assert.equal(owner,mailbox);assert.equal(password,'synthetic');const primary=connection();await primary.connect();return fn(primary);}};
 if(parallel)client.createImapPassword=(owner,password)=>{assert.equal(owner,mailbox);assert.equal(password,'synthetic');return connection(true);};
 const api=new MailApi({config:{dataDirectory:'/must-not-read-owned-store',mailboxes:[{address:mailbox,name:'Owner'}],tokenEncryptionKey:key},client,signatureProvider:null,parallelBudgetMs:budget,parallelConnectMs:connectTimeout});
 return {api,mailbox,folders,searches,fetches,get max(){return max},get opened(){return opened},get active(){return active}};
}

test('two separate connections and serial finish the same full result page',async()=>{
 const serial=fixture(false),parallel=fixture(true),input={operation:'search',query:'needle',limit:20};
 const [a,b]=await Promise.all([serial.api.read(serial.mailbox,input),parallel.api.read(parallel.mailbox,input)]);
 assert.equal(a.messages.length,1);assert.equal(b.messages.length,1);assert.equal(a.messages[0].id,b.messages[0].id);
 assert.equal(a.complete,true);assert.equal(b.complete,true);assert.equal(a.cursor,null);assert.equal(b.cursor,null);
 assert.equal(parallel.max,2);assert.equal(parallel.opened,2);assert.equal(parallel.active,0);
 assert.deepEqual(b.coverage.parallelExecution,{attempted:true,mode:'parallel'});assert.equal(b.coverage.parallelTiming.connections,2);assert.ok(b.coverage.parallelTiming.selectMs>=0);assert.ok(b.coverage.parallelTiming.searchMs>=0);
});
test('secondary connection timeout is explicit and preserves serial results',async()=>{
 const f=fixture(true,{delay:2,count:2,targetIndex:1,secondaryHang:true,connectTimeout:40});
 const page=await f.api.read(f.mailbox,{operation:'search',query:'needle'});
 assert.deepEqual(page.coverage.parallelExecution,{attempted:true,mode:'serial_fallback',reason:'connection_timeout'});
 assert.equal(page.messages.length,1);assert.equal(f.max,1);assert.equal(page.complete,true);
});
test('a stalled pair closes both connections and preserves cursor without claiming absence',async()=>{
 const f=fixture(true,{delay:1000,budget:50}),start=performance.now();
 const page=await f.api.read(f.mailbox,{operation:'search',query:'needle'});
 assert.ok(performance.now()-start<500);assert.equal(page.complete,false);assert.equal(page.messages.length,0);assert.equal(page.coverage.stopped,'time_budget');assert.equal(f.api.uncursor(page.cursor).index,0);assert.equal(f.active,0);
});
test('later provider error retains earlier completed folder and incomplete cursor',async()=>{
 const f=fixture(true,{delay:10,failFolder:'Archive/0000'});
 const page=await f.api.read(f.mailbox,{operation:'search',query:'needle'});
 assert.equal(page.complete,false);assert.equal(page.messages.length,0);assert.equal(page.coverage.stopped,'folder_error');assert.equal(page.coverage.errors[0].code,'MAIL_SEARCH_PROVIDER_FAILED');assert.equal(f.api.uncursor(page.cursor).index,1);assert.equal(f.active,0);
});
test('changed UIDVALIDITY on a continued folder refuses the page and closes speculation',async()=>{
 const f=fixture(true,{delay:1000,budget:50}),first=await f.api.read(f.mailbox,{operation:'search',query:'needle'}),state=f.api.uncursor(first.cursor);
 state.beforeUid=7;state.uidValidity='1';
 await assert.rejects(f.api.read(f.mailbox,{operation:'search',query:'needle',cursor:f.api.cursor(state)}),{code:'MAIL_SEARCH_CURSOR_EXPIRED'});
 assert.equal(f.active,0);
});
test('870 cold folders preserve exact result and cursor across multiple pages',async t=>{
 async function locate(f){let cursor,page;const start=performance.now();for(let i=0;i<5;i++){page=await f.api.read(f.mailbox,{operation:'search',query:'needle',...(cursor?{cursor}:{})});if(page.messages.length)break;assert.equal(page.complete,false);cursor=page.cursor;assert.ok(cursor);}return {page,ms:performance.now()-start};}
 const serial=fixture(false,{count:870,targetIndex:65,delay:5}),parallel=fixture(true,{count:870,targetIndex:65,delay:5});
 const a=await locate(serial),b=await locate(parallel);
 assert.equal(a.page.messages[0].id,b.page.messages[0].id);assert.equal(a.page.complete,false);assert.equal(b.page.complete,false);
 assert.equal(serial.api.uncursor(a.page.cursor).index,parallel.api.uncursor(b.page.cursor).index);assert.equal(parallel.max,2);
 t.diagnostic(JSON.stringify({syntheticFolders:870,serialMs:Math.round(a.ms),parallelMs:Math.round(b.ms),providerCalls:'synthetic-only'}));
});
test('Company-shaped human context uses two connections on company folders',async()=>{
 const f=fixture(true,{count:870,targetIndex:11,delay:2,prefix:'INBOX/FICTALCO/Clientes'}),query='subject_reference:"87654321-X:987654" after:2026-11-03 before:2026-11-06 Fictalco';
 const page=await f.api.read(f.mailbox,{operation:'search',query,limit:20},{searchContext:{humanMessage:'Busca Fictalco 87654321-X:987654 y el original Fictional D26110409180.pdf',sourceMessageId:'human'}});
 assert.equal(f.max,2);assert.equal(f.opened,2);assert.equal(page.messages.length,1);assert.equal(page.complete,false);assert.equal(page.coverage.totalFolders,870);assert.equal(page.coverage.ownedSnapshots.stopped,'human_context_folders_prefer_live');
});
test('two-required-term contextual folders also use parallel search without dropping remaining catalog',async()=>{
 const f=fixture(true,{count:870,targetIndex:11,delay:2,prefix:'INBOX/FICTALCO/HEXPOL'}),query='Fictalco Exempl 87654321';
 const page=await f.api.read(f.mailbox,{operation:'search',query},{searchContext:{humanMessage:'Busca Fictalco Exempl 87654321',sourceMessageId:'human'}});
 assert.equal(f.max,2);assert.equal(f.opened,2);assert.equal(page.messages.length,1);assert.equal(page.complete,false);assert.ok(page.cursor);assert.equal(page.coverage.totalFolders,870);
});
test('explicit folder keeps sequential behavior and is not cut off by parallel budget',async()=>{
 const f=fixture(true,{delay:80,budget:20});const start=performance.now();
 const page=await f.api.read(f.mailbox,{operation:'search',query:'needle',folder:'INBOX'});
 assert.ok(performance.now()-start>=60);assert.equal(f.opened,1);assert.equal(f.max,1);assert.equal(page.complete,true);
});

test('latest received PDF searches concurrently without claiming global latest',async()=>{
 const serial=fixture(false,{count:40,targetIndex:9,delay:5,pdf:true}),parallel=fixture(true,{count:40,targetIndex:9,delay:5,pdf:true});
 async function first(f){let cursor;for(let n=0;n<5;n++){const page=await f.api.read(f.mailbox,{operation:'search',query:'needle',freshness:'live_received_first',attachmentMime:'application/pdf',...(cursor?{cursor}:{})});if(page.messages.length)return page;assert.equal(page.complete,false);cursor=page.cursor;}throw Error('missing synthetic match');}
 const a=await first(serial),b=await first(parallel);assert.equal(a.messages[0].id,b.messages[0].id);assert.equal(b.coverage.freshness.globalLatestVerified,false);assert.equal(b.complete,true);assert.equal(parallel.max,2);assert.equal(parallel.active,0);assert.equal(b.coverage.parallelExecution.mode,'parallel');
});
test('PDF metadata cap keeps an incomplete folder cursor instead of losing unexamined messages',async()=>{
 const f=fixture(true,{count:4,targetIndex:0,delay:2,pdf:false,uidsPerMatch:7});
 const first=await f.api.read(f.mailbox,{operation:'search',query:'needle',freshness:'live_received_first',attachmentMime:'application/pdf',limit:3});
 assert.equal(first.messages.length,0);assert.equal(first.complete,false);assert.equal(first.coverage.attachmentFilter.checkedMetadataThisPage,3);const state=f.api.uncursor(first.cursor);assert.equal(state.index,0);assert.equal(state.beforeUid,5);assert.equal(state.uidValidity,'7');
});

test('faster second search cannot skip the earlier PDF folder',async()=>{
 const f=fixture(true,{count:4,targetIndex:1,delay:50,secondaryDelay:1,pdf:true});
 const page=await f.api.read(f.mailbox,{operation:'search',query:'needle',freshness:'live_received_first',attachmentMime:'application/pdf'});
 assert.equal(page.messages.length,1);assert.equal(page.coverage.completedFolders,4);assert.equal(page.complete,true);assert.equal(page.coverage.freshness.globalLatestVerified,false);assert.equal(f.max,2);
});

test('latest PDF may cover 120 empty folders per page while preserving chronological uncertainty and cursor',async()=>{
 const f=fixture(true,{count:200,targetIndex:150,delay:1,pdf:true}),request={operation:'search',query:'needle',freshness:'live_received_first',attachmentMime:'application/pdf'};
 const first=await f.api.read(f.mailbox,request);assert.equal(first.messages.length,0);assert.equal(first.complete,false);assert.equal(first.coverage.completedFolders,120);assert.equal(first.coverage.parallelTiming.attemptedFolders,120);assert.equal(first.coverage.freshness.globalLatestVerified,false);assert.equal(f.api.uncursor(first.cursor).index,120);
 const next=await f.api.read(f.mailbox,{...request,cursor:first.cursor});assert.equal(next.messages.length,1);assert.equal(next.complete,true);assert.equal(next.coverage.freshness.globalLatestVerified,false);assert.equal(f.max,2);assert.equal(f.active,0);
});

test('larger empty-page allowance retains the same hard time budget and cursor',async()=>{
 const f=fixture(true,{count:200,targetIndex:150,delay:1000,budget:50,pdf:true}),start=performance.now();
 const page=await f.api.read(f.mailbox,{operation:'search',query:'needle',freshness:'live_received_first',attachmentMime:'application/pdf'});
 assert.ok(performance.now()-start<500);assert.equal(page.complete,false);assert.equal(page.coverage.stopped,'time_budget');assert.equal(f.api.uncursor(page.cursor).index,0);assert.equal(f.active,0);
});

test('latest PDF page accumulates exhausted matching folders under one bounded metadata budget',async()=>{
 const f=fixture(true,{count:10,targetIndices:[0,2],delay:2,pdf:true});const p=await f.api.read(f.mailbox,{operation:'search',query:'needle',freshness:'live_received_first',attachmentMime:'application/pdf',limit:10});
 assert.equal(p.messages.length,2);assert.notEqual(p.messages[0].folder,p.messages[1].folder);assert.equal(p.coverage.attachmentFilter.checkedMetadataThisPage,2);assert.equal(p.coverage.freshness.globalLatestVerified,false);assert.equal(f.max,2);assert.equal(f.active,0);
});
test('latest PDF page cannot consume beyond its metadata cap and retains folder cursor',async()=>{
 const f=fixture(true,{count:5,targetIndices:[0,1],delay:2,pdf:true,uidsPerMatch:7});const p=await f.api.read(f.mailbox,{operation:'search',query:'needle',freshness:'live_received_first',attachmentMime:'application/pdf',limit:3});
 assert.equal(p.messages.length,3);assert.equal(p.coverage.attachmentFilter.checkedMetadataThisPage,3);assert.equal(p.complete,false);const state=f.api.uncursor(p.cursor);assert.equal(state.index,0);assert.equal(state.beforeUid,5);
});

test('latest accumulation retains earlier match and reports later provider failure as partial',async()=>{
 const f=fixture(true,{count:5,targetIndex:0,failFolder:'Archive/0000',delay:2,pdf:true});const p=await f.api.read(f.mailbox,{operation:'search',query:'needle',freshness:'live_received_first',attachmentMime:'application/pdf',limit:10});
 assert.equal(p.messages.length,1);assert.equal(p.complete,false);assert.equal(p.coverage.errors[0].code,'MAIL_SEARCH_PROVIDER_FAILED');assert.equal(f.api.uncursor(p.cursor).index,1);assert.equal(f.active,0);
});

test('ordinary pages accumulate matching folders and resume exact unconsumed UID at the limit',async()=>{
 for(const parallel of [false,true]){
  const f=fixture(parallel,{delay:2,count:4,targetIndices:[0,1],uidsPerMatch:2});const request={operation:'search',query:'needle',limit:3};
  const first=await f.api.read(f.mailbox,request);assert.equal(first.messages.length,3);assert.equal(first.complete,false);
  const state=f.api.uncursor(first.cursor);assert.equal(state.index,1);assert.equal(state.beforeUid,7);
  const second=await f.api.read(f.mailbox,{...request,cursor:first.cursor});assert.equal(second.messages.length,1);assert.equal(second.complete,true);
  assert.equal(new Set([...first.messages,...second.messages].map(m=>m.id)).size,4);assert.equal(f.active,0);
 }
});
test('limit1 remains first-match and never fetches speculative later metadata',async()=>{
 const f=fixture(true,{delay:20,secondaryDelay:1,count:5,targetIndices:[0,1]});
 const page=await f.api.read(f.mailbox,{operation:'search',query:'needle',limit:1});
 assert.equal(page.messages.length,1);assert.equal(f.api.uncursor(page.cursor).index,1);assert.deepEqual(f.fetches,[{path:'INBOX',uid:7}]);assert.equal(f.active,0);
});
test('ordinary accumulation keeps earlier matches and exact cursor when the later folder times out',async()=>{
 const f=fixture(true,{delay:2,secondaryDelay:100,budget:30,count:4,targetIndices:[0,1]});
 const page=await f.api.read(f.mailbox,{operation:'search',query:'needle',limit:10});
 assert.equal(page.messages.length,1);assert.equal(page.complete,false);assert.equal(page.coverage.stopped,'time_budget');assert.equal(f.api.uncursor(page.cursor).index,1);assert.equal(f.active,0);
 f.api.parallelBudgetMs=2000;const resumed=await f.api.read(f.mailbox,{operation:'search',query:'needle',limit:10,cursor:page.cursor});
 assert.equal(resumed.messages.length,1);assert.notEqual(resumed.messages[0].id,page.messages[0].id);assert.equal(resumed.complete,true);
});
test('warm locator priority remains serial until fully consumed then reuses the existing parallel pool',async t=>{
 const f=fixture(true,{delay:2,count:5,targetIndices:[0,3],uidsPerMatch:2});const directory=await realpath(await mkdtemp(join(tmpdir(),'mail-priority-page-')));t.after(()=>rm(directory,{recursive:true,force:true}));f.api.config.dataDirectory=directory;
 const query='subject:"needle ZX778899"',request={operation:'search',query,limit:1};
 await new MailLocatorHints(directory,f.mailbox).remember(compileImapQuery(query),[{folder:'INBOX',id:'imap:SU5CT1g:7:7'}],f.folders);
 const first=await f.api.read(f.mailbox,request);assert.equal(first.coverage.locatorFolderPriority.foldersPrioritized,1);assert.equal(f.api.uncursor(first.cursor).index,0);assert.equal(f.max,1);assert.equal(f.opened,1);
 const second=await f.api.read(f.mailbox,{...request,cursor:first.cursor});assert.equal(f.api.uncursor(second.cursor).index,1);assert.equal(f.max,1);assert.equal(f.opened,2);
 const third=await f.api.read(f.mailbox,{...request,limit:10,cursor:second.cursor});assert.equal(third.coverage.parallelExecution.mode,'parallel');assert.equal(f.max,2);assert.equal(third.messages.length,2);assert.equal(third.complete,true);
 assert.equal(f.searches.filter(x=>x.path==='INBOX').length,2);assert.equal(new Set([...first.messages,...second.messages,...third.messages].map(m=>m.id)).size,4);assert.equal(f.active,0);
});
