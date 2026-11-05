import {open,lstat,realpath,mkdir,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve,isAbsolute} from 'node:path';
import {ownedMailSnapshotReference,decodeOwnedMailSnapshotReference} from './mail-reference.mjs';
import {normalizeMailSearchText as norm} from './mail-search-query.mjs';
const addresses=value=>(Array.isArray(value)?value:value?.value??[]).map(x=>x.emailAddress??x);
const addressText=value=>addresses(value).map(x=>`${x.name??''} ${x.address??''}`).join(' ');
const currentFlags=value=>Object.entries(value).some(([key,item])=>['seen','flagged','draft','answered'].includes(key)||item&&typeof item==='object'&&(Array.isArray(item)?item.some(currentFlags):currentFlags(item)));

export function matchesOwnedMailCriteria(data,criteria){
 const fields={subject:data.subject,body:data.text||data.bodyPreview||data.html||'',from:addressText(data.from),to:addressText(data.toRecipients),cc:addressText(data.ccRecipients),bcc:addressText(data.bccRecipients)};
 fields.text=[...Object.values(fields),...(data.attachments??[]).map(a=>a.filename??a.name??'')].join(' ');
 return Object.entries(criteria).every(([key,value])=>{
  if(key==='all')return value===true;
  if(key==='not')return !matchesOwnedMailCriteria(data,value);
  if(key==='or')return value.some(part=>matchesOwnedMailCriteria(data,part));
  if(Object.hasOwn(fields,key))return norm(fields[key]).includes(norm(value));
  const date=String(data.receivedDateTime??data.internalDate??'').slice(0,10);
  if(key==='since')return !!date&&date>=value;
  if(key==='before')return !!date&&date<value;
  if(key==='on')return !!date&&date===value;
  // Historical flags cannot attest current provider state.
  return false;
 });
}

// Folder metadata comes from the already authenticated mailbox LIST. Relevance
// changes ordering only: no folder is added, dropped or treated as authorization.
function positiveSearchValues(criteria,negative=false,result=[]){
 for(const [key,value]of Object.entries(criteria)){
  if(key==='not')positiveSearchValues(value,!negative,result);
  else if(key==='or')for(const part of value)positiveSearchValues(part,negative,result);
  else if(!negative)result.push([key,value]);
 }
 return result;
}
export function rankMailSearchFolders(criteria,folders){
 const terms=[...new Set(positiveSearchValues(criteria).filter(([key])=>['text','subject','body','from','to','cc','bcc'].includes(key)).flatMap(([,value])=>norm(value).match(/[\p{L}\p{N}]{4,}/gu)??[]).filter(value=>!/^[0-9]+$/.test(value)))];
 const ranked=folders.map(path=>{const value=norm(path);return {path,score:terms.reduce((n,term)=>n+Number(value.includes(term)),0)};});
 return ranked.sort((a,b)=>b.score-a.score||(a.path==='INBOX'?-1:b.path==='INBOX'?1:a.path.localeCompare(b.path))).map(item=>item.path);
}
function requiredSearchClauses(criteria,negative=false){
 const combine=(sets,intersection)=>!sets.length?new Set():intersection?new Set([...sets[0]].filter(x=>sets.every(s=>s.has(x)))):new Set(sets.flatMap(s=>[...s]));
 return combine(Object.entries(criteria).map(([key,value])=>key==='not'?requiredSearchClauses(value,!negative):key==='or'?combine(value.map(part=>requiredSearchClauses(part,negative)),!negative):new Set(negative?[]:[JSON.stringify([key,value])])),negative);
}
// Direction is inferred only from an exact mandatory sender in the unchanged
// provider criteria. OR branches with different senders do not qualify.
export function hasMandatoryOwnedMailSender(criteria,mailbox){
 return typeof mailbox==='string'&&[...requiredSearchClauses(criteria)].some(clause=>{
  const [field,value]=JSON.parse(clause);
  return field==='from'&&typeof value==='string'&&value.toLowerCase()===mailbox.toLowerCase();
 });
}
const genericFolderWords=new Set(['invoice','factura','pedido','order','confirmation','oferta','credit','note','correo','message','supplier','proveedor','customer','cliente','clientes','aluminios','attachment','adjunto']);
export function strongMailSearchFolders(criteria,folders){
 const terms=[...new Set([...requiredSearchClauses(criteria)].map(x=>JSON.parse(x)).filter(([key])=>['text','subject','body','from','to','cc','bcc'].includes(key)).flatMap(([,value])=>norm(value).match(/[\p{L}\p{N}]{4,}/gu)??[]).filter(value=>!/^[\p{N}]+$/u.test(value)&&!genericFolderWords.has(value)))];
 return rankMailSearchFolders(criteria,folders).filter(folder=>terms.filter(term=>norm(folder).includes(term)).length>=2);
}

