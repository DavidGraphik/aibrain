import {createHash} from 'node:crypto';
import {PERSONA_SIGNAL_GROUPS,QUALIFICATION_VERSION,COMMON_POINT_STEPS,LUCA_QUALIFICATION_VERSION,LUCA_SCORE_STEPS} from './outreach-qualified-pipeline.ts';
import type {CampaignDraft} from './outreach-campaigns.ts';
export const EDITORIAL_PERSONA_ALIASES={pa_ea:'pa-ea',executives:'executives',business_owners:'business-owners',investors:'investors',family_offices:'family-offices',wealth_managers:'wealth-managers',sports_managers:'sports-managers',artist_managers:'artist-managers',elite_athletes:'athletes',artists_djs:'artists-djs',art_galleries:'art',yachting:'yachting',luxury_travel:'luxury-travel',politicians:'politicians'} as const;
export const LUCA_EDITORIAL_PERSONA_ALIASES={...EDITORIAL_PERSONA_ALIASES,pet_relocation:'pet-relocation'} as const;
const lucaCommonNames=['Mobile found','PA/EA found','News','Checked travel need','Route friction','FBO practicality'];
const mandatoryFilterIds=['role','source','email','economic','eligibility','accountCoordination'];
const campaignIds:Record<string,string>={'pa-ea':'c3','business-owners':'f4',art:'a1'};
const commonNames=['Economic / service fit','Travel relevance','Location and FBO practicality','Role and authority','Source confidence and freshness','Professional contact quality'];
type SequenceStep={minimumCalendarDayOffset:number;subject:string;body:string;threadRule:string};
type SourcePersona={id:keyof typeof LUCA_EDITORIAL_PERSONA_ALIASES;name:string;sharePercent:number;monthOneEnabled:boolean;scoringFactors:{name:string;capPoints:number}[];signals:unknown[];sequence:{language:string;sendEnabled:boolean;steps:SequenceStep[]}};
type Historical={id:string;name:string;language:string;sendEnabled:boolean;steps:SequenceStep[];eligibilityRequirement:string;additionalGate:string;initialCohortEnabled?:boolean};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const record=(x:unknown):x is Record<string,unknown>=>Boolean(x&&typeof x==='object'&&!Array.isArray(x));
export function importPhase1EditorialPack(raw:string){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>1048576)throw Error('BOUNDED_EDITORIAL_PACK_REQUIRED');
 const data:unknown=JSON.parse(raw);if(!record(data))throw Error('EDITORIAL_COVERAGE_REQUIRED');
 const luca=data.schemaVersion==='2.0';
 if(data.schemaVersion!==undefined&&!['1.0','2.0'].includes(String(data.schemaVersion)))throw Error('EDITORIAL_SCHEMA_DENIED');
 const aliases=luca?LUCA_EDITORIAL_PERSONA_ALIASES:EDITORIAL_PERSONA_ALIASES,expectedPersonas=luca?15:14;
 if(!Array.isArray(data.personas)||data.personas.length!==expectedPersonas||!Array.isArray(data.historicalSequences)||data.historicalSequences.length!==4||!record(data.scoring))throw Error('EDITORIAL_COVERAGE_REQUIRED');
 const scoring=data.scoring,pointSteps=luca?LUCA_SCORE_STEPS:COMMON_POINT_STEPS,names=luca?lucaCommonNames:commonNames;
 if(scoring.displayFormula!==(luca?'sum(commonScore)':'0.4 * commonScore + 0.6 * (personaScore / 2)')||!Array.isArray(scoring.commonLayer)||scoring.commonLayer.length!==6||scoring.commonLayer.some((x,i)=>!record(x)||x.name!==names[i]||x.capPoints!==Math.max(...Object.values(pointSteps)[i])))throw Error('EDITORIAL_SCORING_DIFFERENCE_REQUIRES_REVIEW');
 if(luca){
  const gates=scoring.mandatoryFilters;
  if(!Array.isArray(gates)||gates.length!==mandatoryFilterIds.length||gates.some(g=>!record(g)||typeof g.id!=='string'||!mandatoryFilterIds.includes(g.id)||g.required!==true||typeof g.rule!=='string'||!g.rule.trim()||g.rule.length>2000)||new Set(gates.map(g=>g.id)).size!==mandatoryFilterIds.length)throw Error('EDITORIAL_MANDATORY_FILTERS_REQUIRED');
 }
 if(!record(data.workingMix)||data.workingMix.EuropePercent!==100||data.workingMix.MiddleEastPercent!==0||data.workingMix.totalPercent!==100||data.workingMix.historicalFirst!==true)throw Error('EDITORIAL_GEOGRAPHY_DIFFERENCE_REQUIRES_REVIEW');
 const personas=data.personas as SourcePersona[],historical=data.historicalSequences as Historical[],sourceSha256=hash(raw),seen=new Set<string>(),bindings:Record<string,string>={},parity:{sourceId:string;step:number;subjectSha256:string;bodySha256:string;identical:boolean}[]=[];
 function sequence(id:string,name:string,persona:string,audience:'historical'|'new-icp',locale:string,steps:SequenceStep[],sourceId:string):CampaignDraft{
  if(!['en','it'].includes(locale)||!Array.isArray(steps)||steps.length!==3||typeof name!=='string'||!name.trim())throw Error('EDITORIAL_SEQUENCE_DENIED');
  const mapped=steps.map((s,i)=>{if(!s||s.minimumCalendarDayOffset!==[0,7,17][i]||typeof s.subject!=='string'||!s.subject.trim()||s.subject.length>200||/[\r\n\0]/.test(s.subject)||typeof s.body!=='string'||!s.body.trim()||s.body.length>5000||s.body.includes('\0')||typeof s.threadRule!=='string')throw Error('EDITORIAL_MESSAGE_DENIED');return{offset:s.minimumCalendarDayOffset,offsetUnit:'calendar-days' as const,subject:s.subject,body:s.body,threadRule:s.threadRule};});
  mapped.forEach((s,i)=>parity.push({sourceId,step:i+1,subjectSha256:hash(s.subject),bodySha256:hash(s.body),identical:s.subject===steps[i].subject&&s.body===steps[i].body}));
  return{id,name,audience,persona,locale,subject:mapped[0].subject,steps:mapped,sourceReference:'phase1-editorial-sha256:'+sourceSha256,sourceDate:luca?'2026-10-22':'2026-10-16',cadenceOriginal:'Source offsets 0/+7/+17 calendar days. Same-thread continuation; later subject only when a new thread is needed.',version:1,reviewState:'draft',sendEnabled:false,notes:['Finished proposed editorial copy for Example Representative validation. Not client-approved or permission to send.','Source sequence: '+sourceId]};
 }
 let total=0;const icp=personas.flatMap(p=>{
  if(!Object.hasOwn(aliases,p.id)||seen.has(p.id)||!Number.isInteger(p.sharePercent)||p.sharePercent<0||p.sharePercent>100||p.monthOneEnabled!==(p.sharePercent>0)||!Array.isArray(p.scoringFactors)||p.scoringFactors.length!==5||!Array.isArray(p.signals)||p.signals.length!==5||!p.sequence||p.sequence.sendEnabled!==false)throw Error('EDITORIAL_PERSONA_DENIED');seen.add(p.id);total+=p.sharePercent;
  const alias=LUCA_EDITORIAL_PERSONA_ALIASES[p.id];
  if(p.scoringFactors.some((f,i)=>!f||f.capPoints!==40||typeof f.name!=='string'||!f.name.trim()||f.name.length>120||!luca&&f.name!==PERSONA_SIGNAL_GROUPS[alias as keyof typeof PERSONA_SIGNAL_GROUPS][i])||luca&&(new Set(p.scoringFactors.map(f=>f.name)).size!==5||p.signals.some(s=>!record(s)||typeof s.id!=='string'||!/^[-a-zA-Z0-9_:]{1,100}$/.test(s.id))||new Set(p.signals.map(s=>(s as Record<string,unknown>).id)).size!==5))throw Error('EDITORIAL_PERSONA_GROUP_DIFFERENCE_REQUIRES_REVIEW');
  if(luca&&p.id==='wealth_managers'){
   if(p.sharePercent!==0||p.monthOneEnabled!==false)throw Error('EDITORIAL_RETIRED_PERSONA_MUST_BE_DISABLED');
   // Keep source evidence for review, but never produce a separate wealth-manager campaign.
   sequence('retired-wealth-managers',p.name,alias,'new-icp',p.sequence.language,p.sequence.steps,p.id);
   parity.splice(-3);return [];
  }
  if(luca&&p.id==='pet_relocation'&&(p.sharePercent!==0||p.monthOneEnabled!==false))throw Error('EDITORIAL_PET_GEOGRAPHY_PENDING');
  const id=campaignIds[alias]??'icp-'+alias;bindings[alias]=id;return [sequence(id,p.name,alias,'new-icp',p.sequence.language,p.sequence.steps,p.id)];
 });
 if(total!==100||seen.size!==expectedPersonas)throw Error('EDITORIAL_MIX_MUST_SUM_100');
 const historySeen=new Set<string>(),history=historical.map(h=>{if(!['H1_EN','H2_EN','H3_EN','H1_IT'].includes(h.id)||historySeen.has(h.id)||h.sendEnabled!==false||!h.eligibilityRequirement||!h.additionalGate)throw Error('EDITORIAL_HISTORY_DENIED');if(luca&&h.id==='H1_IT'&&h.initialCohortEnabled!==false)throw Error('EDITORIAL_ITALIAN_COHORT_MUST_BE_DISABLED');historySeen.add(h.id);const campaign=sequence(h.id==='H1_EN'?'historical-current-en':'historical-'+h.id,h.name,h.id,'historical',h.language,h.steps,h.id);return luca&&h.id==='H1_IT'?{...campaign,notes:[...campaign.notes!,'Not in the initial cohort; Italian requires explicit CRM/client language preference.']}:campaign;});
 const campaigns=[...history,...icp],configurationVersion=(luca?'luca-editorial-20261022-':'phase1-editorial-')+sourceSha256.slice(0,12);
 return {configurationVersion,sourceSha256,sourceApprovalState:data.approvalState,clientApproval:false,sendEnabled:false,campaigns,
  qualification:{version:luca?LUCA_QUALIFICATION_VERSION:QUALIFICATION_VERSION,commonPointSteps:pointSteps,personaGroups:PERSONA_SIGNAL_GROUPS,formula:scoring.displayFormula,frameworkApproval:'pending-client-validation',...(luca?{mandatoryFilters:scoring.mandatoryFilters,personaFactorsMeaning:'Review evidence checklist only; not additional scoring points'}:{})},
  targeting:{aliases,mix:personas.map(p=>({sourceId:p.id,id:LUCA_EDITORIAL_PERSONA_ALIASES[p.id],percent:p.sharePercent,monthOneEnabled:p.monthOneEnabled})),middleEastMonthOnePercent:0,...(luca?{retiredSequenceIds:['wealth_managers'],petGeographyApproval:'pending-client-validation',historicalInitialCohortSequenceIds:['H1_EN','H2_EN','H3_EN']} : {}),sourceDetails:personas.map(p=>({id:p.id,signals:p.signals,scoringFactors:p.scoringFactors}))},
  sourcePolicy:{sharedEvidenceAndRouting:data.sharedEvidenceAndRouting,aviationMaturityRules:data.aviationMaturityRules,messageUseRules:data.messageUseRules,criticalAmbiguities:data.criticalAmbiguities,interpretation:'Literal source policy reference for human review; inclusion does not claim extra live enforcement or approval.'},
  pipelines:{newAcquisition:{version:configurationVersion,audience:'new-icp' as const,campaignBindings:bindings,campaigns:icp},historical:{version:configurationVersion+'-history',audience:'historical' as const,campaignBindings:{historical:'historical-current-en'},campaigns:history}},
  parity:{messages:parity.length,allIdentical:parity.length===54&&parity.every(x=>x.identical),checks:parity,normalizationsOnly:['explicit source underscore ID to existing engine alias','minimumCalendarDayOffset to calendar offset','language to locale','first step subject repeated as envelope subject'],voiceChanged:false,followupSubjectsAndThreadRulesPreserved:true}};
}
