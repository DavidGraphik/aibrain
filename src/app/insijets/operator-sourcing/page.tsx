import {notFound} from "next/navigation";
import {getSession} from "@/auth/session";
import {loadInstallationConfig} from "@/config/installation";
import {canAccessInsiJetsCMS} from "@/insijets/cms-access";
import {OperatorSourcingStore} from "@/insijets/operator-sourcing-store";
import {shortlistAircraft,prepareAvailabilityDrafts} from "@/insijets/availability-planner.mjs";
export const dynamic="force-dynamic";
export const runtime="nodejs";
export default async function OperatorSourcingPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const session=await getSession();if(!session)notFound();
 const configuration=await loadInstallationConfig();
 if(!canAccessInsiJetsCMS(session,configuration.installationId))notFound();
 const params=await searchParams,val=(key:string)=>typeof params[key]==="string"?params[key] as string:"";
 let summary:ReturnType<OperatorSourcingStore['summary']>|null=null,result:ReturnType<OperatorSourcingStore['browse']>|null=null,operators:ReturnType<OperatorSourcingStore['browseOperators']>|null=null,plan:ReturnType<typeof prepareAvailabilityDrafts>|null=null,error="";
 if(process.env.AIBRAIN_INSIJETS_MULTISOURCE_V2_ENABLED!=="true")error="The combined directory is awaiting activation for this installation.";
 else{
  let store:OperatorSourcingStore|undefined;
  try{
   store=new OperatorSourcingStore(configuration.paths.dataRoot);summary=store.summary();
   if(val('view')==='operators')operators=store.browseOperators(val('query'));
   else result=store.browse({query:val('query'),airport:val('airport')||undefined,minSeats:val('minSeats')?Number(val('minSeats')):undefined});
   if(val('origin')&&val('destination')&&val('passengers')){
    const request={originAirport:val('origin').toUpperCase(),destinationAirport:val('destination').toUpperCase(),passengers:Number(val('passengers')),sender:null,departureISO:null,timeZone:null};
    const shortlist=shortlistAircraft(store.planningDataset(),request,{limit:30});plan=prepareAvailabilityDrafts(shortlist,request);
   }
  }catch(e){error=e instanceof Error?e.message:'The directory could not be loaded.';}finally{store?.close();}
 }
 return <main className="mx-auto max-w-7xl space-y-8 p-6"><header><p className="text-sm text-slate-500">InsiJets · operator sourcing</p><h1 className="text-3xl font-semibold">Find operators and prepare an availability request</h1><p className="mt-3 text-slate-600">Published directory information. Aircraft availability and prices require the operator&apos;s reply.</p></header>
 {error&&<p role="alert" className="rounded-lg bg-amber-50 p-4 text-amber-900">{error}</p>}
 {summary&&<p>{String(summary.sourceOperatorEntities)} source operator records · {String(summary.aircraftObservations)} aircraft observations · {String(summary.uniqueEmails)} published email addresses. Cross-source identity matches await review.</p>}
 <section className="rounded-xl border p-5"><h2 className="text-xl font-semibold">Search the combined directory</h2><form method="get" className="mt-4 flex flex-wrap items-end gap-4"><label>Show<select className="block rounded border p-2" name="view" defaultValue={val('view')||'aircraft'}><option value="aircraft">Aircraft observations</option><option value="operators">Operators from all sources</option></select></label><label>Operator, model or registration<input className="block rounded border p-2" name="query" maxLength={200} defaultValue={val('query')}/></label><label>Base airport<input className="block w-28 rounded border p-2" name="airport" maxLength={4} defaultValue={val('airport')}/></label><label>Minimum seats<input className="block w-28 rounded border p-2" name="minSeats" type="number" min={1} max={500} defaultValue={val('minSeats')}/></label><button className="rounded bg-slate-900 px-4 py-2 text-white" type="submit">Search</button></form></section>
 {(result||operators)&&<section><h2 className="text-xl font-semibold">{String((operators||result)!.total)} matching source records</h2><p className="text-sm text-slate-500">Showing up to 30 records. Refine the search to narrow the list.</p><div className="overflow-x-auto"><table className="mt-4 w-full text-left"><thead><tr>{['Operator','Source','Aircraft / location','Seats','Reference'].map(x=><th key={x} className="border-b p-3">{x}</th>)}</tr></thead><tbody>{(operators||result)!.rows.map(row=><tr key={String(row.id)}><td className="border-b p-3">{String(row.operator||row.name)}</td><td className="border-b p-3">{String(row.source)}</td><td className="border-b p-3">{String(row.model||row.city||'')} {String(row.airport||'')} {String(row.country||'')}</td><td className="border-b p-3">{row.seats==null?'Unknown':String(row.seats)}</td><td className="border-b p-3"><a className="underline" href={String(row.source_url)} target="_blank" rel="noopener noreferrer">View source</a></td></tr>)}</tbody></table></div></section>}
 <section className="rounded-xl border p-5"><h2 className="text-xl font-semibold">Prepare a shortlist</h2><p className="mt-2 text-slate-600">Confirm exact airport codes and passenger count. Example: LFPB to LSGG. This candidate prepares local drafts; Outlook is not connected and sending is disabled.</p><form method="get" className="mt-4 flex flex-wrap items-end gap-4"><label>Departure airport<input className="block rounded border p-2" name="origin" required pattern="[A-Za-z0-9]{3,4}" defaultValue={val('origin')}/></label><label>Arrival airport<input className="block rounded border p-2" name="destination" required pattern="[A-Za-z0-9]{3,4}" defaultValue={val('destination')}/></label><label>Passengers<input className="block rounded border p-2" name="passengers" required type="number" min={1} max={500} defaultValue={val('passengers')}/></label><button className="rounded bg-slate-900 px-4 py-2 text-white" type="submit">Prepare local drafts</button></form></section>
 {plan&&<section><h2 className="text-xl font-semibold">{plan.drafts.length} local drafts · none sent</h2><p className="mt-2 text-amber-900">Sending account, departure date/time and time zone are required. Exact emails must be reviewed and explicitly approved before any send.</p><div className="mt-4 space-y-3">{plan.drafts.map(draft=><details key={draft.to[0]} className="rounded border p-4"><summary className="cursor-pointer">{draft.to[0]} · {draft.subject}</summary><pre className="mt-4 whitespace-pre-wrap font-sans text-sm">{draft.body}</pre></details>)}</div></section>}
 </main>;
}
