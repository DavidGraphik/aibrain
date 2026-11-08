import { deploymentIdentity } from "@/deployment/identities";
import {createHash} from 'node:crypto';
import {OutreachPreparationStore,type PreparedLead,type PreparationActor} from './outreach-preparation.ts';
import {confidenceRating,weeklyReadout,triageReply,dueContent,type MetricCounts,type ReplyKind} from './operator-methods.mjs';

const DAY=86400000;
const metricKeys=['attempted','delivered','hardBounces','readyRecords','duplicateRecords','principalDelivered','principalPositiveReplies','gatekeeperDelivered','gatekeeperPositiveReplies','acceptedLeads','providerCost','creditsUsed'];
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[-a-zA-Z0-9_:]{1,100}$/u.test(v);
const iso=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
const noEffects={providerDispatch:false,crmHistoricalRead:false,crmWrite:false,emailSent:false,campaignActivated:false,callPlaced:false,notificationSent:false,published:false} as const;
export type OperatorActor=PreparationActor&{provider:'local';canManageWorkspace:boolean};
export type OperatorConfiguration={enabled:boolean;installationId:string;storageRoot:string;approvedResearchOrigins:string[];approvedVerificationProviders:string[]};
export class OperatorError extends Error{readonly status:number;readonly code:string;constructor(status:number,code:string){super(code);this.status=status;this.code=code;}}
function deny(code='OPERATOR_INPUT_DENIED'):never{throw new OperatorError(400,code);}
export function assertOperatorAccess(c:OperatorConfiguration,a:OperatorActor){
 if(!a||a.provider!=='local'||a.installationId!=='insijets-demo'||!id(a.actorId)||a.canManageWorkspace!==true||![deploymentIdentity("operator"),deploymentIdentity("cmsOwner")].includes(a.email?.toLowerCase()))throw new OperatorError(403,'OPERATOR_ACCESS_DENIED');
 if(!c||c.enabled!==true||c.installationId!=='insijets-demo'||c.installationId!==a.installationId)throw new OperatorError(404,'OPERATOR_NOT_CONFIGURED');
}
export const OPERATOR_CATALOG={reviewPath:'/outreach',mode:'preparation-only',actions:['stage-draft','review-draft','approve-prepared-handoff','record-metrics','stage-content','review-due-content','record-reply','erase-suppress','queue-prepare','queue-next','queue-finish','queue-wrap','queue-pause','queue-resume'],views:['drafts','metrics','content','replies','call-queue'],providerBindings:'unconfigured',exactFinalEmailApprovalRequired:true,liveDialerCompatibility:'unverified',...noEffects};

