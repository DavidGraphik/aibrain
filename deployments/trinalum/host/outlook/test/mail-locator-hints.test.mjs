import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,writeFile,lstat,chmod,symlink,link,unlink,chown,readdir,realpath} from 'node:fs/promises';
import {tmpdir as nativeTmpdir} from 'node:os';
import {realpathSync as canonicalTmpPath} from 'node:fs';
const tmpdir=()=>canonicalTmpPath(nativeTmpdir());
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {MailLocatorHints,mailLocatorSelector,validMailLocatorPlan,MAIL_LOCATOR_HINT_LIMITS,orderingMailSearchFoldersV2} from '../lib/mail-owned-search.mjs';
import {MailApi,compileImapQuery} from '../lib/mail-api.mjs';
import {encryptToken} from '../lib/token-crypto.mjs';

const mailbox='owner@example.test',other='foreign@example.test';
const ref=(folder,uid=7,generation='9')=>`imap:${Buffer.from(folder).toString('base64url')}:${generation}:${uid}`;
const match=folder=>({id:ref(folder),folder,subject:'Provider content is not a selector'});
const criteria=compileImapQuery('subject:"Acme 778899ZX" after:2001-01-01');
async function root(t){const p=await realpath(await mkdtemp(join(tmpdir(),'mail-locator-hints-')));t.after(()=>rm(p,{force:true,recursive:true}));return p;}
async function store(t){const path=await root(t);let now=1800000000000;return {path,hints:new MailLocatorHints(path,mailbox,{now:()=>now}),setNow:value=>{now=value;},now:()=>now};}

test('cold reads create no cache; exact future live matches privately persist ordering metadata only',async t=>{
 const f=await store(t);assert.deepEqual(await f.hints.folders(criteria,['INBOX','Acme']),[]);assert.deepEqual(await readdir(f.path),[]);
 assert.equal(await f.hints.remember(criteria,[match('Acme'),match('Acme')],['INBOX','Acme']),true);
 const dir=await lstat(f.hints.root),s=await lstat(f.hints.file),data=JSON.parse(await readFile(f.hints.file,'utf8'));
 assert.equal(dir.mode&0o7777,0o700);assert.equal(s.mode&0o7777,0o600);assert.equal(s.uid,process.getuid());assert.equal(s.gid,(await lstat(f.path)).gid);
 assert.equal(data.entries.length,1);assert.deepEqual(Object.keys(data.entries[0]).sort(),['expiresAt','folder','key','learnedAt','tokens','uidValidity']);
 assert.equal(JSON.stringify(data).includes('Provider content'),false);assert.equal(JSON.stringify(data).includes('778899ZX'),false);assert.equal(data.entries[0].expiresAt-f.now(),7*86400000);
 assert.deepEqual(await f.hints.folders(criteria,['INBOX','Acme']),['Acme']);assert.deepEqual(await f.hints.folders(criteria,['INBOX']),[]);
 f.setNow(f.now()+MAIL_LOCATOR_HINT_LIMITS.ttlMs);assert.deepEqual(await f.hints.folders(criteria,['Acme']),[]);
});

test('query keys retain dates, literal fields and OR structure without changing the original criteria',()=>{
 const q=compileImapQuery('subject:(Acme OR Zenith) after:2001-01-01'),before=structuredClone(q);
 assert.notEqual(mailLocatorSelector(q).key,mailLocatorSelector(compileImapQuery('subject:(Acme Zenith) after:2001-01-01')).key);
 assert.notEqual(mailLocatorSelector(q).key,mailLocatorSelector(compileImapQuery('body:(Acme OR Zenith) after:2001-01-01')).key);
 assert.notEqual(mailLocatorSelector(q).key,mailLocatorSelector(compileImapQuery('subject:(Acme OR Zenith) after:2001-01-02')).key);
 assert.deepEqual(q,before);for(const q of ['','invoice credit note','after:2001-01-01'])assert.equal(mailLocatorSelector(compileImapQuery(q)),null);assert.equal(mailLocatorSelector({not:{subject:'Acme'}}),null);
});

