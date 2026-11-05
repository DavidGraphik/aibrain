import { loadInstallationConfig } from '@/config/installation';
import { productRoute, boundedBody } from '@/g03-products/http';
import { readReceivingWorkspace, receivingTool } from '@/g03-products/receiving-tools';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){return productRoute(request,ctx=>readReceivingWorkspace(ctx));}
export async function POST(request:Request){return productRoute(request,async ctx=>receivingTool(ctx,await boundedBody(request),await loadInstallationConfig()));}
