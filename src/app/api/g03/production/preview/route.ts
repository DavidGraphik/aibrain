import { productRoute,boundedBody } from '@/g03-products/http';
import { appPreviewContext } from '@/g03-products/app-preview';
import { readProduction,mutateProduction } from '@/g03-products/production';
import { requireProduct } from '@/g03-products/contracts';
import type { AuthSession } from '@/auth/types';
export const runtime='nodejs';export const dynamic='force-dynamic';
function previewTarget(request:Request,session:AuthSession) {
  const id=new URL(request.url).searchParams.get('id')??'',restricted=session.support?.preview;
  if(restricted)requireProduct(id===restricted.appId,'Espai de prova no autoritzat.',403);
  return {id,workspaceId:restricted?.threadId??id};
}
export async function GET(request:Request){return productRoute(request,async(ctx,session)=>{const p=previewTarget(request,session);return readProduction(await appPreviewContext(ctx,p.id,p.workspaceId));});}
export async function POST(request:Request){return productRoute(request,async(ctx,session)=>{const p=previewTarget(request,session);return mutateProduction(await appPreviewContext(ctx,p.id,p.workspaceId),await boundedBody(request));});}
