import { deploymentIdentity } from "@/deployment/identities";
import 'server-only';
import {getSession} from '@/auth/session';
import {isWorkspaceAdmin} from '@/admin/server-service';
import {isSameOriginMutation} from '@/auth/request-security';
import {loadOperatorConfiguration} from './operator-server';
import {handleOutreachSystemRequest,outreachSystemOverview} from './outreach-system-http';
import {OutreachSystemStore} from './outreach-system-store';
export async function loadOutreachSystemConfiguration(){const config=await loadOperatorConfiguration();return {...config,enabled:config.enabled&&process.env.AIBRAIN_INSIJETS_OUTREACH_SYSTEM_ENABLED==='true'};}
export const handleOutreachSystem=(request:Request)=>handleOutreachSystemRequest(request,{session:getSession,admin:isWorkspaceAdmin,sameOrigin:isSameOriginMutation,configuration:loadOutreachSystemConfiguration});
export async function loadOutreachSystemEntry(){
 const session=await getSession();
 if(!session||session.provider!=='local'||session.tenant.id!=='insijets-demo'||!Number.isFinite(Date.parse(session.expiresAt))||Date.parse(session.expiresAt)<=Date.now()||![deploymentIdentity("operator"),deploymentIdentity("cmsOwner")].includes(session.user.email.toLowerCase())||!await isWorkspaceAdmin(session))return null;
 const config=await loadOutreachSystemConfiguration();if(!config.enabled||config.installationId!==session.tenant.id)return null;
 return {session,config};
}
export async function loadOutreachSystemReview(){
 const entry=await loadOutreachSystemEntry();if(!entry)return null;
 const {session,config}=entry;
 const store=new OutreachSystemStore(config,{actorId:session.user.id,installationId:session.tenant.id,email:session.user.email,provider:'local',canManageWorkspace:true});
 try{return outreachSystemOverview(store);}finally{store.close();}
}
