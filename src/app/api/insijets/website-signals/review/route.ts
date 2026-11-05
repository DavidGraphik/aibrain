import { deploymentIdentity } from "@/deployment/identities";
import {getSession} from '@/auth/session';
import {isWorkspaceAdmin} from '@/admin/server-service';
import {readWebsiteSignalsForReview} from '@/insijets/website-signals';
import {loadWebsiteSignalConfiguration} from '@/insijets/website-signals-server';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(){
 const session=await getSession();if(!session)return Response.json({error:'AUTH_REQUIRED'},{status:401,headers:{'Cache-Control':'no-store'}});
 if(session.tenant.id!=='insijets-demo'||![deploymentIdentity("operator"),deploymentIdentity("cmsOwner")].includes(session.user.email.toLowerCase())||!await isWorkspaceAdmin(session))return Response.json({error:'REVIEW_DENIED'},{status:403,headers:{'Cache-Control':'no-store'}});
 try{return Response.json(readWebsiteSignalsForReview(await loadWebsiteSignalConfiguration(),{installationId:session.tenant.id,email:session.user.email}),{headers:{'Cache-Control':'private, no-store'}});}
 catch{return Response.json({error:'REVIEW_DENIED_OR_UNAVAILABLE'},{status:403,headers:{'Cache-Control':'no-store'}});}
}
