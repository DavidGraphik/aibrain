import 'server-only';
import {loadInstallationConfig} from '@/config/installation';
import type {OperatorConfiguration} from './operator-runtime';
function strings(name:string){
 const raw=process.env[name];if(!raw)return [];
 const parsed:unknown=JSON.parse(raw);if(!Array.isArray(parsed)||parsed.length>200||parsed.some(v=>typeof v!=='string'||!v||v.length>200))throw Error('Operator scope unavailable');return parsed as string[];
}
export async function loadOperatorConfiguration():Promise<OperatorConfiguration>{
 const installation=await loadInstallationConfig();
 const origins=strings('AIBRAIN_INSIJETS_APPROVED_RESEARCH_ORIGINS');
 for(const origin of origins){const u=new URL(origin);if(u.protocol!=='https:'||u.origin!==origin||/(^|\.)(hubapi\.com|hubspot\.com|freshsales\.io|freshworks\.com|myfreshworks\.com|salesforce\.com)$/u.test(u.hostname))throw Error('Operator research scope denied');}
 return{enabled:process.env.AIBRAIN_INSIJETS_OPERATOR_ENABLED==='true',installationId:installation.installationId,storageRoot:installation.paths.dataRoot,approvedResearchOrigins:origins,approvedVerificationProviders:strings('AIBRAIN_INSIJETS_APPROVED_VERIFICATION_PROVIDERS')};
}
