import { redirect } from 'next/navigation';
import { getSession } from '@/auth/session';
import { productContext,grant } from '@/g03-products/access';
import { ProductionWorkspace } from '@/g03-products/production-workspace';
export const dynamic='force-dynamic';
export default async function ProductionPage(){const session=await getSession();if(!session)redirect('/login');grant(await productContext(session),'read');return <div style={{height:'100dvh'}}><ProductionWorkspace/></div>;}