// A single specific company word is enough ONLY for ordering an already
// authenticated folder catalog. Unverified candidate relaxation below still
// uses strongMailSearchFolders and its independent two-required-term guard.
const orderingGenericWords=new Set([...genericFolderWords,'email','mail','today','yesterday','hoy','ayer','actual','reciente','latest','newest','original','originales','documento','documentos','nota','abono','abonos','presupuesto','presupuestos','quote','quotation','cotizacion','precio','precios','tarifa','tarifas','urgente','urgentes','asunto','subject','confirmaciones','confirmacion','confirmation','compras','ventas','archivo','archive','inbox','sent','sentitems','trash','drafts','borradores','enviados','recibidos','aluminio','quimica','plastico','general','pendiente','pendientes','noviembre','octubre','enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','diciembre']);
export function orderingMailSearchFolders(criteria,folders){
 const terms=[...new Set([...requiredSearchClauses(criteria)].map(x=>JSON.parse(x)).filter(([key])=>['text','subject','body','from','to','cc','bcc'].includes(key)).flatMap(([,value])=>norm(value).match(/[\p{L}\p{N}]{4,64}/gu)??[]).filter(term=>/\p{L}/u.test(term)&&!orderingGenericWords.has(term)))];
 return rankMailSearchFolders(criteria,folders).filter(folder=>{const words=new Set(norm(folder).match(/[\p{L}\p{N}]+/gu)??[]);return terms.some(term=>words.has(term));});
}

