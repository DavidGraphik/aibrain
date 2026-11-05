import test from 'node:test';
import assert from 'node:assert/strict';
import {MailApi,compileImapQuery,mailApiContract} from '../lib/mail-api.mjs';
import {compileMailSearchQuery,mailReferenceSearchVariants} from '../lib/mail-search-query.mjs';
import {encryptToken} from '../lib/token-crypto.mjs';

// Model the provider's literal substring SEARCH, not the more tolerant owned
// snapshot matcher: that distinction caused the historical live-search miss.
function providerMatch(criteria,subject,body='',date='2026-11-04'){
 return Object.entries(criteria).every(([key,value])=>{
  if(key==='or')return value.some(item=>providerMatch(item,subject,body,date));
  if(key==='not')return !providerMatch(value,subject,body,date);
  if(key==='subject')return subject.toLowerCase().includes(value.toLowerCase());
  if(key==='text')return (subject+' '+body).toLowerCase().includes(value.toLowerCase());
  if(key==='since')return date>=value;
  if(key==='before')return date<value;
  if(key==='uid'||key==='all')return true;
  throw Error('Unexpected synthetic provider criterion: '+key);
 });
}

test('explicit reference matches the live spaced subject while literal TEXT stays exact',()=>{
 const subject='87654321 - X:987654',query='reference:"87654321-X:987654"';
 assert.equal(providerMatch(compileImapQuery('text:"87654321-X:987654"'),subject),false);
 assert.equal(providerMatch(compileImapQuery(query),subject),true);
 assert.equal(compileMailSearchQuery(query)({data:{subject},from:[]}),true);
 assert.deepEqual(compileImapQuery('text:"87654321-X:987654"'),{text:'87654321-X:987654'});
 assert.deepEqual(compileImapQuery('subject:"87654321 - X:987654"'),{subject});
});

test('spacing variants retain every separator, letter, digit and position',()=>{
 for(const reference of ['AB-0123:45','98765 / Z_001','X.0001','42','A–0123']){
  const variants=mailReferenceSearchVariants(reference);assert.ok(variants.length<=64);assert.equal(new Set(variants).size,variants.length);
  for(const variant of variants){assert.equal(variant.replaceAll(' ',''),reference.replaceAll(' ',''));assert.equal(providerMatch(compileImapQuery(`reference:"${reference}"`),variant),true);}
 }
 const match=compileImapQuery('reference:"87654321-X:987654"');
 for(const wrong of ['87654321 - H:987654','87654321 - G:260259','87654321 G:987654','G:987654 - 87654321','87654321 irrelevant G:987654'])assert.equal(providerMatch(match,wrong),false,wrong);
 for(const subject of ['A-0123','A  –  0123','Á–0123'])assert.equal(compileMailSearchQuery('subject_reference:"A–0123"')({data:{subject},from:[]}),false,subject);
});

test('reference selectors preserve subject scope, AND dates and OR alternatives',()=>{
 const q=compileImapQuery('(subject_reference:"AB-0123" OR subject_reference:"XY:0042") after:2026-11-03 before:2026-11-05');
 assert.equal(providerMatch(q,'AB - 0123'),true);assert.equal(providerMatch(q,'XY : 0042'),true);
 assert.equal(providerMatch(q,'unrelated','AB - 0123'),false);assert.equal(providerMatch(q,'AB - 0123','','2026-11-05'),false);
 assert.equal(providerMatch(compileImapQuery('SupplierX reference:"AB-0123"'),'Other AB - 0123'),false);
 assert.equal(providerMatch(compileImapQuery('SupplierX reference:"AB-0123"'),'SupplierX AB - 0123'),true);
});

