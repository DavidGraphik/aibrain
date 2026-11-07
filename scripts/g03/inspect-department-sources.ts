/** Operator read-only inspection; results stay in private evidence, never versioned. */
import { loadInstallationConfig } from '../../src/config/installation';
import { browseServerForSession, previewServerForSession } from '../../src/documents/server-browser-service';
import type { AuthSession } from '../../src/auth/types';
async function main(){
 const c=await loadInstallationConfig();if(c.installationId!=='g03-production'||c.publicUrl!=='https://g03.graphikai.com')throw Error('G03 only');
 const session:AuthSession={provider:'local',user:{id:'d720e7a3-0fc7-4606-971b-28ca28eab464',email:'quality@example.invalid',name:'Rafael Zamora'},tenant:{id:c.installationId,name:c.companyName},expiresAt:new Date(Date.now()+600000).toISOString()};
 let project='3aba4474-2322-4c6a-bef6-3366c0b9b4a0';
 if(process.argv[4]==='jordi'){session.user={id:'0b94f177-baf6-4eb1-898e-be8fe8184032',email:'production@example.invalid',name:'Jordi'};project='2faf1644-c380-4acd-b983-a4042d0f04da';}
 const result=process.argv[2]==='read'?await previewServerForSession(session,project,process.argv[3]):await browseServerForSession(session,project,process.argv[3]||'home');
 console.log(JSON.stringify(result,null,2));
}void main().catch(e=>{console.error(e.message);process.exitCode=1});