test('owner-derived filenames isolate owners before opening; foreign payload is rejected',async t=>{
 const f=await store(t);await f.hints.remember(criteria,[match('Acme')],['Acme']);const foreign=new MailLocatorHints(f.path,other,{now:f.now}),opened=[];
 const read=foreign.readFile.bind(foreign);foreign.readFile=async(scope,path,limit)=>{opened.push(path);return read(scope,path,limit);};
 assert.deepEqual(await foreign.folders(criteria,['Acme']),[]);assert.deepEqual(opened,[foreign.file]);assert.notEqual(foreign.file,f.hints.file);
 await writeFile(foreign.file,await readFile(f.hints.file),{mode:0o600});await assert.rejects(foreign.folders(criteria,['Acme']),/Unsafe/);
});

test('never learns historical, relaxed, foreign-path or nonexistent-folder candidates',async t=>{
 const f=await store(t);for(const value of [
  {...match('Acme'),id:'imap:snapshot-v2:untrusted'},
  {...match('Acme'),source:'owned_snapshot'},
  {...match('Acme'),matchType:'folder_candidate'},
  {...match('Acme'),exactQueryMatched:false},
  {...match('Acme'),folder:'Other'},match('Missing'),{...match('Acme'),id:ref('Acme',0)},
 ])assert.equal(await f.hints.remember(criteria,[value],['Acme']),false);
 assert.equal(await f.hints.remember(compileImapQuery('invoice'),[match('Acme')],['Acme']),false);assert.deepEqual(await readdir(f.path),[]);
});

test('caps count, serialized bytes, selection and TTL while evicting only own metadata',async t=>{
 const f=await store(t);for(let i=0;i<70;i++){
  f.setNow(f.now()+1);const query=compileImapQuery('subject:"Acme '+String(i).padStart(5,'0')+'"'),folder='Acme/'+i+'x'.repeat(1000);
  await f.hints.remember(query,[match(folder)],[folder]);
 }
 const raw=await readFile(f.hints.file),value=JSON.parse(raw);assert.ok(raw.length<=65536);assert.ok(value.entries.length<=64);assert.ok(value.entries.length<64);assert.ok(value.entries.every(e=>e.folder!=='Acme/0'+'x'.repeat(1000)));
 const dirs=['Acme/A','Acme/B','Acme/C','Acme/D'];await f.hints.remember(criteria,dirs.map(match),dirs);assert.equal((await f.hints.folders(criteria,dirs)).length,3);
});

test('symlink directories/files, hardlinks, permissive mode and oversized files fail before content reads',async t=>{
 const f=await store(t),outside=await root(t);await symlink(outside,f.hints.root);await assert.rejects(f.hints.folders(criteria,['Acme']));await unlink(f.hints.root);
 await f.hints.remember(criteria,[match('Acme')],['Acme']);const raw=await readFile(f.hints.file);
 await unlink(f.hints.file);await writeFile(join(outside,'foreign'),raw,{mode:0o600});await symlink(join(outside,'foreign'),f.hints.file);await assert.rejects(f.hints.folders(criteria,['Acme']));await unlink(f.hints.file);
 await link(join(outside,'foreign'),f.hints.file);await assert.rejects(f.hints.folders(criteria,['Acme']));await unlink(f.hints.file);
 await writeFile(f.hints.file,raw,{mode:0o600});await chmod(f.hints.file,0o644);await assert.rejects(f.hints.folders(criteria,['Acme']));assert.equal((await lstat(f.hints.file)).mode&0o777,0o644);
 await chmod(f.hints.file,0o600);await writeFile(f.hints.file,'x'.repeat(65537));await assert.rejects(f.hints.folders(criteria,['Acme']));
});

test('a file replaced after open is not accepted as a hint',async t=>{
 const f=await store(t);await f.hints.remember(criteria,[match('Acme')],['Acme']);const check=f.hints.check.bind(f.hints);let calls=0;
 f.hints.check=async scope=>{await check(scope);if(++calls===3){const raw=await readFile(f.hints.file);await unlink(f.hints.file);await writeFile(f.hints.file,raw,{mode:0o600});}};
 await assert.rejects(f.hints.folders(criteria,['Acme']));
});

test('busy writers do not wait or overwrite; a dead writer lock is removed for a later search',async t=>{
 const f=await store(t);await f.hints.remember(criteria,[match('Acme')],['Acme']);const lock=f.hints.file+'.lock';await writeFile(lock,JSON.stringify({pid:process.pid}),{mode:0o600});
 assert.equal(await f.hints.remember(criteria,[match('Acme')],['Acme']),false);assert.equal(JSON.parse(await readFile(lock)).pid,process.pid);
 await writeFile(lock,JSON.stringify({pid:2147483647}));assert.equal(await f.hints.remember(criteria,[match('Acme')],['Acme']),false);await assert.rejects(lstat(lock),{code:'ENOENT'});
 assert.equal(await f.hints.remember(criteria,[match('Acme')],['Acme']),true);
});

