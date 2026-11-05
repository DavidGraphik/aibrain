import type {Metadata} from 'next';
import {notFound,redirect} from 'next/navigation';
import {loadOutreachSystemEntry} from '@/insijets/outreach-system-server';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Outreach System · InsiJets',robots:{index:false,follow:false}};
export default async function OutreachSystemPage(){if(!await loadOutreachSystemEntry())notFound();redirect('/?workspace=outreach');}
