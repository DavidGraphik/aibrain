import { deploymentIdentity } from "@/deployment/identities";
import {OperatorError,OPERATOR_CATALOG,OutreachOperatorStore,type OperatorActor,type OperatorConfiguration} from './operator-runtime.ts';
import type {AuthSession} from '../auth/types';
type Session=AuthSession;
export type OperatorHttpDependencies={session:()=>Promise<Session|null>;admin:(session:Session)=>Promise<boolean>;sameOrigin:(request:Request)=>Promise<boolean>;configuration:()=>Promise<OperatorConfiguration>;now?:()=>number};
const reply=(status:number,data:unknown)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
export async function handleOperatorRequest(request:Request,deps:OperatorHttpDependencies){
 let store:OutreachOperatorStore|undefined;
 try{
  if(!['GET','POST'].includes(request.method))return reply(405,{error:'OPERATOR_METHOD_DENIED'});
  const session=await deps.session();
  if(!session)return reply(401,{error:'AUTH_REQUIRED'});
  if(!Number.isFinite(Date.parse(session.expiresAt))||Date.parse(session.expiresAt)<=(deps.now??Date.now)()||session.provider!=='local'||session.tenant.id!=='insijets-demo'||![deploymentIdentity("operator"),deploymentIdentity("cmsOwner")].includes(session.user.email.toLowerCase()))return reply(403,{error:'OPERATOR_ACCESS_DENIED'});
  if(!await deps.admin(session))return reply(403,{error:'OPERATOR_ACCESS_DENIED'});
  if(request.method==='POST'&&!await deps.sameOrigin(request))return reply(403,{error:'ORIGIN_DENIED'});
  const url=new URL(request.url);
  if(request.method==='POST'&&url.search)return reply(400,{error:'OPERATOR_INPUT_DENIED'});
  const config=await deps.configuration();
  if(!config.enabled||config.installationId!==session.tenant.id)return reply(404,{error:'OPERATOR_NOT_CONFIGURED'});
  const actor:OperatorActor={actorId:session.user.id,installationId:session.tenant.id,email:session.user.email,provider:'local',canManageWorkspace:true};
  if(request.method==='GET'){
   if([...url.searchParams.keys()].some(k=>!['view','limit'].includes(k))||url.searchParams.getAll('view').length>1||url.searchParams.getAll('limit').length>1)return reply(400,{error:'OPERATOR_INPUT_DENIED'});
   const view=url.searchParams.get('view');
   if(!view){if(url.searchParams.has('limit'))return reply(400,{error:'OPERATOR_INPUT_DENIED'});return reply(200,{catalog:OPERATOR_CATALOG,installationId:config.installationId});}
   const raw=url.searchParams.get('limit')??'50';if(!/^[1-9]\d{0,2}$/u.test(raw)||Number(raw)>100||!OPERATOR_CATALOG.views.includes(view))return reply(400,{error:'OPERATOR_INPUT_DENIED'});
   store=new OutreachOperatorStore(config,actor,deps.now);return reply(200,store.snapshot(view,Number(raw)));
  }
  if(!request.headers.get('content-type')?.startsWith('application/json'))return reply(415,{error:'JSON_REQUIRED'});
  const reader=request.body?.getReader();if(!reader)return reply(400,{error:'OPERATOR_INPUT_DENIED'});
  const parts:Uint8Array[]=[];let length=0;
  while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>16384){await reader.cancel();return reply(413,{error:'OPERATOR_INPUT_TOO_LARGE'});}parts.push(part.value);}
  const input:unknown=JSON.parse(Buffer.concat(parts).toString('utf8'));
  if(!input||typeof input!=='object'||Array.isArray(input)||!('action' in input)||typeof input.action!=='string'||!OPERATOR_CATALOG.actions.includes(input.action))return reply(400,{error:'OPERATOR_INPUT_DENIED'});
  store=new OutreachOperatorStore(config,actor,deps.now);return reply(200,store.execute(input));
 }catch(error){
  if(error instanceof OperatorError)return reply(error.status,{error:error.code});
  if(error instanceof SyntaxError)return reply(400,{error:'OPERATOR_INPUT_DENIED'});
  // Never serialize input, provider details, SQLite errors or personal data.
  return reply(409,{error:'OPERATOR_REVIEW_OR_RECONCILIATION_REQUIRED'});
 }finally{store?.close();}
}