test('root normalizes only a newly created directory for a999:987 data root', {skip:process.getuid()!==0},async t=>{
 const f=await store(t);await chown(f.path,999,987);await f.hints.remember(criteria,[match('Acme')],['Acme']);assert.equal((await lstat(f.hints.root)).uid,999);assert.equal((await lstat(f.hints.file)).gid,987);
 const otherRoot=await root(t);await chown(otherRoot,999,987);const foreign=new MailLocatorHints(otherRoot,mailbox);await mkdir(foreign.root,{mode:0o700});await assert.rejects(foreign.remember(criteria,[match('Acme')],['Acme']));assert.equal((await lstat(foreign.root)).uid,0);
});

async function apiFixture(t){
 const path=await root(t),folders=[...Array.from({length:65},(_,i)=>'Acme/'+String(i).padStart(3,'0')),'Acme/zz-target','INBOX'],target='Acme/zz-target',searches=[];let flags=new Set(),generation='9',error=null,latestEmpty=false;
 const imap={mailbox:{uidValidity:generation,uidNext:8},async list(){return folders.map(path=>({path}));},async getMailboxLock(path,options){assert.equal(options.readOnly,true);this.path=path;this.mailbox={uidValidity:generation,uidNext:8};return {release(){}};},async search(query){searches.push({path:this.path,query:structuredClone(query)});if(error)throw Object.assign(Error('Provider rejected'),{code:error});return this.path===target&&!latestEmpty?[7]:[];},async fetchOne(uid){assert.equal(uid,7);return {uid,flags,envelope:{subject:'Acme 778899ZX',messageId:'<current@example.test>'},internalDate:new Date('2001-01-02T00:00:00Z'),size:123};}};
 const key='11'.repeat(32),credential={password_encrypted:encryptToken('synthetic',key),folders_json:JSON.stringify({inbox:'INBOX'})},config={dataDirectory:path,mailboxes:[{address:mailbox,name:'Owner'}],tokenEncryptionKey:key};
 const client={requiredCredential(owner){assert.equal(owner,mailbox);return credential;},async withImapPassword(owner,password,callback){assert.equal(owner,mailbox);assert.equal(password,'synthetic');return callback(imap);}};
 return {path,target,folders,searches,imap,api:()=>new MailApi({config,client,signatureProvider:null}),flags:()=>{flags=new Set(['\\Seen']);generation='99';},error:code=>{error=code;},latestEmpty:()=>{latestEmpty=true;}};
}

test('cold live continuation learns without retro-import; a new process/search then finds a fresh match in one SEARCH',async t=>{
 const f=await apiFixture(t),query='subject:"Acme 778899ZX" after:2001-01-01';let cursor,found;
 do{const p=await f.api().read(mailbox,{operation:'search',query,...(cursor?{cursor}:{})});cursor=p.cursor;if(p.messages.length)found=p;}while(!found&&cursor);
 assert.ok(f.searches.length>30);assert.equal(found.messages[0].id,ref(f.target));const coldCalls=f.searches.length;
 f.searches.length=0;f.flags();const warm=await f.api().read(mailbox,{operation:'search',query,limit:1});
 assert.equal(f.searches.length,1);assert.equal(f.searches[0].path,f.target);assert.deepEqual(f.searches[0].query,compileImapQuery(query));assert.equal(warm.messages[0].id,ref(f.target,7,'99'));assert.equal(warm.messages[0].isRead,true);assert.equal(warm.messages[0].originalVerified,false);
 assert.equal(warm.coverage.locatorFolderPriority.foldersPrioritized,1);assert.equal(warm.coverage.totalFolders,f.folders.length);assert.equal(warm.complete,false);assert.ok(coldCalls>f.searches.length);t.diagnostic(JSON.stringify({syntheticColdSearches:coldCalls,syntheticWarmSearches:f.searches.length,providerCriteriaUnchanged:true}));
});

