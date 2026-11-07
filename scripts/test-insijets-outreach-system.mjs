import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {prepareOutreachBatch} from '../src/insijets/outreach-preparation.ts';
import {planOutreachMonth} from '../src/insijets/outreach-month-plan.ts';
import {OutreachMonthPlanStore} from '../src/insijets/outreach-tier1-store.ts';

test('portfolio caps include all followups, reservations survive to month two and gates cannot grant live readiness',()=>{
 const plan=planOutreachMonth();
 assert.equal(plan.days.length,20);assert.equal(plan.totals.monthOneEmailCapacity,150);
 assert.deepEqual(plan.controls.sendWeekdays,[2,3,4]);assert.deepEqual(plan.controls.followupOffsets,[7,17]);
 assert.equal(plan.calendar,'relative-four-weeks-monday-start');
 assert.equal(planOutreachMonth({sendWeekdays:[1,2,3,4,5]}).totals.monthOneEmailCapacity,250);
 for(const day of plan.days)if(![2,3,4].includes(day.weekday))assert.equal(day.totalEmails,0);
 const initialByDay=new Map(plan.days.map(d=>[d.calendarDay,d.initial.historical]));
 // Before +7 calendar days no default followups are due.
 assert.equal(plan.days.filter(d=>d.calendarDay<9).reduce((n,d)=>n+d.followups.historical,0),0);
 assert.equal(initialByDay.get(2),5);
 assert.equal(plan.pilotReady,false);assert.equal(plan.scenarioGatesSatisfied,false);assert.ok(plan.blockers.includes('crm-not-connected'));
 assert.equal(plan.totals.initialContacts.newResearch,0);
 assert.ok(plan.carryover.length>0);
 const contactCount=plan.totals.initialContacts.historical+plan.totals.initialContacts.newResearch;
 assert.equal(plan.totals.monthOneEmails+plan.carryover.reduce((n,d)=>n+d.totalEmails,0),contactCount*3);
 for(const day of [...plan.days,...plan.carryover])assert.ok(day.totalEmails<=day.portfolioCap);
 const allDeclared=planOutreachMonth({crmConnected:true,historicalSegmentApproved:true,historicalSegmentReference:'luca-controlled',sendingReadinessVerified:true,audienceCopyApproved:true,stopSyncVerified:true});
 assert.equal(allDeclared.scenarioGatesSatisfied,true);assert.equal(allDeclared.pilotReady,false);assert.equal(allDeclared.emailSent,false);
 assert.equal(plan.activationDate,null);assert.ok(plan.assumptions.some(v=>v.includes('+7/+10 calendar-day')));
});

test('bounded cap scenarios, pauses, mix rounding, stop and invalid inputs',()=>{
 for(const caps of [[1,1,1,1],[0,0,1,1],[50,50,50,50],[4,7,13,19]])for(const share of [0,18,50,100]){
  const plan=planOutreachMonth({weeklyPortfolioCaps:caps,historicalSharePercent:share,pausedBusinessDays:[4,5,6,12,21,22]});
  for(const day of [...plan.days,...plan.carryover]){
   assert.ok(day.totalEmails<=day.portfolioCap);if(day.paused)assert.equal(day.totalEmails,0);
   assert.equal(day.totalEmails,day.initial.historical+day.initial.newResearch+day.followups.historical+day.followups.newResearch);
  }
  assert.equal(plan.icp.newResearchCapacity.reduce((n,v)=>n+v.contacts,0),plan.totals.initialContacts.newResearch);
  const initials=plan.totals.initialContacts.historical+plan.totals.initialContacts.newResearch;
  assert.equal(plan.totals.monthOneEmails+plan.carryover.reduce((n,d)=>n+d.totalEmails,0),initials*3);
 }
 assert.equal(planOutreachMonth({stopped:true}).totals.monthOneEmails,0);
 for(const input of [{weeklyPortfolioCaps:[51,1,1,1]},{weeklyPortfolioCaps:[1]},{historicalSharePercent:101},{pausedBusinessDays:[0]},{crmConnected:'true'},{icpMix:[{id:'a',percent:99}]},{icpMix:[{id:'a',percent:100},{id:'a',percent:0}]},{historicalSegmentReference:'person@example.test'},{sendWeekdays:[6]},{sendWeekdays:[2,2]},{followupCalendarOffsets:[7,7]},{followupCalendarOffsets:[0,17]},{unknown:true}])assert.throws(()=>planOutreachMonth(input));
 const defaults=planOutreachMonth();defaults.icp.mix[0].percent=0;assert.equal(planOutreachMonth().icp.mix[0].percent,20);
});