// A server-supplied human request is an ordering hint, never provider criteria
// or authority. Persist only a small data-only plan in the signed search cursor.
export function humanMailSearchPlan(context,criteria,folders){
 if(context==null)return null;
 if(!context||typeof context!=='object'||Array.isArray(context)||Object.keys(context).sort().join(',')!=='humanMessage,sourceMessageId'||typeof context.humanMessage!=='string'||!context.humanMessage.trim()||context.humanMessage.length>8000||context.humanMessage.includes('\0')||typeof context.sourceMessageId!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(context.sourceMessageId))throw Object.assign(Error('Invalid internal search context'),{code:'MAIL_API_INVALID'});
 const human=norm(context.humanMessage),paths=folders.map(norm),commandWords=new Set(['busca','buscar','encuentra','muestra','enseñame','original','originales','documento','documentos','necesito','quiero','search','find','show','please','email','mail']);
 const terms=[...new Set(human.match(/[\p{L}\p{N}]{4,64}/gu)??[])].filter(term=>!/^[\p{N}]+$/u.test(term)&&!genericFolderWords.has(term)&&!commandWords.has(term)&&paths.some(path=>path.includes(term))).slice(0,16);
 const references=(human.match(/[\p{L}\p{N}]+(?:[._:/-][\p{L}\p{N}]+)*/gu)??[]).filter(value=>value.length>=5&&/\p{L}/u.test(value)&&(value.match(/\p{N}/gu)??[]).length>=3);
 const queryValues=positiveSearchValues(criteria).filter(([key])=>['text','subject','body','from','to','cc','bcc'].includes(key)).map(([,value])=>norm(value));
 const latestReceived=/\b(?:ultim[oa]s?|latest|newest|most recent|mas reciente)\b/u.test(human)&&!/\b(?:enviad[oa]s?|sent|borrador(?:es)?|drafts?)\b/u.test(human);
 return {folderOrdering:'specific-token-v1',contextHash:createHash('sha256').update(JSON.stringify(context)).digest('hex'),hintTerms:terms,referenceOmitted:references.length>0&&!references.some(value=>queryValues.some(query=>query.includes(value))),...(latestReceived?{latestReceived:true}:{})};
}
export function validHumanMailSearchPlan(plan){
 return plan===null||Boolean(plan&&typeof plan==='object'&&!Array.isArray(plan)&&['contextHash,hintTerms,referenceOmitted','contextHash,hintTerms,latestReceived,referenceOmitted','contextHash,folderOrdering,hintTerms,referenceOmitted','contextHash,folderOrdering,hintTerms,latestReceived,referenceOmitted'].includes(Object.keys(plan).sort().join(','))&&(!Object.hasOwn(plan,'folderOrdering')||plan.folderOrdering==='specific-token-v1')&&(!Object.hasOwn(plan,'latestReceived')||plan.latestReceived===true)&&/^[a-f0-9]{64}$/.test(plan.contextHash??'')&&Array.isArray(plan.hintTerms)&&plan.hintTerms.length<=16&&plan.hintTerms.every(term=>typeof term==='string'&&/^[\p{L}\p{N}]{4,64}$/u.test(term))&&typeof plan.referenceOmitted==='boolean');
}
export function mailSearchCandidateCriteria(criteria){
 const parts=[...requiredSearchClauses(criteria)].map(x=>JSON.parse(x)).filter(([key])=>['since','before','on','seen','flagged','draft','answered'].includes(key)).map(([key,value])=>({[key]:value}));
 return parts.length===0?{all:true}:parts.length===1?parts[0]:{not:{or:parts.map(part=>({not:part}))}};
}
export const isBareMailReference=criteria=>Object.keys(criteria).join(',')==='text'&&/^[\p{L}\p{N}._:/-]+$/u.test(criteria.text)&&/\p{N}/u.test(criteria.text);

export function prefersHistoricalMailFolders(criteria,today){
 // This is a plan preference, never a claim that the source window is complete.
 // Live SEARCH still evaluates the entire unmodified provider criteria.
 return positiveSearchValues(criteria).some(([key,value])=>key==='before'&&value<=today||key==='on'&&value<today);
}

export const MAIL_LOCATOR_HINT_LIMITS=Object.freeze({ttlMs:7*24*60*60*1000,entries:64,bytes:64*1024,folders:3});
const hintHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const HINT_HASH=/^[a-f0-9]{64}$/;
const hintInvalid=()=>{throw Error('Unsafe optional mail locator hints');};
const sameInode=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.uid===b.uid&&a.gid===b.gid&&a.mode===b.mode;
const sameHintFile=(a,b)=>sameInode(a,b)&&a.nlink===b.nlink&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
const validHintFolder=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\r\n\0]/.test(value);

// Exact normalized criteria identity retains field and Boolean/OR structure.
// Tokens gate relevance only; neither normalization nor dates change SEARCH.
export function mailLocatorSelector(criteria){
 const tokens=[...new Set(positiveSearchValues(criteria).filter(([key])=>['text','subject','body','from','to','cc','bcc'].includes(key)).flatMap(([,value])=>(norm(value).match(/[\p{L}\p{N}]+/gu)??[]).filter(t=>t.length>=4&&t.length<=64)))].sort().slice(0,12);
 if(!tokens.some(term=>/\p{L}/u.test(term)&&!orderingGenericWords.has(term)))return null;
 const canonical=(value,key)=>value instanceof Date?value.toISOString():Array.isArray(value)?value.map(item=>canonical(item,key)):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k],k)])):typeof value==='string'&&['text','subject','body','from','to','cc','bcc'].includes(key)?norm(value):value;
 return {key:hintHash(canonical(criteria)),tokens};
}

