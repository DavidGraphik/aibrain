import {handleWebsiteSignal} from '@/insijets/website-signals';
import {loadWebsiteSignalConfiguration} from '@/insijets/website-signals-server';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function handle(request:Request){
 try{return await handleWebsiteSignal(request,await loadWebsiteSignalConfiguration());}
 catch{return Response.json({error:'NOT_CONFIGURED'},{status:404,headers:{'Cache-Control':'no-store'}});}
}
export async function GET(request:Request){return handle(request);}
export async function POST(request:Request){return handle(request);}
