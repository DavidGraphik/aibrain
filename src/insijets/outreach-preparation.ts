import { deploymentIdentity } from "@/deployment/identities";
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chmodSync,existsSync,lstatSync,mkdirSync} from 'node:fs';
import path from 'node:path';
type Account={id:string;company:string;country:string;persona:string;sourceUrl:string;signalDate:string;fitReviewed:boolean};
type Contact={email:string;firstName:string;persona:string};
type Verification={status:'valid'|'invalid'|'risky'|'unknown';checkedAt:string;provider:string};
type Source={id:string;costCredits:number;enrich:(account:Account)=>Promise<Contact|null>};
type Policy={installationId:string;execution:'synthetic-fixture'|'prepared';sourceApproved:boolean;allowedCountries:string[];allowedPersonas:string[];allowedSources:string[];maxCredits:number;maxCalls:number;verificationCostCredits:number;suppressedEmailHashes:string[];sendingAccountReference:string;allowedResearchOrigins:string[]};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const email=(v:string)=>typeof v==='string'&&v.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const text=(v:string,max=200)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\r\n\u0000]/.test(v);
export type PreparedLead={id:string;accountId:string;company:string;country:string;persona:string;contact:Contact;verification:Verification;sourceUrl:string;signalDate:string;score:number;scoreMeaning:'review priority; no inferred charter intent';draft:{sendingAccountReference:string;to:string[];cc:never[];bcc:never[];subject:string;body:string;attachments:never[]};digest:string;status:'draft';externalDispatch:false};
export async function prepareOutreachBatch(accounts:Account[],policy:Policy,sources:Source[],verify:(contact:Contact)=>Promise<Verification>,now=Date.now()){
 if(policy.installationId!=='insijets-demo'||policy.sourceApproved!==true||!['synthetic-fixture','prepared'].includes(policy.execution)||!Array.isArray(accounts)||accounts.length>100||!Number.isInteger(policy.maxCalls)||policy.maxCalls<1||policy.maxCalls>200||!Number.isFinite(policy.maxCredits)||policy.maxCredits<0||!Number.isFinite(policy.verificationCostCredits)||policy.verificationCostCredits<0||!text(policy.sendingAccountReference,100)||!Array.isArray(policy.allowedResearchOrigins)||!policy.allowedResearchOrigins.length||policy.allowedResearchOrigins.some(origin=>{try{const url=new URL(origin);return url.protocol!=='https:'||url.origin!==origin;}catch{return true;}})||!sources.length||sources.some(s=>!policy.allowedSources.includes(s.id)||!Number.isFinite(s.costCredits)||s.costCredits<0))throw Error('Approved bounded Example Charter preparation policy required');
 const leads:PreparedLead[]=[],held:{accountId:string;reason:string}[]=[],trace:{accountId:string;stage:string;provider?:string;outcome:string}[]=[];const seen=new Set<string>(),accountIds=new Set<string>();let calls=0,credits=0;
 for(const account of accounts){
  if(!text(account.id,100)||accountIds.has(account.id)){held.push({accountId:String(account.id),reason:'duplicate_or_invalid_account'});continue;}accountIds.add(account.id);
  let source:URL|undefined;try{source=new URL(account.sourceUrl);}catch{}
  const age=now-Date.parse(account.signalDate);
  if(!text(account.company)||!source||source.protocol!=='https:'||source.username||source.password||source.search||source.hash||!policy.allowedResearchOrigins.includes(source.origin)||!Number.isFinite(age)||age<0||age>90*86400000||account.fitReviewed!==true||!policy.allowedCountries.includes(account.country)||!policy.allowedPersonas.includes(account.persona)){held.push({accountId:account.id,reason:'source_fit_geography_role_or_signal_gate'});continue;}
  trace.push({accountId:account.id,stage:'research',outcome:'approved_public_evidence_reviewed'});let chosen:Contact|undefined,verification:Verification|undefined;
  for(const provider of sources){
   if(calls+2>policy.maxCalls||credits+provider.costCredits+policy.verificationCostCredits>policy.maxCredits){trace.push({accountId:account.id,stage:'budget',outcome:'held_no_provider_call'});break;}calls++;credits+=provider.costCredits;
   let candidate:Contact|null;try{candidate=await provider.enrich(account);}catch{trace.push({accountId:account.id,stage:'enrichment',provider:provider.id,outcome:'failed_fallback'});continue;}
   trace.push({accountId:account.id,stage:'enrichment',provider:provider.id,outcome:candidate?'candidate':'no_match_fallback'});
   if(!candidate||!email(candidate.email)||!text(candidate.firstName,80)||candidate.persona!==account.persona)continue;
   candidate={email:candidate.email.toLowerCase(),firstName:candidate.firstName,persona:candidate.persona};const emailHash=hash(candidate.email);
   if(policy.suppressedEmailHashes.includes(emailHash)||seen.has(emailHash)){trace.push({accountId:account.id,stage:'quality',outcome:'duplicate_or_suppressed'});continue;}
   calls++;credits+=policy.verificationCostCredits;let result:Verification;try{result=await verify(candidate);}catch{trace.push({accountId:account.id,stage:'verification',outcome:'unavailable_fallback'});continue;}
   trace.push({accountId:account.id,stage:'verification',provider:result.provider,outcome:result.status});
   const verificationAge=now-Date.parse(result.checkedAt);if(result.status!=='valid'||!text(result.provider,100)||!Number.isFinite(verificationAge)||verificationAge<0||verificationAge>7*86400000)continue;
   chosen=candidate;verification={status:result.status,checkedAt:result.checkedAt,provider:result.provider};seen.add(emailHash);break;
  }
  if(!chosen||!verification){held.push({accountId:account.id,reason:'no_verified_unsuppressed_contact_or_budget'});continue;}
  // Priority score uses reviewed role/geography/source recency only. It is not
  // a forecast of wealth, charter intent, booking probability or deal value.
  const score=60+(age<=30*86400000?20:10)+20;
  const draft={sendingAccountReference:policy.sendingAccountReference,to:[chosen.email],cc:[] as never[],bcc:[] as never[],subject:'A travel contact for your team',body:`Hi ${chosen.firstName},\n\nI’m your travel contact at Example Charter. We help teams arrange private flights when commercial routes do not fit their schedule.\n\nWould it be useful to have a contact for a future trip?\n\nExample Representative\nExample Charter`,attachments:[] as never[]};
  const lead={id:randomUUID(),accountId:account.id,company:account.company,country:account.country,persona:account.persona,contact:chosen,verification,sourceUrl:account.sourceUrl,signalDate:account.signalDate,score,scoreMeaning:'review priority; no inferred charter intent' as const,draft,status:'draft' as const,externalDispatch:false as const};leads.push({...lead,digest:hash(JSON.stringify(lead))});trace.push({accountId:account.id,stage:'draft',outcome:'prepared_never_sent'});
 }
 return {installationId:'insijets-demo',execution:policy.execution,leads,held,trace,budget:{calls,credits,maxCalls:policy.maxCalls,maxCredits:policy.maxCredits},providerDispatch:false,campaignActivation:false,emailSend:false};
}
const exactKeys=(value:object,keys:string[])=>Object.keys(value).sort().join(',')===keys.sort().join(',');
function validateDraft(lead:PreparedLead,now:number,checkFresh=true){
 const allowed=['id','accountId','company','country','persona','contact','verification','sourceUrl','signalDate','score','scoreMeaning','draft','digest','status','externalDispatch'];
 if(!lead||!exactKeys(lead,allowed)||lead.externalDispatch!==false||lead.status!=='draft'||lead.scoreMeaning!=='review priority; no inferred charter intent'||!text(lead.id,100)||!text(lead.accountId,100)||!text(lead.company)||!text(lead.country,100)||!text(lead.persona,100)||!Number.isFinite(lead.score)||!text(lead.digest,64))throw Error('Exact immutable preparation draft required');
 const c=lead.contact,v=lead.verification,d=lead.draft;
 if(!c||!exactKeys(c,['email','firstName','persona'])||!email(c.email)||!text(c.firstName,80)||c.persona!==lead.persona||!v||!exactKeys(v,['status','checkedAt','provider'])||v.status!=='valid'||!text(v.provider,100)||!d||!exactKeys(d,['sendingAccountReference','to','cc','bcc','subject','body','attachments'])||!text(d.sendingAccountReference,100)||!Array.isArray(d.to)||d.to.length!==1||d.to[0]!==c.email||!Array.isArray(d.cc)||d.cc.length||!Array.isArray(d.bcc)||d.bcc.length||!Array.isArray(d.attachments)||d.attachments.length||!text(d.subject,200)||typeof d.body!=='string'||!d.body.trim()||d.body.length>10000||d.body.includes('\u0000'))throw Error('Minimal preparation fields required');
 let source:URL;try{source=new URL(lead.sourceUrl);}catch{throw Error('Public preparation source required');}if(source.protocol!=='https:'||source.username||source.password||source.search||source.hash)throw Error('Public preparation source required');
 const age=now-Date.parse(v.checkedAt),signalAge=now-Date.parse(lead.signalDate);if(!Number.isFinite(age)||!Number.isFinite(signalAge)||age<0||signalAge<0||(checkFresh&&(age>7*86400000||signalAge>90*86400000)))throw Error('Fresh verification and public evidence required');
}
export type PreparationActor={actorId:string;installationId:string;email:string};
function requireOwner(actor:PreparationActor){
 if(!actor||!text(actor.actorId,100)||actor.installationId!=='insijets-demo'||![deploymentIdentity("operator"),deploymentIdentity("cmsOwner")].includes(actor.email?.toLowerCase()))throw Error('Authenticated Example Charter preparation owner required');
}
export class OutreachPreparationStore{
 protected db:DatabaseSync;
 protected now:()=>number;
 constructor(root:string,installationId:string,now:()=>number=Date.now){
  this.now=now;
  if(installationId!=='insijets-demo'||!path.isAbsolute(root))throw Error('Example Charter preparation identity required');
  const directory=path.join(root,'insijets-outreach-preparation');
  if(existsSync(directory)&&(!lstatSync(directory).isDirectory()||lstatSync(directory).isSymbolicLink()))throw Error('Preparation path denied');
  mkdirSync(directory,{recursive:true,mode:0o700});const file=path.join(directory,'queue.sqlite');
  if(existsSync(file)&&(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink()))throw Error('Preparation store denied');
  const existed=existsSync(file);this.db=new DatabaseSync(file);
  try{
   if(existed){const identities=this.db.prepare('SELECT installation FROM identity LIMIT 2').all();if(identities.length!==1||identities[0]?.installation!==installationId)throw Error('Foreign preparation store denied');}
   chmodSync(directory,0o700);chmodSync(file,0o600);
   this.db.exec(`PRAGMA busy_timeout=5000;PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS identity(installation TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,digest TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS handoffs(id TEXT PRIMARY KEY,draft_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS contacts(email_hash TEXT PRIMARY KEY,draft_id TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS suppressions(email_hash TEXT PRIMARY KEY,at INTEGER NOT NULL);`);
   if(!existed)this.db.prepare('INSERT INTO identity VALUES(?)').run(installationId);
   // Backfill only this owned queue. Duplicate legacy rows fail closed.
   this.db.exec('BEGIN IMMEDIATE');
   for(const row of this.db.prepare("SELECT id,payload FROM drafts WHERE status IN ('draft','handoff_prepared')").all()){
    const lead=JSON.parse(String(row.payload)) as PreparedLead;validateDraft(lead,this.now(),false);
    const emailHash=hash(lead.contact.email.toLowerCase()),bound=this.db.prepare('SELECT draft_id FROM contacts WHERE email_hash=?').get(emailHash);
    if(bound&&bound.draft_id!==row.id)throw Error('Duplicate legacy preparation contact requires reconciliation');
    this.db.prepare('INSERT OR IGNORE INTO contacts VALUES(?,?)').run(emailHash,String(row.id));
   }
   this.db.exec('COMMIT');
  }catch(error){try{this.db.exec('ROLLBACK');}catch{}this.db.close();throw error;}
 }
 protected transaction<T>(operation:()=>T):T{
  this.db.exec('BEGIN IMMEDIATE');try{const result=operation();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 protected readDraft(id:string,digest:string,allowHeld=false){
  const row=this.db.prepare('SELECT * FROM drafts WHERE id=?').get(id);
  if(!row||row.digest!==digest||!['draft','handoff_prepared'].includes(String(row.status)))throw Error('Exact draft approval mismatch');
  if(!allowHeld&&this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operator_holds'").get()&&this.db.prepare('SELECT draft_id FROM operator_holds WHERE draft_id=?').get(id))throw Error('Reply hold requires human review');
  const stored=JSON.parse(String(row.payload)) as PreparedLead;validateDraft(stored,this.now(),false);
  const {digest:storedDigest,...storedPayload}=stored;
  if(storedDigest!==digest||hash(JSON.stringify(storedPayload))!==digest)throw Error('Stored preparation payload tampered');
  if(this.db.prepare('SELECT 1 FROM suppressions WHERE email_hash=?').get(hash(stored.contact.email.toLowerCase())))throw Error('Preparation contact suppressed');
  return stored;
 }
 stage(lead:PreparedLead){
  validateDraft(lead,this.now());const {digest,...payload}=lead;
  if(hash(JSON.stringify(payload))!==digest)throw Error('Exact immutable preparation draft required');
  return this.transaction(()=>{
   const emailHash=hash(lead.contact.email.toLowerCase());
   if(this.db.prepare('SELECT 1 FROM suppressions WHERE email_hash=?').get(emailHash))throw Error('Preparation contact suppressed');
   const previous=this.db.prepare('SELECT digest FROM drafts WHERE id=?').get(lead.id);
   if(previous){if(previous.digest!==digest)throw Error('Preparation draft conflict');this.readDraft(lead.id,digest);return{duplicate:true,id:lead.id};}
   const contact=this.db.prepare('SELECT draft_id FROM contacts WHERE email_hash=?').get(emailHash);
   if(contact){
    const oldRow=this.db.prepare('SELECT digest,status FROM drafts WHERE id=?').get(String(contact.draft_id));
    if(!oldRow)throw Error('Contact reconciliation required');
    if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operator_holds'").get()&&this.db.prepare('SELECT draft_id FROM operator_holds WHERE draft_id=?').get(String(contact.draft_id)))throw Error('Reply hold requires human review');
    if(oldRow.status!=='expired'){const old=this.readDraft(String(contact.draft_id),String(oldRow.digest));if(this.now()-Date.parse(old.verification.checkedAt)<=7*86400000)throw Error('Durable duplicate preparation contact');}
    // A newly verified immutable draft supersedes an expired local draft only.
    this.db.prepare("UPDATE drafts SET payload='{}',status='superseded' WHERE id=?").run(String(contact.draft_id));
    this.db.prepare('DELETE FROM contacts WHERE email_hash=?').run(emailHash);
   }
   this.db.prepare('INSERT INTO drafts VALUES(?,?,?,?)').run(lead.id,digest,JSON.stringify(lead),'draft');
   this.db.prepare('INSERT INTO contacts VALUES(?,?)').run(emailHash,lead.id);
   return{duplicate:false,id:lead.id};
  });
 }
 approveHandoff(id:string,digest:string,actor:PreparationActor&{confirmation:string}){
  requireOwner(actor);if(actor.confirmation!=='APPROVE PREPARED HANDOFF ONLY')throw Error('Exact operator handoff approval required');
  return this.transaction(()=>{
   const stored=this.readDraft(id,digest);validateDraft(stored,this.now());
   // A manual Tier1 account cannot also enter the email/CRM handoff lane.
   // Keep the minimal account lock across body expiry/reverification; a later
   // explicit coordination/release workflow must resolve it, never a new draft.
   if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='outreach_tier1_account_locks'").get()&&this.db.prepare('SELECT 1 FROM outreach_tier1_account_locks WHERE account_hash=?').get(hash(`insijets-demo:${stored.accountId}`)))throw Error('Tier1 account requires Example Representative manual coordination');
   const previous=this.db.prepare('SELECT payload FROM handoffs WHERE draft_id=?').get(id);
   if(previous)return JSON.parse(String(previous.payload));
   const handoff={id:randomUUID(),draftId:id,digest,accountHash:hash(`insijets-demo:${stored.accountId}`),actorId:actor.actorId,kind:'crm.draft-contact',approvedAt:new Date(this.now()).toISOString(),verificationExpiresAt:new Date(Date.parse(stored.verification.checkedAt)+7*86400000).toISOString(),confirmationScope:'prepared-handoff',status:'prepared',providerDispatch:false,emailSend:false,campaignActivation:false,requiresSeparateDavidApprovalOfExactFinalEmail:true};
   this.db.prepare('INSERT INTO handoffs VALUES(?,?,?)').run(handoff.id,id,JSON.stringify(handoff));
   this.db.prepare("UPDATE drafts SET status='handoff_prepared' WHERE id=?").run(id);return handoff;
  });
 }
 review(id:string,digest:string,actor:PreparationActor){requireOwner(actor);const draft=this.readDraft(id,digest,true);validateDraft(draft,this.now());return{draft,sendingAccountResolved:false,emailApprovalGranted:false,providerDispatch:false};}
 receipt(id:string,actor:PreparationActor){
  requireOwner(actor);const row=this.db.prepare('SELECT id,digest,status,payload FROM drafts WHERE id=?').get(id);if(!row)throw Error('Preparation receipt not found');
  let status=String(row.status);
  if(['draft','handoff_prepared'].includes(status)){const draft=this.readDraft(id,String(row.digest));if(this.now()-Date.parse(draft.verification.checkedAt)>7*86400000||this.now()-Date.parse(draft.signalDate)>90*86400000)status='expired';}
  const handoff=this.db.prepare('SELECT id FROM handoffs WHERE draft_id=?').get(id);
  return{draftId:id,digest:String(row.digest),status,handoffId:handoff?String(handoff.id):null,providerDispatch:false,emailSend:false};
 }
 protected eraseTier1Evidence(emailHash:string){
  if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='outreach_tier1_candidates'").get())this.db.prepare("UPDATE outreach_tier1_candidates SET reason='',evidence_url='',linkedin_url='',status='expired' WHERE contact_hash=?").run(emailHash);
 }
 eraseAndSuppress(emailAddress:string,actor:PreparationActor){
  requireOwner(actor);if(!email(emailAddress))throw Error('Valid suppression contact required');
  return this.transaction(()=>{
   const emailHash=hash(emailAddress.toLowerCase()),contact=this.db.prepare('SELECT draft_id FROM contacts WHERE email_hash=?').get(emailHash);
   this.db.prepare('INSERT OR IGNORE INTO suppressions VALUES(?,?)').run(emailHash,this.now());
   this.eraseTier1Evidence(emailHash);
   if(contact){this.db.prepare("UPDATE drafts SET payload='{}',status='erased' WHERE id=?").run(String(contact.draft_id));this.db.prepare('DELETE FROM contacts WHERE email_hash=?').run(emailHash);}
   return{status:'erased_and_suppressed',providerDispatch:false,emailSend:false};
  });
 }
 suppressionHashes(actor:PreparationActor){requireOwner(actor);return this.db.prepare('SELECT email_hash FROM suppressions').all().map(row=>String(row.email_hash));}
 summary(){return{drafts:Number(this.db.prepare('SELECT count(*) AS n FROM drafts').get()?.n),handoffs:Number(this.db.prepare('SELECT count(*) AS n FROM handoffs').get()?.n),providerDispatch:false,emailSend:false};}
 close(){this.db.close();}
}