// Paths, never results or authority. A cursor freezes tiny base-catalog indices
// rather than long folder paths, preserving the existing16KB cursor budget.
export function validMailLocatorPlan(plan,baseCatalog,folderCount){
 return Boolean(plan&&Object.keys(plan).sort().join(',')==='baseCatalog,indices,version'&&plan.version===1&&plan.baseCatalog===baseCatalog&&Array.isArray(plan.indices)&&plan.indices.length<=3&&new Set(plan.indices).size===plan.indices.length&&plan.indices.every(i=>Number.isSafeInteger(i)&&i>=0&&i<folderCount));
}

/** Private, regenerable metadata from future exact live matches only.
 * No snapshots, directory scans, body text, credentials or cross-owner index. */
export class MailLocatorHints{
 constructor(dataRoot,mailbox,{now=Date.now}={}){
  if(typeof dataRoot!=='string'||!isAbsolute(dataRoot)||typeof mailbox!=='string'||mailbox!==mailbox.trim().toLowerCase()||mailbox.length>320||/[\r\n\0]/.test(mailbox)||!/^\S+@\S+$/.test(mailbox))hintInvalid();
  this.dataRoot=resolve(dataRoot);this.root=join(this.dataRoot,'search-locator-hints');this.ownerHash=hintHash(mailbox);this.file=join(this.root,this.ownerHash+'.json');this.now=now;
 }
 async directory(create=false){
  const parent=await lstat(this.dataRoot);if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)||await realpath(this.dataRoot)!==this.dataRoot)hintInvalid();
  let created=false,dir;try{dir=await lstat(this.root);}catch(error){if(error.code!=='ENOENT')throw error;if(!create)return null;try{await mkdir(this.root,{mode:0o700});created=true;}catch(e){if(e.code!=='EEXIST')throw e;}dir=await lstat(this.root);}
  if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o7777)!==0o700||await realpath(this.root)!==this.root)hintInvalid();
  // Only an inode created by THIS call may have ownership normalized. Existing
  // foreign ownership/ACL stays untouched; the optional hint layer falls back.
  if(created&&(dir.uid!==parent.uid||dir.gid!==parent.gid)){
   const h=await open(this.root,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);
   try{if(!sameInode(dir,await h.stat()))hintInvalid();await h.chown(parent.uid,parent.gid);}finally{await h.close();}dir=await lstat(this.root);
  }
  if(dir.uid!==parent.uid||dir.gid!==parent.gid)hintInvalid();
  const scope={parent,dir};await this.check(scope);return scope;
 }
 async check(scope){if(!sameInode(scope.parent,await lstat(this.dataRoot))||!sameInode(scope.dir,await lstat(this.root)))hintInvalid();}
 async readFile(scope,path,maxBytes){
  await this.check(scope);const named=await lstat(path);
  if(!named.isFile()||named.isSymbolicLink()||named.nlink!==1||named.uid!==scope.parent.uid||named.gid!==scope.parent.gid||(named.mode&0o7777)!==0o600||named.size>maxBytes)hintInvalid();
  const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   if(!sameHintFile(named,await h.stat()))hintInvalid();await this.check(scope);
   const buffer=Buffer.alloc(maxBytes+1);let length=0;
   while(length<buffer.length){const {bytesRead}=await h.read(buffer,length,buffer.length-length,length);if(!bytesRead)break;length+=bytesRead;}
   if(length!==named.size||length>maxBytes||!sameHintFile(named,await h.stat())||!sameHintFile(named,await lstat(path)))hintInvalid();await this.check(scope);
   return {value:JSON.parse(buffer.subarray(0,length).toString('utf8')),stat:named};
  }finally{await h.close();}
 }
 valid(value){
  return value&&Object.keys(value).sort().join(',')==='entries,owner,version'&&value.version===1&&value.owner===this.ownerHash&&Array.isArray(value.entries)&&value.entries.length<=64&&value.entries.every(e=>e&&Object.keys(e).sort().join(',')==='expiresAt,folder,key,learnedAt,tokens,uidValidity'&&typeof e.key==='string'&&HINT_HASH.test(e.key)&&Array.isArray(e.tokens)&&e.tokens.length>0&&e.tokens.length<=12&&e.tokens.every(t=>typeof t==='string'&&/^[\p{L}\p{N}]{4,64}$/u.test(t))&&validHintFolder(e.folder)&&typeof e.uidValidity==='string'&&/^\d+$/.test(e.uidValidity)&&Number.isSafeInteger(e.learnedAt)&&e.learnedAt<=this.now()&&e.expiresAt===e.learnedAt+MAIL_LOCATOR_HINT_LIMITS.ttlMs);
 }
 async load(scope){
  let result;try{result=await this.readFile(scope,this.file,MAIL_LOCATOR_HINT_LIMITS.bytes);}catch(error){if(error.code==='ENOENT')return {value:{version:1,owner:this.ownerHash,entries:[]},stat:null};throw error;}
  if(!this.valid(result.value))hintInvalid();return result;
 }
 async folders(criteria,liveFolders){
  const selector=mailLocatorSelector(criteria);if(!selector)return [];
  const scope=await this.directory();if(!scope)return [];
  const {value}=await this.load(scope),allowed=new Set(liveFolders);
  return [...new Set(value.entries.filter(e=>e.expiresAt>this.now()&&e.key===selector.key&&JSON.stringify(e.tokens)===JSON.stringify(selector.tokens)&&allowed.has(e.folder)).sort((a,b)=>b.learnedAt-a.learnedAt||a.folder.localeCompare(b.folder)).map(e=>e.folder))].slice(0,3);
 }
 async remember(criteria,messages,liveFolders){
  const selector=mailLocatorSelector(criteria);if(!selector)return false;const allowed=new Set(liveFolders),matches=[];
  for(const message of messages){
   // Only MailApi's exact live-match branch calls this method. Independently
   // reject snapshot/candidate-shaped input; cached UIDs are never fetched.
   const [kind,encoded,uidValidity,uid,extra]=String(message.id??'').split(':');
   if(kind!=='imap'||extra||!encoded||!/^\d+$/.test(uidValidity??'')||!Number.isSafeInteger(Number(uid))||Number(uid)<1||message.matchType||message.source||message.exactQueryMatched===false)continue;
   const folder=Buffer.from(encoded,'base64url').toString('utf8');if(Buffer.from(folder).toString('base64url')!==encoded||folder!==message.folder||!validHintFolder(folder)||!allowed.has(folder))continue;
   if(matches.some(item=>item.folder===folder))continue;matches.push({folder,uidValidity});if(matches.length===3)break;
  }
  if(!matches.length)return false;
  const scope=await this.directory(true),lock=this.file+'.lock';let handle,lockStat;
  try{handle=await open(lock,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(error){
   if(error.code!=='EEXIST')throw error;
   const old=await this.readFile(scope,lock,256);if(!Number.isSafeInteger(old.value.pid)||old.value.pid<1)hintInvalid();
   try{process.kill(old.value.pid,0);}catch(e){if(e.code==='ESRCH'&&sameHintFile(old.stat,await lstat(lock))){await this.check(scope);await unlink(lock);}}
   return false; // Never wait for another search or repeat a provider read.
  }
  lockStat=await handle.stat();let temp;
  try{
   await handle.chown(scope.parent.uid,scope.parent.gid);await handle.writeFile(JSON.stringify({pid:process.pid}));lockStat=await handle.stat();
   const old=await this.load(scope),now=this.now(),entries=old.value.entries.filter(e=>e.expiresAt>now&&!matches.some(m=>e.key===selector.key&&e.folder===m.folder));
   entries.push(...matches.map(m=>({...m,key:selector.key,tokens:selector.tokens,learnedAt:now,expiresAt:now+MAIL_LOCATOR_HINT_LIMITS.ttlMs})));entries.sort((a,b)=>b.learnedAt-a.learnedAt||a.folder.localeCompare(b.folder));
   const value={version:1,owner:this.ownerHash,entries:entries.slice(0,64)};while(Buffer.byteLength(JSON.stringify(value))>MAIL_LOCATOR_HINT_LIMITS.bytes)value.entries.pop();
   temp=join(this.root,'.'+this.ownerHash+'.'+randomUUID()+'.tmp');const out=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await out.chown(scope.parent.uid,scope.parent.gid);await out.writeFile(JSON.stringify(value));await out.sync();}finally{await out.close();}
   await this.check(scope);let named=null;try{named=await lstat(this.file);}catch(e){if(e.code!=='ENOENT')throw e;}if(Boolean(named)!==Boolean(old.stat)||named&&!sameHintFile(named,old.stat))hintInvalid();
   await rename(temp,this.file);temp=null;const dir=await open(this.root,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);try{if(!sameInode(scope.dir,await dir.stat()))hintInvalid();await dir.sync();}finally{await dir.close();}return true;
  }finally{await handle.close();if(temp)await unlink(temp).catch(()=>{});if(lockStat){try{const named=await lstat(lock);if(named.dev===lockStat.dev&&named.ino===lockStat.ino&&named.isFile()&&named.nlink===1)await unlink(lock);}catch(e){if(e.code!=='ENOENT')throw e;}}}
 }
}

