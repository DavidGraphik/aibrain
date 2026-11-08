import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MailApi,compileImapQuery} from '../lib/mail-api.mjs';
import {orderingMailSearchFolders,rankMailSearchFolders,strongMailSearchFolders,humanMailSearchPlan,validHumanMailSearchPlan} from '../lib/mail-owned-search.mjs';
import {encryptToken} from '../lib/token-crypto.mjs';
const company='INBOX/A-Quimica/FICTALCO/Clientes/Exempl/Fable';
const mailbox='own@example.test',key='11'.repeat(32);
const context={sourceMessageId:'own-human-request',humanMessage:'Busca en mi correo del 4 de noviembre de 2026 Fictalco AG Credit Note con Fictional D26110409180.pdf'};
function fixture(){
 const folders=['INBOX',company,'Archive','INBOX/Facturas','INBOX/Pedidos','INBOX/Hoy','INBOX/Ofertas'];let sourceReads=0;const searches=[];
 const imap={mailbox:{uidValidity:9,uidNext:4},async list(){return folders.map(path=>({path}));},async getMailboxLock(path,options){assert.equal(options.readOnly,true);this.path=path;return {release(){}};},async search(query){searches.push({path:this.path,query});return this.path===company?[3,2,1]:[];},async fetchOne(uid){return {uid,envelope:{subject:'Fictalco AG - Credit Note',messageId:`<own-${uid}@example.test>`},internalDate:new Date('2026-11-04T10:26:44Z'),flags:new Set()};}};
 const client={requiredCredential(owner){assert.equal(owner,mailbox);return {password_encrypted:encryptToken('pw',key),folders_json:JSON.stringify({inbox:'INBOX'})};},async withImapPassword(owner,pw,callback){assert.equal(owner,mailbox);assert.equal(pw,'pw');return callback(imap);}};
 const api=new MailApi({config:{mailboxes:[{address:mailbox,name:'Owner'}],dataDirectory:'/must-not-read-owned-store',tokenEncryptionKey:key},store:{getImapState(){sourceReads++;return null;}},client,now:()=>Date.parse('2026-11-05T00:01:00Z'),signatureProvider:null});
 return {api,imap,folders,searches,get sourceReads(){return sourceReads;}};
}
test('one specific authorized folder word prioritizes live, never relaxes candidates or the exact query',async()=>{
 const f=fixture(),query='"Fictalco AG - Credit Note 16.10.26" after:2026-11-03 before:2026-11-06';
 const page=await f.api.read(mailbox,{operation:'search',query,limit:1},{searchContext:context});
 assert.equal(f.sourceReads,0);assert.equal(f.searches.length,1);assert.equal(f.searches[0].path,company);assert.deepEqual(f.searches[0].query,{...compileImapQuery(query),uid:'1:3'});assert.equal(page.messages.length,1);assert.equal(page.complete,false);assert.equal(page.coverage.ownedSnapshots.readSnapshots,0);assert.equal(page.coverage.planning.humanContextForOrdering,true);assert.equal(page.coverage.totalFolders,f.folders.length);assert.equal('candidates'in page,false);
 assert.deepEqual(strongMailSearchFolders({text:'Fictalco'},f.folders),[]);assert.deepEqual(orderingMailSearchFolders({text:'Fictalco'},f.folders),[company]);
});
test('generic, short, numeric, absent and substring-only words never activate company ordering',async()=>{
 for(const word of ['mail','email','factura','pedido','hoy','oferta','compras','quimica','cc','2026','UnknownSupplier','Nabal'])assert.deepEqual(orderingMailSearchFolders({text:word},['INBOX/'+word,company].filter(x=>!['UnknownSupplier','Nabal'].includes(word)||x===company)),[],word);
 const f=fixture();await f.api.read(mailbox,{operation:'search',query:'subject:oferta'},{searchContext:{...context,humanMessage:'Busca el correo de oferta de hoy'}});assert.ok(f.sourceReads>0);assert.equal(f.api.uncursor(f.api.cursor({searchPlan:humanMailSearchPlan(null,{},f.folders)})).searchPlan,null);
});
test('generic followup preserves the signed original company plan, order and provider next UID',async()=>{
 const f=fixture(),request={operation:'search',query:'subject:credit',limit:1},first=await f.api.read(mailbox,request,{searchContext:context}),state=f.api.uncursor(first.cursor);
 assert.equal(state.searchPlan.folderOrdering,'specific-token-v2');assert.equal(state.beforeUid,3);const next=await f.api.read(mailbox,{...request,cursor:first.cursor},{searchContext:{sourceMessageId:'later-own-human',humanMessage:'continúa'}});const resumed=f.api.uncursor(next.cursor);assert.deepEqual(resumed.searchPlan,state.searchPlan);assert.equal(resumed.beforeUid,2);assert.equal(f.searches[1].path,company);assert.equal(next.messages[0].id.endsWith(':2'),true);assert.equal(f.sourceReads,0);
 await assert.rejects(f.api.read(mailbox,{...request,query:'subject:other',cursor:first.cursor},{searchContext:context}),/different mailbox or query/);await assert.rejects(f.api.read('foreign@example.test',{...request,cursor:first.cursor}),e=>e.code==='MAILBOX_NOT_ALLOWED');
});
test('old issued plans keep their two-word ordering semantics and remain valid',()=>{
 const p=humanMailSearchPlan(context,compileImapQuery('Fictalco'),[company]);assert.equal(p.folderOrdering,'specific-token-v1');assert.equal(validHumanMailSearchPlan(p),true);delete p.folderOrdering;assert.equal(validHumanMailSearchPlan(p),true);assert.deepEqual(strongMailSearchFolders({text:p.hintTerms.join(' ')},[company]),[]);assert.equal(validHumanMailSearchPlan({...p,folderOrdering:'tampered'}),false);
});
test('negative and disjoint OR terms cannot produce a required one-word company match',()=>{
 assert.deepEqual(orderingMailSearchFolders({not:{text:'Fictalco'}},[company]),[]);
 assert.deepEqual(orderingMailSearchFolders(compileImapQuery('Fictalco OR OtherSupplier'),[company]),[]);
 assert.deepEqual(strongMailSearchFolders(compileImapQuery('Fictalco OR OtherSupplier'),[company]),[]);
});

