/** Portfolio accounting only. Baseline emails include follow-ups; never a lead quota. */
export type CapacityMailbox={id:string;dailyEmailCap:number;ready:boolean};
export type CapacityDay={day:number;initial:number;followups:number;capacity:number;emails:number;unused:number};
export function planOutreachSteadyCapacity(input:{mailboxes:CapacityMailbox[];sendWeekdays:number[];initialDemandPerDay:number;priorCohorts?:{firstDay:number;contacts:number}[];followupOffsets?:[number,number]}){
 const {mailboxes,sendWeekdays,initialDemandPerDay}=input,offsets=input.followupOffsets??[7,17];
 if(!Array.isArray(mailboxes)||mailboxes.length<1||mailboxes.length>100||new Set(mailboxes.map(m=>m.id)).size!==mailboxes.length||mailboxes.some(m=>!/^[-a-z0-9]{1,80}$/.test(m.id)||!Number.isSafeInteger(m.dailyEmailCap)||m.dailyEmailCap<0||m.dailyEmailCap>100||typeof m.ready!=='boolean')||!Array.isArray(sendWeekdays)||!sendWeekdays.length||sendWeekdays.length>5||new Set(sendWeekdays).size!==sendWeekdays.length||sendWeekdays.some(x=>!Number.isInteger(x)||x<1||x>5)||!Number.isInteger(initialDemandPerDay)||initialDemandPerDay<0||initialDemandPerDay>10000||!Array.isArray(offsets)||offsets.length!==2||!offsets.every(x=>Number.isInteger(x)&&x>0&&x<=30)||offsets[0]>=offsets[1])throw Error('CAPACITY_INPUT_DENIED');
 if(input.priorCohorts!==undefined&&(!Array.isArray(input.priorCohorts)||input.priorCohorts.length>100||input.priorCohorts.reduce((n,c)=>n+c.contacts,0)>5000))throw Error('CARRYOVER_INPUT_DENIED');
 const dailyCap=mailboxes.filter(m=>m.ready).reduce((n,m)=>n+m.dailyEmailCap,0);
 const days:CapacityDay[]=Array.from({length:112},(_,day)=>({day,initial:0,followups:0,capacity:sendWeekdays.includes(day%7+1)?dailyCap:0,emails:0,unused:0}));
 const reserve=(from:number)=>days.findIndex((d,i)=>i>=from&&d.emails<d.capacity);
 let priorContacts=0;
 for(const cohort of input.priorCohorts??[]){
  if(!Number.isInteger(cohort.firstDay)||cohort.firstDay>=0||cohort.firstDay< -60||!Number.isInteger(cohort.contacts)||cohort.contacts<0||cohort.contacts>10000)throw Error('CARRYOVER_INPUT_DENIED');
  priorContacts+=cohort.contacts;
  for(const offset of offsets){
   if(cohort.firstDay+offset<0)continue;
   for(let c=0;c<cohort.contacts;c++){const at=reserve(cohort.firstDay+offset);if(at<0)throw Error('CARRYOVER_EXCEEDS_HORIZON');days[at].followups++;days[at].emails++;}
  }
 }
 for(let day=0;day<28;day++)for(let n=0;n<initialDemandPerDay&&days[day].emails<days[day].capacity;n++){
  const first=reserve(day+offsets[0]);if(first<0)break;days[first].followups++;days[first].emails++;
  const second=reserve(Math.max(day+offsets[1],first+1));if(second<0){days[first].followups--;days[first].emails--;break;}
  days[second].followups++;days[second].emails++;days[day].initial++;days[day].emails++;
 }
 for(const day of days)day.unused=day.capacity-day.emails;
 const month=days.slice(0,28),carryover=days.slice(28).filter(d=>d.emails>0),sum=(key:keyof Pick<CapacityDay,'initial'|'followups'|'emails'|'capacity'>)=>month.reduce((n,d)=>n+d[key],0);
 return {mode:'scenario-only' as const,period:'four-relative-weeks' as const,rampIncluded:false,baselineEmailTarget:5760,baselineIncludesFollowups:true,steadyStateThreeTouchContactEquivalent:1920,priorContacts,days:month,carryover,totals:{capacity:sum('capacity'),emails:sum('emails'),firstContacts:sum('initial'),followups:sum('followups'),futureFollowups:carryover.reduce((n,d)=>n+d.followups,0)},baselineCapacitySupported:sum('capacity')>=5760,assumptions:['Ready mailbox flags and caps are scenario inputs, not verified sender health.','Calendar offsets roll forward to the next permitted window with available portfolio capacity.','Reserve both follow-ups before admitting a first contact; replies/opt-outs reduce actual follow-ups.','5,760 is an approximate steady-state email baseline including follow-ups, never 5,760 unique leads. With three complete touches and no stops, 1,920 contact sequences consume 5,760 emails over a stable cycle; calendar-period first touches vary with carryover.','The initial 5/10/15/20 portfolio ramp remains separate and requires approval.'],dispatch:false as const};
}
