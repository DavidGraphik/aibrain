import {getSession} from '@/auth/session';
import {isWorkspaceAdmin} from '@/admin/server-service';
import {isSameOriginMutation} from '@/auth/request-security';
import {handleOperatorRequest} from '@/insijets/operator-http';
import {loadOperatorConfiguration} from '@/insijets/operator-server';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const dependencies={session:getSession,admin:isWorkspaceAdmin,sameOrigin:isSameOriginMutation,configuration:loadOperatorConfiguration};
export async function GET(request:Request){return handleOperatorRequest(request,dependencies);}
export async function POST(request:Request){return handleOperatorRequest(request,dependencies);}
