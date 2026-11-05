import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {QUALIFICATION_VERSION,PERSONA_SIGNAL_GROUPS,evaluateQualification,prepareQualifiedOutreachBatch} from '../src/insijets/outreach-qualified-pipeline.ts';
import {OutreachSystemStore} from '../src/insijets/outreach-system-store.ts';
import library from '../src/insijets/outreach-demo-library.json' with {type:'json'};
const now=Date.now(),DAY=86400000,origin='https://example.test';
const fact=(id,extra={})=>({factId:id,sourceUrl:origin+'/source-'+id,checkedAt:new Date(now).toISOString(),kind:'signal',...extra});
function qualification(accountId='fixture-account',persona='business-owners'){
 return{accountId,persona,frameworkVersion:QUALIFICATION_VERSION,common:Object.entries({economicFit:20,travelRelevance:20,fboPracticality:10,roleAuthority:10,sourceFreshness:10,contactQuality:10}).map(([group,points])=>({group,points,evidence:fact('common-'+group)})),signals:PERSONA_SIGNAL_GROUPS[persona].map((group,i)=>({group,points:i<3?40:20,evidence:fact('persona-'+i)})),exclusions:[],eligibility:'client-attested-eligible'};
}
const policy={installationId:'insijets-demo',execution:'synthetic-fixture',sourceApproved:true,allowedCountries:['IT'],allowedPersonas:['business-owners','pa-ea'],allowedSources:['primary','fallback','never'],maxCredits:0,maxCalls:10,verificationCostCredits:0,suppressedEmailHashes:[],sendingAccountReference:'synthetic-unresolved-sender',allowedResearchOrigins:[origin]};
const campaign=(id='owner-template',audience='new-icp')=>({id,name:'Synthetic reviewed configuration',audience,persona:'business-owners',locale:'en',subject:'A contact for {{company}}',steps:[{offset:0,offsetUnit:'calendar-days',body:'Hi {{first_name}},\nSynthetic persona-specific copy for {{company}}. Review only.'},{offset:7,offsetUnit:'calendar-days',body:'Synthetic followup one.'},{offset:17,offsetUnit:'calendar-days',body:'Synthetic followup two.'}],sourceReference:'synthetic-editorial-config',sourceDate:'2026-10-15',cadenceOriginal:'0/7/17 calendar',version:1,reviewState:'draft',sendEnabled:false});
const row=(id='fixture-account',persona='business-owners')=>({account:{id,company:'Synthetic Example Ltd',country:'IT',persona,sourceUrl:origin+'/reviewed-company',signalDate:new Date(now).toISOString(),fitReviewed:true},qualification:qualification(id,persona)});
const config=()=>({version:'synthetic-config-v1',audience:'new-icp',campaignBindings:{'business-owners':'owner-template'},campaigns:[campaign()]});
test('delivered weighted framework computes 80/100 +160/200 ->80 with complete trace and confidence; every persona has five groups',()=>{
 const score=evaluateQualification(qualification(),[origin],now);assert.equal(score.commonScore,80);assert.equal(score.personaScore,160);assert.equal(score.displayScore,80);assert.equal(score.confidence,'high');assert.equal(score.routing,'priority-review');assert.equal(score.trace.length,11);assert.equal(score.frameworkApproval,'pending-client-validation');assert.equal(score.emailSend,false);for(const groups of Object.values(PERSONA_SIGNAL_GROUPS))assert.equal(groups.length,5);
});
test('missing signals earn zero; exclusions and unconfirmed eligibility always hold regardless of score',()=>{
 const missing=evaluateQualification({...qualification(),common:[],signals:[]},[origin],now);assert.equal(missing.displayScore,0);assert.equal(missing.confidence,'low');assert.equal(missing.routing,'research');
 for(const reason of ['opt-out','current-client','active-conversation','protected-tier1','conflicting-evidence']){const result=evaluateQualification({...qualification(),exclusions:[reason]},[origin],now);assert.equal(result.routing,'held');assert.ok(result.holds.includes(reason));}
 assert.equal(evaluateQualification({...qualification(),eligibility:'unknown'},[origin],now).routing,'held');
});
test('financial/role freshness, duplicate facts, future/expired events and invalid source cannot inflate qualification',()=>{
 const q=qualification();q.signals[0].evidence=fact('event',{kind:'event',eventAt:new Date(now+61*DAY).toISOString()});assert.equal(evaluateQualification(q,[origin],now).personaScore,140);
 q.signals[0].evidence.eventAt=new Date(now-DAY).toISOString();assert.equal(evaluateQualification(q,[origin],now).routing,'held');
 q.signals[0].evidence=fact('stale',{kind:'role-contact',checkedAt:new Date(now-91*DAY).toISOString()});assert.ok(evaluateQualification(q,[origin],now).holds.includes('stale-or-future-evidence'));
 q.signals[0].evidence=fact('financial',{kind:'financial',checkedAt:new Date(now-179*DAY).toISOString()});assert.equal(evaluateQualification(q,[origin],now).personaScore,160);
 q.signals[0].evidence.checkedAt=new Date(now-181*DAY).toISOString();assert.equal(evaluateQualification(q,[origin],now).routing,'held');
 const dup=qualification();dup.signals[0].evidence=dup.common[0].evidence;const d=evaluateQualification(dup,[origin],now);assert.equal(d.routing,'held');assert.equal(d.personaScore,120);
 const bad=qualification();bad.common[0].evidence.sourceUrl='https://unapproved.example.test/fact';assert.throws(()=>evaluateQualification(bad,[origin],now),/SOURCE_DENIED/);
 assert.throws(()=>evaluateQualification({...qualification(),frameworkVersion:'invented'},[origin],now),/INPUT_DENIED/);assert.throws(()=>evaluateQualification({...qualification(),signals:[{group:'invented',points:40,evidence:fact('invented')}]},[origin],now),/GROUP_DENIED/);
});
test('configured qualification precedes waterfall, binds persona copy and persists exact immutable draft after restart',async()=>{
 let calls=[];const sources=[{id:'primary',costCredits:0,enrich:async()=>{calls.push('primary');return null;}},{id:'fallback',costCredits:0,enrich:async a=>{calls.push('fallback');return{firstName:'Fixture',email:'fixture@example.test',persona:a.persona};}},{id:'never',costCredits:0,enrich:async()=>{throw Error('must stop');}}];
 const invalid=row('excluded');invalid.qualification.exclusions=['opt-out'];
 const result=await prepareQualifiedOutreachBatch([row(),invalid],config(),policy,sources,async()=>{calls.push('verify');return{status:'valid',provider:'fixture-verifier',checkedAt:new Date(now).toISOString()};},now);
 assert.deepEqual(calls,['primary','fallback','verify']);assert.equal(result.leads.length,1);assert.equal(result.leads[0].score,80);assert.equal(result.held.length,1);assert.equal(result.leads[0].draft.subject,'A contact for Synthetic Example Ltd');assert.match(result.leads[0].draft.body,/Hi Fixture/);assert.match(result.leads[0].draft.body,/persona-specific/);assert.equal(result.qualificationReceipts[0].campaignVersion,1);assert.equal(result.liveReady,false);
 const root=mkdtempSync(join(tmpdir(),'qualified-pipeline-'));const actor={actorId:'fixture-owner',installationId:'insijets-demo',email:'operator@example.invalid',provider:'local',canManageWorkspace:true},settings={enabled:true,installationId:'insijets-demo',storageRoot:root,approvedResearchOrigins:[origin],approvedVerificationProviders:['fixture-verifier']};let store;
 try{store=new OutreachSystemStore(settings,actor,()=>now);store.execute({action:'stage-draft',lead:result.leads[0]});store.close();store=new OutreachSystemStore(settings,actor,()=>now);const review=store.review(result.leads[0].id,result.leads[0].digest,actor);assert.equal(review.draft.score,80);assert.equal(review.draft.draft.body,result.leads[0].draft.body);assert.equal(review.emailApprovalGranted,false);}finally{store?.close();rmSync(root,{recursive:true,force:true});}
});
test('missing/mismatched campaign, unresolved placeholders and wrong historical relationship stop before contact lookup',async()=>{
 let calls=0;const sources=[{id:'primary',costCredits:0,enrich:async()=>{calls++;return null;}}],verify=async()=>{throw Error('no verifier');};
 for(const setting of [{...config(),campaignBindings:{}},{...config(),campaigns:[campaign('owner-template','historical')]},{...config(),campaigns:[{...campaign(),subject:'About {{unverified_route}}'}]}]){const result=await prepareQualifiedOutreachBatch([row()],setting,policy,sources,verify,now);assert.equal(result.leads.length,0);assert.equal(calls,0);}
 const historical={...config(),audience:'historical',campaignBindings:{historical:'historical-template'},campaigns:[campaign('historical-template','historical')]};assert.equal((await prepareQualifiedOutreachBatch([row()],historical,policy,sources,verify,now)).leads.length,0);assert.equal(calls,0);
 await assert.rejects(prepareQualifiedOutreachBatch([row(),row()],config(),policy,sources,verify,now),/ACCOUNT_BINDING/);
});
test('invalid verifier, budget exhaustion and disallowed source permission retain original upstream safety gates',async()=>{
 let calls=0;const sources=[{id:'primary',costCredits:1,enrich:async a=>{calls++;return{firstName:'Fixture',email:'fixture@example.test',persona:a.persona};}}];
 const zero=await prepareQualifiedOutreachBatch([row()],config(),policy,sources,async()=>{throw Error('no verifier');},now);assert.equal(zero.leads.length,0);assert.equal(calls,0);
 const risky=await prepareQualifiedOutreachBatch([row()],config(),{...policy,maxCredits:2},sources,async()=>({status:'risky',provider:'fixture',checkedAt:new Date(now).toISOString()}),now);assert.equal(risky.leads.length,0);
 await assert.rejects(prepareQualifiedOutreachBatch([row()],config(),{...policy,sourceApproved:false},sources,async()=>{throw Error('no verifier');},now),/policy/);
});
test('delivered persona template uses only explicitly reviewed context bound to supported source facts; no invented fallback',async()=>{
 let calls=0;const sources=[{id:'primary',costCredits:0,enrich:async a=>{calls++;return{firstName:'Fixture',email:'assistant@example.test',persona:a.persona};}}],verify=async()=>({status:'valid',provider:'fixture',checkedAt:new Date(now).toISOString()});
 const configured={version:'source-demo-c3-v1',audience:'new-icp',campaignBindings:{'pa-ea':'c3'},campaigns:library.map(c=>c.id==='c3'?{...c,steps:c.steps.map((step,i)=>i===0?{...step,body:step.body+' {{verified_relevant_context}}'}:step)}:c)};
 const input=row('fixture-assistant','pa-ea');
 assert.equal((await prepareQualifiedOutreachBatch([input],configured,policy,sources,verify,now)).leads.length,0);assert.equal(calls,0);
 input.copyVariables={principalFullName:{text:'Synthetic Principal',factIds:['principal-link'],evidence:fact('principal-link',{kind:'role-contact'})},verified_relevant_context:{text:'Synthetic fixture: your reviewed role includes itinerary coordination.',factIds:['persona-0']}};
 const result=await prepareQualifiedOutreachBatch([input],configured,policy,sources,verify,now);assert.equal(result.leads.length,1);assert.match(result.leads[0].draft.body,/Synthetic fixture/);assert.doesNotMatch(result.leads[0].draft.body,/{{/);assert.equal(result.qualificationReceipts[0].campaignId,'c3');assert.deepEqual(result.qualificationReceipts[0].copyBindings.verified_relevant_context,['persona-0']);
 input.copyVariables.verified_relevant_context.factIds=['unreviewed-fact'];await assert.rejects(prepareQualifiedOutreachBatch([input],configured,policy,sources,verify,now),/COPY_BINDINGS/);
});

// The financial values below are synthetic fixtures, never real prospect claims.
function lucaQualification(accountId='fixture-account',persona='business-owners'){
 const financial=id=>fact(id,{kind:'financial'});
 return {accountId,persona,frameworkVersion:'insijets-luca-20261022-v2',gates:{
  role:{status:'confirmed',evidence:fact('gate-role',{kind:'role-contact'})},
  source:{status:'confirmed',evidence:fact('gate-source')},
  email:{status:'valid',professional:true,identityMatched:true,catchAll:false,independent:true,emailHash:createHash('sha256').update('fixture@example.test').digest('hex'),provider:'fixture-verifier',checkedAt:new Date(now).toISOString(),evidence:fact('gate-email',{kind:'role-contact'})},
  economic:{status:'confirmed',policy:{currency:'EUR',application:'principal-and-company',netRevenueDefinition:'Synthetic net revenue definition for test only',confirmationRef:'synthetic-policy'},personalNetWorth:{amount:20000000,currency:'EUR',evidence:financial('gate-wealth')},companyNetRevenue:[2024,2025].map(fiscalYear=>({fiscalYear,amount:20000000,currency:'EUR',evidence:financial('gate-revenue-'+fiscalYear)})),trajectory:{outlook:'positive',evidence:financial('gate-trajectory')}}
 },common:Object.entries({mobile:15,assistant:15,news:20,travelNeed:20,routeFriction:20,fboPracticality:10}).map(([group,points])=>({group,points,evidence:fact('score-'+group),...(group==='news'?{newsKind:'private-jet-use'}:{})})),signals:[],exclusions:[],eligibility:'client-attested-eligible'};
}
test('Luca v2 gates contribute no points; capped reviewed factors total 100 and remain unapproved',()=>{
 const result=evaluateQualification(lucaQualification(),[origin],now);
 assert.equal(result.displayScore,100);assert.equal(result.personaScore,0);assert.equal(result.trace.length,6);assert.equal(result.routing,'priority-review');assert.equal(result.frameworkApproval,'pending-client-validation');assert.equal(result.emailSend,false);
 const noScore=lucaQualification();noScore.common=[];assert.equal(evaluateQualification(noScore,[origin],now).displayScore,0);
 const positive=lucaQualification();positive.common[2].points=5;positive.common[2].newsKind='positive-news';assert.equal(evaluateQualification(positive,[origin],now).displayScore,85);
 positive.common[2].points=20;assert.throws(()=>evaluateQualification(positive,[origin],now),/NEWS_KIND/);
 const stacked=lucaQualification();stacked.common[2].points=25;assert.throws(()=>evaluateQualification(stacked,[origin],now),/GROUP_DENIED/);
});
test('Luca required gates override maximum score, unresolved policy never invents currency or financial fit',()=>{
 const mutations=[
  q=>q.gates.role.status='unknown',q=>q.gates.source.status='failed',q=>q.gates.email.status='risky',q=>delete q.gates.email.emailHash,q=>delete q.gates.email.professional,q=>q.gates.email.professional=false,q=>q.gates.email.identityMatched=false,q=>q.gates.email.catchAll=true,q=>q.gates.email.independent=false,
  q=>delete q.gates.economic.policy,q=>q.gates.economic.personalNetWorth.amount=19999999,
  q=>q.gates.economic.companyNetRevenue[0].amount=19999999,q=>q.gates.economic.companyNetRevenue[0].currency='USD',
  q=>q.gates.economic.companyNetRevenue[0].fiscalYear=2025,q=>q.gates.economic.trajectory.outlook='unknown',
  q=>q.gates.role.evidence.checkedAt=new Date(now-91*DAY).toISOString(),
  q=>q.gates.email.checkedAt=new Date(now-8*DAY).toISOString(),
  q=>q.gates.economic.trajectory.evidence.checkedAt=new Date(now+DAY).toISOString(),
  q=>q.exclusions=['opt-out'],q=>q.eligibility='unknown'
 ];
 for(const mutate of mutations){const q=lucaQualification();mutate(q);const result=evaluateQualification(q,[origin],now);assert.equal(result.routing,'held');assert.ok(result.holds.length>0);assert.equal(result.emailSend,false);}
});
test('Luca score rejects duplicate gate/signal facts, unapproved source and expired itinerary',()=>{
 const q=lucaQualification();q.common[0].evidence=q.gates.role.evidence;const duplicate=evaluateQualification(q,[origin],now);assert.equal(duplicate.displayScore,85);assert.equal(duplicate.routing,'held');
 const bad=lucaQualification();bad.gates.source.evidence.sourceUrl='https://unapproved.example.test/source';assert.throws(()=>evaluateQualification(bad,[origin],now),/SOURCE_DENIED/);
 const expired=lucaQualification();expired.common[4].evidence=fact('expired-route',{kind:'event',eventAt:new Date(now-DAY).toISOString()});assert.equal(evaluateQualification(expired,[origin],now).routing,'held');
});
test('prepared legacy records are held before enrichment; Luca valid gate is bound to actual verified candidate',async()=>{
 let calls=0;const sources=[{id:'primary',costCredits:0,enrich:async a=>{calls++;return {firstName:'Fixture',email:'fixture@example.test',persona:a.persona};}}];
 const verify=async()=>({status:'valid',provider:'fixture-verifier',checkedAt:new Date(now).toISOString()});
 const legacy=await prepareQualifiedOutreachBatch([row()],config(),{...policy,execution:'prepared'},sources,verify,now);assert.equal(calls,0);assert.equal(legacy.leads.length,0);assert.match(legacy.held[0].reason,/legacy-qualification/);
 const input={...row(),qualification:lucaQualification()};const result=await prepareQualifiedOutreachBatch([input],config(),{...policy,execution:'prepared'},sources,verify,now);assert.equal(result.leads.length,1);assert.equal(result.leads[0].score,100);
 input.qualification.gates.email.emailHash=createHash('sha256').update('other@example.test').digest('hex');const mismatch=await prepareQualifiedOutreachBatch([input],config(),{...policy,execution:'prepared'},sources,verify,now);assert.equal(mismatch.leads.length,0);assert.match(mismatch.held[0].reason,/email-gate-contact-mismatch/);
});

test('canonical historical copy uses fresh non-score evidence and neutral greeting; missing enquiry date holds before lookup',async()=>{
 let calls=0;const sources=[{id:'primary',costCredits:0,enrich:async a=>{calls++;return {firstName:'Fixture',email:'fixture@example.test',persona:a.persona};}}],verify=async()=>({status:'valid',provider:'fixture-verifier',checkedAt:new Date(now).toISOString()});
 const historical={...config(),audience:'historical',campaignBindings:{historical:'historical-template'},campaigns:[{...campaign('historical-template','historical'),steps:campaign('historical-template','historical').steps.map((step,i)=>i===0?{...step,body:'{{greeting}}\nYour enquiry on {{previousEnquiryDate}} concerned {{previousService}}: {{previousItineraryOrServiceContext}}.'}:step)}]};
 const copy=(text,id)=>({text,factIds:[id],evidence:fact(id,{kind:'event',eventAt:'2025-03-01T12:00:00Z'})});
 const input={...row(),qualification:lucaQualification(),historicalRelationshipAttested:true,copyVariables:{previousService:copy('private charter','history-service'),previousItineraryOrServiceContext:copy('a Milan to Crete request','history-route')}};
 const missing=await prepareQualifiedOutreachBatch([input],historical,{...policy,execution:'prepared'},sources,verify,now);assert.equal(missing.leads.length,0);assert.equal(calls,0);assert.equal(missing.held[0].reason,'unresolved-source-copy-variables');
 input.copyVariables.previousEnquiryDate=copy('1 March 2025','history-date');
 const result=await prepareQualifiedOutreachBatch([input],historical,{...policy,execution:'prepared'},sources,verify,now);assert.equal(result.leads.length,1);assert.match(result.leads[0].draft.body,/^Hello,\nYour enquiry on 1 March 2025/);assert.equal(result.leads[0].score,100);assert.equal(result.qualificationReceipts[0].neutralGreetingFallback,true);assert.equal(result.qualificationReceipts[0].copyEvidence.previousEnquiryDate.factId,'history-date');assert.equal(result.qualificationReceipts[0].emailApproval,false);
 input.copyVariables.greeting={text:'Dear Dr Synthetic,',factIds:['crm-salutation'],evidence:fact('crm-salutation',{kind:'role-contact'})};
 const addressed=await prepareQualifiedOutreachBatch([input],historical,{...policy,execution:'prepared'},sources,verify,now);assert.match(addressed.leads[0].draft.body,/^Dear Dr Synthetic,/);assert.equal(addressed.qualificationReceipts[0].neutralGreetingFallback,false);
 input.copyVariables.previousEnquiryDate.evidence.eventAt=new Date(now+DAY).toISOString();await assert.rejects(prepareQualifiedOutreachBatch([input],historical,policy,sources,verify,now),/COPY_EVENT_DENIED/);input.copyVariables.previousEnquiryDate.evidence.eventAt='2025-03-01T12:00:00Z';
 input.copyVariables.greeting.evidence.checkedAt=new Date(now-91*DAY).toISOString();await assert.rejects(prepareQualifiedOutreachBatch([input],historical,policy,sources,verify,now),/COPY_EVIDENCE_STALE/);
});
test('canonical copy rejects unsupported fields or facts and held pet/standalone wealth lanes cannot enter preparation',async()=>{
 const sources=[{id:'primary',costCredits:0,enrich:async()=>{throw Error('must not call');}}],verify=async()=>{throw Error('must not verify');};
 const input={...row(),qualification:lucaQualification(),copyVariables:{inventedPrivateTravel:{text:'invented',factIds:['a'],evidence:fact('a')}}};await assert.rejects(prepareQualifiedOutreachBatch([input],config(),policy,sources,verify,now),/COPY_BINDINGS/);
 input.copyVariables={previousService:{text:'charter',factIds:['unproven']}};await assert.rejects(prepareQualifiedOutreachBatch([input],config(),policy,sources,verify,now),/COPY_BINDINGS/);
 input.copyVariables={greeting:{text:'Dear Lady Synthetic,',factIds:['score-mobile']}};await assert.rejects(prepareQualifiedOutreachBatch([input],config(),policy,sources,verify,now),/COPY_BINDINGS/);
 for(const persona of ['pet-relocation','wealth-managers'])assert.ok(evaluateQualification(lucaQualification('lane-test',persona),[origin],now).holds.includes('lane-pending-review-or-merged'));
});
