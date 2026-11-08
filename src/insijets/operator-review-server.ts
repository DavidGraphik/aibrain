import { deploymentIdentity } from "@/deployment/identities";
import 'server-only';
import {getSession} from '@/auth/session';
import {isWorkspaceAdmin} from '@/admin/server-service';
import {loadOperatorConfiguration} from './operator-server';
import {OutreachOperatorStore,type OperatorActor} from './operator-runtime';
export async function loadOperatorReview(){
 const session=await getSession();
 if(!session||session.provider!=='local'||session.tenant.id!=='insijets-demo'||!Number.isFinite(Date.parse(session.expiresAt))||Date.parse(session.expiresAt)<=Date.now()||![deploymentIdentity("operator"),deploymentIdentity("cmsOwner")].includes(session.user.email.toLowerCase())||!await isWorkspaceAdmin(session))return null;
 const configuration=await loadOperatorConfiguration();if(!configuration.enabled||configuration.installationId!==session.tenant.id)return null;
 const actor:OperatorActor={actorId:session.user.id,installationId:session.tenant.id,email:session.user.email,provider:'local',canManageWorkspace:true};
 const store=new OutreachOperatorStore(configuration,actor);
 try{return{drafts:store.snapshot('drafts'),metrics:store.snapshot('metrics'),content:store.snapshot('content'),replies:store.snapshot('replies'),queue:store.snapshot('call-queue')};}finally{store.close();}
}
