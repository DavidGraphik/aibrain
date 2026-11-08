import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleOutreachSystemRequest} from '../src/insijets/outreach-system-http.ts';
import {handleOutreachSystemChatTool,outreachSystemToolsForTurn} from '../src/insijets/outreach-system-chat.ts';
import {OutreachSystemStore} from '../src/insijets/outreach-system-store.ts';
import {prepareOutreachBatch} from '../src/insijets/outreach-preparation.ts';
import {DatabaseSync} from 'node:sqlite';
const now=Date.now();
const actor={actorId:'fixture-owner',installationId:'insijets-demo',email:'operator@example.invalid',provider:'local',canManageWorkspace:true};
const session={provider:'local',expiresAt:new Date(now+86400000).toISOString(),tenant:{id:'insijets-demo'},user:{id:actor.actorId,email:actor.email}};
function setup(){const root=mkdtempSync(join(tmpdir(),'outreach-http-'));return {root,configuration:{enabled:true,installationId:'insijets-demo',storageRoot:root,approvedResearchOrigins:['https://example.test'],approvedVerificationProviders:['fixture']}};}
function deps(configuration,overrides={}){return {session:async()=>session,admin:async()=>true,sameOrigin:async()=>true,configuration:async()=>configuration,now:()=>now,...overrides};}
const get=()=>new Request('https://brain.example.test/api/insijets/outreach/system');
const post=(body)=>new Request(get(),{method:'POST',headers:{Origin:'https://brain.example.test','Content-Type':'application/json'},body:JSON.stringify(body)});

