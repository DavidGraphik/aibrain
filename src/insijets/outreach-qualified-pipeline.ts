import {createHash} from 'node:crypto';
import {prepareOutreachBatch,type PreparedLead} from './outreach-preparation.ts';
import type {CampaignDraft} from './outreach-campaigns.ts';
const DAY=86400000;
export const QUALIFICATION_VERSION='insijets-working-20261015-v1';
export const COMMON_POINT_STEPS={economicFit:[0,10,20],travelRelevance:[0,10,20],fboPracticality:[0,5,10,15],roleAuthority:[0,5,10,15],sourceFreshness:[0,5,10,15],contactQuality:[0,5,10,15]} as const;
/** These are the delivered source groups, still subject to client validation. */
export const PERSONA_SIGNAL_GROUPS={
 'pa-ea':['Travel responsibility','Principal fit','Schedule complexity','Backup need','Current role and reachability'],
 executives:['Multi-site remit','Route friction','Time pressure','Decision access','Recurring need'],
 'business-owners':['Financial fit','Regional operating base','Business expansion','Principal access','Practical itinerary'],
 investors:['Active portfolio','Travel trigger','Geographic spread','Professional authority','Coordination route'],
 'family-offices':['Principal-service fit','Travel remit','International footprint','Relevant service need','Relationship access'],
 'wealth-managers':['Private-client segment','Introductions remit','Travel service relevance','Cross-border practice','Partnership pathway'],
 'sports-managers':['Relevant roster','Itinerary density','Travel authority','Operational complexity','Portfolio relevance'],
 'artist-managers':['Current roster','Dated itinerary','Logistics remit','Transfer complexity','Service opportunity'],
 athletes:['Competition schedule','Transfer compression','Professional scale','Delegated travel contact','Operational fit'],
 'artists-djs':['Upcoming tour','Turnaround pressure','Tour scale','Team access','Flight practicality'],
 art:['International programme','Decision-maker role','Dated travel trigger','Client service fit','Airport relevance'],
 yachting:['Owner-service remit','Regional itinerary','Dated movement','Coordination authority','Ground/air connection'],
 'luxury-travel':['Private travel clientele','Flight coordination','Trip complexity','Partnership fit','Professional channel'],
 'pet-relocation':['Service geography','Partnership authority','Passenger and pet need','Operational constraints','Professional contact'],
 politicians:['Office contact availability','Professional relevance','Office remit','Timing and protocol','Client approval'],
} as const;
type Persona=keyof typeof PERSONA_SIGNAL_GROUPS;
type Evidence={factId:string;sourceUrl:string;checkedAt:string;kind:'role-contact'|'financial'|'signal'|'event';eventAt?:string};
type Finding={group:string;points:number;evidence?:Evidence};
type LegacyQualificationInput={accountId:string;persona:Persona;frameworkVersion:string;common:Finding[];signals:Finding[];exclusions:('opt-out'|'current-client'|'active-conversation'|'protected-tier1'|'conflicting-evidence')[];eligibility:'client-attested-eligible'|'unknown'};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[-a-zA-Z0-9_:]{1,100}$/.test(v);
const exact=(v:object,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function evaluateLegacyQualification(input:LegacyQualificationInput,allowedOrigins:string[],now=Date.now()){
 if(!input||typeof input!=='object'||Array.isArray(input)||!exact(input,['accountId','persona','frameworkVersion','common','signals','exclusions','eligibility'])||!id(input.accountId)||input.frameworkVersion!==QUALIFICATION_VERSION||!Object.hasOwn(PERSONA_SIGNAL_GROUPS,input.persona)||!Array.isArray(input.common)||input.common.length>6||!Array.isArray(input.signals)||input.signals.length>5||!Array.isArray(input.exclusions)||input.exclusions.some(x=>!['opt-out','current-client','active-conversation','protected-tier1','conflicting-evidence'].includes(x))||!['client-attested-eligible','unknown'].includes(input.eligibility)||!Number.isFinite(now))throw Error('QUALIFICATION_INPUT_DENIED');
 const holds:string[]=[...input.exclusions],facts=new Set<string>(),seen=new Set<string>();
 if(input.eligibility!=='client-attested-eligible')holds.push('client-eligibility-unconfirmed');
 if(['art','yachting','politicians'].includes(input.persona))holds.push('month-one-parked-persona');
 if(['pet-relocation','wealth-managers'].includes(input.persona))holds.push('lane-pending-review-or-merged');
 function score(finding:Finding,layer:'common'|'persona'){
  const group=layer+':'+finding.group;
  const steps:readonly number[]=layer==='common'?COMMON_POINT_STEPS[finding.group as keyof typeof COMMON_POINT_STEPS]??[]:[0,20,40];
  if(!finding||typeof finding!=='object'||!exact(finding,['group','points','evidence'])||!steps.includes(finding.points)||seen.has(group)||layer==='persona'&&!(PERSONA_SIGNAL_GROUPS[input.persona] as readonly string[]).includes(finding.group))throw Error('QUALIFICATION_GROUP_DENIED');
  seen.add(group);if(finding.points===0)return {layer,group:finding.group,points:0,reason:'unsupported-or-missing',factId:null};
  const e=finding.evidence;if(!e||!exact(e,['factId','sourceUrl','checkedAt','kind','eventAt'])||!id(e.factId)||!['role-contact','financial','signal','event'].includes(e.kind))throw Error('QUALIFICATION_EVIDENCE_REQUIRED');
  let u:URL;try{u=new URL(e.sourceUrl);}catch{throw Error('QUALIFICATION_SOURCE_DENIED');}
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!allowedOrigins.includes(u.origin))throw Error('QUALIFICATION_SOURCE_DENIED');
  const age=now-Date.parse(e.checkedAt),window=e.kind==='financial'?180*DAY:90*DAY;
  if(!Number.isFinite(age)||age<0||age>window){holds.push('stale-or-future-evidence');return {layer,group:finding.group,points:0,reason:'stale-or-future',factId:e.factId};}
  if(facts.has(e.factId)){holds.push('duplicate-fact-across-groups');return {layer,group:finding.group,points:0,reason:'same-fact-not-counted-twice',factId:e.factId};}facts.add(e.factId);
  let points=finding.points,reason='reviewer-supported';
  if(e.kind==='event'){
   const until=Date.parse(e.eventAt??'')-now;if(!Number.isFinite(until))throw Error('QUALIFICATION_EVENT_DATE_REQUIRED');
   if(until<0){holds.push('expired-event');points=0;reason='expired-event';}else if(until>60*DAY){points/=2;reason='event-outside-sixty-days-half-weight';}
  }
  return {layer,group:finding.group,points,reason,factId:e.factId};
 }
 const common=input.common.map(f=>score(f,'common')),persona=input.signals.map(f=>score(f,'persona'));
 const commonScore=common.reduce((n,x)=>n+x.points,0),personaScore=persona.reduce((n,x)=>n+x.points,0),displayScore=Math.round((0.4*commonScore+0.6*personaScore/2)*100)/100;
 const supported=[...common,...persona].filter(x=>x.points>0).length;
 const confidence=supported===11&&!holds.length?'high':supported>=6&&!holds.length?'medium':'low';
 return {accountId:input.accountId,frameworkVersion:QUALIFICATION_VERSION,frameworkApproval:'pending-client-validation',commonScore,personaScore,displayScore,confidence,confidenceMeaning:'Completeness of supplied reviewed evidence, not independent source verification or charter intent',routing:holds.length?'held':displayScore>=75&&confidence==='high'?'priority-review':displayScore>=55?'qualification-review':'research',holds:[...new Set(holds)],trace:[...common,...persona],emailSend:false,crmWrite:false};
}
/** Example Representative's 19 October corrections. Point allocation beyond his 15/15/20/5
 * suggestions remains a review proposal; no score authorizes sending. */
