import {OutreachOperatorStore,assertOperatorAccess,OperatorError,type OperatorActor,type OperatorConfiguration} from './operator-runtime.ts';
import {planOutreachMonth,type MonthPlanInput} from './outreach-month-plan.ts';
import {createHash} from 'node:crypto';

const DAY=86400000;
const noEffects={providerDispatch:false,crmHistoricalRead:false,crmWrite:false,emailSent:false,campaignActivated:false,notificationSent:false,linkedinAction:false,schedulerInstalled:false} as const;
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[-a-zA-Z0-9_:]{1,100}$/.test(value);
const validDigest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(input:object,allowed:string[])=>Object.keys(input).every(key=>allowed.includes(key));
const madridDay=(time:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
function deny(code='OUTREACH_SYSTEM_INPUT_DENIED'):never{throw new OperatorError(400,code);}
export type Tier1CandidateInput={draftId:string;digest:string;reason:string;evidenceUrl:string;evidenceCheckedAt:string;linkedinUrl:string};
export type Tier1Status='requested'|'connected'|'skipped';
export type Tier1DigestItem={draftId:string;digest:string;reason:string;evidenceUrl:string;evidenceCheckedAt:string;linkedinUrl:string;status:'ready'|Tier1Status};
export type Tier1Digest={day:string;timeZone:'Europe/Madrid';mode:'local-manual-linkedin-review';items:Tier1DigestItem[];counts:{selected:number;available:number;heldOrExpired:number};created:boolean;emailSent:false;notificationSent:false;linkedinAction:false;schedulerInstalled:false;providerDispatch:false;crmHistoricalRead:false;crmWrite:false;campaignActivated:false};

/** Shares the exact operator SQLite identity/store and references existing drafts. */
export class OutreachMonthPlanStore extends OutreachOperatorStore{
 private readonly systemConfiguration:OperatorConfiguration;
 private readonly systemActor:OperatorActor;
 constructor(configuration:OperatorConfiguration,actor:OperatorActor,now:()=>number=Date.now){
  super(configuration,actor,now);
  this.systemConfiguration={...configuration,approvedResearchOrigins:[...configuration.approvedResearchOrigins],approvedVerificationProviders:[...configuration.approvedVerificationProviders]};
  this.systemActor={...actor};
  try{this.db.exec(`
   CREATE TABLE IF NOT EXISTS outreach_tier1_candidates(draft_id TEXT PRIMARY KEY,digest TEXT NOT NULL,contact_hash TEXT NOT NULL,reason TEXT NOT NULL,evidence_url TEXT NOT NULL,evidence_checked_at INTEGER NOT NULL,linkedin_url TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS outreach_tier1_digests(day TEXT PRIMARY KEY,created_at INTEGER NOT NULL,limit_count INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS outreach_tier1_digest_items(day TEXT NOT NULL,draft_id TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(day,draft_id),UNIQUE(day,position));
   CREATE INDEX IF NOT EXISTS outreach_tier1_contact ON outreach_tier1_candidates(contact_hash);
   CREATE TABLE IF NOT EXISTS outreach_tier1_account_locks(account_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,created_at INTEGER NOT NULL);
  `);this.expireTier1();}catch(error){this.close();throw error;}
 }
 private access(){assertOperatorAccess(this.systemConfiguration,this.systemActor);}
 private expireTier1(){
  // Minimal evidence is retained for at most seven days; immutable membership
  // references may outlive it but readback never reconstructs erased evidence.
  this.db.prepare("UPDATE outreach_tier1_candidates SET reason='',evidence_url='',linkedin_url='',status=CASE WHEN status='ready' THEN 'expired' ELSE status END WHERE evidence_checked_at<? AND (reason!='' OR evidence_url!='' OR linkedin_url!='')").run(this.now()-7*DAY);
 }
 private eligible(draftId:string):Tier1DigestItem|null{
  const row=this.db.prepare('SELECT * FROM outreach_tier1_candidates WHERE draft_id=?').get(draftId);
  if(!row||row.status==='expired'||Number(row.evidence_checked_at)<this.now()-7*DAY||Number(row.evidence_checked_at)>this.now())return null;
  if(this.db.prepare('SELECT 1 FROM suppressions WHERE email_hash=?').get(String(row.contact_hash))||this.db.prepare('SELECT 1 FROM operator_holds WHERE draft_id=?').get(draftId))return null;
  try{
   const lead=this.readDraft(draftId,String(row.digest));
   const verificationAge=this.now()-Date.parse(lead.verification.checkedAt),signalAge=this.now()-Date.parse(lead.signalDate);
   if(verificationAge<0||verificationAge>7*DAY||signalAge<0||signalAge>90*DAY)return null;
   if(!this.db.prepare('SELECT 1 FROM contacts WHERE draft_id=? AND email_hash=?').get(draftId,String(row.contact_hash)))return null;
  }catch{return null;}
  return {draftId,digest:String(row.digest),reason:String(row.reason),evidenceUrl:String(row.evidence_url),evidenceCheckedAt:new Date(Number(row.evidence_checked_at)).toISOString(),linkedinUrl:String(row.linkedin_url),status:String(row.status) as Tier1DigestItem['status']};
 }
 monthPlan(input:MonthPlanInput={}){this.access();try{return planOutreachMonth(input);}catch{deny('OUTREACH_MONTH_PLAN_INPUT_DENIED');}}
 stageTier1Candidate(input:Tier1CandidateInput){
  this.access();this.expireTier1();
  if(!input||typeof input!=='object'||!exact(input,['draftId','digest','reason','evidenceUrl','evidenceCheckedAt','linkedinUrl'])||!validId(input.draftId)||!validDigest(input.digest)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500||/[\r\n\0]/.test(input.reason))deny();
  let linkedin:URL,evidence:URL;try{linkedin=new URL(input.linkedinUrl);evidence=new URL(input.evidenceUrl);}catch{deny();}
  if(linkedin.protocol!=='https:'||linkedin.hostname!=='www.linkedin.com'||linkedin.username||linkedin.password||linkedin.port||linkedin.search||linkedin.hash||!/^\/in\/[a-zA-Z0-9_%\-]{2,100}\/?$/.test(linkedin.pathname)||linkedin.pathname.includes('%'))deny('OUTREACH_PUBLIC_LINKEDIN_PROFILE_REQUIRED');
  if(evidence.protocol!=='https:'||evidence.username||evidence.password||evidence.search||evidence.hash||!this.systemConfiguration.approvedResearchOrigins.includes(evidence.origin))deny('OUTREACH_EVIDENCE_SCOPE_DENIED');
  const checked=Date.parse(input.evidenceCheckedAt);if(!Number.isFinite(checked)||new Date(checked).toISOString()!==input.evidenceCheckedAt||checked>this.now()||checked<this.now()-7*DAY)deny('OUTREACH_FRESH_EVIDENCE_REQUIRED');
  const lead=this.readDraft(input.draftId,input.digest);this.review(input.draftId,input.digest,this.systemActor);
  if(input.evidenceUrl!==lead.sourceUrl)deny('OUTREACH_EXISTING_DRAFT_EVIDENCE_REQUIRED');
  return this.transaction(()=>{
   this.readDraft(input.draftId,input.digest);
   const contact=this.db.prepare('SELECT email_hash FROM contacts WHERE draft_id=?').get(input.draftId);if(!contact)deny();
   const old=this.db.prepare('SELECT * FROM outreach_tier1_candidates WHERE draft_id=?').get(input.draftId);
   if(old){if(old.digest!==input.digest||old.reason!==input.reason||old.evidence_url!==input.evidenceUrl||Number(old.evidence_checked_at)!==checked||old.linkedin_url!==input.linkedinUrl)throw new OperatorError(409,'OUTREACH_TIER1_IMMUTABLE_CONFLICT');return{draftId:input.draftId,duplicate:true,...noEffects};}
   if(Number(this.db.prepare('SELECT count(*) AS n FROM outreach_tier1_candidates').get()?.n)>=5000)throw new OperatorError(429,'OUTREACH_TIER1_CAPACITY_REACHED');
   const accountHash=createHash('sha256').update(`${this.systemConfiguration.installationId}:${lead.accountId}`).digest('hex');
   for(const row of this.db.prepare('SELECT h.payload AS handoff,d.payload AS draft FROM handoffs h LEFT JOIN drafts d ON d.id=h.draft_id').all()){
    const handoff=JSON.parse(String(row.handoff)),draft=JSON.parse(String(row.draft??'{}'));
    const previousHash=typeof handoff.accountHash==='string'?handoff.accountHash:typeof draft.accountId==='string'?createHash('sha256').update(`${this.systemConfiguration.installationId}:${draft.accountId}`).digest('hex'):null;
    if(previousHash===null||previousHash===accountHash)throw new OperatorError(409,'OUTREACH_ACCOUNT_HANDOFF_RECONCILIATION_REQUIRED');
   }
   this.db.prepare('INSERT OR IGNORE INTO outreach_tier1_account_locks VALUES(?,?,?)').run(accountHash,'luca-manual-coordination',this.now());
   this.db.prepare('INSERT INTO outreach_tier1_candidates VALUES(?,?,?,?,?,?,?,?,?)').run(input.draftId,input.digest,String(contact.email_hash),input.reason,input.evidenceUrl,checked,input.linkedinUrl,'ready',this.now());
   return{draftId:input.draftId,duplicate:false,...noEffects};
  });
 }
 prepareTier1Digest(input:{day?:string;limit?:number}={}):Tier1Digest{
  this.access();this.expireTier1();if(!input||typeof input!=='object'||!exact(input,['day','limit']))deny();
  const day=input.day??madridDay(this.now()),limit=input.limit??5;
  if(day!==madridDay(this.now())||!Number.isInteger(limit)||limit<1||limit>20)deny('OUTREACH_CURRENT_DAY_AND_BOUNDED_LIMIT_REQUIRED');
  let created=false;
  this.transaction(()=>{
   const previous=this.db.prepare('SELECT limit_count FROM outreach_tier1_digests WHERE day=?').get(day);
   if(previous){if(Number(previous.limit_count)!==limit)throw new OperatorError(409,'OUTREACH_DIGEST_IMMUTABLE_LIMIT');return;}
   this.db.prepare('INSERT INTO outreach_tier1_digests VALUES(?,?,?)').run(day,this.now(),limit);created=true;
   const rows=this.db.prepare("SELECT draft_id,contact_hash FROM outreach_tier1_candidates WHERE status='ready' ORDER BY created_at,draft_id").all();
   let position=0;const selectedContacts=new Set<string>();
   for(const row of rows){
    if(position>=limit)break;
    if(selectedContacts.has(String(row.contact_hash))||!this.eligible(String(row.draft_id)))continue;
    // Reverification cannot bypass a previous manual request/connection or the
    // seven-day digest cooldown for the same hashed contact.
    const permanent=this.db.prepare("SELECT 1 FROM outreach_tier1_candidates WHERE contact_hash=? AND status IN ('requested','connected')").get(String(row.contact_hash));
    const recent=this.db.prepare('SELECT 1 FROM outreach_tier1_digest_items i JOIN outreach_tier1_candidates c ON c.draft_id=i.draft_id JOIN outreach_tier1_digests d ON d.day=i.day WHERE c.contact_hash=? AND d.created_at>=?').get(String(row.contact_hash),this.now()-7*DAY);
    if(permanent||recent)continue;
    this.db.prepare('INSERT INTO outreach_tier1_digest_items VALUES(?,?,?)').run(day,String(row.draft_id),position++);selectedContacts.add(String(row.contact_hash));
   }
  });
  return{...this.tier1Snapshot(day),created};
 }
 tier1Snapshot(day=madridDay(this.now())):Tier1Digest{
  this.access();this.expireTier1();
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(Date.parse(day)).toISOString().slice(0,10)!==day||day>madridDay(this.now()))deny('OUTREACH_DIGEST_DAY_DENIED');
  const digest=this.db.prepare('SELECT created_at FROM outreach_tier1_digests WHERE day=?').get(day);
  const members=this.db.prepare('SELECT draft_id FROM outreach_tier1_digest_items WHERE day=? ORDER BY position').all(day);
  const items=digest&&Number(digest.created_at)>=this.now()-7*DAY?members.map(row=>this.eligible(String(row.draft_id))).filter((item):item is Tier1DigestItem=>item!==null):[];
  return{day,timeZone:'Europe/Madrid',mode:'local-manual-linkedin-review',items,counts:{selected:members.length,available:items.length,heldOrExpired:members.length-items.length},created:false,...noEffects};
 }
 updateTier1Status(input:{draftId:string;status:Tier1Status}){
  this.access();this.expireTier1();if(!input||typeof input!=='object'||!exact(input,['draftId','status'])||!validId(input.draftId)||!['requested','connected','skipped'].includes(input.status))deny();
  return this.transaction(()=>{
   const candidate=this.eligible(input.draftId);if(!candidate)throw new OperatorError(409,'OUTREACH_TIER1_HELD_OR_EXPIRED');
   if(!this.db.prepare('SELECT 1 FROM outreach_tier1_digest_items WHERE draft_id=?').get(input.draftId))throw new OperatorError(409,'OUTREACH_TIER1_NOT_SELECTED');
   if(candidate.status==='connected'&&input.status!=='connected'||candidate.status==='requested'&&input.status==='skipped')throw new OperatorError(409,'OUTREACH_TIER1_STATE_CONFLICT');
   this.db.prepare('UPDATE outreach_tier1_candidates SET status=? WHERE draft_id=?').run(input.status,input.draftId);
   return{draftId:input.draftId,status:input.status,recordedBy:'authenticated-operator',providerReceiptVerified:false,...noEffects};
  });
 }
}
