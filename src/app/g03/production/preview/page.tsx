import { redirect } from 'next/navigation';
import { getSession } from '@/auth/session';
import { productContext } from '@/g03-products/access';
import { readApp } from '@/g03-products/apps';
import { requireProduct } from '@/g03-products/contracts';
import { ProductionWorkspace } from '@/g03-products/production-workspace';
export const dynamic='force-dynamic';
export default async function Preview({searchParams}:{searchParams:Promise<{id?:string}>}){
  const session=await getSession();if(!session)redirect('/login');const ctx=await productContext(session);requireProduct(ctx.appDesigner===true,'No tens permís de disseny.',403);
  const app=await readApp(ctx,(await searchParams).id);
  return <main><h1>Prova aïllada · {app.title}</h1><p>Dades sintètiques persistents. No modifica el full de Producció ni envia moviments a SAGE.</p><ProductionWorkspace endpoint={`/api/g03/production/preview?id=${app.id}`} previewAppId={app.id}/></main>;
}