export const LUCA_QUALIFICATION_VERSION='insijets-luca-20261022-v2';
export const LUCA_SCORE_STEPS={mobile:[0,15],assistant:[0,15],news:[0,5,20],travelNeed:[0,10,20],routeFriction:[0,10,20],fboPracticality:[0,5,10]} as const;
export const LUCA_REQUIRED_GATES=['confirmed-role-and-authority','current-valid-sources','independently-verified-professional-email','confirmed-economic-policy-and-evidence','client-eligibility-and-exclusions'] as const;
type ConfirmedGate={status:'confirmed'|'unknown'|'failed';evidence?:Evidence};
type EconomicGate={
 status:'confirmed'|'unknown'|'failed';
 policy?:{currency:string;application:'principal-and-company';netRevenueDefinition:string;confirmationRef:string};
 personalNetWorth?:{amount:number;currency:string;evidence:Evidence};
 companyNetRevenue?:{fiscalYear:number;amount:number;currency:string;evidence:Evidence}[];
 trajectory?:{outlook:'positive'|'unknown'|'negative';evidence:Evidence};
};
export type LucaQualificationInput={
 accountId:string;persona:Persona;frameworkVersion:typeof LUCA_QUALIFICATION_VERSION;
 gates:{role:ConfirmedGate;source:ConfirmedGate;email:{status:'valid'|'unknown'|'invalid'|'risky';emailHash?:string;provider?:string;checkedAt?:string;professional?:boolean;identityMatched?:boolean;catchAll?:boolean;independent?:boolean;evidence?:Evidence};economic:EconomicGate};
 common:(Finding&{newsKind?:'private-jet-use'|'positive-news'})[];signals:[];
 exclusions:LegacyQualificationInput['exclusions'];eligibility:LegacyQualificationInput['eligibility'];
};
export type QualificationInput=LegacyQualificationInput|LucaQualificationInput;
export function evaluateQualification(input:QualificationInput,allowedOrigins:string[],now=Date.now()){
 if(input?.frameworkVersion!==LUCA_QUALIFICATION_VERSION)return evaluateLegacyQualification(input as LegacyQualificationInput,allowedOrigins,now);
 const q=input as LucaQualificationInput;
 if(!exact(q,['accountId','persona','frameworkVersion','gates','common','signals','exclusions','eligibility'])||!id(q.accountId)||!Object.hasOwn(PERSONA_SIGNAL_GROUPS,q.persona)||!q.gates||!exact(q.gates,['role','source','email','economic'])||!Array.isArray(q.common)||q.common.length>6||!Array.isArray(q.signals)||q.signals.length!==0||!Array.isArray(q.exclusions)||q.exclusions.some(x=>!['opt-out','current-client','active-conversation','protected-tier1','conflicting-evidence'].includes(x))||!['client-attested-eligible','unknown'].includes(q.eligibility)||!Number.isFinite(now))throw Error('QUALIFICATION_INPUT_DENIED');
 const holds:string[]=[...q.exclusions],facts=new Set<string>(),groups=new Set<string>();
 if(q.eligibility!=='client-attested-eligible')holds.push('client-eligibility-unconfirmed');
 if(['art','yachting','politicians'].includes(q.persona))holds.push('month-one-parked-persona');
 if(['pet-relocation','wealth-managers'].includes(q.persona))holds.push('lane-pending-review-or-merged');
 function evidence(e:Evidence|undefined,label:string,days=90){
  if(!e||typeof e!=='object'||!exact(e,['factId','sourceUrl','checkedAt','kind','eventAt'])||!id(e.factId)||!['role-contact','financial','signal','event'].includes(e.kind)){holds.push(label+'-evidence-missing');return false;}
  let u:URL;try{u=new URL(e.sourceUrl);}catch{throw Error('QUALIFICATION_SOURCE_DENIED');}
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!allowedOrigins.includes(u.origin))throw Error('QUALIFICATION_SOURCE_DENIED');
  const age=now-Date.parse(e.checkedAt);
  if(!Number.isFinite(age)||age<0||age>days*DAY){holds.push(label+'-evidence-stale-or-future');return false;}
  if(e.kind==='event'){
   const until=Date.parse(e.eventAt??'')-now;
   if(!Number.isFinite(until)||until<0){holds.push(label+'-event-expired-or-missing');return false;}
  }
  return true;
 }
 const rememberGate=(e:Evidence|undefined)=>{if(e?.factId)facts.add(e.factId);};
 for(const key of ['role','source'] as const){
  const gate=q.gates[key];
  if(!gate||!exact(gate,['status','evidence'])||!['confirmed','unknown','failed'].includes(gate.status))throw Error('QUALIFICATION_GATE_DENIED');
  if(gate.status!=='confirmed')holds.push(key+'-gate-unconfirmed');
  if(!evidence(gate.evidence,key))continue;
  rememberGate(gate.evidence);
 }
 const email=q.gates.email;
 if(!email||!exact(email,['status','emailHash','provider','checkedAt','professional','identityMatched','catchAll','independent','evidence'])||!['valid','unknown','invalid','risky'].includes(email.status))throw Error('QUALIFICATION_GATE_DENIED');
 const emailAge=now-Date.parse(email.checkedAt??'');
 if(email.professional!==true||email.identityMatched!==true||email.catchAll!==false||email.independent!==true)holds.push('professional-identity-noncatchall-independent-verification-required');
 if(email.status!=='valid'||!/^[a-f0-9]{64}$/.test(email.emailHash??'')||!id(email.provider)||!Number.isFinite(emailAge)||emailAge<0||emailAge>7*DAY)holds.push('verified-professional-email-required');
 evidence(email.evidence,'email',7);rememberGate(email.evidence);
 const economic=q.gates.economic;
 if(!economic||!exact(economic,['status','policy','personalNetWorth','companyNetRevenue','trajectory'])||!['confirmed','unknown','failed'].includes(economic.status))throw Error('QUALIFICATION_GATE_DENIED');
 const policy=economic.policy;
 const policyConfirmed=!!policy&&exact(policy,['currency','application','netRevenueDefinition','confirmationRef'])&&/^[A-Z]{3}$/.test(policy.currency)&&policy.application==='principal-and-company'&&typeof policy.netRevenueDefinition==='string'&&policy.netRevenueDefinition.trim().length>0&&policy.netRevenueDefinition.length<=500&&id(policy.confirmationRef);
 if(!policyConfirmed)holds.push('economic-currency-application-definition-unconfirmed');
 if(economic.status!=='confirmed')holds.push('economic-gate-unconfirmed');
 const wealth=economic.personalNetWorth;
 if(!wealth||!exact(wealth,['amount','currency','evidence'])||!Number.isFinite(wealth.amount)||wealth.amount<20000000||wealth.currency!==policy?.currency)holds.push('personal-net-worth-threshold-unproven');
 evidence(wealth?.evidence,'personal-net-worth',180);rememberGate(wealth?.evidence);
 const revenues=economic.companyNetRevenue;
 const currentYear=new Date(now).getUTCFullYear();
 if(!Array.isArray(revenues)||revenues.length!==2)holds.push('two-year-net-revenue-threshold-unproven');
 else{
  const sorted=[...revenues].sort((a,b)=>a.fiscalYear-b.fiscalYear);
  if(sorted.some(r=>!r||!exact(r,['fiscalYear','amount','currency','evidence'])||!Number.isSafeInteger(r.fiscalYear)||!Number.isFinite(r.amount)||r.amount<20000000||r.currency!==policy?.currency)||sorted[1].fiscalYear!==sorted[0].fiscalYear+1||sorted[1].fiscalYear<currentYear-1||sorted[1].fiscalYear>currentYear)holds.push('two-year-net-revenue-threshold-unproven');
  for(const r of sorted){evidence(r.evidence,'net-revenue-'+r.fiscalYear,180);rememberGate(r.evidence);}
 }
 const trajectory=economic.trajectory;
 if(!trajectory||!exact(trajectory,['outlook','evidence'])||trajectory.outlook!=='positive')holds.push('positive-trajectory-unproven');
 evidence(trajectory?.evidence,'trajectory',180);rememberGate(trajectory?.evidence);
 const trace=q.common.map(f=>{
  if(!f||typeof f!=='object'||!exact(f,['group','points','evidence','newsKind'])||!Object.hasOwn(LUCA_SCORE_STEPS,f.group)||groups.has(f.group)||!(LUCA_SCORE_STEPS[f.group as keyof typeof LUCA_SCORE_STEPS] as readonly number[]).includes(f.points))throw Error('QUALIFICATION_GROUP_DENIED');
  if(f.group==='news'&&f.points>0&&(f.points===20?f.newsKind!=='private-jet-use':f.newsKind!=='positive-news')||f.group!=='news'&&f.newsKind!==undefined)throw Error('QUALIFICATION_NEWS_KIND_DENIED');
  groups.add(f.group);
  let points=f.points,reason='reviewer-supported';
  if(points===0)return {layer:'common',group:f.group,points:0,reason:'unsupported-or-missing',factId:null};
  if(!evidence(f.evidence,'score-'+f.group)){points=0;reason='unsupported-or-stale';}
  if(f.evidence&&facts.has(f.evidence.factId)){holds.push('duplicate-fact-across-groups');points=0;reason='same-fact-not-counted-twice';}
  if(f.evidence)facts.add(f.evidence.factId);
  if(points>0&&f.evidence?.kind==='event'&&Date.parse(f.evidence.eventAt??'')-now>60*DAY){points/=2;reason='event-outside-sixty-days-half-weight';}
  return {layer:'common',group:f.group,points,reason,factId:f.evidence?.factId??null};
 });
 const commonScore=trace.reduce((n,f)=>n+f.points,0),confidence=holds.length?'low':'high';
 return {accountId:q.accountId,frameworkVersion:LUCA_QUALIFICATION_VERSION,frameworkApproval:'pending-client-validation',commonScore,personaScore:0,displayScore:commonScore,confidence,confidenceMeaning:'Required supplied gates and reviewed evidence; not independent verification, intent or approval',routing:holds.length?'held':commonScore>=75?'priority-review':commonScore>=55?'qualification-review':'research',holds:[...new Set(holds)],trace,emailSend:false,crmWrite:false};
}