export class OutreachOperatorStore extends OutreachPreparationStore{
 private configuration:OperatorConfiguration;private actor:OperatorActor;
 constructor(configuration:OperatorConfiguration,actor:OperatorActor,now:()=>number=Date.now){
  assertOperatorAccess(configuration,actor);super(configuration.storageRoot,configuration.installationId,now);this.configuration=configuration;this.actor=actor;
  try{
   this.db.exec(`CREATE TABLE IF NOT EXISTS operator_items(id TEXT PRIMARY KEY,kind TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS operator_holds(draft_id TEXT PRIMARY KEY,reason TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS operator_queue(id TEXT PRIMARY KEY,draft_id TEXT UNIQUE NOT NULL,provider TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS operator_single_active ON operator_queue((1)) WHERE state IN ('reviewing','wrap-up');
    CREATE TABLE IF NOT EXISTS operator_settings(id TEXT PRIMARY KEY,value TEXT NOT NULL);`);
   this.expire();
  }catch(error){this.close();throw error;}
 }
 private expire(){
  this.transaction(()=>{
   for(const row of this.db.prepare("SELECT id,digest,payload FROM drafts WHERE status IN ('draft','handoff_prepared')").all()){
    const lead=this.readDraft(String(row.id),String(row.digest),true);
    if(this.now()-Date.parse(lead.verification.checkedAt)>7*DAY){
     this.db.prepare("UPDATE drafts SET payload='{}',status='expired' WHERE id=?").run(String(row.id));
     this.db.prepare("UPDATE operator_queue SET state='held' WHERE draft_id=? AND state!='completed'").run(String(row.id));
    }
   }
   this.db.prepare("UPDATE operator_items SET payload='{}',status='expired' WHERE created_at<? AND status!='expired'").run(this.now()-7*DAY);
   this.db.prepare("UPDATE operator_queue SET state='held' WHERE state!='completed' AND (draft_id IN (SELECT id FROM drafts WHERE status IN ('expired','erased','superseded')) OR draft_id IN (SELECT draft_id FROM operator_holds))").run();
  });
 }
 private item(itemId:string,kind:string,payload:Record<string,unknown>){
  if(!id(itemId))deny();
  const hash=digest(payload),old=this.db.prepare('SELECT * FROM operator_items WHERE id=?').get(itemId);
  if(old){if(old.status!=='expired'&&digest(JSON.parse(String(old.payload)))!==old.digest)throw new OperatorError(409,'OPERATOR_STORED_PAYLOAD_CHANGED');if(old.digest!==hash||old.kind!==kind||old.status==='expired')throw new OperatorError(409,'OPERATOR_IMMUTABLE_CONFLICT');return {id:itemId,digest:hash,duplicate:true,...noEffects};}
  if(Number(this.db.prepare('SELECT count(*) AS n FROM operator_items').get()?.n)>=5000)throw new OperatorError(429,'OPERATOR_CAPACITY_REACHED');
  this.db.prepare('INSERT INTO operator_items VALUES(?,?,?,?,?,?)').run(itemId,kind,hash,JSON.stringify(payload),'prepared',this.now());
  return {id:itemId,digest:hash,duplicate:false,...noEffects};
 }
 private draft(draftId:string){
  const row=this.db.prepare('SELECT digest FROM drafts WHERE id=?').get(draftId);if(!row)throw new OperatorError(404,'OPERATOR_DRAFT_NOT_FOUND');
  const reviewed=this.review(draftId,String(row.digest),this.actor);return reviewed.draft;
 }
 private hold(draftId:string,reason:ReplyKind){
  const row=this.db.prepare('SELECT id FROM drafts WHERE id=?').get(draftId);if(!row)throw new OperatorError(404,'OPERATOR_DRAFT_NOT_FOUND');
  this.db.prepare('INSERT INTO operator_holds VALUES(?,?,?) ON CONFLICT(draft_id) DO UPDATE SET reason=excluded.reason,at=excluded.at').run(draftId,reason,this.now());
  if(reason==='opt-out'){
   const contact=this.db.prepare('SELECT email_hash FROM contacts WHERE draft_id=?').get(draftId);
   if(!contact)throw new OperatorError(409,'OPERATOR_CONTACT_MAPPING_UNAVAILABLE');
   this.db.prepare('INSERT OR IGNORE INTO suppressions VALUES(?,?)').run(String(contact.email_hash),this.now());
   this.eraseTier1Evidence(String(contact.email_hash));
   this.db.prepare("UPDATE drafts SET payload='{}',status='erased' WHERE id=?").run(draftId);
   this.db.prepare('DELETE FROM contacts WHERE draft_id=?').run(draftId);
  }
  this.db.prepare("UPDATE operator_queue SET state='held' WHERE draft_id=? AND state!='completed'").run(draftId);
 }
 snapshot(view:string,limit=50){
  assertOperatorAccess(this.configuration,this.actor);if(!OPERATOR_CATALOG.views.includes(view)||!Number.isInteger(limit)||limit<1||limit>100)deny();this.expire();
  if(view==='drafts'){
   const items=this.db.prepare('SELECT id,digest,status FROM drafts ORDER BY rowid DESC LIMIT ?').all(limit).map(row=>{
    let lead:PreparedLead|undefined;
    if(['draft','handoff_prepared'].includes(String(row.status)))lead=this.readDraft(String(row.id),String(row.digest),true);
    const held=!!this.db.prepare('SELECT draft_id FROM operator_holds WHERE draft_id=?').get(String(row.id));
    return{draftId:String(row.id),digest:String(row.digest),status:String(row.status),replyHeld:held,review:lead?{draft:lead,sendingAccountResolved:false,emailApprovalGranted:false}:null,confidence:lead?confidenceRating({verification:lead.verification,source:{url:lead.sourceUrl,checkedAt:lead.signalDate},fitReviewed:true},new Date(this.now()).toISOString()):null};
   });return{items,summary:this.summary(),...noEffects};
  }
  if(view==='call-queue')return{mode:'preparation-only',paused:this.db.prepare("SELECT value FROM operator_settings WHERE id='call-paused'").get()?.value==='true',items:this.db.prepare('SELECT id,draft_id AS draftId,provider,state FROM operator_queue ORDER BY created_at,rowid LIMIT ?').all(limit),adapterCompatibility:'unverified',observations:this.db.prepare("SELECT id,digest,payload,status FROM operator_items WHERE kind='call' ORDER BY created_at DESC LIMIT ?").all(limit).map(row=>{const data=row.status==='expired'?null:JSON.parse(String(row.payload));if(data&&digest(data)!==row.digest)throw new OperatorError(409,'OPERATOR_STORED_PAYLOAD_CHANGED');return{id:String(row.id),digest:String(row.digest),status:row.status,data};}),...noEffects};
  const kind=view==='metrics'?'metrics':view==='content'?'content':'reply';
  const items=this.db.prepare('SELECT id,digest,payload,status FROM operator_items WHERE kind=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(kind,limit).map(row=>{const data=row.status==='expired'?null:JSON.parse(String(row.payload));if(data&&digest(data)!==row.digest)throw new OperatorError(409,'OPERATOR_STORED_PAYLOAD_CHANGED');return{id:String(row.id),digest:String(row.digest),status:String(row.status),data};});
  return{items,sourceVerified:false,...noEffects};
 }
 execute(input:unknown){
  assertOperatorAccess(this.configuration,this.actor);this.expire();
  if(!record(input)||typeof input.action!=='string'||!OPERATOR_CATALOG.actions.includes(input.action))deny();
  const action=input.action;
  if(action==='stage-draft'){
   if(!keys(input,['action','lead'])||!record(input.lead))deny();const lead=input.lead as unknown as PreparedLead;
   let origin:string;try{origin=new URL(lead.sourceUrl).origin;}catch{deny();}
   if(!this.configuration.approvedResearchOrigins.includes(origin)||!this.configuration.approvedVerificationProviders.includes(lead.verification?.provider))throw new OperatorError(403,'OPERATOR_EVIDENCE_SCOPE_DENIED');
   return{...this.stage(lead),...noEffects};
  }
  if(action==='review-draft'||action==='approve-prepared-handoff'){
   if(!keys(input,['action','draftId','digest',...(action==='approve-prepared-handoff'?['confirmation']:[])])||!id(input.draftId)||typeof input.digest!=='string'||!/^[a-f0-9]{64}$/u.test(input.digest))deny();
   if(action==='review-draft')return{...this.review(input.draftId,input.digest,this.actor),confidence:confidenceRating({verification:this.draft(input.draftId).verification,source:{url:this.draft(input.draftId).sourceUrl,checkedAt:this.draft(input.draftId).signalDate},fitReviewed:true},new Date(this.now()).toISOString()),...noEffects};
   if(input.confirmation!=='APPROVE PREPARED HANDOFF ONLY')deny('OPERATOR_EXACT_HANDOFF_CONFIRMATION_REQUIRED');
   return this.approveHandoff(input.draftId,input.digest,{...this.actor,confirmation:input.confirmation});
  }
  if(action==='record-metrics'){
   if(!keys(input,['action','id','counts','periodStart','periodEnd','sourceKind','sourceReference'])||!id(input.id)||!record(input.counts)||!keys(input.counts,metricKeys)||!iso(input.periodStart)||!iso(input.periodEnd)||Date.parse(input.periodEnd)<Date.parse(input.periodStart)||Date.parse(input.periodEnd)>this.now()||Date.parse(input.periodEnd)-Date.parse(input.periodStart)>31*DAY||!['client-report','provider-report','synthetic-fixture'].includes(String(input.sourceKind))||!id(input.sourceReference))deny();
   for(const [key,value] of Object.entries(input.counts))if(value!==null&&key!=='providerCost'&&(!Number.isSafeInteger(value)||Number(value)<0))deny();
   const method=weeklyReadout(input.counts as MetricCounts);
   return this.transaction(()=>this.item(input.id as string,'metrics',{...method,mode:'supplied-aggregate-report',periodStart:input.periodStart,periodEnd:input.periodEnd,timeZone:'Europe/Madrid',sourceKind:input.sourceKind,sourceReference:input.sourceReference,sourceVerified:false,definitionsApproval:false}));
  }
  if(action==='stage-content'){
   if(!keys(input,['action','id','kind','dueAt','subject','body','sourceReference'])||!id(input.id)||!['seo-review','newsletter-review'].includes(String(input.kind))||!iso(input.dueAt)||typeof input.subject!=='string'||!input.subject.trim()||input.subject.length>200||/[\r\n\0]/u.test(input.subject)||typeof input.body!=='string'||!input.body.trim()||input.body.length>10000||input.body.includes('\0')||!id(input.sourceReference))deny();
   return this.transaction(()=>this.item(input.id as string,'content',{kind:input.kind,dueAt:input.dueAt,envelope:{sendingAccount:null,to:null,cc:[],bcc:[],subject:input.subject,body:input.body,attachments:[]},sourceReference:input.sourceReference,state:'review-draft',sourceReviewed:false,editorialApproved:false,publish:false,send:false}));
  }
  if(action==='review-due-content'){
   if(!keys(input,['action']))deny();const rows=this.db.prepare("SELECT id,payload FROM operator_items WHERE kind='content' AND status='prepared' ORDER BY created_at LIMIT 100").all();
   const plan=rows.map(row=>{const data=JSON.parse(String(row.payload));const stored=this.db.prepare('SELECT digest FROM operator_items WHERE id=?').get(String(row.id));if(digest(data)!==stored?.digest)throw new OperatorError(409,'OPERATOR_STORED_PAYLOAD_CHANGED');return{id:String(row.id),...data};});return{items:dueContent(plan,new Date(this.now()).toISOString()),schedulerInstalled:false,...noEffects};
  }
  if(action==='record-reply'){
   if(!keys(input,['action','id','draftId','kind','sourceReference'])||!id(input.id)||!id(input.draftId)||!id(input.sourceReference)||!['positive','question','referral','negative','opt-out','out-of-office','unknown'].includes(String(input.kind)))deny();
   const payload={...triageReply({kind:input.kind as ReplyKind,requestId:input.draftId}),sourceReference:input.sourceReference,classification:'operator-supplied',providerStopAcknowledged:false,suppressionScope:'local-preparation-only'};
   return this.transaction(()=>{const result=this.item(input.id as string,'reply',payload);if(!result.duplicate)this.hold(input.draftId as string,input.kind as ReplyKind);return{...result,triage:payload};});
  }
  if(action==='erase-suppress'){
   if(!keys(input,['action','email'])||typeof input.email!=='string')deny();const result=this.eraseAndSuppress(input.email,this.actor);this.expire();return{...result,...noEffects};
  }
  if(action==='queue-prepare'){
   if(!keys(input,['action','id','draftId','provider'])||!id(input.id)||!id(input.draftId)||!['zadarma','acefone'].includes(String(input.provider)))deny();
   return this.transaction(()=>{
    const draft=this.draft(input.draftId as string);this.readDraft(draft.id,draft.digest); // holds and suppression deny enrollment
    const previous=this.db.prepare('SELECT * FROM operator_queue WHERE id=? OR draft_id=?').all(input.id as string,draft.id);
    if(previous.length){if(previous.length!==1||previous[0].id!==input.id||previous[0].draft_id!==draft.id||previous[0].provider!==input.provider)throw new OperatorError(409,'OPERATOR_QUEUE_CONFLICT');return{duplicate:true,mode:'preparation-only',...noEffects};}
    if(Number(this.db.prepare('SELECT count(*) AS n FROM operator_queue').get()?.n)>=1000)throw new OperatorError(429,'OPERATOR_CAPACITY_REACHED');
    this.db.prepare('INSERT INTO operator_queue VALUES(?,?,?,?,?)').run(input.id as string,draft.id,input.provider as string,'prepared',this.now());return{duplicate:false,mode:'preparation-only',...noEffects};
   });
  }
  if(action==='queue-pause'||action==='queue-resume'){
   if(!keys(input,['action']))deny();this.db.prepare("INSERT INTO operator_settings VALUES('call-paused',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(action==='queue-pause'?'true':'false');return{paused:action==='queue-pause',...noEffects};
  }
  if(action==='queue-next'){
   if(!keys(input,['action']))deny();return this.transaction(()=>{
    if(this.db.prepare("SELECT value FROM operator_settings WHERE id='call-paused'").get()?.value==='true'||this.db.prepare("SELECT id FROM operator_queue WHERE state IN ('reviewing','wrap-up')").get())return{item:null,...noEffects};
    const row=this.db.prepare("SELECT * FROM operator_queue WHERE state='prepared' ORDER BY created_at,rowid LIMIT 1").get();if(!row)return{item:null,...noEffects};
    try{const lead=this.draft(String(row.draft_id));this.readDraft(lead.id,lead.digest);}catch{this.db.prepare("UPDATE operator_queue SET state='held' WHERE id=?").run(String(row.id));return{item:null,held:true,...noEffects};}
    this.db.prepare("UPDATE operator_queue SET state='reviewing' WHERE id=?").run(String(row.id));return{item:{id:String(row.id),draftId:String(row.draft_id),provider:String(row.provider),state:'reviewing',mode:'preparation-only',transportConfigured:false},...noEffects};
   });
  }
  if(action==='queue-finish'||action==='queue-wrap'){
   if(!keys(input,action==='queue-wrap'?['action','id']:['action','id','outcome','durationSeconds','sourceReference'])||!id(input.id))deny();
   if(action==='queue-finish'&&(!['connected','no-answer','busy','failed','opt-out'].includes(String(input.outcome))||!Number.isSafeInteger(input.durationSeconds)||Number(input.durationSeconds)<0||Number(input.durationSeconds)>86400||!id(input.sourceReference)))deny();
   return this.transaction(()=>{
    const row=this.db.prepare('SELECT * FROM operator_queue WHERE id=?').get(input.id as string);if(!row||row.state!==(action==='queue-wrap'?'wrap-up':'reviewing'))throw new OperatorError(409,'OPERATOR_QUEUE_STATE_CONFLICT');
    if(action==='queue-finish'){
     this.item('call:'+digest(String(row.id)),'call',{queueId:row.id,draftId:row.draft_id,provider:row.provider,outcome:input.outcome,durationSeconds:input.durationSeconds,sourceReference:input.sourceReference,evidence:'operator-supplied-unverified',providerReceiptVerified:false,hubspotWritten:false});
     if(input.outcome==='opt-out'){this.hold(String(row.draft_id),'opt-out');return{state:'held',...noEffects};}
    }
    const state=action==='queue-wrap'?'completed':'wrap-up';this.db.prepare('UPDATE operator_queue SET state=? WHERE id=?').run(state,input.id as string);return{state,...noEffects};
   });
  }
  deny();
 }
}
