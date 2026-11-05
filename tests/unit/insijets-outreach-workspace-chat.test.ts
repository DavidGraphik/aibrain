import {describe,it,expect,vi} from 'vitest';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OutreachSystemStore} from '@/insijets/outreach-system-store';
import {handleOutreachSystemChatTool,outreachSystemToolsForTurn,type OutreachSystemChatContext} from '@/insijets/outreach-system-chat';

const campaignId='11111111-1111-4111-8111-111111111111';
function context():OutreachSystemChatContext{return {
 session:{provider:'local',user:{id:'david-user',email:'operator@example.invalid',name:'David'},tenant:{id:'insijets-demo',name:'InsiJets'},expiresAt:new Date(Date.now()+60_000).toISOString()},
 installationId:'insijets-demo',dataRoot:'/this-path-must-not-be-opened',enabled:true,backgroundExecution:false,
 sourceThreadId:'thread-1',sourceTurnId:'turn-1',canManageWorkspace:vi.fn(async()=>true),approvedResearchOrigins:[],approvedVerificationProviders:[],
 readInstantly:vi.fn(async(operation)=>operation==='campaign'?{campaign:{id:campaignId,name:'Actual campaign'},sequences:[]}:{items:[{id:campaignId,name:'Actual campaign',status:1}],nextCursor:null}),
};}
describe('Outreach Brain workspace tools',()=>{
 it('exposes disabled CRM status through the ordinary authenticated chat without opening data or revealing secrets',async()=>{
  const ctx=context();vi.stubEnv('AIBRAIN_INSIJETS_CRM_ENABLED','false');
  try{
   expect(outreachSystemToolsForTurn(ctx)[0].tools.map(t=>t.name)).toEqual(expect.arrayContaining(['crm_connection_status','crm_selected_facts','crm_sync_selected']));
   expect(await handleOutreachSystemChatTool('crm_connection_status',{},ctx)).toMatchObject({enabled:false,configuredForDispatch:false,liveAccepted:false});
   await expect(handleOutreachSystemChatTool('crm_sync_selected',{selectionRef:'cohort:1',revision:'policy:1',recordRefs:['record:1'],fields:{email:'injected@example.test'}},ctx)).rejects.toThrow('OUTREACH_ARGUMENTS_DENIED');
   await expect(handleOutreachSystemChatTool('crm_sync_selected',{selectionRef:'cohort:1',revision:'policy:1',recordRefs:['record:1']},ctx)).rejects.toThrow('INSIJETS_CRM_UNAVAILABLE');
   expect(ctx.readInstantly).not.toHaveBeenCalled();
  }finally{vi.unstubAllEnvs();}
 });

 it.each(['disabled','anonymous','foreign-tenant','expired','background','not-admin','no-turn'] as const)('denies %s before any connector or local review data',async(kind)=>{
  const ctx=context();if(kind==='disabled')ctx.enabled=false;if(kind==='anonymous')ctx.session=null;if(kind==='foreign-tenant')ctx.installationId='other';if(kind==='expired')ctx.session!.expiresAt=new Date(0).toISOString();if(kind==='background')ctx.backgroundExecution=true;if(kind==='not-admin')ctx.canManageWorkspace=async()=>false;if(kind==='no-turn')ctx.sourceTurnId='';
  await expect(handleOutreachSystemChatTool('live_campaigns',{},ctx)).rejects.toThrow('OUTREACH_ACCESS_DENIED');expect(ctx.readInstantly).not.toHaveBeenCalled();
 });
 it('exposes live reads and pure planning, and plans 1000 contacts without opening a store or contacting a provider',async()=>{
  const ctx=context();expect(outreachSystemToolsForTurn(ctx)[0].tools.map(tool=>tool.name)).toEqual(expect.arrayContaining(['live_campaigns','live_campaign','prepare_research_plan']));
  const result=await handleOutreachSystemChatTool('prepare_research_plan',{targetQualifiedContacts:1000,audience:'new',tier:'standard'},ctx);
  expect(result).toMatchObject({target:{count:1000},ownership:{separateProspectDatabase:false},leadExtraction:false,campaignEnrollment:false,emailSent:false});expect(ctx.readInstantly).not.toHaveBeenCalled();
 });
 it('reads the exact final library without opening storage or calling providers',async()=>{
  const ctx=context();
  expect(await handleOutreachSystemChatTool('final_content',{},ctx)).toMatchObject({counts:{profiles:15,signalChecks:75,messages:54,sequences:18},sendEnabled:false});
  expect(await handleOutreachSystemChatTool('final_content',{section:'profile',personaId:'pa-ea'},ctx)).toHaveProperty('persona');
  await expect(handleOutreachSystemChatTool('final_content',{section:'invalid'},ctx)).rejects.toThrow('OUTREACH_ARGUMENTS_DENIED');
  expect(ctx.readInstantly).not.toHaveBeenCalled();
 });
 it('distinguishes steady capacity from unique contacts and grants no execution',async()=>{
  const ctx=context(); const result=await handleOutreachSystemChatTool('steady_capacity',{mailboxes:Array.from({length:12},(_,i)=>({id:'box-'+i,dailyEmailCap:24,ready:true})),sendWeekdays:[1,2,3,4,5],initialDemandPerDay:96},ctx);
  expect(result).toMatchObject({baselineEmailTarget:5760,baselineIncludesFollowups:true,baselineCapacitySupported:true,dispatch:false});expect(ctx.readInstantly).not.toHaveBeenCalled();
 });
 it('runs the guarded fixed self-test through the real private document adapter without a connector call',async()=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'outreach-chat-selftest-')));const ctx={...context(),dataRoot:root};
  try{
   const result=await handleOutreachSystemChatTool('run_synthetic_acceptance',{runId:'guarded-chat'},ctx);
   expect(result).toMatchObject({mode:'synthetic-acceptance-only',profilesTested:10,preparedContacts:10,preparedSequenceSteps:30,privatePersistedReadback:true,idempotentReplay:true,realProviderCalls:0,realCreditsSpent:0,crmWrite:false,emailSent:false});
   const replay=await handleOutreachSystemChatTool('run_synthetic_acceptance',{runId:'guarded-chat'},ctx);expect(replay).toMatchObject({previouslyPrepared:true,providerCallsThisInvocation:0});
   expect(ctx.readInstantly).not.toHaveBeenCalled();
   expect(JSON.stringify(result)).not.toContain('@example.invalid');
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('keeps private final override text out of general chat overview results',async()=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'outreach-chat-private-')));const ctx={...context(),dataRoot:root};
  try{
   const store=new OutreachSystemStore({enabled:true,installationId:ctx.installationId,storageRoot:root,approvedResearchOrigins:[],approvedVerificationProviders:[]},{actorId:ctx.session!.user.id,installationId:ctx.installationId,email:ctx.session!.user.email,provider:'local',canManageWorkspace:true});
   try{const draft=store.finalCampaigns()[0];store.saveFinalCampaign({id:draft.id,version:draft.version,subjects:draft.steps.map(s=>s.subject),bodies:draft.steps.map((s,i)=>i?'PRIVATE_OVERRIDE_MARKER':s.body)});}finally{store.close();}
   const result=await handleOutreachSystemChatTool('overview',{},ctx);expect(result).toHaveProperty('finalCampaigns');expect(JSON.stringify(result)).not.toContain('PRIVATE_OVERRIDE_MARKER');
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('rejects Clay for standard leads before any effects and allows a Tier 1 plan only',async()=>{
  const ctx=context(),input={targetQualifiedContacts:30,audience:'new',tier:'standard',providers:['clay']};
  await expect(handleOutreachSystemChatTool('prepare_research_plan',input,ctx)).rejects.toThrow('CLAY_REQUIRES_TIER1');
  expect(await handleOutreachSystemChatTool('prepare_research_plan',{...input,tier:'tier1'},ctx)).toMatchObject({sourcePolicy:{clayAllowed:true},providerDispatch:false});expect(ctx.readInstantly).not.toHaveBeenCalled();
 });
 it('uses real bound Instantly campaigns rather than local review templates',async()=>{
  const ctx=context();expect(await handleOutreachSystemChatTool('live_campaigns',{cursor:'next'},ctx)).toMatchObject({items:[{name:'Actual campaign'}]});expect(ctx.readInstantly).toHaveBeenCalledExactlyOnceWith('campaigns',{limit:25,cursor:'next'});
 });
 it('reads campaign ownership before aggregate results, without fetching contacts or replies',async()=>{
  const ctx=context();await handleOutreachSystemChatTool('live_campaign',{campaignId},ctx);expect(vi.mocked(ctx.readInstantly!).mock.calls).toEqual([['campaign',{campaignId}],['metrics',{campaignId}]]);
 });
 it('preserves campaign copy while reporting unavailable results without fake zeros',async()=>{
  const ctx=context();ctx.readInstantly=vi.fn(async(op)=>{if(op==='metrics')throw Error('private provider credential');return {campaign:{id:campaignId},sequences:[]};});
  expect(await handleOutreachSystemChatTool('live_campaign',{campaignId},ctx)).toMatchObject({results:null,resultsError:'INSTANTLY_UNAVAILABLE'});
 });
 it('reads bounded selected-campaign replies for review and omits address columns',async()=>{
  const ctx=context();ctx.readInstantly=vi.fn(async()=>({items:[{id:'reply-1',campaign_id:campaignId,subject:'Question',bodyText:'Please call me',from_address_email:'person@example.test',eaccount:'sender@example.test'}],nextCursor:'next-page'}));
  const result=await handleOutreachSystemChatTool('live_replies',{campaignId,cursor:'page-1'},ctx);
  expect(ctx.readInstantly).toHaveBeenCalledExactlyOnceWith('replies',{campaignId,limit:25,cursor:'page-1'});expect(result).toMatchObject({items:[{id:'reply-1',bodyText:'Please call me'}],nextCursor:'next-page',untrustedContent:true,addressColumnsOmitted:true});expect(JSON.stringify(result)).not.toContain('@example.test');
 });
 it('does not read metrics after a campaign ownership failure and never leaks raw exceptions',async()=>{
  const ctx=context();ctx.readInstantly=vi.fn(async()=>{throw Object.assign(Error('private credential'),{code:'INSTANTLY_WORKSPACE_MISMATCH'});});
  await expect(handleOutreachSystemChatTool('live_campaign',{campaignId},ctx)).rejects.toThrow(/^INSTANTLY_WORKSPACE_MISMATCH$/);expect(ctx.readInstantly).toHaveBeenCalledTimes(1);
 });
 it.each([['live_campaign',{campaignId:'not-a-uuid'}],['live_campaign',{campaignId,url:'https://evil.test'}],['live_campaigns',{cursor:'x\r\ny'}],['prepare_research_plan',{targetQualifiedContacts:10,audience:'new',tier:'standard',approved:true}]])('rejects injected or invalid %s input',async(tool,input)=>{
  const ctx=context();await expect(handleOutreachSystemChatTool(String(tool),input,ctx)).rejects.toThrow('OUTREACH_ARGUMENTS_DENIED');expect(ctx.readInstantly).not.toHaveBeenCalled();
 });
});