type Base=typeof prepareOutreachBatch;
type Account=Parameters<Base>[0][number];
export const REVIEWED_COPY_FIELDS=['greeting','agencyName','announcementDate','artEventDate','artEventName','bespokeTravelService','cityA','cityB','companyName','competitionName','confirmedProfessionalContext','expansionProject','guestServiceName','officeName','previousContactMonth','previousEnquiryDate','previousItineraryOrServiceContext','previousQuoteDate','previousQuoteRoute','previousQuoteService','previousRoute','previousService','principalFullName','principalServiceName','roadshowDate','roadshowName','siteA','siteB','tourName','tourOrPerformanceName','verifiedPetRelocationService','verifiedServiceLocation'] as const;
export type ConfiguredPipelineInput={account:Account;qualification:QualificationInput;historicalRelationshipAttested?:boolean;copyVariables?:Record<string,{text:string;factIds:string[];evidence?:Evidence}>};
export type PipelineConfiguration={version:string;audience:'historical'|'new-icp';campaignBindings:Record<string,string>;campaigns:CampaignDraft[]};
/** Runs reviewed configuration against injected bounded adapters. Not a live binding.
 * Qualification happens before any contact lookup; no generic-copy fallback exists.
 */
export async function prepareQualifiedOutreachBatch(inputs:ConfiguredPipelineInput[],configuration:PipelineConfiguration,policy:Parameters<Base>[1],sources:Parameters<Base>[2],verify:Parameters<Base>[3],now=Date.now()){
 if(!Array.isArray(inputs)||inputs.length>100||!configuration||!id(configuration.version)||!['historical','new-icp'].includes(configuration.audience)||!Array.isArray(configuration.campaigns)||!configuration.campaignBindings||typeof configuration.campaignBindings!=='object'||Array.isArray(configuration.campaignBindings))throw Error('CONFIGURED_PIPELINE_REQUIRED');
 const selected=new Map<string,{qualification:ReturnType<typeof evaluateQualification>;campaign:CampaignDraft;variables:Record<string,string>;bindings:Record<string,string[]>;copyEvidence:Record<string,Evidence>}>(),seenAccounts=new Set<string>(),held:{accountId:string;reason:string}[]=[];
 for(const row of inputs){
  if(!row||!row.account||row.account.id!==row.qualification?.accountId||row.account.persona!==row.qualification.persona||seenAccounts.has(row.account.id))throw Error('QUALIFICATION_ACCOUNT_BINDING_REQUIRED');seenAccounts.add(row.account.id);
  if(policy.execution!=='synthetic-fixture'&&row.qualification.frameworkVersion!==LUCA_QUALIFICATION_VERSION){held.push({accountId:row.account.id,reason:'legacy-qualification-requires-luca-gates'});continue;}
  const qualification=evaluateQualification(row.qualification,policy.allowedResearchOrigins,now),campaignId=configuration.campaignBindings[configuration.audience==='historical'?'historical':row.account.persona];
  const matches=configuration.campaigns.filter(c=>c.id===campaignId);const campaign=matches.length===1?matches[0]:undefined;
  if(qualification.routing==='held'||qualification.routing==='research'){held.push({accountId:row.account.id,reason:'qualification-'+qualification.routing});continue;}
  if(!campaign||campaign.audience!==configuration.audience||campaign.sendEnabled!==false||campaign.reviewState!=='draft'||!Number.isSafeInteger(campaign.version)||campaign.version<1||!Array.isArray(campaign.steps)||campaign.steps.length!==3||campaign.steps.some((s,i)=>s.offset!==[0,7,17][i])||typeof campaign.subject!=='string'||!campaign.subject.trim()||campaign.subject.length>200||/[\r\n\0]/.test(campaign.subject)||campaign.steps.some(s=>typeof s.body!=='string'||!s.body.trim()||s.body.length>10000||s.body.includes('\0')||s.offsetUnit!=='calendar-days')||configuration.audience==='historical'&&row.historicalRelationshipAttested!==true){held.push({accountId:row.account.id,reason:'campaign-or-historical-relationship-unconfirmed'});continue;}
  const variables:Record<string,string>={greeting:'Hello,',companyName:row.account.company},bindings:Record<string,string[]>={},copyEvidence:Record<string,Evidence>={},supported=new Set(qualification.trace.filter(f=>f.points>0&&f.factId).map(f=>f.factId));
  if(row.copyVariables!==undefined){
   if(!row.copyVariables||typeof row.copyVariables!=='object'||Array.isArray(row.copyVariables)||Object.keys(row.copyVariables).length>30)throw Error('REVIEWED_COPY_BINDINGS_REQUIRED');
   for(const [key,value] of Object.entries(row.copyVariables)){
    if(!((REVIEWED_COPY_FIELDS as readonly string[]).includes(key)||/^verified_[a-z_]{1,60}$/.test(key))||!value||!exact(value,['text','factIds','evidence'])||typeof value.text!=='string'||!value.text.trim()||value.text.length>500||/[\r\n\0{}]/.test(value.text)||!Array.isArray(value.factIds)||!value.factIds.length||value.factIds.length>5||value.factIds.some(f=>!id(f)))throw Error('REVIEWED_COPY_BINDINGS_REQUIRED');
    const direct=new Set(supported);
    if(value.evidence!==undefined){
     const e=value.evidence;
     if(!e||typeof e!=='object'||!exact(e,['factId','sourceUrl','checkedAt','kind','eventAt'])||!id(e.factId)||!['role-contact','financial','signal','event'].includes(e.kind)||!value.factIds.includes(e.factId))throw Error('REVIEWED_COPY_BINDINGS_REQUIRED');
     let source:URL;try{source=new URL(e.sourceUrl);}catch{throw Error('REVIEWED_COPY_SOURCE_DENIED');}
     if(source.protocol!=='https:'||source.username||source.password||source.search||source.hash||!policy.allowedResearchOrigins.includes(source.origin))throw Error('REVIEWED_COPY_SOURCE_DENIED');
     const age=now-Date.parse(e.checkedAt),window=e.kind==='financial'?180*DAY:90*DAY;
     if(!Number.isFinite(age)||age<0||age>window)throw Error('REVIEWED_COPY_EVIDENCE_STALE');
     // A historical enquiry/quote is a past fact; fresh CRM confirmation, not a
     // fabricated future event, supports it. Current event claims must not expire.
     if(e.kind==='event'){
      const event=Date.parse(e.eventAt??'');
      if(!Number.isFinite(event)||(key.startsWith('previous')?event>now:event<now))throw Error('REVIEWED_COPY_EVENT_DENIED');
     }
     direct.add(e.factId);copyEvidence[key]={...e};
    }
    if(value.factIds.some(f=>!direct.has(f))||key==='greeting'&&!value.evidence||key==='companyName'&&value.text!==row.account.company)throw Error('REVIEWED_COPY_BINDINGS_REQUIRED');
    variables[key]=value.text;bindings[key]=[...value.factIds];
   }
  }
  if([...((campaign.subject+'\n'+campaign.steps.map(s=>(s.subject??'')+'\n'+s.body).join('\n')).matchAll(/{{([^{}]+)}}/g))].some(match=>!['firstName','first_name','company'].includes(match[1].trim())&&!Object.hasOwn(variables,match[1].trim()))){held.push({accountId:row.account.id,reason:'unresolved-source-copy-variables'});continue;}
  selected.set(row.account.id,{qualification,campaign,variables,bindings,copyEvidence});
 }
 const result=await prepareOutreachBatch(inputs.filter(row=>selected.has(row.account.id)).map(row=>row.account),policy,sources,verify,now);
 const receipts:Record<string,unknown>[]=[];
 const leads=result.leads.filter(original=>{
  const input=inputs.find(row=>row.account.id===original.accountId)!;
  if(input.qualification.frameworkVersion===LUCA_QUALIFICATION_VERSION){
   const emailGate=(input.qualification as LucaQualificationInput).gates.email;
   if(createHash('sha256').update(original.contact.email.toLowerCase()).digest('hex')!==emailGate.emailHash||original.verification.provider!==emailGate.provider){held.push({accountId:original.accountId,reason:'verified-email-gate-contact-mismatch'});return false;}
  }
  return true;
 }).map(original=>{
  const {qualification,campaign,variables,bindings,copyEvidence}=selected.get(original.accountId)!;
  const render=(text:string)=>text.replace(/{{\s*([^{}]+?)\s*}}/g,(_,key:string)=>key==='company'?original.company:['firstName','first_name'].includes(key)?original.contact.firstName:variables[key]);
  const {digest:_,...payload}=original;
  const next={...payload,score:qualification.displayScore,draft:{...payload.draft,subject:render(campaign.subject),body:render(campaign.steps[0].body)}};
  const lead:PreparedLead={...next,digest:digest(next)};
  receipts.push({draftId:lead.id,draftDigest:lead.digest,configurationVersion:configuration.version,configurationDigest:digest(configuration),campaignId:campaign.id,campaignVersion:campaign.version,sourceReference:campaign.sourceReference,qualification,copyBindings:bindings,copyEvidence,neutralGreetingFallback:!Object.hasOwn(bindings,'greeting'),sequence:campaign.steps.map(s=>({offset:s.offset,offsetUnit:s.offsetUnit})),clientApproval:false,emailApproval:false,dispatch:false});return lead;
 });
 return {...result,leads,held:[...held,...result.held],configurationVersion:configuration.version,qualificationReceipts:receipts,adapterBinding:'injected-not-provider-verified',frameworkApproval:'pending-client-validation',liveReady:false};
}
