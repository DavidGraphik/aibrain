import {createHash} from 'node:crypto';
import {assertOperatorAccess,type OperatorActor,type OperatorConfiguration} from './operator-runtime.ts';
export type OutreachProvider='apollo'|'prospeo'|'clay';
export type ProviderOperation='connection-proof'|'company-lookup'|'company-people'|'selected-person-enrich'|'tier1-table-submit';
export const OUTREACH_PROVIDER_ENV_NAMES={apolloKey:'AIBRAIN_INSIJETS_APOLLO_API_KEY',prospeoKey:'AIBRAIN_INSIJETS_PROSPEO_API_KEY',clayWebhook:'AIBRAIN_INSIJETS_CLAY_WEBHOOK_URL',clayToken:'AIBRAIN_INSIJETS_CLAY_WEBHOOK_TOKEN',bindingsFile:'AIBRAIN_INSIJETS_OUTREACH_PROVIDER_BINDINGS_FILE',executionEnabled:'AIBRAIN_INSIJETS_OUTREACH_SOURCE_EXECUTION_ENABLED'} as const;
export const OUTREACH_PROVIDER_BLUEPRINTS={
 apollo:{prepared:true,enabledByDefault:false,origin:'https://api.apollo.io',authHeader:'x-api-key',operations:['connection-proof','company-lookup','company-people','selected-person-enrich'],permissionNames:['api/v1/usage_stats/api_usage_stats','api/v1/organizations/enrich','api/v1/mixed_people/api_search','api/v1/people/match'],connectionProof:'POST /api/v1/usage_stats/api_usage_stats; documented zero-credit usage read; not executed',independentVerifierPrepared:false},
 prospeo:{prepared:true,enabledByDefault:false,origin:'https://api.prospeo.io',authHeader:'X-KEY',operations:['connection-proof','company-lookup','selected-person-enrich'],permissionNames:['Client-owned API key; account plan and endpoint eligibility must be confirmed'],connectionProof:'GET /account-information; documented free account read; not executed',independentVerifierPrepared:false},
 clay:{prepared:true,enabledByDefault:false,origin:'https://api.clay.com',authHeader:'Client-copied webhook authentication header; exact contract pending',operations:['tier1-table-submit'],permissionNames:['Client-owned restricted Tier 1 table webhook; table/enrichment/cost/auth/result contract required'],connectionProof:'No non-billable table probe established; do not submit a test row as an account check',independentVerifierPrepared:false},
} as const;
export type ClientProviderBinding={provider:OutreachProvider;installationId:'insijets-demo';clientOwned:boolean;accountRef:string;ownershipApprovalRef:string;credentialRef:string;enabled:boolean;allowedOperations:ProviderOperation[];connectionProofRef?:string;connectionProofAt?:string;clay?:{endpointPathSha256:string;tableRef:string;schemaApprovalRef:string;costCeilingReviewRef:string;maximumCreditsPerSubmission:number;authHeaderName:string;tokenRef:string}};
export type ProviderRequestInput={provider:OutreachProvider;operation:ProviderOperation;companyDomain?:string;firstName?:string;lastName?:string;personId?:string;titles?:string[];limit?:number;accountRef?:string;icp?:string;tier?:'standard'|'tier1'};
export type PreparedProviderOperation={provider:OutreachProvider;operation:ProviderOperation;method:'GET'|'POST';path:string|null;body:Record<string,unknown>|null;companyDomain:string|null;maximumCredits:number;requiresSelectedContactApproval:boolean;clayEndpointContractRequired:boolean;effects:{emailSent:false;crmWrite:false;campaignActivated:false}};
const ref=(x:unknown):x is string=>typeof x==='string'&&/^[-a-zA-Z0-9_:./]{1,120}$/.test(x);
const text=(x:unknown,max=80):x is string=>typeof x==='string'&&x.trim()===x&&x.length>0&&x.length<=max&&!/[\u0000-\u001f\u007f]/.test(x);
const domain=(x:unknown):x is string=>typeof x==='string'&&x.length<=253&&x===x.toLowerCase()&&!x.startsWith('www.')&&!/^\d+(?:\.\d+){3}$/.test(x)&&/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(x)&&!['localhost','local','internal','invalid'].includes(x.split('.').at(-1)!);
const email=(x:unknown):x is string=>typeof x==='string'&&x.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
const record=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
function validBinding(binding:ClientProviderBinding|undefined,provider:OutreachProvider){return !!binding&&binding.provider===provider&&binding.installationId==='insijets-demo'&&binding.clientOwned===true&&ref(binding.accountRef)&&ref(binding.ownershipApprovalRef)&&binding.credentialRef===(provider==='apollo'?OUTREACH_PROVIDER_ENV_NAMES.apolloKey:provider==='prospeo'?OUTREACH_PROVIDER_ENV_NAMES.prospeoKey:OUTREACH_PROVIDER_ENV_NAMES.clayWebhook)&&typeof binding.enabled==='boolean'&&Array.isArray(binding.allowedOperations)&&binding.allowedOperations.length<=5&&binding.allowedOperations.every(op=>(OUTREACH_PROVIDER_BLUEPRINTS[provider].operations as readonly string[]).includes(op));}
export function outreachProviderReadiness(provider:OutreachProvider,binding?:ClientProviderBinding,credentialPresent=false,executionEnabled=false,now=Date.now()){
 if(!Object.hasOwn(OUTREACH_PROVIDER_BLUEPRINTS,provider))throw Error('PROVIDER_DENIED');
 const owned=validBinding(binding,provider),age=now-Date.parse(binding?.connectionProofAt??''),proof=owned&&ref(binding?.connectionProofRef)&&Number.isFinite(age)&&age>=0&&age<=7*86400000;
 const clayContract=provider!=='clay'||!!binding?.clay&&/^[a-f0-9]{64}$/.test(binding.clay.endpointPathSha256)&&ref(binding.clay.tableRef)&&ref(binding.clay.schemaApprovalRef)&&ref(binding.clay.costCeilingReviewRef)&&binding.clay.tokenRef===OUTREACH_PROVIDER_ENV_NAMES.clayToken&&Number.isFinite(binding.clay.maximumCreditsPerSubmission)&&binding.clay.maximumCreditsPerSubmission>0;
 return {provider,adapterPrepared:true,credentialPresent,clientOwnedBindingVerified:!!proof,connectionVerified:credentialPresent&&!!proof,executionPermitted:credentialPresent&&!!proof&&binding?.enabled===true&&executionEnabled===true&&clayContract,clayContractPrepared:provider==='clay'?clayContract:null,independentVerifierConfigured:false,defaultOff:true,leadExtractionPerformed:false,emailSent:false,crmWrite:false};
}
/** Pure allowlisted request preparation; no network, env, secrets or extraction. */
export function prepareOutreachProviderOperation(input:ProviderRequestInput):PreparedProviderOperation{
 if(!input||!record(input)||Object.keys(input).some(k=>!['provider','operation','companyDomain','firstName','lastName','personId','titles','limit','accountRef','icp','tier'].includes(k))||!Object.hasOwn(OUTREACH_PROVIDER_BLUEPRINTS,input.provider)||!(OUTREACH_PROVIDER_BLUEPRINTS[input.provider].operations as readonly string[]).includes(input.operation))throw Error('PROVIDER_OPERATION_DENIED');
 const effects={emailSent:false,crmWrite:false,campaignActivated:false} as const;
 if(input.operation==='connection-proof'){
  if(Object.keys(input).some(k=>!['provider','operation'].includes(k)))throw Error('PROVIDER_PROOF_INPUT_DENIED');
  return {provider:input.provider,operation:input.operation,method:input.provider==='apollo'?'POST':'GET',path:input.provider==='apollo'?'/api/v1/usage_stats/api_usage_stats':'/account-information',body:null,companyDomain:null,maximumCredits:0,requiresSelectedContactApproval:false,clayEndpointContractRequired:false,effects};
 }
 if(!domain(input.companyDomain))throw Error('PROVIDER_KNOWN_COMPANY_DOMAIN_REQUIRED');
 const base={provider:input.provider,operation:input.operation,companyDomain:input.companyDomain,requiresSelectedContactApproval:false,clayEndpointContractRequired:false,effects};
 if(input.operation==='company-lookup'){
  if(Object.keys(input).some(k=>!['provider','operation','companyDomain'].includes(k)))throw Error('PROVIDER_COMPANY_INPUT_DENIED');
  return {...base,method:input.provider==='apollo'?'GET':'POST',path:input.provider==='apollo'?'/api/v1/organizations/enrich':'/enrich-company',body:input.provider==='apollo'?null:{data:{company_website:input.companyDomain}},maximumCredits:1};
 }
 if(input.operation==='company-people'){
  if(Object.keys(input).some(k=>!['provider','operation','companyDomain','titles','limit'].includes(k))||!Array.isArray(input.titles)||input.titles.length<1||input.titles.length>5||input.titles.some(t=>!text(t))||!Number.isSafeInteger(input.limit)||input.limit!<1||input.limit!>25)throw Error('PROVIDER_SCOPED_PEOPLE_INPUT_DENIED');
  return {...base,method:'POST',path:'/api/v1/mixed_people/api_search',body:{q_organization_domains_list:[input.companyDomain],person_titles:input.titles,include_similar_titles:false,page:1,per_page:input.limit},maximumCredits:0};
 }
 if(!text(input.firstName)||!text(input.lastName)||input.personId!==undefined&&!/^[-a-zA-Z0-9]{1,80}$/.test(input.personId))throw Error('PROVIDER_SELECTED_PERSON_REQUIRED');
 if(input.operation==='tier1-table-submit'){
  if(input.tier!=='tier1'||!ref(input.accountRef)||!ref(input.icp)||Object.keys(input).some(k=>!['provider','operation','companyDomain','firstName','lastName','accountRef','icp','tier'].includes(k)))throw Error('PROVIDER_CLAY_TIER1_ONLY');
  return {...base,method:'POST',path:null,body:{schemaVersion:'insijets-tier1-input-v1',accountRef:input.accountRef,companyDomain:input.companyDomain,person:{firstName:input.firstName,lastName:input.lastName},icp:input.icp,tier:'tier1'},maximumCredits:0,requiresSelectedContactApproval:true,clayEndpointContractRequired:true};
 }
 if(Object.keys(input).some(k=>!['provider','operation','companyDomain','firstName','lastName','personId'].includes(k)))throw Error('PROVIDER_SELECTED_PERSON_INPUT_DENIED');
 return {...base,method:'POST',path:input.provider==='apollo'?'/api/v1/people/match':'/enrich-person',body:input.provider==='apollo'?{first_name:input.firstName,last_name:input.lastName,domain:input.companyDomain,...(input.personId?{id:input.personId}:{}),reveal_personal_emails:false,reveal_phone_number:false,run_waterfall_email:false,run_waterfall_phone:false}:{only_verified_email:true,enrich_mobile:false,data:{first_name:input.firstName,last_name:input.lastName,company_website:input.companyDomain,...(input.personId?{person_id:input.personId}:{})}},maximumCredits:input.provider==='apollo'?9:1,requiresSelectedContactApproval:true};
}
export type ProviderApprovalBinding={approvalRef:string;operationId:string;actorId:string;installationId:string;clientAccountRef:string;provider:OutreachProvider;operation:ProviderOperation;requestDigest:string;maximumCredits:number;maximumCalls:1;intent:'connection-check'|'source-execution'};
export type ProviderCallerPorts={verifyApproval:(binding:ProviderApprovalBinding)=>Promise<boolean>;readSecret:(ref:string)=>Promise<string>;fetch:(url:string,init:RequestInit)=>Promise<Response>;ledger:{reserve:(input:{operationId:string;requestDigest:string;provider:OutreachProvider;operation:ProviderOperation;maximumCredits:number;calls:1})=>Promise<'reserved'|'duplicate'|'denied'>;finish:(operationId:string,outcome:'received'|'ambiguous-or-failed')=>Promise<void>}};
export type ProviderAuthorization={operationId:string;approvalRef:string;sourceExecutionApproved:boolean;selectedContactApproved:boolean;paidUsageApproved:boolean;connectionCheckApproved:boolean;executionEnabled:boolean};
async function boundedJSON(response:Response,maximumBytes=262144){
 if(!response.headers.get('content-type')?.toLowerCase().includes('application/json')||Number(response.headers.get('content-length')??0)>maximumBytes||!response.body)throw Error('PROVIDER_RESPONSE_DENIED');
 const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maximumBytes)throw Error('PROVIDER_RESPONSE_TOO_LARGE');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const bytes=Buffer.concat(chunks);try{const value:unknown=JSON.parse(bytes.toString('utf8'));if(!record(value))throw Error();return value;}catch{throw Error('PROVIDER_RESPONSE_SCHEMA_DENIED');}
}
function companyMatches(company:unknown,expected:string){
 if(!record(company))return false;
 const domains=[company.primary_domain,company.domain];try{if(typeof company.website==='string')domains.push(new URL(company.website).hostname.replace(/^www\./,''));}catch{}
 return domains.includes(expected);
}
function selectedCandidate(provider:OutreachProvider,data:Record<string,unknown>,input:ProviderRequestInput,now:number){
 const person=data.person;if(!record(person))return null;
 const company=provider==='apollo'?person.organization:data.company;
 if(!companyMatches(company,input.companyDomain!))throw Error('PROVIDER_COMPANY_MATCH_HOLD');
 if(typeof person.first_name!=='string'||typeof person.last_name!=='string'||person.first_name.toLocaleLowerCase()!==input.firstName!.toLocaleLowerCase()||person.last_name.toLocaleLowerCase()!==input.lastName!.toLocaleLowerCase())throw Error('PROVIDER_PERSON_MATCH_HOLD');
 if(provider==='apollo'&&(data.match_confidence??person.match_confidence)!=='high')throw Error('PROVIDER_MATCH_CONFIDENCE_HOLD');
 const detail=person.email,emailValue=provider==='apollo'?detail:record(detail)?detail.email:null,status=provider==='apollo'?person.email_status:record(detail)?detail.status:null;
 if(record(detail)&&(detail.catch_all===true||detail.catchAll===true)||person.email_is_catchall===true)throw Error('PROVIDER_EMAIL_QUALITY_HOLD');
 if(!email(emailValue)||!['verified','VERIFIED'].includes(String(status))||provider==='prospeo'&&(!record(detail)||detail.revealed!==true)||emailValue.split('@')[1].toLowerCase()!==input.companyDomain||/^(?:info|contact|support|sales|admin|hello|noreply|no-reply)@/i.test(emailValue))throw Error('PROVIDER_EMAIL_QUALITY_HOLD');
 return {email:emailValue.toLowerCase(),firstName:person.first_name,lastName:person.last_name,companyDomain:input.companyDomain,providerFamily:provider,observedAt:new Date(now).toISOString(),independentlyVerified:false,verificationRequired:true};
}
/** Server-only caller port. Off unless client-owned proof and exact authorization are supplied. */
export async function callOutreachProvider(input:ProviderRequestInput,binding:ClientProviderBinding,authorization:ProviderAuthorization,configuration:OperatorConfiguration,actor:OperatorActor,ports:ProviderCallerPorts,now=Date.now()){
 assertOperatorAccess(configuration,actor);const prepared=prepareOutreachProviderOperation(input);
 if(!validBinding(binding,input.provider)||!binding.allowedOperations.includes(input.operation)||!ref(authorization.operationId)||!ref(authorization.approvalRef))throw Error('PROVIDER_CLIENT_BINDING_REQUIRED');
 const proof=input.operation==='connection-proof',readiness=outreachProviderReadiness(input.provider,binding,true,authorization.executionEnabled,now);
 if(proof?authorization.connectionCheckApproved!==true:!readiness.executionPermitted||authorization.sourceExecutionApproved!==true||prepared.requiresSelectedContactApproval&&authorization.selectedContactApproved!==true)throw Error('PROVIDER_EXECUTION_NOT_APPROVED');
 const maximumCredits=input.provider==='clay'?binding.clay!.maximumCreditsPerSubmission:prepared.maximumCredits;
 if(maximumCredits>0&&authorization.paidUsageApproved!==true)throw Error('PROVIDER_PAID_USAGE_NOT_APPROVED');
 const requestDigest=sha(JSON.stringify({prepared,actorId:actor.actorId,installationId:actor.installationId,binding,maximumCredits,intent:proof?'connection-check':'source-execution'}));
 const approvalBinding:ProviderApprovalBinding={approvalRef:authorization.approvalRef,operationId:authorization.operationId,actorId:actor.actorId,installationId:actor.installationId,clientAccountRef:binding.accountRef,provider:input.provider,operation:input.operation,requestDigest,maximumCredits,maximumCalls:1,intent:proof?'connection-check':'source-execution'};
 let approved=false;try{approved=typeof ports.verifyApproval==='function'&&await ports.verifyApproval(approvalBinding)===true;}catch{}
 if(!approved)throw Error('PROVIDER_EXACT_SERVER_APPROVAL_REQUIRED');
 const secret=async(reference:string)=>{try{return await ports.readSecret(reference);}catch{throw Error('PROVIDER_CREDENTIAL_UNAVAILABLE');}};
 const headers:Record<string,string>={'Content-Type':'application/json',accept:'application/json','Cache-Control':'no-cache'};
 let url:string;
 if(input.provider==='clay'){
  const clay=binding.clay!;const endpoint=await secret(binding.credentialRef);let u:URL;try{u=new URL(endpoint);}catch{throw Error('PROVIDER_CLAY_ENDPOINT_DENIED');}
  if(u.origin!=='https://api.clay.com'||u.username||u.password||u.search||u.hash||u.pathname==='/'||u.pathname.includes('%')||u.pathname.includes('..')||sha(u.pathname)!==clay.endpointPathSha256||!(/^(?:Authorization|x-[a-z0-9-]{1,50})$/i.test(clay.authHeaderName))||/^(?:x-forwarded|x-original|x-rewrite|x-http-method|x-proxy)/i.test(clay.authHeaderName))throw Error('PROVIDER_CLAY_ENDPOINT_DENIED');
  const token=await secret(clay.tokenRef);if(!text(token,512))throw Error('PROVIDER_CREDENTIAL_DENIED');headers[clay.authHeaderName]=token;url=u.toString();
 }else{
  const token=await secret(binding.credentialRef);if(!text(token,512)||token.length<16||/\s/.test(token))throw Error('PROVIDER_CREDENTIAL_DENIED');headers[input.provider==='apollo'?'x-api-key':'X-KEY']=token;
  const target=new URL(prepared.path!,OUTREACH_PROVIDER_BLUEPRINTS[input.provider].origin);if(prepared.method==='GET'&&prepared.companyDomain)target.searchParams.set('domain',prepared.companyDomain);url=target.toString();
 }
 let claim:'reserved'|'duplicate'|'denied';try{claim=await ports.ledger.reserve({operationId:authorization.operationId,requestDigest,provider:input.provider,operation:input.operation,maximumCredits,calls:1});}catch{throw Error('PROVIDER_LEDGER_RECONCILIATION_REQUIRED');}
 if(claim!=='reserved')throw Error(claim==='duplicate'?'PROVIDER_DUPLICATE_RECONCILIATION_REQUIRED':'PROVIDER_AGGREGATE_BUDGET_DENIED');
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('PROVIDER_TIMEOUT_HOLD'));},8000);});
  const data=await Promise.race([(async()=>{const response=await ports.fetch(url,{method:prepared.method,headers,body:prepared.body?JSON.stringify(prepared.body):undefined,redirect:'error',signal:controller.signal,cache:'no-store'});if(response.status<200||response.status>=300||response.redirected)throw Error('PROVIDER_HTTP_STATUS_HOLD');return boundedJSON(response);})(),deadline]);
  if(input.provider==='prospeo'&&data.error!==false)throw Error('PROVIDER_RESPONSE_STATUS_HOLD');
  let result:Record<string,unknown>;
  if(proof){if(input.provider==='apollo'&&!Object.values(data).some(value=>record(value)&&['day','hour','minute'].some(window=>{const bucket=value[window];return record(bucket)&&Number.isFinite(bucket.limit)&&Number.isFinite(bucket.consumed);})))throw Error('PROVIDER_RESPONSE_SCHEMA_DENIED');if(input.provider==='prospeo'&&(!record(data.response)||!Number.isFinite(data.response.remaining_credits)))throw Error('PROVIDER_RESPONSE_SCHEMA_DENIED');result={kind:'connection-proof',credentialAccepted:true,ownershipVerifiedByResponse:false};}
  else if(input.operation==='company-lookup'){
   const company=input.provider==='apollo'?data.organization:data.company;if(!companyMatches(company,input.companyDomain!))throw Error('PROVIDER_COMPANY_MATCH_HOLD');
   if(!record(company)||!text(company.name,200))throw Error('PROVIDER_RESPONSE_SCHEMA_DENIED');result={kind:'company-match',companyDomain:input.companyDomain,name:company.name,providerFamily:input.provider,requiresEvidenceQualification:true};
  }else if(input.operation==='company-people'){
   if(!Array.isArray(data.people)||data.people.length>input.limit!||data.people.some(p=>!record(p)||!/^[-a-zA-Z0-9]{1,80}$/.test(String(p.person_id??p.id))))throw Error('PROVIDER_RESPONSE_SCHEMA_DENIED');
   result={kind:'scoped-person-references',people:data.people.map(p=>({personId:p.person_id??p.id,title:typeof p.title==='string'?p.title.slice(0,200):null})),companyDomain:input.companyDomain,selectionAndCurrentRoleReviewRequired:true};
  }else if(input.provider==='clay'){result={kind:'table-submission-accepted',resultPending:true,contactsReturned:0,tableResultSchemaAndVerificationPending:true};}
  else result={kind:'enriched-candidate',candidate:selectedCandidate(input.provider,data,input,now)};
  await ports.ledger.finish(authorization.operationId,'received');return {provider:input.provider,operation:input.operation,result,reservedMaximumCredits:maximumCredits,actualCredits:'provider-ledger-reconciliation-required',emailSent:false,crmWrite:false,campaignActivated:false};
 }catch{await ports.ledger.finish(authorization.operationId,'ambiguous-or-failed').catch(()=>{});throw Error('PROVIDER_ATTEMPT_HELD_RECONCILIATION_REQUIRED');}finally{if(timer)clearTimeout(timer);}
}
/** A provider's own enrichment flag cannot authorize its own verification pass. */
export function normalizeOutreachProviderFamily(value:string){return value.toLowerCase().replace(/^(apollo|prospeo|clay)(?:[-_:\/].*)$/,'$1');}
export function requireIndependentOutreachVerification(candidate:{email:string;providerFamily:string},verification:{email:string;providerFamily:string;status:string;checkedAt:string;catchAll:boolean},now=Date.now()){
 const age=now-Date.parse(verification.checkedAt);
 if(!email(candidate.email)||!email(verification.email)||!ref(candidate.providerFamily)||verification.email.toLowerCase()!==candidate.email.toLowerCase()||!ref(verification.providerFamily)||normalizeOutreachProviderFamily(verification.providerFamily)===normalizeOutreachProviderFamily(candidate.providerFamily)||verification.status!=='valid'||verification.catchAll!==false||!Number.isFinite(age)||age<0||age>7*86400000)throw Error('INDEPENDENT_VERIFICATION_REQUIRED');
 return {status:'valid' as const,provider:verification.providerFamily,checkedAt:verification.checkedAt,independent:true};
}