test('real handler rejects foreign identity, expiry, durable role and CSRF before configuration/storage',async()=>{
 const {root,configuration}=setup();let reads=0;
 try{const config=async()=>{reads++;return configuration;};
  for(const value of [null,{...session,provider:'demo'},{...session,tenant:{id:'foreign'}},{...session,expiresAt:'invalid'},{...session,expiresAt:new Date(0).toISOString()},{...session,user:{id:'another',email:'another@example.test'}}])assert.ok([401,403].includes((await handleOutreachSystemRequest(get(),deps(configuration,{session:async()=>value,configuration:config}))).status));
  assert.equal((await handleOutreachSystemRequest(get(),deps(configuration,{admin:async()=>false,configuration:config}))).status,403);
  assert.equal((await handleOutreachSystemRequest(post({action:'tier1-prepare',input:{}}),deps(configuration,{sameOrigin:async()=>false,configuration:config}))).status,403);
  assert.equal(reads,0);assert.equal(existsSync(join(root,'insijets-outreach-preparation')),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('campaign source preserved, editable drafts persist across handler/store restart, stale save denied and approval cannot be supplied',async()=>{
 const {root,configuration}=setup();try{
  const response=await handleOutreachSystemRequest(get(),deps(configuration));assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  const view=await response.json();assert.equal(view.campaigns.length,18);assert.equal(view.campaigns.reduce((n,c)=>n+c.steps.length,0),54);assert.deepEqual(view.campaigns[0].steps.map(s=>s.offset),[0,7,17]);assert.equal(view.month.totals.monthOneEmailCapacity,150);assert.equal(view.readiness.crmConnected,false);assert.equal(view.sourcing.leadExtractionEnabled,false);
  const old=view.campaigns[0],input={id:old.id,version:old.version,subject:'Synthetic review title',locale:'en',bodies:old.steps.map(s=>s.body)};
  assert.equal((await handleOutreachSystemRequest(post({action:'save-campaign',input:{...input,sendEnabled:true}}),deps(configuration))).status,400);
  const saved=await handleOutreachSystemRequest(post({action:'save-campaign',input}),deps(configuration));assert.equal(saved.status,200);const data=await saved.json();assert.equal(data.result.campaign.version,2);assert.equal(data.result.emailApprovalGranted,false);
  assert.equal((await handleOutreachSystemRequest(post({action:'save-campaign',input}),deps(configuration))).status,409);
  const reopened=await (await handleOutreachSystemRequest(get(),deps(configuration))).json();assert.equal(reopened.campaigns[0].subject,input.subject);assert.equal(reopened.campaigns[0].sendEnabled,false);
  for(const action of ['send','activate','crm-upsert','extract-leads','schedule','linkedin-connect'])assert.equal((await handleOutreachSystemRequest(post({action,input:{}}),deps(configuration))).status,400);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('bounded API input and scenarios cannot establish live readiness; empty daily list is idempotent',async()=>{
 const {root,configuration}=setup();try{
  for(const body of [{action:'tier1-prepare',input:{limit:21}},{action:'month-plan',input:{weeklyPortfolioCaps:[1000]}},{action:'month-plan',input:{providerURL:'https://bad.example'}}])assert.equal((await handleOutreachSystemRequest(post(body),deps(configuration))).status,400);
  assert.equal((await handleOutreachSystemRequest(post({action:'save-campaign',input:{body:'x'.repeat(33000)}}),deps(configuration))).status,413);
  const declared=await (await handleOutreachSystemRequest(post({action:'month-plan',input:{crmConnected:true,historicalSegmentApproved:true,historicalSegmentReference:'opaque-fixture',sendingReadinessVerified:true,audienceCopyApproved:true,stopSyncVerified:true}}),deps(configuration))).json();assert.equal(declared.result.pilotReady,false);
  for(let i=0;i<2;i++){const data=await (await handleOutreachSystemRequest(post({action:'tier1-prepare',input:{limit:5}}),deps(configuration))).json();assert.equal(data.result.items.length,0);assert.equal(data.result.created,i===0);assert.equal(data.result.notificationSent,false);}
  assert.equal((await handleOutreachSystemRequest(get(),deps({...configuration,enabled:false}))).status,404);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('chat tools use authenticated foreground context and cannot widen scope or invoke effects',async()=>{
 const {root,configuration}=setup();try{
  const context={session,installationId:'insijets-demo',dataRoot:root,enabled:true,backgroundExecution:false,sourceThreadId:'fixture-thread',sourceTurnId:'fixture-turn',canManageWorkspace:async()=>true,approvedResearchOrigins:configuration.approvedResearchOrigins,approvedVerificationProviders:['fixture']};
  assert.equal(outreachSystemToolsForTurn(context).length,1);
  for(const changes of [{backgroundExecution:true},{enabled:false},{session:{...session,tenant:{id:'foreign'}}},{sourceTurnId:''}]){assert.equal(outreachSystemToolsForTurn({...context,...changes}).length,0);await assert.rejects(handleOutreachSystemChatTool('overview',{}, {...context,...changes}));}
  await assert.rejects(handleOutreachSystemChatTool('overview',{}, {...context,canManageWorkspace:async()=>false}));
  for(const [tool,input] of [['send',{}],['overview',{dataRoot:'/tmp/foreign'}],['month_plan',{crmConnected:true}],['campaign_demo',{id:'invented'}]])await assert.rejects(handleOutreachSystemChatTool(tool,input,context));
  const local=new OutreachSystemStore(configuration,actor);try{
   const current=local.campaigns()[0];local.saveCampaign({id:current.id,version:current.version,subject:'PRIVATE_PERSONAL_MARKER',locale:'en',bodies:['PRIVATE_BODY_MARKER','PRIVATE_BODY_MARKER','PRIVATE_BODY_MARKER']});
   const lead=await prepared('private@example.test');local.execute({action:'stage-draft',lead});local.stageTier1Candidate({...tierCandidate(lead),reason:'PRIVATE_REASON_MARKER',linkedinUrl:'https://www.linkedin.com/in/private-personal-marker'});
  }finally{local.close();}
  const demo=await handleOutreachSystemChatTool('campaign_demo',{id:'historical-current-en'},context);assert.equal(demo.emailSent,false);assert.equal(demo.to,null);assert.equal(demo.campaign.steps.length,3);assert.equal(demo.templateOnly,true);
  const overview=await handleOutreachSystemChatTool('overview',{},context);assert.equal(overview.readiness.pilotReady,false);assert.equal(overview.campaigns.length,18);
  const tier1=await handleOutreachSystemChatTool('prepare_daily_tier1',{},context);assert.equal(tier1.counts.available,1);assert.equal(tier1.personalRecordsIncluded,false);
  for(const result of [demo,overview,tier1])assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|private@example|private-personal-marker/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('Tier1 account lock prevents email/CRM handoff for another contact of the same account after restart',async()=>{
 const {root,configuration}=setup();let store;
 try{
  async function lead(email){const batch=await prepareOutreachBatch([{id:'one-coordinated-account',company:'Synthetic Company',country:'IT',persona:'manager',sourceUrl:'https://example.test/team',signalDate:new Date(now).toISOString(),fitReviewed:true}],{installationId:'insijets-demo',execution:'synthetic-fixture',sourceApproved:true,allowedCountries:['IT'],allowedPersonas:['manager'],allowedSources:['fixture'],maxCredits:0,maxCalls:2,verificationCostCredits:0,suppressedEmailHashes:[],sendingAccountReference:'unassigned-fixture',allowedResearchOrigins:['https://example.test']},[{id:'fixture',costCredits:0,enrich:async()=>({email,firstName:'Fixture',persona:'manager'})}],async()=>({status:'valid',checkedAt:new Date(now).toISOString(),provider:'fixture'}),now);return batch.leads[0];}
  const principal=await lead('principal@example.test'),assistant=await lead('assistant@example.test');
  store=new OutreachSystemStore(configuration,actor,()=>now);store.execute({action:'stage-draft',lead:principal});store.execute({action:'stage-draft',lead:assistant});
  store.stageTier1Candidate({draftId:principal.id,digest:principal.digest,reason:'Synthetic reviewed account and professional role',evidenceUrl:principal.sourceUrl,evidenceCheckedAt:new Date(now).toISOString(),linkedinUrl:'https://www.linkedin.com/in/fixture-principal'});
  store.close();store=new OutreachSystemStore(configuration,actor,()=>now);
  assert.throws(()=>store.approveHandoff(assistant.id,assistant.digest,{...actor,confirmation:'APPROVE PREPARED HANDOFF ONLY'}),/Tier1 account/);
  assert.equal(store.prepareTier1Digest({limit:5}).items.length,1);
 }finally{store?.close();rmSync(root,{recursive:true,force:true});}
});

async function prepared(email){const batch=await prepareOutreachBatch([{id:'shared-fixture-account',company:'Synthetic Company',country:'IT',persona:'manager',sourceUrl:'https://example.test/team',signalDate:new Date(now).toISOString(),fitReviewed:true}],{installationId:'insijets-demo',execution:'synthetic-fixture',sourceApproved:true,allowedCountries:['IT'],allowedPersonas:['manager'],allowedSources:['fixture'],maxCredits:0,maxCalls:2,verificationCostCredits:0,suppressedEmailHashes:[],sendingAccountReference:'unassigned-fixture',allowedResearchOrigins:['https://example.test']},[{id:'fixture',costCredits:0,enrich:async()=>({email,firstName:'Fixture',persona:'manager'})}],async()=>({status:'valid',checkedAt:new Date(now).toISOString(),provider:'fixture'}),now);return batch.leads[0];}
const tierCandidate=lead=>({draftId:lead.id,digest:lead.digest,reason:'Synthetic fit reason',evidenceUrl:lead.sourceUrl,evidenceCheckedAt:new Date(now).toISOString(),linkedinUrl:'https://www.linkedin.com/in/fixture-principal'});
test('an existing prepared handoff blocks Tier1 registration for both the same contact and another contact in the account',async()=>{
 const {root,configuration}=setup();let store;try{
  const first=await prepared('first@example.test'),second=await prepared('second@example.test');
  store=new OutreachSystemStore(configuration,actor,()=>now);store.execute({action:'stage-draft',lead:first});store.execute({action:'stage-draft',lead:second});store.approveHandoff(first.id,first.digest,{...actor,confirmation:'APPROVE PREPARED HANDOFF ONLY'});store.close();store=new OutreachSystemStore(configuration,actor,()=>now);
  for(const lead of [first,second])assert.throws(()=>store.stageTier1Candidate(tierCandidate(lead)),/ACCOUNT_HANDOFF_RECONCILIATION/);
  assert.equal(store.prepareTier1Digest({limit:5}).items.length,0);
 }finally{store?.close();rmSync(root,{recursive:true,force:true});}
});
test('explicit erasure and opt-out immediately remove all Tier1 evidence, retaining only minimal locks and hashes',async()=>{
 for(const operation of ['erase-suppress','record-reply']){
  const {root,configuration}=setup();let store;try{
   const lead=await prepared('erase@example.test');store=new OutreachSystemStore(configuration,actor,()=>now);store.execute({action:'stage-draft',lead});store.stageTier1Candidate(tierCandidate(lead));store.prepareTier1Digest({limit:5});
   store.execute(operation==='erase-suppress'?{action:operation,email:'erase@example.test'}:{action:operation,id:'fixture-optout',draftId:lead.id,kind:'opt-out',sourceReference:'fixture'});
   assert.equal(store.tier1Snapshot().items.length,0);store.close();store=undefined;
   const db=new DatabaseSync(join(root,'insijets-outreach-preparation','queue.sqlite'),{readOnly:true});try{const row=db.prepare('SELECT reason,evidence_url,linkedin_url,status FROM outreach_tier1_candidates WHERE draft_id=?').get(lead.id);assert.deepEqual({...row},{reason:'',evidence_url:'',linkedin_url:'',status:'expired'});assert.equal(db.prepare('SELECT count(*) AS n FROM outreach_tier1_account_locks').get().n,1);}finally{db.close();}
  }finally{store?.close();rmSync(root,{recursive:true,force:true});}
 }
});
