/** Pure scenario planner. No provider, source extraction, calendar or dispatch access. */
export type IcpAllocation = {id:string;percent:number};
export type MonthPlanInput = {
 weeklyPortfolioCaps?:number[]; historicalSharePercent?:number; pausedBusinessDays?:number[]; stopped?:boolean;
 crmConnected?:boolean; historicalSegmentApproved?:boolean; historicalSegmentReference?:string;
 sendingReadinessVerified?:boolean; audienceCopyApproved?:boolean; stopSyncVerified?:boolean;
 icpMix?:IcpAllocation[];sendWeekdays?:number[];followupCalendarOffsets?:number[];
};
export const DOCUMENTED_ICP_MIX:IcpAllocation[] = [
 {id:'pa-ea',percent:20},{id:'executives',percent:15},{id:'business-owners',percent:18},
 {id:'investors',percent:8},{id:'family-offices',percent:13},{id:'wealth-managers',percent:0},
 {id:'sports-managers',percent:7},{id:'artist-managers',percent:5},{id:'athletes',percent:5},
 {id:'artists-djs',percent:6},{id:'art',percent:0},{id:'yachting',percent:0},
 {id:'luxury-travel',percent:3},{id:'politicians',percent:0},{id:'pet-relocation',percent:0},
];
export const DEFAULT_MONTH_PLAN_INPUT:MonthPlanInput = {
 weeklyPortfolioCaps:[5,10,15,20],historicalSharePercent:100,pausedBusinessDays:[],stopped:false,
 crmConnected:false,historicalSegmentApproved:false,sendingReadinessVerified:false,audienceCopyApproved:false,stopSyncVerified:false,
 icpMix:DOCUMENTED_ICP_MIX,sendWeekdays:[2,3,4],followupCalendarOffsets:[7,17],
};
type CohortCounts={historical:number;newResearch:number};
export type MonthPlanDay={businessDay:number;calendarDay:number;weekday:number;week:number;portfolioCap:number;paused:boolean;nonSendingWindow:boolean;initial:CohortCounts;followups:CohortCounts;totalEmails:number;unusedCapacity:number};
export type MonthPlan={
 mode:'scenario-only';calendar:'relative-four-weeks-monday-start';activationDate:null;pilotReady:false;scenarioGatesSatisfied:boolean;blockers:string[];
 days:MonthPlanDay[];carryover:MonthPlanDay[];totals:{monthOneEmailCapacity:number;monthOneEmails:number;initialContacts:CohortCounts;followups:CohortCounts;monthTwoFollowups:CohortCounts;unusedCapacity:number};
 icp:{status:'documented_working_mix_pending_confirmation'|'operator_scenario_pending_confirmation';sourceReference:string;mix:IcpAllocation[];newResearchCapacity:{id:string;percent:number;contacts:number}[];middleEastMonthOnePercent:0};
 assumptions:string[];controls:{weeklyPortfolioCaps:number[];historicalSharePercent:number;pausedBusinessDays:number[];stopped:boolean;sendWeekdays:number[];followupsReservedFirst:true;followupOffsets:number[];followupOffsetUnit:'calendar-days-from-first-touch';requiresFreshVerification:true;requiresSuppressionAndReplyChecks:true};
 providerDispatch:false;crmHistoricalRead:false;crmWrite:false;emailSent:false;campaignActivated:false;notificationSent:false;schedulerInstalled:false;
};
const blank=():CohortCounts=>({historical:0,newResearch:0});
const integer=(v:unknown,min:number,max:number):v is number=>Number.isInteger(v)&&Number(v)>=min&&Number(v)<=max;
function allocate(total:number,mix:IcpAllocation[]){
 const raw=mix.map(v=>({...v,contacts:Math.floor(total*v.percent/100),fraction:total*v.percent/100%1}));
 let remainder=total-raw.reduce((n,v)=>n+v.contacts,0);
 for(const v of [...raw].sort((a,b)=>b.fraction-a.fraction||a.id.localeCompare(b.id))){if(remainder--<=0)break;v.contacts++;}
 return raw.map(({fraction:_,...v})=>v);
}
export function planOutreachMonth(input:MonthPlanInput={}):MonthPlan{
 const allowed=['weeklyPortfolioCaps','historicalSharePercent','pausedBusinessDays','stopped','crmConnected','historicalSegmentApproved','historicalSegmentReference','sendingReadinessVerified','audienceCopyApproved','stopSyncVerified','icpMix','sendWeekdays','followupCalendarOffsets'];
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw new Error('Bounded month planning input required');
 const config={...DEFAULT_MONTH_PLAN_INPUT,...input};
 const caps=config.weeklyPortfolioCaps!,share=config.historicalSharePercent!,paused=config.pausedBusinessDays!,mix=config.icpMix!;
 const weekdays=config.sendWeekdays!,offsets=config.followupCalendarOffsets!;
 if(!Array.isArray(caps)||caps.length!==4||caps.some(c=>!integer(c,0,50))||!integer(share,0,100)||!Array.isArray(paused)||paused.length>60||paused.some(d=>!integer(d,1,60))||new Set(paused).size!==paused.length)throw new Error('Bounded portfolio caps, share and pause days required');
 if(!Array.isArray(weekdays)||!weekdays.length||weekdays.length>5||weekdays.some(d=>!integer(d,1,5))||new Set(weekdays).size!==weekdays.length||!Array.isArray(offsets)||offsets.length!==2||offsets.some(d=>!integer(d,1,30))||offsets[1]<=offsets[0])throw new Error('Bounded weekdays and increasing calendar-day followup offsets required');
 for(const field of ['stopped','crmConnected','historicalSegmentApproved','sendingReadinessVerified','audienceCopyApproved','stopSyncVerified'] as const)if(typeof config[field]!=='boolean')throw new Error('Explicit boolean readiness required');
 if(config.historicalSegmentReference!==undefined&&(typeof config.historicalSegmentReference!=='string'||!/^[-a-zA-Z0-9_:]{1,100}$/.test(config.historicalSegmentReference)))throw new Error('Opaque historical segment reference required');
 if(!Array.isArray(mix)||!mix.length||mix.length>30||mix.some(v=>!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='id,percent'||typeof v.id!=='string'||!/^[-a-z0-9]{1,60}$/.test(v.id)||!integer(v.percent,0,100))||new Set(mix.map(v=>v.id)).size!==mix.length||mix.reduce((n,v)=>n+v.percent,0)!==100)throw new Error('Explicit ICP percentages must sum to 100; no silent normalization');
 const days:MonthPlanDay[]=Array.from({length:112},(_,i)=>{
  const weekday=i%7+1,week=Math.floor(i/7)+1,businessDay=(week-1)*5+Math.min(5,weekday),nonSendingWindow=!weekdays.includes(weekday);
  return{businessDay,calendarDay:i+1,weekday,week,portfolioCap:nonSendingWindow?0:caps[Math.min(3,week-1)],paused:config.stopped===true||paused.includes(businessDay),nonSendingWindow,initial:blank(),followups:blank(),totalEmails:0,unusedCapacity:0};
 });
 const available=(index:number)=>index<days.length&&!days[index].paused&&days[index].totalEmails<days[index].portfolioCap;
 const reserveAt=(start:number)=>{for(let i=start;i<days.length;i++)if(available(i))return i;return -1;};
 let initials=0,historical=0;
 for(let i=0;i<28;i++){
  while(available(i)){
   // Reserve both future touches before allocating another first touch.
   const first=reserveAt(i+offsets[0]);if(first<0)break;
   days[first].totalEmails++;
   const second=reserveAt(Math.max(i+offsets[1],first+1));
   if(second<0){days[first].totalEmails--;break;}
   days[second].totalEmails++;
   const cohort: keyof CohortCounts = historical < Math.round((initials+1)*share/100)?'historical':'newResearch';
   if(cohort==='historical')historical++;initials++;
   days[i].initial[cohort]++;days[i].totalEmails++;
   days[first].followups[cohort]++;days[second].followups[cohort]++;
  }
 }
 for(const day of days)day.unusedCapacity=day.paused?0:day.portfolioCap-day.totalEmails;
 const firstMonth=days.slice(0,28).filter(d=>d.weekday<=5),carryover=days.slice(28).filter(d=>d.totalEmails>0);
 const sum=(selection:MonthPlanDay[],field:'initial'|'followups')=>selection.reduce((n,d)=>({historical:n.historical+d[field].historical,newResearch:n.newResearch+d[field].newResearch}),blank());
 const blockers:string[]=[];
 if(!config.crmConnected)blockers.push('crm-not-connected');
 if(!config.historicalSegmentApproved||!config.historicalSegmentReference)blockers.push('luca-controlled-historical-segment-required');
 if(!config.sendingReadinessVerified)blockers.push('sender-authentication-and-delivery-unverified');
 if(!config.audienceCopyApproved)blockers.push('exact-audience-and-email-approval-required');
 if(!config.stopSyncVerified)blockers.push('provider-stop-suppression-and-reply-sync-unverified');
 if(config.stopped)blockers.push('global-stop');
 const initialContacts=sum(firstMonth,'initial');
 return {mode:'scenario-only',calendar:'relative-four-weeks-monday-start',activationDate:null,pilotReady:false,scenarioGatesSatisfied:blockers.length===0,blockers,days:firstMonth,carryover,
  totals:{monthOneEmailCapacity:firstMonth.reduce((n,d)=>n+(d.paused?0:d.portfolioCap),0),monthOneEmails:firstMonth.reduce((n,d)=>n+d.totalEmails,0),initialContacts,followups:sum(firstMonth,'followups'),monthTwoFollowups:sum(carryover,'followups'),unusedCapacity:firstMonth.reduce((n,d)=>n+d.unusedCapacity,0)},
  icp:{status:input.icpMix?'operator_scenario_pending_confirmation':'documented_working_mix_pending_confirmation',sourceReference:'drive:1k1Ro2QpyxKSbmUvJkonzs9n5iL1vEE70/word/comments.xml:0-5',mix:mix.map(v=>({...v})),newResearchCapacity:allocate(initialContacts.newResearch,mix),middleEastMonthOnePercent:0},
  assumptions:['5/10/15/20 emails per allowed sending day is a suggested scenario across the whole portfolio, not an approved quota or per-mailbox limit.','Four relative weeks start on a notional Monday; no actual activation or send date is selected. Weekends and public holidays are not converted to a real calendar.','Default sending windows are Tuesday/Wednesday/Thursday, following the delivered documents. Monday/Friday and weekends have zero sending capacity.','Delivered historical +7/+10 calendar-day spacing means offsets 0/7/17 from initial touch. Followups roll forward to the next allowed window with available capacity. Custom weekdays or offsets remain unapproved scenarios.','No replies or suppressions are assumed in capacity arithmetic; before any live touch recheck opt-outs, replies, verification and provider state.','Historical share is a capacity scenario, not the size of Example Representative’s CRM. Default reserves all first touches for controlled historical pilot.','Research ICP mix applies only to newResearch capacity, never silently to the historical segment.','Unused capacity is acceptable; count scenarios are neither lead promises nor permission to extract.'],
  controls:{weeklyPortfolioCaps:[...caps],historicalSharePercent:share,pausedBusinessDays:[...paused],stopped:config.stopped!,sendWeekdays:[...weekdays],followupsReservedFirst:true,followupOffsets:[...offsets],followupOffsetUnit:'calendar-days-from-first-touch',requiresFreshVerification:true,requiresSuppressionAndReplyChecks:true},
  providerDispatch:false,crmHistoricalRead:false,crmWrite:false,emailSent:false,campaignActivated:false,notificationSent:false,schedulerInstalled:false};
}