test('a strong company+reference hint orders a changed query but returns only a fresh provider match',async t=>{
 const f=await apiFixture(t),query='subject_reference:778899ZX Acme after:2001-01-01',compiled=compileImapQuery(query);
 await new MailLocatorHints(f.path,mailbox).remember(criteria,[match(f.target)],f.folders);
 f.flags();const page=await f.api().read(mailbox,{operation:'search',query,limit:1},{searchContext:{humanMessage:'Busca el correo Acme 778899ZX',sourceMessageId:'human'}});
 assert.equal(f.searches.length,1);assert.equal(f.searches[0].path,f.target);const {uid,...providerCriteria}=f.searches[0].query;assert.equal(uid,'1:7');assert.deepEqual(providerCriteria,compiled);
 assert.equal(page.messages[0].id,ref(f.target,7,'99'));assert.equal(page.messages[0].originalVerified,false);assert.equal(page.complete,false);assert.equal(page.coverage.totalFolders,f.folders.length);
 const foreign=new MailLocatorHints(f.path,other);assert.deepEqual(await foreign.folders(compiled,f.folders),[]);
});

test('weak shared company or unrelated reference cannot reuse an earlier folder hint',async t=>{
 const f=await store(t);await f.hints.remember(criteria,[match('Acme')],['Acme']);
 for(const query of ['Acme','Acme 111111ZZ','778899ZX','Acme correo'])assert.deepEqual(await f.hints.folders(compileImapQuery(query),['Acme']),[]);
});

test('cold 870-folder search prioritizes a punctuation/accent-normalized company folder with live search',async t=>{
 const path=await root(t),target='INBOX/A-Quimica/Fíc-talco/Clientes/Exempl/Fable',folders=['INBOX',...Array.from({length:868},(_,i)=>'Archivo/Correo/'+i),target],searches=[];
 const imap={mailbox:{uidValidity:'99',uidNext:8},async list(){return folders.map(path=>({path}));},async getMailboxLock(folder,options){assert.equal(options.readOnly,true);this.path=folder;this.mailbox={uidValidity:'99',uidNext:8};return {release(){}};},async search(query){searches.push({path:this.path,query:structuredClone(query)});return this.path===target?[7]:[];},async fetchOne(uid){return {uid,envelope:{subject:'Fictalco 87654321-X:987654',messageId:'<current@example.test>'},internalDate:new Date('2026-11-04T00:00:00Z'),size:123,flags:new Set()};}};
 const key='11'.repeat(32),credential={password_encrypted:encryptToken('synthetic',key),folders_json:JSON.stringify({inbox:'INBOX'})},config={dataDirectory:path,mailboxes:[{address:mailbox,name:'Owner'}],tokenEncryptionKey:key},client={requiredCredential(){return credential;},async withImapPassword(_owner,_pass,fn){return fn(imap);}};
 const query='subject_reference:"87654321-X:987654" after:2026-11-03 before:2026-11-06 Fictalco',api=new MailApi({config,client,signatureProvider:null});
 const page=await api.read(mailbox,{operation:'search',query,limit:1},{searchContext:{humanMessage:'Busca el correo de Fictalco con la referencia 87654321-X:987654',sourceMessageId:'human'}});
 assert.equal(searches.length,1);assert.equal(searches[0].path,target);const {uid,...providerCriteria}=searches[0].query;assert.equal(uid,'1:7');assert.deepEqual(providerCriteria,compileImapQuery(query));
 assert.equal(page.messages[0].id,ref(target,7,'99'));assert.equal(page.complete,false);assert.equal(page.coverage.totalFolders,870);assert.ok(page.cursor);
 assert.deepEqual(orderingMailSearchFoldersV2(compileImapQuery('correo'),folders),[]);
 assert.deepEqual(orderingMailSearchFoldersV2(compileImapQuery('Fíc-talco'),['INBOX/FICTALCO','INBOX/Correo']),['INBOX/FICTALCO']);
});

