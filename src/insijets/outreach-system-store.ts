import {OutreachMonthPlanStore} from './outreach-tier1-store.ts';
import {FINAL_REVIEW_CAMPAIGNS} from './outreach-final-content.ts';
import {DEMO_CAMPAIGNS,type CampaignDraft} from './outreach-campaigns.ts';
import {OperatorError,type OperatorActor,type OperatorConfiguration,assertOperatorAccess} from './operator-runtime.ts';
export class OutreachSystemStore extends OutreachMonthPlanStore {
 private campaignConfiguration:OperatorConfiguration;private campaignActor:OperatorActor;
 constructor(configuration:OperatorConfiguration,actor:OperatorActor,now:()=>number=Date.now){
  super(configuration,actor,now);this.campaignConfiguration=structuredClone(configuration);this.campaignActor={...actor};
  try{this.db.exec('CREATE TABLE IF NOT EXISTS outreach_campaign_drafts(id TEXT PRIMARY KEY,version INTEGER NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL)');}catch(error){this.close();throw error;}
 }
 campaigns():CampaignDraft[]{assertOperatorAccess(this.campaignConfiguration,this.campaignActor);return DEMO_CAMPAIGNS.map(template=>{const row=this.db.prepare('SELECT payload FROM outreach_campaign_drafts WHERE id=?').get(template.id);return row?JSON.parse(String(row.payload)) as CampaignDraft:structuredClone(template);});}

 /** Immutable final source uses a distinct namespace, preserving all earlier private edits. */
 finalCampaigns():CampaignDraft[]{
  assertOperatorAccess(this.campaignConfiguration,this.campaignActor);
  return FINAL_REVIEW_CAMPAIGNS.map(template=>{const sourceId=template.notes!.find(x=>x.startsWith('Source sequence: '))!.slice(17);const id='final-editorial:'+sourceId;
   const row=this.db.prepare('SELECT payload FROM outreach_campaign_drafts WHERE id=?').get(id);
   return row?JSON.parse(String(row.payload)) as CampaignDraft:{...structuredClone(template),id};
  });
 }
 saveFinalCampaign(input:unknown,reset=false){
  assertOperatorAccess(this.campaignConfiguration,this.campaignActor);
  const invalid=()=>{throw new OperatorError(400,'FINAL_CAMPAIGN_INPUT_DENIED');};
  if(!input||typeof input!=='object'||Array.isArray(input))return invalid();
  const p=input as Record<string,unknown>;
  if(Object.keys(p).some(k=>!(reset?['id','version']:['id','version','subjects','bodies']).includes(k))||typeof p.id!=='string'||!Number.isSafeInteger(p.version))return invalid();
  const template=this.finalCampaigns().find(x=>x.id===p.id);if(!template)return invalid();
  if(!reset&&(!Array.isArray(p.subjects)||p.subjects.length!==3||p.subjects.some(x=>typeof x!=='string'||!x.trim()||x.length>200||/[\r\n\0]/u.test(x))||!Array.isArray(p.bodies)||p.bodies.length!==3||p.bodies.some(x=>typeof x!=='string'||!x.trim()||x.length>5000||x.includes('\0'))))return invalid();
  return this.transaction(()=>{
   const existing=this.finalCampaigns().find(x=>x.id===p.id)!;
   if(existing.version!==p.version)throw new OperatorError(409,'CAMPAIGN_DRAFT_VERSION_CHANGED');
   const original=FINAL_REVIEW_CAMPAIGNS.find(x=>x.notes?.includes('Source sequence: '+String(p.id).slice(16)))!;
   // A future source change cannot silently rebase privately edited wording.
   if(!reset&&existing.sourceReference!==original.sourceReference)throw new OperatorError(409,'FINAL_CAMPAIGN_SOURCE_CHANGED');
   const campaign:CampaignDraft={...(reset?structuredClone(original):existing),id:existing.id,version:existing.version+1,reviewState:'draft',sendEnabled:false,
    ...(reset?{}:{subject:(p.subjects as string[])[0],steps:existing.steps.map((step,i)=>({...step,subject:(p.subjects as string[])[i],body:(p.bodies as string[])[i]}))})};
   this.db.prepare('INSERT INTO outreach_campaign_drafts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,payload=excluded.payload,updated_at=excluded.updated_at').run(campaign.id,campaign.version,JSON.stringify(campaign),this.now());
   return {campaign,reviewState:'draft',emailApprovalGranted:false,campaignActivated:false,resetToSource:reset};
  });
 }
 saveCampaign(input:unknown){
  assertOperatorAccess(this.campaignConfiguration,this.campaignActor);
  const invalid=()=>{throw new OperatorError(400,'CAMPAIGN_DRAFT_INPUT_DENIED');};
  if(!input||typeof input!=='object'||Array.isArray(input))return invalid();
  const p=input as Record<string,unknown>;
  if(Object.keys(p).some(k=>!['id','version','subject','bodies','locale'].includes(k))||!DEMO_CAMPAIGNS.some(x=>x.id===p.id)||!Number.isSafeInteger(p.version)||typeof p.subject!=='string'||!p.subject.trim()||p.subject.length>200||/[\r\n\0]/u.test(p.subject)||typeof p.locale!=='string'||!['en','it','es','fr','de','ar'].includes(p.locale)||!Array.isArray(p.bodies)||p.bodies.length!==3||p.bodies.some(x=>typeof x!=='string'||!x.trim()||x.length>5000||x.includes('\0')))return invalid();
  return this.transaction(()=>{
   const existing=this.campaigns().find(x=>x.id===p.id)!;if(existing.version!==p.version)throw new OperatorError(409,'CAMPAIGN_DRAFT_VERSION_CHANGED');
   const campaign:CampaignDraft={...existing,subject:p.subject as string,locale:p.locale as string,steps:existing.steps.map((step,i)=>({...step,...(i===0&&step.subject!==undefined?{subject:p.subject as string}:{}),body:(p.bodies as string[])[i]})),version:existing.version+1,reviewState:'draft',sendEnabled:false};
   this.db.prepare('INSERT INTO outreach_campaign_drafts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,payload=excluded.payload,updated_at=excluded.updated_at').run(campaign.id,campaign.version,JSON.stringify(campaign),this.now());
   return {campaign,reviewState:'draft',emailApprovalGranted:false,campaignActivated:false};
  });
 }
}
