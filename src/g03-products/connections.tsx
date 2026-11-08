'use client';
import { useEffect, useState } from 'react';
import type { ConnectorMention } from '@/connectors/mentions-contract';
import { serverDirectoryQuery } from '@/documents/server-reference-contract';
export function G03Connections({projectId}:{projectId:string|null}) {
  const [internal,setInternal]=useState<ConnectorMention[]>([]);
  const [internalError,setInternalError]=useState('');
  useEffect(()=>{let active=true;void fetch('/api/connectors/mentions',{cache:'no-store'}).then(async response=>{if(!response.ok)throw Error();return response.json();}).then(data=>{if(active)setInternal(data.mentions.filter((m:ConnectorMention)=>m.id==='g03-production'||m.id.startsWith('g03-app-')));}).catch(()=>{if(active)setInternalError('No s’han pogut comprovar les aplicacions internes. Torna a obrir Connexions.');});return()=>{active=false;};},[]);
  const [status,setStatus]=useState('Comprova la connexió per consultar l’estat actual.'),[busy,setBusy]=useState(false);
  async function check() {
    if(!projectId)return; setBusy(true);
    try {
      const read=async(query:string)=>{const r=await fetch(`/api/server-files?${new URLSearchParams({projectId:projectId!,query})}`,{cache:'no-store'});const b=await r.json();if(!r.ok||!b.available)throw Error(r.status===403?'No tens accés a aquesta ubicació amb els permisos d’aquest projecte.':'No s’ha pogut confirmar una lectura del servidor. Comprova que l’equip Windows i el connector estan en marxa; això no indica que la carpeta estigui buida.');return b;};
      const home=await read('home');const root=home.results?.find((r:{kind:string;path:string})=>r.kind==='directory');
      if(!root)throw Error('No hi ha carpetes autoritzades en aquest projecte.');
      const live=await read(serverDirectoryQuery(root.path));
      if(live.sourceChecked!==true)throw Error('No s’ha pogut verificar una lectura actual del servidor.');
      setStatus(`Connectat · lectura verificada ${new Date(live.checkedAt||Date.now()).toLocaleString('ca-ES')} · ${live.results?.length??0} elements accessibles en aquesta ubicació.`);
    }catch(e){setStatus(e instanceof Error?e.message:'No disponible.');}finally{setBusy(false);}
  }
  return <section className="mb-6 space-y-3" aria-label="Connexions de G03"><h3 className="font-semibold">Connexions de G03</h3>
    <article className="rounded-xl border border-[var(--border)] p-4"><h4 className="font-semibold">Servidor documental</h4><p className="my-2 text-sm" role="status">{status}</p><p className="text-sm">Consulta les carpetes autoritzades des de «Servidor» al xat. Els originals es conserven.</p><button className="mt-3 rounded-lg border px-3 py-2" disabled={busy||!projectId} onClick={()=>void check()}>{busy?'Comprovant…':'Comprovar ara'}</button>{!projectId&&<p>Selecciona un projecte per comprovar-ne l’accés.</p>}</article>
    {internalError&&<p role="alert">{internalError}</p>}
    {internal.map(connector=><article key={connector.id} className="rounded-xl border border-[var(--border)] p-4"><h4 className="font-semibold">{connector.label} · {connector.id==='g03-production'?'Full de producció':'Automatització'}</h4><p className="mt-2 text-sm">Dades desades a AI Brain. Selecciona «{connector.label}» a les eines del xat per consultar-ne els registres actuals.</p></article>)}
    <article className="rounded-xl border border-[var(--border)] p-4"><h4 className="font-semibold">Sage 200 · Solitium</h4><p className="mt-2 text-sm">Pendent de confirmació i de rebre l’API.</p></article>
    <article className="rounded-xl border border-[var(--border)] p-4"><h4 className="font-semibold">Correu personal</h4><p className="mt-2 text-sm">Connecta la teva bústia per consultar el correu des del xat. Els resultats i avisos de treball es consulten dins d’AI Brain.</p></article>
  </section>;
}