/** Recent source hints only. Enumerate owner-derived names, never a shared body
 * directory or another employee's cache. The ordinary live cursor covers history. */
export async function recentOwnedMail({mailbox,store,dataDirectory,criteria,folder,limit,now=Date.now,deadline,maxReads=30,uidWindow=250,cursor=null}){
 if(currentFlags(criteria))return {messages:[],coverage:{source:'recent_owned_snapshots',complete:false,readSnapshots:0,stopped:'current_flags_require_live_search'}};
 const candidates=[];
 for(const logical of ['Inbox','SentItems']){
  const state=store.getImapState(mailbox,logical);
  if(!state||!/^\d+$/.test(state.uid_validity??'')||!Number.isSafeInteger(state.last_uid)||state.last_uid<1)continue;
  for(let uid=state.last_uid;uid>=Math.max(1,state.last_uid-uidWindow+1);uid--){
   const id=ownedMailSnapshotReference({mailbox,folder:logical,uidValidity:state.uid_validity,uid});const scope=decodeOwnedMailSnapshotReference(id,mailbox);
   candidates.push({id,scope,file:join(dataDirectory,'delta',scope.snapshotId+'.json')});
  }
 }
 // Metadata from only owner-derived paths is safe to rank before body reads.
 let unavailableSources=0;
 const found=(await Promise.all(candidates.map(async candidate=>{
  try{
   const stat=await lstat(candidate.file);
   if(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&!(stat.mode&0o077)&&stat.size<=2*1024*1024)return {...candidate,stat};
   unavailableSources++;return null;
  }catch(error){if(error.code!=='ENOENT')unavailableSources++;return null;}
 }))).filter(Boolean).sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs||b.scope.uid-a.scope.uid);
 // A page budget must not discard the rest of the authenticated owner's
 // source window. Bind continuation to this exact source catalog so changing
 // files cannot silently skip or substitute candidates between pages.
 const catalog=createHash('sha256').update(JSON.stringify(found.map(c=>[c.id,c.stat.dev,c.stat.ino,c.stat.size,c.stat.mtimeMs,c.stat.ctimeMs]))).digest('hex');
 if(cursor&&(Object.keys(cursor).sort().join(',')!=='catalog,index'||cursor.catalog!==catalog||!Number.isSafeInteger(cursor.index)||cursor.index<0||cursor.index>found.length))throw Object.assign(Error('Owned sources changed; restart search'),{code:'MAIL_SEARCH_CURSOR_EXPIRED'});
 const startIndex=cursor?.index??0,messages=[];let read=0,bytes=0,stopped=null,index=startIndex;
 while(index<found.length){
  const candidate=found[index];
  if(messages.length>=limit){stopped='page_limit';break;}
  if(read>=maxReads||now()>=deadline||bytes+candidate.stat.size>8*1024*1024){stopped='work_budget';break;}
  index++;
  let handle;
  // A missing/changing hint is not a missing provider message. Failed attempts
  // consume the same bounded read/byte budget and never prevent live fallback.
  read++;bytes+=candidate.stat.size;
  try{
   handle=await open(candidate.file,constants.O_RDONLY|constants.O_NOFOLLOW);
   const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.ino!==candidate.stat.ino||before.dev!==candidate.stat.dev||before.size!==candidate.stat.size||before.mtimeMs!==candidate.stat.mtimeMs)throw Error('Owned mail snapshot changed');
   const raw=await handle.readFile();const after=await handle.stat();if(raw.length!==before.size||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error('Owned mail snapshot changed');
   const snapshot=JSON.parse(raw);
   if(snapshot.mailbox!==mailbox||snapshot.folder!==candidate.scope.folder)throw Error('Owned mail snapshot scope mismatch');
   const data=snapshot.data??{},[kind,,generation,uid,extra]=String(data.id??'').split(':');
   if(kind!=='imap'||extra||generation!==candidate.scope.uidValidity||String(candidate.scope.uid)!==uid)throw Error('Owned mail snapshot identity mismatch');
   if(['subject','text','bodyPreview','html','receivedDateTime','internalDate','internetMessageId'].some(key=>data[key]!=null&&typeof data[key]!=='string')||['from','toRecipients','ccRecipients','bccRecipients','attachments'].some(key=>data[key]!=null&&!Array.isArray(data[key])))throw Error('Invalid owned mail hint shape');
   if(folder){const native=Buffer.from(String(data.id).split(':')[1]??'','base64url').toString();if(native!==folder)continue;}
   if(!matchesOwnedMailCriteria(data,criteria))continue;
   messages.push({id:candidate.id,originalMessageId:data.id,folder:snapshot.folderPath??Buffer.from(data.id.split(':')[1],'base64url').toString(),subject:data.subject??'',from:addresses(data.from),to:addresses(data.toRecipients),cc:addresses(data.ccRecipients),date:data.receivedDateTime??data.internalDate??null,internetMessageId:data.internetMessageId??null,attachments:(data.attachments??[]).map(a=>({name:a.filename??a.name,contentType:a.contentType,size:a.size})),source:'owned_snapshot',originalVerified:false,warning:'Owned historical source locator. Read this ID to recover and verify the current original; attachment names do not attest original bytes.'});
  }catch{unavailableSources++;}finally{await handle?.close().catch(()=>{unavailableSources++;});}
 }
 messages.sort((a,b)=>String(b.date??'').localeCompare(String(a.date??''))||a.id.localeCompare(b.id));
 return {messages,cursor:index>startIndex&&index<found.length?{catalog,index}:null,coverage:{source:'recent_owned_snapshots',complete:false,uidWindowPerFolder:uidWindow,candidateFiles:found.length,readSnapshots:read,readBytes:bytes,unavailableSources,stopped,remainingCandidates:found.length-index,windowExhausted:index===found.length,truncatedMatches:false}};
}