const actor={actorId:'fixture-owner',installationId:'insijets-demo',email:'operator@example.invalid',provider:'local',canManageWorkspace:true};
const origins=['https://example.test'];
async function fixture(clock,email='fixture@example.test'){
 const result=await prepareOutreachBatch([{id:'account-'+email.split('@')[0],company:'Synthetic Company',country:'IT',persona:'tour-manager',sourceUrl:'https://example.test/team',signalDate:new Date(clock).toISOString(),fitReviewed:true}],{installationId:'insijets-demo',execution:'synthetic-fixture',sourceApproved:true,allowedCountries:['IT'],allowedPersonas:['tour-manager'],allowedSources:['fixture'],maxCredits:0,maxCalls:2,verificationCostCredits:0,suppressedEmailHashes:[],sendingAccountReference:'fixture-no-send',allowedResearchOrigins:origins},[{id:'fixture',costCredits:0,enrich:async()=>({email,firstName:'Fixture',persona:'tour-manager'})}],async()=>({status:'valid',provider:'fixture',checkedAt:new Date(clock).toISOString()}),clock);
 return result.leads[0];
}
function candidate(lead,clock){return{draftId:lead.id,digest:lead.digest,reason:'Reviewed role and recent public company evidence; no inferred intent',evidenceUrl:lead.sourceUrl,evidenceCheckedAt:new Date(clock).toISOString(),linkedinUrl:'https://www.linkedin.com/in/synthetic-fixture'};}
function setup(){const root=mkdtempSync(join(tmpdir(),'insijets-system-')),configuration={enabled:true,installationId:'insijets-demo',storageRoot:root,approvedResearchOrigins:origins,approvedVerificationProviders:['fixture']};return{root,configuration};}

test('Tier1 uses authenticated owned SQLite, immutable daily selection and manual states survive restart without duplicate contacts',async()=>{
 const {root,configuration}=setup();let clock=Date.parse('2026-10-19T08:00:00.000Z'),store;
 try{
  for(const foreign of [{...actor,installationId:'foreign'},{...actor,email:'stranger@example.test'},{...actor,provider:'supabase'},{...actor,canManageWorkspace:false}])assert.throws(()=>new OutreachMonthPlanStore(configuration,foreign,()=>clock),/ACCESS_DENIED/);
  store=new OutreachMonthPlanStore(configuration,actor,()=>clock);
  const lead=await fixture(clock);store.execute({action:'stage-draft',lead});
  assert.equal(store.stageTier1Candidate(candidate(lead,clock)).duplicate,false);assert.equal(store.stageTier1Candidate(candidate(lead,clock)).duplicate,true);
  const digest=store.prepareTier1Digest({limit:1});assert.equal(digest.items.length,1);assert.equal(digest.created,true);assert.equal(digest.emailSent,false);assert.equal(digest.linkedinAction,false);
  assert.throws(()=>store.prepareTier1Digest({limit:2}),/IMMUTABLE_LIMIT/);
  store.close();store=new OutreachMonthPlanStore(configuration,actor,()=>clock);
  assert.equal(store.prepareTier1Digest({limit:1}).created,false);assert.deepEqual(store.tier1Snapshot().items,digest.items);
  assert.equal(store.updateTier1Status({draftId:lead.id,status:'requested'}).providerReceiptVerified,false);
  assert.equal(store.tier1Snapshot().items[0].status,'requested');
  assert.throws(()=>store.updateTier1Status({draftId:lead.id,status:'skipped'}),/STATE_CONFLICT/);
  store.updateTier1Status({draftId:lead.id,status:'connected'});
  clock+=DAY;assert.equal(store.prepareTier1Digest({limit:1}).items.length,0);
  const db=new DatabaseSync(join(root,'insijets-outreach-preparation','queue.sqlite'));
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM outreach_tier1_candidates').get().n),1);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM outreach_tier1_candidates').all()).includes('fixture@example.test'),false);db.close();
 }finally{store?.close();rmSync(root,{recursive:true,force:true});}
});
const DAY=86400000;

