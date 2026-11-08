import {createHash} from 'node:crypto';
import {prepareQualifiedOutreachBatch,type ConfiguredPipelineInput,type PipelineConfiguration} from './outreach-qualified-pipeline.ts';
import {assertOperatorAccess,type OperatorActor,type OperatorConfiguration} from './operator-runtime.ts';
import type {prepareOutreachBatch} from './outreach-preparation.ts';
type Base=typeof prepareOutreachBatch;
type Policy=Parameters<Base>[1];
type Source=Parameters<Base>[2][number];
type Contact=Parameters<Parameters<Base>[3]>[0];
type Verification=Awaited<ReturnType<Parameters<Base>[3]>>;
export type WorkflowSource=Source&{family:'apollo'|'prospeo'|'clay'|'official'|'other';binding:'synthetic-fixture'|'server-verified'};
/** A private Brain document adapter must implement atomic create-if-absent. No prospect DB. */
export type TemporaryReviewDocuments={
 kind:'private-brain-documents';
 create:(key:string,body:string,expiresAt:string)=>Promise<boolean>;
 read:(key:string)=>Promise<{body:string;expiresAt:string}|null>;
 replace:(key:string,expectedBody:string,body:string,expiresAt:string)=>Promise<boolean>;
};
export type WorkflowPorts={documents:TemporaryReviewDocuments;sources:WorkflowSource[];verify:{id:string;family?:string;binding:'synthetic-fixture'|'server-verified';run:(contact:Contact)=>Promise<Verification>};stopState:(emailHash:string)=>Promise<'clear'|'replied'|'opted-out'|'unknown'>};
export type WorkflowInput={runId:string;tier:'standard'|'tier1';rows:ConfiguredPipelineInput[];configuration:PipelineConfiguration;policy:Policy;actor:OperatorActor;operator:OperatorConfiguration;sourceExecutionApproved:boolean;maxRetries:number;crmContract:'pending'|'create-only-conflict-review';crmContractApprovalRef?:string;eligibilityRef:string};
export type WorkflowResult={
 runId:string;execution:Policy['execution'];adapterBinding:'synthetic-only-not-production-configured'|'injected-server-verified';
 privateTemporaryReview:true;expiresAt:string;leads:Awaited<ReturnType<typeof prepareQualifiedOutreachBatch>>['leads'];qualificationReceipts:Record<string,unknown>[];
 held:{accountId:string;reason:string}[];crmPayloads:Record<string,unknown>[];preparedSequences:Record<string,unknown>[];
 budget:{calls:number;credits:number;maxCalls:number;maxCredits:number};attempts:{stage:string;provider:string;outcome:string}[];
 clayAllowed:boolean;clientApproval:false;emailApproval:false;productionReady:false;duplicate:boolean;
 crmWrite:false;emailSent:false;campaignActivated:false;notificationSent:false;schedulerInstalled:false;crmHistoricalRead:false;
};
const hash=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const id=(value:unknown):value is string=>typeof value==='string'&&/^[-a-zA-Z0-9_:]{1,100}$/.test(value);
const noEffects={crmWrite:false,emailSent:false,campaignActivated:false,notificationSent:false,schedulerInstalled:false,crmHistoricalRead:false} as const;
/** Bounded orchestration with injected ports. This function does not bind or activate providers. */
export async function prepareOutreachWorkflow(input:WorkflowInput,ports:WorkflowPorts,now=Date.now()):Promise<WorkflowResult>{
 assertOperatorAccess(input.operator,input.actor);
 if(!id(input.runId)||!id(input.eligibilityRef)||!['standard','tier1'].includes(input.tier)||!Array.isArray(input.rows)||input.rows.length>5000||!Number.isSafeInteger(input.maxRetries)||input.maxRetries<0||input.maxRetries>2||!Number.isFinite(now)||ports.documents.kind!=='private-brain-documents'||input.sourceExecutionApproved!==true||!['pending','create-only-conflict-review'].includes(input.crmContract)||input.crmContract==='create-only-conflict-review'&&!id(input.crmContractApprovalRef))throw Error('WORKFLOW_AUTHORIZATION_OR_INPUT_DENIED');
 if(!input.operator.approvedVerificationProviders.includes(ports.verify.id)||input.policy.allowedResearchOrigins.some(origin=>!input.operator.approvedResearchOrigins.includes(origin)))throw Error('WORKFLOW_OPERATOR_EVIDENCE_SCOPE_DENIED');
 if(input.policy.installationId!==input.actor.installationId||!Number.isSafeInteger(input.policy.maxCalls)||input.policy.maxCalls<1||input.policy.maxCalls>30000||!Number.isFinite(input.policy.maxCredits)||input.policy.maxCredits<0||input.policy.sourceApproved!==true)throw Error('WORKFLOW_BUDGET_OR_TENANT_DENIED');
 const mode=input.policy.execution;
 if(!['synthetic-fixture','prepared'].includes(mode)||!ports.sources.length||ports.sources.some(s=>s.binding!==(mode==='synthetic-fixture'?'synthetic-fixture':'server-verified'))||ports.verify.binding!==(mode==='synthetic-fixture'?'synthetic-fixture':'server-verified')||ports.sources.some(s=>s.id===ports.verify.id)||!id(ports.verify.id)||ports.sources.some(s=>!id(s.id)||!Number.isFinite(s.costCredits)||s.costCredits<0)||!Number.isFinite(input.policy.verificationCostCredits)||input.policy.verificationCostCredits<0)throw Error('WORKFLOW_INDEPENDENT_BINDINGS_REQUIRED');
 // Different adapter IDs alone do not establish independent verification. Real
 // preparation requires a server-verified provider-family identity, distinct from
 // every allowed enrichment supplier, before spending any calls or credits.
 if(mode==='prepared'&&(!id(ports.verify.family)||['other','unknown'].includes(ports.verify.family)||ports.sources.some(source=>source.family===ports.verify.family)))throw Error('WORKFLOW_INDEPENDENT_PROVIDER_FAMILY_REQUIRED');
 const distinctRows:ConfiguredPipelineInput[]=[],rowDigests=new Map<string,string>();
 for(const row of input.rows){
  if(!row?.account||!id(row.account.id))throw Error('WORKFLOW_ACCOUNT_BINDING_REQUIRED');
  const previous=rowDigests.get(row.account.id),next=hash(row);
  if(previous&&previous!==next)throw Error('WORKFLOW_ACCOUNT_CONTENT_CONFLICT');
  if(!previous){distinctRows.push(row);rowDigests.set(row.account.id,next);}
 }
 const sources=ports.sources.filter(s=>input.tier==='tier1'||s.family!=='clay');
 if(!sources.length)throw Error('WORKFLOW_NO_PERMITTED_SOURCE');
 const expiry=new Date(now+7*86400000).toISOString(),requestDigest=hash({...input,bindingConfiguration:{sources:sources.map(s=>({id:s.id,family:s.family,binding:s.binding,costCredits:s.costCredits})),verifier:{id:ports.verify.id,family:ports.verify.family??null,binding:ports.verify.binding}},actor:{...input.actor},operator:{enabled:input.operator.enabled,installationId:input.operator.installationId}}),key=`insijets-demo:outreach-review:${input.runId}`;
 const claim=JSON.stringify({status:'preparing',requestDigest,createdAt:new Date(now).toISOString(),...noEffects});
 if(!await ports.documents.create(key,claim,expiry)){
  const old=await ports.documents.read(key);if(!old||Date.parse(old.expiresAt)<=now)throw Error('WORKFLOW_EXPIRED_REVIEW_REQUIRES_NEW_APPROVAL');
  const record=JSON.parse(old.body) as {status:string;requestDigest:string;resultDigest:string;result:Omit<WorkflowResult,'duplicate'>};if(record.requestDigest!==requestDigest)throw Error('WORKFLOW_IDEMPOTENCY_CONFLICT');
  if(record.status!=='prepared')throw Error('WORKFLOW_INCOMPLETE_REQUIRES_RECONCILIATION');
  if(record.resultDigest!==hash(record.result))throw Error('WORKFLOW_REVIEW_TAMPERED');
  for(const lead of record.result.leads){
   if(await ports.stopState(hash(lead.contact.email))!=='clear'){
    await ports.documents.replace(key,old.body,JSON.stringify({status:'held-reconciliation-required',requestDigest,reason:'reply-optout-or-unknown-after-review',...noEffects}),old.expiresAt);
    throw Error('WORKFLOW_REVIEW_STOP_CHANGED');
   }
  }
  return {...record.result,duplicate:true};
 }
 let calls=0,credits=0;
 const attempts:{stage:string;provider:string;outcome:string}[]=[],candidateSource=new Map<string,string>(),seenHashes=new Set(input.policy.suppressedEmailHashes),held:{accountId:string;reason:string}[]=[];
 const debit=(cost:number)=>{if(calls+1>input.policy.maxCalls||credits+cost>input.policy.maxCredits)throw Error('WORKFLOW_BUDGET_EXHAUSTED');calls++;credits+=cost;};
 const retry=async<T>(stage:string,provider:string,cost:number,operation:()=>Promise<T>)=>{
  for(let n=0;;n++){debit(cost);try{const result=await operation();attempts.push({stage,provider,outcome:'success'});return result;}catch(error){attempts.push({stage,provider,outcome:n<input.maxRetries?'failed-retry':'failed-fallback'});if(n>=input.maxRetries)throw error;}}
 };
 const adapted=sources.map(source=>({...source,enrich:async(account:Parameters<Source['enrich']>[0])=>{
  const candidate=await retry('enrichment',source.id,source.costCredits,()=>source.enrich(account));
  if(candidate&&typeof candidate.email==='string')candidateSource.set(candidate.email.toLowerCase(),source.id);
  return candidate;
 }}));
 const verify=async(contact:Contact)=>{
  const emailHash=hash(contact.email.toLowerCase());
  if(seenHashes.has(emailHash))throw Error('WORKFLOW_DUPLICATE_OR_SUPPRESSED');
  if(await ports.stopState(emailHash)!=='clear')throw Error('WORKFLOW_STOP_OR_UNKNOWN');
  const previousContact=await ports.documents.read(`insijets-demo:outreach-contact:${emailHash}`);
  if(previousContact&&Date.parse(previousContact.expiresAt)>now)throw Error('WORKFLOW_TEMPORARY_DUPLICATE');
  const result=await retry('verification',ports.verify.id,input.policy.verificationCostCredits,()=>ports.verify.run(contact));
  if(result.provider!==ports.verify.id||result.provider===candidateSource.get(contact.email.toLowerCase()))throw Error('WORKFLOW_VERIFIER_IDENTITY_MISMATCH');
  if(result.status==='valid'&&Number.isFinite(Date.parse(result.checkedAt))&&now-Date.parse(result.checkedAt)>=0&&now-Date.parse(result.checkedAt)<=7*86400000){
   // Atomic temporary contact claims prevent duplicates between independent batches.
   if(!await ports.documents.create(`insijets-demo:outreach-contact:${emailHash}`,JSON.stringify({runId:input.runId,accountScope:'temporary-review'}),expiry))throw Error('WORKFLOW_TEMPORARY_DUPLICATE');
   seenHashes.add(emailHash);
  }
  return result;
 };
 try{
  const leads:Awaited<ReturnType<typeof prepareQualifiedOutreachBatch>>['leads']=[],qualificationReceipts:Record<string,unknown>[]=[];
  // Existing per-batch limits remain intact; the aggregate ledger accounts every retry.
  for(let offset=0;offset<distinctRows.length;offset+=50){
   const batch=distinctRows.slice(offset,offset+50);
   const result=await prepareQualifiedOutreachBatch(batch,input.configuration,{...input.policy,maxCalls:200,maxCredits:input.policy.maxCredits,suppressedEmailHashes:[...seenHashes]},adapted,verify,now);
   leads.push(...result.leads);held.push(...result.held);qualificationReceipts.push(...result.qualificationReceipts);
  }
  const reviewLeads:typeof leads=[],crmPayloads:Record<string,unknown>[]=[],preparedSequences:Record<string,unknown>[]=[];
  for(const lead of leads){
   if(await ports.stopState(hash(lead.contact.email))!=='clear'){held.push({accountId:lead.accountId,reason:'reply-optout-or-unknown-before-review'});continue;}
   reviewLeads.push(lead);
   const binding=input.configuration.campaignBindings[input.configuration.audience==='historical'?'historical':lead.persona];
   const campaign=input.configuration.campaigns.find(c=>c.id===binding)!;
   const row=input.rows.find(r=>r.account.id===lead.accountId)!;
   const render=(text:string)=>text.replace(/{{\s*([^{}]+?)\s*}}/g,(_,key:string)=>{
    if(Object.hasOwn(row.copyVariables??{},key))return row.copyVariables![key].text;
    if(key==='greeting')return 'Hello,';
    if(['company','companyName'].includes(key))return lead.company;
    if(['firstName','first_name'].includes(key))return lead.contact.firstName;
    throw Error('WORKFLOW_UNRESOLVED_COPY_VARIABLE');
   });
   if(render(campaign.steps[0].body)!==lead.draft.body)throw Error('WORKFLOW_FIRST_COPY_READBACK_MISMATCH');
   preparedSequences.push({draftId:lead.id,campaignId:campaign.id,campaignVersion:campaign.version,sourceReference:campaign.sourceReference,steps:campaign.steps.map(step=>({...step,subject:render(step.subject??campaign.subject),body:render(step.body)})),emailApproval:false,dispatch:false});
   if(lead.company.length>120){held.push({accountId:lead.accountId,reason:'crm-field-contract-company-length'});continue;}
   const fields={email:lead.contact.email,firstName:lead.contact.firstName,company:lead.company,sourceRef:`review:${input.runId}`,icp:lead.persona,tier:input.tier==='tier1'?'tier1':'tier2',locale:campaign.locale,campaignRef:campaign.id,eligibilityRef:input.eligibilityRef};
   crmPayloads.push({operationId:`outreach_${hash([input.runId,lead.digest]).slice(0,40)}`,action:'create-contact',fields,contractStatus:input.crmContract==='pending'?'written-operation-and-existing-record-policy-required':'prepared-create-only-conflict-review',contractApprovalRef:input.crmContractApprovalRef??null,existingRecord:'hold-for-client-review-never-overwrite',manualTier1CoordinationRequired:input.tier==='tier1',dispatch:false});
  }
  const result={runId:input.runId,execution:mode,adapterBinding:mode==='synthetic-fixture'?'synthetic-only-not-production-configured':'injected-server-verified',privateTemporaryReview:true,expiresAt:expiry,leads:reviewLeads,qualificationReceipts,held,crmPayloads,preparedSequences,budget:{calls,credits,maxCalls:input.policy.maxCalls,maxCredits:input.policy.maxCredits},attempts,clayAllowed:input.tier==='tier1',clientApproval:false,emailApproval:false,productionReady:false,...noEffects} satisfies Omit<WorkflowResult,'duplicate'>;
  const body=JSON.stringify({status:'prepared',requestDigest,resultDigest:hash(result),result});
  if(!await ports.documents.replace(key,claim,body,expiry))throw Error('WORKFLOW_REVIEW_CONCURRENT_CHANGE');
  const persisted=await ports.documents.read(key);if(!persisted||persisted.body!==body||persisted.expiresAt!==expiry)throw Error('WORKFLOW_EXACT_PERSISTED_READBACK_FAILED');
  return {...result,duplicate:false};
 }catch(error){
  await ports.documents.replace(key,claim,JSON.stringify({status:'held-reconciliation-required',requestDigest,budget:{calls,credits},...noEffects}),expiry);
  throw error;
 }
}
