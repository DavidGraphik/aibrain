import { productRoute,boundedBody } from '@/g03-products/http';
import { appBridge } from '@/g03-products/app-bridge';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(request:Request){return productRoute(request,async ctx=>appBridge(ctx,await boundedBody(request)));}