test('freshness, public profile URLs and exact draft evidence fail closed; expired details are scrubbed',async()=>{
 const {root,configuration}=setup();let clock=Date.parse('2026-10-19T08:00:00.000Z');let store=new OutreachMonthPlanStore(configuration,actor,()=>clock);
 try{
  const lead=await fixture(clock);store.execute({action:'stage-draft',lead});const input=candidate(lead,clock);
  for(const linkedinUrl of ['https://www.linkedin.com/company/test','https://www.linkedin.com/in/person?secret=x','http://www.linkedin.com/in/person','https://www.linkedin.com/in/%61bc','https://evil.test/in/person'])assert.throws(()=>store.stageTier1Candidate({...input,linkedinUrl}));
  assert.throws(()=>store.stageTier1Candidate({...input,evidenceCheckedAt:new Date(clock-8*DAY).toISOString()}),/FRESH/);
  assert.throws(()=>store.stageTier1Candidate({...input,evidenceUrl:'https://example.test/other'}),/DRAFT_EVIDENCE/);
  store.stageTier1Candidate(input);const digest=store.prepareTier1Digest();assert.equal(digest.items.length,1);
  clock+=8*DAY;assert.equal(store.tier1Snapshot(digest.day).items.length,0);
  store.close();store=new OutreachMonthPlanStore(configuration,actor,()=>clock);
  assert.equal(store.prepareTier1Digest().items.length,0);assert.throws(()=>store.updateTier1Status({draftId:lead.id,status:'requested'}),/HELD_OR_EXPIRED/);
  const db=new DatabaseSync(join(root,'insijets-outreach-preparation','queue.sqlite'));const row=db.prepare('SELECT * FROM outreach_tier1_candidates').get();assert.equal(row.reason,'');assert.equal(row.linkedin_url,'');assert.equal(row.evidence_url,'');db.close();
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('reply holds and opt-outs hide existing daily digest and forbid fresh enrollment immediately and after restart',async()=>{
 for(const kind of ['positive','question','referral','negative','opt-out','out-of-office','unknown']){
  const {root,configuration}=setup();const clock=Date.parse('2026-10-19T08:00:00.000Z');let store=new OutreachMonthPlanStore(configuration,actor,()=>clock);
  try{
   const lead=await fixture(clock);store.execute({action:'stage-draft',lead});store.stageTier1Candidate(candidate(lead,clock));store.prepareTier1Digest();
   store.execute({action:'record-reply',id:'reply-fixture',draftId:lead.id,kind,sourceReference:'fixture-supplied'});
   assert.equal(store.tier1Snapshot().items.length,0);assert.equal(store.tier1Snapshot().counts.heldOrExpired,1);
   assert.throws(()=>store.updateTier1Status({draftId:lead.id,status:'requested'}),/HELD_OR_EXPIRED/);
   store.close();store=new OutreachMonthPlanStore(configuration,actor,()=>clock);assert.equal(store.prepareTier1Digest().items.length,0);
   if(kind==='opt-out'){assert.equal(store.suppressionHashes(actor).length,1);const renewed=await fixture(clock);assert.throws(()=>store.execute({action:'stage-draft',lead:renewed}),/suppressed/);}
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
 }
});

test('cooldown and stable day membership survive added candidates and sender suppression',async()=>{
 const {root,configuration}=setup();let clock=Date.parse('2026-10-19T08:00:00.000Z');const store=new OutreachMonthPlanStore(configuration,actor,()=>clock);
 try{
  const first=await fixture(clock,'a@example.test'),second=await fixture(clock,'b@example.test');
  store.execute({action:'stage-draft',lead:first});store.stageTier1Candidate(candidate(first,clock));const original=store.prepareTier1Digest({limit:1});
  store.execute({action:'stage-draft',lead:second});store.stageTier1Candidate(candidate(second,clock));assert.equal(store.prepareTier1Digest({limit:1}).items[0].draftId,original.items[0].draftId);
  assert.throws(()=>store.prepareTier1Digest({day:'2026-10-20'}),/CURRENT_DAY/);assert.throws(()=>store.tier1Snapshot('2026-02-30'),/DAY_DENIED/);
  clock+=DAY;const next=store.prepareTier1Digest({limit:1});assert.equal(next.items.length,1);assert.equal(next.items[0].draftId,second.id);
  store.execute({action:'erase-suppress',email:'b@example.test'});assert.equal(store.tier1Snapshot().items.length,0);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