test('signed continuation freezes the original hint plan across cache updates and new human context',async t=>{
 const f=await apiFixture(t),query='subject:"Acme 778899ZX" after:2001-01-01',api=f.api(),first=await api.read(mailbox,{operation:'search',query});assert.equal(first.messages.length,0);
 const before=api.uncursor(first.cursor);assert.deepEqual(before.locatorPlan.indices,[]);const hints=new MailLocatorHints(f.path,mailbox);await hints.remember(criteria,[match(f.target)],f.folders);
 const next=await api.read(mailbox,{operation:'search',query,cursor:first.cursor},{searchContext:{humanMessage:'continúa',sourceMessageId:'new-human'}}),after=api.uncursor(next.cursor);
 assert.deepEqual(after.locatorPlan,before.locatorPlan);assert.equal(after.index,60);assert.equal(next.messages.length,0);assert.equal(next.coverage.locatorFolderPriority.foldersPrioritized,0);
 const fresh=await api.read(mailbox,{operation:'search',query});assert.equal(fresh.messages.length,1);assert.equal(api.uncursor(fresh.cursor).locatorPlan.indices.length,1);
 const bad=api.cursor({...before,locatorPlan:{...before.locatorPlan,baseCatalog:'0'.repeat(64)}});await assert.rejects(api.read(mailbox,{operation:'search',query,cursor:bad}),{code:'MAIL_SEARCH_CURSOR_EXPIRED'});
 await assert.rejects(api.read(mailbox,{operation:'search',query:query+' NOT elsewhere',cursor:first.cursor}),/different mailbox or query/);
 await assert.rejects(api.read(other,{operation:'search',query,cursor:first.cursor}),{code:'MAILBOX_NOT_ALLOWED'});
 await assert.rejects(api.read(mailbox,{operation:'search',query,cursor:first.cursor.slice(0,-2)+'xx'}),/Invalid search cursor/);
});

test('already issued legacy cursors do not inject new hints or lose their position',async t=>{
 const f=await apiFixture(t),api=f.api(),query='subject:"Acme 778899ZX" after:2001-01-01',first=await api.read(mailbox,{operation:'search',query}),old=api.uncursor(first.cursor);delete old.locatorPlan;
 await new MailLocatorHints(f.path,mailbox).remember(criteria,[match(f.target)],f.folders);
 const next=await api.read(mailbox,{operation:'search',query,cursor:api.cursor(old)});assert.equal(next.messages.length,0);assert.equal(api.uncursor(next.cursor).index,60);assert.equal(api.uncursor(next.cursor).locatorPlan,undefined);assert.equal(next.coverage.locatorFolderPriority,undefined);
});

test('explicit folders and latest received bypass hints; generation and filters always remain live',async t=>{
 const f=await apiFixture(t),query='subject:"Acme 778899ZX" after:2001-01-01';await new MailLocatorHints(f.path,mailbox).remember(criteria,[match(f.target)],f.folders);
 const explicit=await f.api().read(mailbox,{operation:'search',query,folder:'INBOX'});assert.equal(explicit.coverage.locatorFolderPriority,undefined);assert.equal(f.searches.at(-1).path,'INBOX');
 f.searches.length=0;f.latestEmpty();const latest=await f.api().read(mailbox,{operation:'search',query,freshness:'live_received_first'});assert.equal(f.searches[0].path,'INBOX');assert.equal(latest.coverage.locatorFolderPriority,undefined);assert.equal(latest.coverage.freshness.globalLatestVerified,false);
 f.searches.length=0;await f.api().read(mailbox,{operation:'search',query},{searchContext:{humanMessage:'Find the latest received Acme mail',sourceMessageId:'human'}});assert.notEqual(f.searches[0].path,f.target);
});

test('bad optional cache preserves live outcomes and never masks provider or authentication failures',async t=>{
 const f=await apiFixture(t),hints=new MailLocatorHints(f.path,mailbox),query='subject:"Acme 778899ZX" after:2001-01-01';await hints.remember(criteria,[match(f.target)],f.folders);await writeFile(hints.file,'{malformed');
 const p=await f.api().read(mailbox,{operation:'search',query});assert.equal(p.complete,false);assert.equal(p.messages.length,0);assert.equal(p.coverage.searchedThisPage,30);assert.equal(p.coverage.locatorFolderPriority.foldersPrioritized,0);
 f.error('MAIL_SEARCH_PROVIDER_FAILED');const failed=await f.api().read(mailbox,{operation:'search',query});assert.equal(failed.coverage.errors[0].code,'MAIL_SEARCH_PROVIDER_FAILED');assert.equal(failed.coverage.stopped,'folder_error');
 const api=f.api();api.client.withImapPassword=async()=>{throw Object.assign(Error('Denied'),{code:'MAIL_AUTHENTICATION_FAILED'});};await assert.rejects(api.read(mailbox,{operation:'search',query}),{code:'MAIL_AUTHENTICATION_FAILED'});
});

