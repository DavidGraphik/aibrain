import { productRoute, boundedBody } from '@/g03-products/http';
import { requireProduct } from '@/g03-products/contracts';
import { readProduction, mutateProduction, summarizeProductionAudit } from '@/g03-products/production';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request:Request) { return productRoute(request, async ctx=>{const data=await readProduction(ctx),name=new URL(request.url).searchParams.get('sourceSheet');if(name!==null){const sheet=data.sheets?.find(s=>s.name===name);requireProduct(sheet,'Full no trobat.',404);return {sheet,capturedAt:data.capturedAt,sourceHash:data.sourceHash};}const {sheets,...operational}=data;return {...operational,audit:summarizeProductionAudit(operational.audit),sourceSheets:sheets?.map(s=>({name:s.name,dimension:s.dimension}))??[]};}); }
export async function POST(request: Request) { return productRoute(request, async ctx => mutateProduction(ctx, await boundedBody(request))); }
