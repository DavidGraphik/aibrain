import {createHash} from 'node:crypto';
import {DOCUMENTED_ICP_MIX} from './outreach-month-plan.ts';
import {OUTREACH_SOURCING_SPEC} from './outreach-sourcing-spec.ts';

export type ResearchProvider = 'apollo'|'prospeo'|'clay';
export type ResearchPlanInput = {
 targetQualifiedContacts:number;
 audience:'historical'|'new';
 tier:'tier1'|'standard';
 personaId?:string;
 campaignId?:string;
 budgetCredits?:number;
 providers?:ResearchProvider[];
};
export const RESEARCH_PLAN_LIMITS = {maxTargetQualifiedContacts:10000,maxRequestedCredits:100000} as const;
const PROVIDERS:ResearchProvider[]=['apollo','prospeo','clay'];
const inputKeys=['targetQualifiedContacts','audience','tier','personaId','campaignId','budgetCredits','providers'];
const opaqueId=(v:unknown):v is string=>typeof v==='string'&&/^[-a-zA-Z0-9_:]{1,100}$/.test(v);
const boundedInteger=(v:unknown,min:number,max:number):v is number=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;

/** Shared boundary for future dispatch adapters: enforce before credentials or activity.
 * A selected provider is a proposal; this check never grants provider permission.
 */
export function assertResearchProviderPolicy(tier:'standard'|'tier1',provider:ResearchProvider):void {
 if(!['standard','tier1'].includes(tier)||!PROVIDERS.includes(provider))throw Error('RESEARCH_PROVIDER_POLICY_INVALID');
 if(provider==='clay'&&tier!=='tier1')throw Error('CLAY_REQUIRES_TIER1');
}

function allocate(total:number,mix:{id:string;percent:number}[]) {
 const allocations=mix.map(item=>({...item,contacts:Math.floor(total*item.percent/100),remainder:(total*item.percent)%100}));
 let remaining=total-allocations.reduce((sum,item)=>sum+item.contacts,0);
 for(const item of [...allocations].sort((a,b)=>b.remainder-a.remainder||a.id.localeCompare(b.id))) {
  if(remaining--<=0)break;
  item.contacts++;
 }
 return allocations.map(({remainder:_,...item})=>item);
}

/** Pure bounded work plan. Contains no contacts, credentials, live adapters or lead store.
 * Its target is a research outcome, independent of mailbox capacity and send volume.
 */
