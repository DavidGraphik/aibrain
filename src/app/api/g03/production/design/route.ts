import { productRoute,boundedBody } from '@/g03-products/http';
import { readProductionDesign,mutateProductionDesign } from '@/g03-products/production-design';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request){return productRoute(request,ctx=>readProductionDesign(ctx));}
export async function POST(request:Request){return productRoute(request,async ctx=>mutateProductionDesign(ctx,await boundedBody(request)));}
