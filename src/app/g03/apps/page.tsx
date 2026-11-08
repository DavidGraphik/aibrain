import { redirect } from 'next/navigation';
import { getSession } from '@/auth/session';
import { productContext } from '@/g03-products/access';
import { AppsWorkspace } from '@/g03-products/apps-workspace';
export const dynamic = 'force-dynamic';
export default async function AppPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const session=await getSession();if(!session)redirect('/login');await productContext(session);const q=await searchParams;
  return <div style={{height:'100dvh'}}><AppsWorkspace actor={session.user.id} initialId={typeof q.id==='string'?q.id:undefined} initialPublished={q.published==='1'}/></div>;
}