export function prepareResearchPlan(input:ResearchPlanInput) {
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!inputKeys.includes(key))||
  !boundedInteger(input.targetQualifiedContacts,1,RESEARCH_PLAN_LIMITS.maxTargetQualifiedContacts)||
  !['historical','new'].includes(input.audience)||!['tier1','standard'].includes(input.tier)||
  input.personaId!==undefined&& !DOCUMENTED_ICP_MIX.some(item=>item.id===input.personaId)||
  input.campaignId!==undefined&&!opaqueId(input.campaignId)||
  input.budgetCredits!==undefined&&!boundedInteger(input.budgetCredits,0,RESEARCH_PLAN_LIMITS.maxRequestedCredits)||
  input.providers!==undefined&&(!Array.isArray(input.providers)||input.providers.length>PROVIDERS.length||
   input.providers.some(provider=>!PROVIDERS.includes(provider))||new Set(input.providers).size!==input.providers.length)) {
  throw Error('BOUNDED_RESEARCH_PLAN_INPUT_REQUIRED');
 }
 if(input.audience==='historical'&&input.personaId!==undefined)throw Error('HISTORICAL_COHORT_MUST_REMAIN_SEPARATE');
 const providers=[...(input.providers??['apollo','prospeo'])].sort() as ResearchProvider[];
 for(const provider of providers)assertResearchProviderPolicy(input.tier,provider);
 const selectedPersona=input.personaId?DOCUMENTED_ICP_MIX.find(item=>item.id===input.personaId):undefined;
 const allocations=input.audience==='new'?allocate(input.targetQualifiedContacts,
  selectedPersona?[{id:selectedPersona.id,percent:100}]:DOCUMENTED_ICP_MIX):[];
 const requirements=[
  {id:'execution-authority',status:'pending' as const,detail:'Live research and any credit spend require an authorised execution policy; a chat request or this plan does not establish account permissions.'},
  {id:'source-bindings',status:'pending' as const,detail:'Bind approved provider accounts, API scopes, source rights, per-request ceilings and source ownership; no credentials are accepted in this plan.'},
  {id:'independent-verification',status:'pending' as const,detail:'Bind a fresh independent verifier separately from contact discovery; a provider name alone is not a verification result.'},
  {id:'crm-eligibility',status:'pending' as const,detail:'Agree the client-controlled eligibility, current-client, active-conversation, account-ownership and suppression mechanism within authorised CRM permissions; no historical read is implied.'},
  {id:'campaign-binding',status:'pending' as const,detail:input.campaignId?'Validate this proposed Instantly campaign, audience, sequence version, custom-field mapping and permitted enrollment operation.':'Select and validate the correct Instantly campaign for each audience/persona, sequence version, custom-field mapping and permitted enrollment operation.'},
  {id:'source-score-approval',status:'pending' as const,detail:'Confirm the documented working source, geographic and scoring rules; evidence completeness does not prove travel intent.'},
  {id:'budget-policy',status:'pending' as const,detail:input.budgetCredits===undefined?'Set an approved provider-specific credit/spend ceiling and authoritative cost units before paid activity.':'Validate the requested ceiling against approved provider-specific cost units, remaining balances and authoritative costs before paid activity.'},
  {id:'temporary-document-policy',status:'pending' as const,detail:'Bind the authorised private Brain document location, access controls and expiry/deletion policy for transient research material.'},
  ...(input.audience==='historical'?[{id:'historical-cohort',status:'pending' as const,detail:'Example Representative supplies or attests an eligible historical cohort and relationship reference; it is not replaced by a new-ICP prospect search.'}]:[]),
  ...(selectedPersona?.percent===0?[{id:'parked-persona',status:'pending' as const,detail:'This persona has zero allocation in the documented month-one mix and needs an explicit approved strategy change before execution.'}]:[]),
 ];
 const phases=[
  {id:'account-discovery',title:input.audience==='historical'?'Receive the client-controlled historical cohort':'Discover companies for the selected ICPs',detail:input.audience==='historical'?'Use the authorised eligible cohort without assuming broad CRM history access.':'Research current professional sources and approved company APIs; start with company evidence, not bulk person extraction.'},
  {id:'provisional-qualification',title:'Qualify accounts provisionally',detail:'Check company fit, source freshness, dated signals and exclusions before looking up people. Unknown aviation maturity remains unknown.'},
  {id:'people-lookup',title:'Find the appropriate professional contacts',detail:'Use approved direct contact sources only for qualifying accounts; coordinate principal, assistant and manager routes to avoid account overlap.'},
  ...(providers.includes('clay')?[{id:'tier1-enrichment',title:'Optional Tier 1 enrichment through Clay',detail:'Use only for this Tier 1 batch under an approved binding and ceiling; never as the default standard-tier waterfall.'}]:[]),
  {id:'independent-verification',title:'Verify contacts independently',detail:'Require fresh authorised verification; risky, catch-all, unverifiable or stale contacts are held, not counted as qualified.'},
  {id:'final-qualification',title:'Complete scores and eligibility checks',detail:'Attach source-backed score reasons, remove duplicates, and recheck client eligibility, opt-outs, protected relationships and active conversations.'},
  {id:'campaign-enrollment',title:'Prepare the correct Instantly campaign enrollment',detail:'Selected verified eligible contacts belong in their mapped Instantly campaign. Validate copy, fields and operation permissions; no separate prospect CRM is created and enrollment does not activate sending.'},
  {id:'outcome-report',title:'Report the actual result and any shortfall',detail:'Report accepted, held and rejected counts, reasons and actual provider costs when available. Do not pad the target, substitute a different ICP or silently increase the ceiling.'},
 ].map(phase=>({...phase,status:'prepared' as const,executionStatus:'blocked' as const}));
 const normalized={targetQualifiedContacts:input.targetQualifiedContacts,audience:input.audience,tier:input.tier,
  personaId:input.personaId??null,campaignId:input.campaignId??null,budgetCredits:input.budgetCredits??null,providers};
 return {
  id:'research-plan-'+createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0,24),
  version:'insijets-research-plan-v1',status:'prepared' as const,executionStatus:'blocked' as const,
  target:{count:input.targetQualifiedContacts,unit:'qualified-verified-contacts' as const,meaning:'Qualified verified contacts ready for the correct campaign, not emails, sends or a promised yield.'},
  audience:input.audience,tier:input.tier,proposedCampaignId:input.campaignId??null,
  priority:'historical-first' as const,audiencePolicy:'Keep historical relationship work separate from new-ICP sourcing; do not silently switch cohorts.',
  icp:{status:'documented-working-mix-pending-confirmation',selection:input.audience==='historical'?'client-controlled-historical-cohort':selectedPersona?'explicit-persona':'saved-working-mix',allocations,sourceReference:OUTREACH_SOURCING_SPEC.sourceReference},
  geography:{status:'working-policy-pending-confirmation',region:'Europe',europePercent:100,middleEastPercent:0},
  sourcePolicy:{owner:'AI Brain',proposedProviders:providers,directSources:providers.filter(provider=>provider!=='clay'),clayAllowed:input.tier==='tier1',clayRequested:providers.includes('clay'),clayRequirement:'optional-tier1-only',providerConfigurationVerified:false,independentVerificationBinding:'pending',researchRules:OUTREACH_SOURCING_SPEC.sourceLadder},
  budget:{requestedCreditCeiling:input.budgetCredits??null,approvedCreditCeiling:null,estimatedCredits:null,estimatedPrice:null,unitsVerified:false,reason:'Provider costs and credit units are not bound; no numeric price is fabricated. Stop before any request that cannot fit its authorised ceiling.'},
  ownership:{durableCustomerRecords:'client-crm',selectedContacts:'mapped-instantly-campaign',workingMaterial:'temporary-private-brain-documents',separateProspectDatabase:false,temporaryDocumentPolicyVerified:false},
  phases,requiredBindings:requirements,
  outcomePolicy:{reportShortfalls:true,padQuota:false,changeIcpSilently:false,raiseBudgetSilently:false,reuseAuthorisedExistingRecordsFirst:true},
  liveReady:false,providerDispatch:false,paidLookupsApproved:false,crmHistoricalRead:false,crmWrite:false,
  leadExtraction:false,campaignEnrollment:false,campaignActivated:false,emailSent:false,schedulerInstalled:false,
 };
}
export type ResearchPlan=ReturnType<typeof prepareResearchPlan>;
