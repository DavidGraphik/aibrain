import "server-only";
import {getSession} from "@/auth/session";
import {loadInstallationConfig} from "@/config/installation";
import {operatorSourcingResponse} from "./operator-sourcing-api";
export async function handleOperatorSourcing(request:Request){
 const session=await getSession();
 if(!session)return Response.json({error:"AUTH_REQUIRED"},{status:401,headers:{"Cache-Control":"private, no-store"}});
 const config=await loadInstallationConfig();
 return operatorSourcingResponse(request,{installationId:config.installationId,origin:new URL(config.publicUrl).origin,dataRoot:config.paths.dataRoot,enabled:process.env.AIBRAIN_INSIJETS_MULTISOURCE_V2_ENABLED==="true"},session);
}