test('a stale moved hint never supplies a result or omits remaining folders',async t=>{
 const f=await apiFixture(t),query='subject:"Acme 778899ZX" after:2001-01-01';await new MailLocatorHints(f.path,mailbox).remember(criteria,[match('Acme/000')],f.folders);const api=f.api();let p=await api.read(mailbox,{operation:'search',query}),pages=1;
 assert.equal(p.messages.length,0);while(!p.messages.length&&p.cursor&&pages++<5)p=await api.read(mailbox,{operation:'search',query,cursor:p.cursor});assert.equal(p.messages[0].folder,f.target);assert.ok(f.searches.some(s=>s.path===f.target));
});

test('compact index plan validates every field and cannot add arbitrary folders',()=>{
 const catalog='a'.repeat(64);assert.equal(validMailLocatorPlan({version:1,baseCatalog:catalog,indices:[0,1,2]},catalog,70),true);
 for(const patch of [{indices:[0,0]},{indices:[70]},{indices:[-1]},{indices:[0,1,2,3]},{indices:['0']},{version:2},{folders:['foreign']},{baseCatalog:'b'.repeat(64)}])assert.equal(validMailLocatorPlan({version:1,baseCatalog:catalog,indices:[],...patch},catalog,70),false);
});

test('synthetic warm lookup and write overhead stays bounded without a provider RPC or body scan',async t=>{
 const f=await store(t);for(let i=0;i<60;i++)await f.hints.remember(compileImapQuery('subject:Acme'+i),[match('Acme/'+i+'x'.repeat(700))],['Acme/'+i+'x'.repeat(700)]);await f.hints.remember(criteria,[match('Acme')],['Acme']);const samples=[];
 for(let i=0;i<50;i++){const start=performance.now();assert.deepEqual(await f.hints.folders(criteria,['INBOX','Acme']),['Acme']);samples.push(performance.now()-start);}
 const start=performance.now();await f.hints.remember(criteria,[match('Acme')],['Acme']);const writeMs=performance.now()-start;samples.sort((a,b)=>a-b);
 t.diagnostic(JSON.stringify({fixture:'synthetic64KiB-cap',reads:samples.length,medianReadMs:samples[25],p95ReadMs:samples[47],maxReadMs:samples.at(-1),writeMs,storedBytes:(await lstat(f.hints.file)).size,providerCalls:0,bodyScans:0}));
});


test('a warm signed plan survives metadata expiry/replacement and preserves deduplication position',async t=>{
 const f=await apiFixture(t),query='subject:"Acme 778899ZX" after:2001-01-01',api=f.api(),hints=new MailLocatorHints(f.path,mailbox);await hints.remember(criteria,[match(f.target)],f.folders);
 const first=await api.read(mailbox,{operation:'search',query,limit:1}),before=api.uncursor(first.cursor);assert.equal(before.index,1);assert.equal(first.messages.length,1);
 const value=JSON.parse(await readFile(hints.file));value.entries.forEach(e=>{e.learnedAt-=MAIL_LOCATOR_HINT_LIMITS.ttlMs;e.expiresAt-=MAIL_LOCATOR_HINT_LIMITS.ttlMs;});await writeFile(hints.file,JSON.stringify(value));
 f.searches.length=0;const next=await api.read(mailbox,{operation:'search',query,cursor:first.cursor},{searchContext:{humanMessage:'continue',sourceMessageId:'later'}}),after=api.uncursor(next.cursor);
 assert.deepEqual(after.locatorPlan,before.locatorPlan);assert.equal(after.index,31);assert.deepEqual(after.seenKeys,before.seenKeys);assert.equal(next.messages.length,0);assert.equal(f.searches.some(s=>s.path===f.target),false);
});

test('OR criteria remain byte-for-byte provider criteria with warm ordering and no cache-to-result authority',async t=>{
 const f=await apiFixture(t),query='subject:Acme OR from:Zenith',compiled=compileImapQuery(query);await new MailLocatorHints(f.path,mailbox).remember(compiled,[match(f.target)],f.folders);
 const page=await f.api().read(mailbox,{operation:'search',query,limit:1});assert.equal(f.searches.length,1);assert.deepEqual(f.searches[0].query,compiled);assert.equal(page.messages[0].originalVerified,false);assert.equal(page.coverage.locatorFolderPriority.metadataNotResult,true);
});