test('issued v1 cursors retain their original ordering plan after v2 deploy',async()=>{
 const f=fixture(),request={operation:'search',query:'Fictalco',limit:1};
 const first=await f.api.read(mailbox,request,{searchContext:context}),state=f.api.uncursor(first.cursor);
 state.searchPlan.folderOrdering='specific-token-v1';delete state.folderOrderVersion;
 f.searches.length=0;const next=await f.api.read(mailbox,{...request,cursor:f.api.cursor(state)});
 assert.equal(f.searches[0].path,company);assert.equal(next.messages.length,1);assert.equal(f.api.uncursor(next.cursor).searchPlan.folderOrdering,'specific-token-v1');
});


test('a real legacy cursor resumes its original catalog without retroactively applying one-word ordering',async()=>{
 const f=fixture(),request={operation:'search',query:'subject:credit',limit:1},first=await f.api.read(mailbox,request,{searchContext:context}),state=f.api.uncursor(first.cursor);
 delete state.searchPlan.folderOrdering;state.index=0;state.beforeUid=null;state.uidValidity=null;delete state.seenOwnedKeys;
 state.catalog=createHash('sha256').update(JSON.stringify(rankMailSearchFolders(compileImapQuery(request.query),f.folders))).digest('hex');
 // The pre225 producer had neither one-word ordering nor locatorPlan (added
 // later by1fae517c). Retaining a new plan while replacing its base catalog
 // makes an impossible hybrid, which the production guard must still reject.
 assert.ok(state.locatorPlan);f.searches.length=0;
 await assert.rejects(f.api.read(mailbox,{...request,cursor:f.api.cursor(state)}),error=>error.code==='MAIL_SEARCH_CURSOR_EXPIRED'&&/Locator ordering plan changed/.test(error.message));
 assert.equal(f.searches.length,0);delete state.locatorPlan;
 f.searches.length=0;const legacy=f.api.cursor(state),next=await f.api.read(mailbox,{...request,cursor:legacy},{searchContext:{sourceMessageId:'new-human',humanMessage:'continúa con otra empresa'}});
 assert.deepEqual(f.searches.map(x=>x.path),['INBOX','Archive',company]);assert.equal(next.messages.length,1);assert.deepEqual(f.api.uncursor(next.cursor).searchPlan,state.searchPlan);assert.equal('folderOrdering'in f.api.uncursor(next.cursor).searchPlan,false);
 await assert.rejects(f.api.read(mailbox,{...request,cursor:legacy+'x'}),/Invalid search cursor/);
 const tampered={...state,searchPlan:{...state.searchPlan,folderOrdering:'fake'}};await assert.rejects(f.api.read(mailbox,{...request,cursor:f.api.cursor(tampered)}),e=>e.code==='MAIL_SEARCH_CURSOR_EXPIRED');
});

test('tool input and mail data cannot supply ordering authority or another mailbox folder',async()=>{
 const f=fixture();await assert.rejects(f.api.read(mailbox,{operation:'search',query:'credit',searchContext:context}),/internal search-only option/);assert.equal(f.searches.length,0);
 assert.deepEqual(orderingMailSearchFolders({text:'Fictalco'},['INBOX','Archive']),[]);
 await assert.rejects(f.api.read(mailbox,{operation:'search',query:'credit',folder:'foreign/Fictalco'},{searchContext:context}),e=>e.code==='MAIL_FOLDER_NOT_FOUND');assert.equal(f.searches.length,0);
});