test('invalid, injected and excessive references fail closed rather than becoming raw IMAP',()=>{
 for(const value of ['AB 123','AB-','A--123','A-123 OR ALL','A-123) (ALL','$(A123)','A123\\Seen','A123\r\nALL','A-1-2-3-4','A'.repeat(97)])assert.throws(()=>mailReferenceSearchVariants(value),{code:'MAIL_SEARCH_QUERY_INVALID'},value);
 for(const query of ['reference:"A-123 OR ALL"','reference:"A123\\\" OR ALL"','reference:(AB123 OR CD456)','subject_reference:"A-123) (ALL"',Array(3).fill('reference:"A-1:2/3"').join(' ')])assert.throws(()=>compileImapQuery(query),{code:'MAIL_API_INVALID'},query);
 // Existing explicit literals remain data, even when they resemble commands.
 assert.deepEqual(compileImapQuery('text:"A123 OR ALL"'),{text:'A123 OR ALL'});
 assert.deepEqual(compileImapQuery('"$(not executed)"'),{text:'$(not executed)'});
});

function fixture(){
 const mailbox='own@example.test',key='11'.repeat(32),company='INBOX/SupplierX',subject='SupplierX 87654321 - X:987654';
 const folders=['INBOX',...Array.from({length:868},(_,i)=>'Archive/Other'+i),company],searches=[];let connected=0;
 const imap={mailbox:{uidValidity:7,uidNext:2},async list(){return folders.map(path=>({path}));},async getMailboxLock(path,options){assert.equal(options.readOnly,true);this.path=path;return {release(){}};},async search(criteria){searches.push({path:this.path,criteria});return this.path===company&&providerMatch(criteria,subject)?[1]:[];},async fetchOne(uid){return {uid,envelope:{subject,messageId:'<own-reference@example.test>'},internalDate:new Date('2026-11-04T09:00:00Z'),flags:new Set()};}};
 const client={requiredCredential(owner){assert.equal(owner,mailbox);return {password_encrypted:encryptToken('synthetic',key),folders_json:JSON.stringify({inbox:'INBOX'})};},async withImapPassword(owner,password,callback){assert.equal(owner,mailbox);assert.equal(password,'synthetic');connected++;return callback(imap);}};
 const api=new MailApi({config:{mailboxes:[{address:mailbox,name:'Owner'}],dataDirectory:'/not-read',tokenEncryptionKey:key},store:{getImapState(){throw Error('Known company must prefer the live folder');}},client,signatureProvider:null,now:()=>Date.parse('2026-11-05T00:00:00Z')});
 return {api,mailbox,company,searches,get connected(){return connected;}};
}

test('870-folder synthetic provider finds requested original with one unchanged-budget SEARCH',async()=>{
 const f=fixture(),query='SupplierX reference:"87654321-X:987654"';
 const page=await f.api.read(f.mailbox,{operation:'search',query,limit:1});
 assert.equal(page.messages.length,1);assert.equal(page.messages[0].subject,'SupplierX 87654321 - X:987654');assert.equal(page.messages[0].folder,f.company);
 assert.equal(page.query,query);assert.equal(f.searches.length,1);assert.equal(page.coverage.totalFolders,870);assert.equal(page.coverage.searchedThisPage,1);assert.equal(page.complete,false);assert.ok(page.cursor);assert.equal('candidates'in page,false);
 assert.deepEqual(f.searches[0].criteria,{...compileImapQuery(query),uid:'1:1'});
 await assert.rejects(f.api.read('foreign@example.test',{operation:'search',query}),{code:'MAILBOX_NOT_ALLOWED'});
 await assert.rejects(f.api.read(f.mailbox,{operation:'search',query:'SupplierX text:"87654321-X:987654"',cursor:page.cursor}),/different mailbox or query/);
});

test('invalid reference performs no provider connection and discovery describes opt-in semantics',async()=>{
 const f=fixture();await assert.rejects(f.api.read(f.mailbox,{operation:'search',query:'reference:"A123 OR ALL"'}),{code:'MAIL_API_INVALID'});assert.equal(f.connected,0);
 const grammar=mailApiContract(f.mailbox).searchGrammar;assert.ok(grammar.fields.includes('reference'));assert.ok(grammar.fields.includes('subject_reference'));assert.match(grammar.references,/Existing text:\/subject:\/quoted literal terms remain exact/);
});
