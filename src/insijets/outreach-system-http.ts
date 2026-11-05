import { deploymentIdentity } from "@/deployment/identities";
import {OperatorError,assertOperatorAccess,type OperatorActor} from './operator-runtime.ts';
import type {OperatorHttpDependencies} from './operator-http.ts';
import {OutreachSystemStore} from './outreach-system-store.ts';
import {OUTREACH_READINESS} from './outreach-campaigns.ts';
import {outreachProviderConnections} from './outreach-provider-connection-status.ts';
import {OUTREACH_SOURCING_SPEC} from './outreach-sourcing-spec.ts';
const response=(status:number,data:unknown)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
export function outreachSystemOverview(store:OutreachSystemStore){return {providerConnections:outreachProviderConnections(),readiness:OUTREACH_READINESS,sourcing:OUTREACH_SOURCING_SPEC,campaigns:store.campaigns(),finalCampaigns:store.finalCampaigns(),month:store.monthPlan(),tier1:store.tier1Snapshot()};}
export async function handleOutreachSystemRequest(request:Request,deps:OperatorHttpDependencies){
 let store:OutreachSystemStore|undefined;
 try{
  if(!['GET','POST'].includes(request.method))return response(405,{error:'METHOD_DENIED'});
  const session=await deps.session();if(!session)return response(401,{error:'AUTH_REQUIRED'});
  if(session.provider!=='local'||session.tenant.id!=='insijets-demo'||!Number.isFinite(Date.parse(session.expiresAt))||Date.parse(session.expiresAt)<=(deps.now??Date.now)()||![deploymentIdentity("operator"),deploymentIdentity("cmsOwner")].includes(session.user.email.toLowerCase())||!await deps.admin(session))return response(403,{error:'OUTREACH_ACCESS_DENIED'});
  if(request.method==='POST'&&!await deps.sameOrigin(request))return response(403,{error:'ORIGIN_DENIED'});
  const url=new URL(request.url);if(url.search)return response(400,{error:'INPUT_DENIED'});
  const configuration=await deps.configuration();
  const actor:OperatorActor={actorId:session.user.id,installationId:session.tenant.id,email:session.user.email,provider:'local',canManageWorkspace:true};
  assertOperatorAccess(configuration,actor);
  if(request.method==='GET'){store=new OutreachSystemStore(configuration,actor,deps.now);return response(200,outreachSystemOverview(store));}
  if(!request.headers.get('content-type')?.startsWith('application/json'))return response(415,{error:'JSON_REQUIRED'});
  const reader=request.body?.getReader();if(!reader)return response(400,{error:'INPUT_DENIED'});
  const parts:Uint8Array[]=[];let length=0;
  while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>32768){await reader.cancel();return response(413,{error:'INPUT_TOO_LARGE'});}parts.push(part.value);}
  const input:unknown=JSON.parse(Buffer.concat(parts).toString('utf8'));
  if(!input||typeof input!=='object'||Array.isArray(input))return response(400,{error:'INPUT_DENIED'});
  const p=input as Record<string,unknown>;
  if(typeof p.action!=='string'||!['month-plan','save-campaign','save-final-campaign','reset-final-campaign','tier1-stage','tier1-prepare','tier1-status'].includes(p.action)||Object.keys(p).some(k=>!['action','input'].includes(k)))return response(400,{error:'ACTION_DENIED'});
  store=new OutreachSystemStore(configuration,actor,deps.now);
  let result:unknown;
  if(p.action==='month-plan')result=store.monthPlan(p.input as Parameters<OutreachSystemStore['monthPlan']>[0]);
  else if(p.action==='save-campaign')result=store.saveCampaign(p.input);
  else if(p.action==='save-final-campaign'||p.action==='reset-final-campaign')result=store.saveFinalCampaign(p.input,p.action==='reset-final-campaign');
  else if(p.action==='tier1-stage')result=store.stageTier1Candidate(p.input as Parameters<OutreachSystemStore['stageTier1Candidate']>[0]);
  else if(p.action==='tier1-prepare')result=store.prepareTier1Digest(p.input as Parameters<OutreachSystemStore['prepareTier1Digest']>[0]);
  else result=store.updateTier1Status(p.input as Parameters<OutreachSystemStore['updateTier1Status']>[0]);
  return response(200,{result,externalDispatch:false,emailSent:false,crmWritten:false,linkedinAction:false});
 }catch(error){
  if(error instanceof OperatorError)return response(error.status,{error:error.code});
  if(error instanceof SyntaxError)return response(400,{error:'INPUT_DENIED'});
  return response(409,{error:'OUTREACH_REVIEW_REQUIRED'});
 }finally{store?.close();}
}
