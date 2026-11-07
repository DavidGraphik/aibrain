import {createHash} from 'node:crypto';
import {prepareOutreachWorkflow,type WorkflowInput,type WorkflowPorts} from './outreach-workflow.ts';
import {OutreachReviewDocuments} from './outreach-review-documents.ts';
import {LUCA_SCORE_STEPS,PERSONA_SIGNAL_GROUPS,LUCA_QUALIFICATION_VERSION,type LucaQualificationInput,type ConfiguredPipelineInput} from './outreach-qualified-pipeline.ts';
import {FINAL_REVIEW_CAMPAIGNS,OUTREACH_FINAL_CONTENT_VERSION,OUTREACH_FINAL_SOURCE_SHA256} from './outreach-final-content.ts';
import {assertOperatorAccess,type OperatorActor,type OperatorConfiguration} from './operator-runtime.ts';
/** Deterministic fictitious evidence for the controlled self-test and its regression
 * fixtures. The official.example.invalid records are never production evidence. */
export function createSyntheticOutreachRow(persona:keyof typeof PERSONA_SIGNAL_GROUPS,index:number,now:number,accountId=`synthetic-${index}`,verificationProvider='independent-fixture'){
 const origin='https://official.example.invalid',at=new Date(now).toISOString();
 const evidence=(factId:string,kind:'signal'|'role-contact'|'financial'='signal')=>({factId,sourceUrl:`${origin}/fixture/${accountId}/${factId}`,checkedAt:at,kind});
 const campaign=FINAL_REVIEW_CAMPAIGNS.find(c=>c.audience==='new-icp'&&c.persona===persona);
 const fields=new Set([...(campaign?.steps.map(step=>(step.subject??'')+'\n'+step.body).join('\n')??'').matchAll(/{{\s*([^{}]+?)\s*}}/g)].map(match=>match[1]));
 const copyVariables:NonNullable<ConfiguredPipelineInput['copyVariables']>={};
 for(const field of fields){
  if(['greeting','companyName','company','firstName','first_name'].includes(field))continue;
  const factId=`copy-${index}-${field}`;
  copyVariables[field]={text:`Synthetic ${field} ${index}`,factIds:[factId],evidence:evidence(factId)};
 }
 const year=new Date(now).getUTCFullYear();
 const qualification:LucaQualificationInput={accountId,persona,frameworkVersion:LUCA_QUALIFICATION_VERSION,gates:{
  role:{status:'confirmed',evidence:evidence(`role-${index}`,'role-contact')},source:{status:'confirmed',evidence:evidence(`source-${index}`)},
  email:{status:'valid',professional:true,identityMatched:true,catchAll:false,independent:true,emailHash:createHash('sha256').update(`${accountId}@example.invalid`).digest('hex'),provider:verificationProvider,checkedAt:at,evidence:evidence(`email-${index}`,'role-contact')},
  economic:{status:'confirmed',policy:{currency:'EUR',application:'principal-and-company',netRevenueDefinition:'Synthetic net revenue fixture only',confirmationRef:'synthetic-policy-never-real-approval'},personalNetWorth:{amount:20000000,currency:'EUR',evidence:evidence(`wealth-${index}`,'financial')},companyNetRevenue:[year-2,year-1].map(fiscalYear=>({fiscalYear,amount:20000000,currency:'EUR',evidence:evidence(`revenue-${index}-${fiscalYear}`,'financial')})),trajectory:{outlook:'positive',evidence:evidence(`outlook-${index}`,'financial')}}
 },common:Object.entries(LUCA_SCORE_STEPS).map(([group,steps],i)=>({group,points:Math.max(...steps),evidence:evidence(`score-${index}-${i}`),...(group==='news'?{newsKind:'private-jet-use' as const}:{})})),signals:[],eligibility:'client-attested-eligible',exclusions:[]};
 return {account:{id:accountId,company:`Synthetic company ${index}`,country:'UK',persona,sourceUrl:`${origin}/account/${index}`,signalDate:at,fitReviewed:true},qualification,copyVariables};
}
/** Reachable controlled self-test. No provider/environment/network credentials are read. */
export async function runOutreachSyntheticAcceptance(configuration:OperatorConfiguration,actor:OperatorActor,input:{runId:string}){
 assertOperatorAccess(configuration,actor);
 if(!input||Object.keys(input).join(',')!=='runId'||typeof input.runId!=='string'||!/^[-a-zA-Z0-9_]{1,60}$/.test(input.runId))throw Error('SYNTHETIC_ACCEPTANCE_INPUT_DENIED');
 const documents=new OutreachReviewDocuments(configuration,actor),clock=Date.now(),seedKey=`insijets-demo:outreach-review:selftest-seed-${input.runId}`;
 const seedBody=JSON.stringify({fixtureAt:new Date(clock).toISOString()});
 await documents.create(seedKey,seedBody,new Date(clock+7*86400000).toISOString());
 const seed=await documents.read(seedKey);if(!seed)throw Error('SYNTHETIC_ACCEPTANCE_SEED_READBACK_FAILED');
 const seedValue=JSON.parse(seed.body);
 if(!seedValue||Object.keys(seedValue).join(',')!=='fixtureAt'||typeof seedValue.fixtureAt!=='string'||!Number.isFinite(Date.parse(seedValue.fixtureAt))||Date.parse(seedValue.fixtureAt)>Date.now())throw Error('SYNTHETIC_ACCEPTANCE_SEED_DENIED');
 // One persisted synthetic clock keeps repeated calls exactly idempotent for this run.
 const now=Date.parse(seedValue.fixtureAt),at=new Date(now).toISOString(),fixtureOrigin='https://official.example.invalid',runScope=createHash('sha256').update(input.runId).digest('hex').slice(0,12);
 const personas=(Object.keys(PERSONA_SIGNAL_GROUPS) as (keyof typeof PERSONA_SIGNAL_GROUPS)[]).filter(p=>!['art','yachting','politicians','wealth-managers','pet-relocation'].includes(p));
 const rows=personas.map((persona,index)=>createSyntheticOutreachRow(persona,index,now,`acceptance-${runScope}-${index}`,'independent-acceptance-fixture'));
 let sourceCalls=0,verificationCalls=0;
 // These synthetic policies do not expand the caller's real provider/origin permissions.
 const syntheticConfiguration={...configuration,approvedResearchOrigins:[fixtureOrigin],approvedVerificationProviders:['independent-acceptance-fixture']};
 const policy:WorkflowInput={runId:`selftest-${input.runId}`,tier:'standard',rows,configuration:{version:'synthetic-final-'+OUTREACH_FINAL_CONTENT_VERSION,audience:'new-icp',campaignBindings:Object.fromEntries(personas.map(p=>[p,FINAL_REVIEW_CAMPAIGNS.find(c=>c.audience==='new-icp'&&c.persona===p)!.id])),campaigns:FINAL_REVIEW_CAMPAIGNS.filter(c=>c.audience==='new-icp')},actor,operator:syntheticConfiguration,sourceExecutionApproved:true,maxRetries:0,crmContract:'pending',eligibilityRef:'synthetic-acceptance-only',policy:{installationId:'insijets-demo',execution:'synthetic-fixture',sourceApproved:true,allowedCountries:['UK'],allowedPersonas:personas,allowedSources:['empty-acceptance-fixture','fallback-acceptance-fixture'],maxCalls:100,maxCredits:100,verificationCostCredits:1,suppressedEmailHashes:[],sendingAccountReference:'synthetic-never-send',allowedResearchOrigins:[fixtureOrigin]}};
 const ports:WorkflowPorts={documents,sources:[{id:'empty-acceptance-fixture',family:'official',binding:'synthetic-fixture',costCredits:1,enrich:async()=>{sourceCalls++;return null;}},{id:'fallback-acceptance-fixture',family:'prospeo',binding:'synthetic-fixture',costCredits:1,enrich:async account=>{sourceCalls++;return {email:`${account.id}@example.invalid`,firstName:'Synthetic',persona:account.persona};}}],verify:{id:'independent-acceptance-fixture',binding:'synthetic-fixture',run:async()=>{verificationCalls++;return {status:'valid',provider:'independent-acceptance-fixture',checkedAt:at};}},stopState:async()=> 'clear'};
 const result=await prepareOutreachWorkflow(policy,ports,now),callsBeforeReplay=sourceCalls+verificationCalls;
 const replay=await prepareOutreachWorkflow(policy,ports,now);
 return {mode:'synthetic-acceptance-only' as const,runId:input.runId,profilesTested:personas.length,preparedContacts:result.leads.length,preparedSequenceSteps:result.preparedSequences.reduce((n,s)=>n+(Array.isArray(s.steps)?s.steps.length:0),0),inertCRMPayloads:result.crmPayloads.length,held:result.held.length,syntheticLedger:result.budget,providerCallsThisInvocation:sourceCalls+verificationCalls,realProviderCalls:0,realCreditsSpent:0,privatePersistedReadback:true,idempotentReplay:replay.duplicate===true,providerCallsDuringReplay:sourceCalls+verificationCalls-callsBeforeReplay,previouslyPrepared:result.duplicate,editorialSourceSha256:OUTREACH_FINAL_SOURCE_SHA256,reviewResultDigest:createHash('sha256').update(JSON.stringify(result.leads.map(l=>l.digest))).digest('hex'),productionBindingsConfigured:false,fixtureTimestamp:at,reviewExpiresAt:result.expiresAt,crmWrite:false,emailSent:false,campaignActivated:false,notificationSent:false,schedulerInstalled:false};
}
