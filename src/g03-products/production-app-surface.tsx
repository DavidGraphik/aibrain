'use client';
import { useEffect,useRef,useState,useId } from 'react';
/** Generated code never receives credentials, same-origin DOM or arbitrary URLs. */
export function ProductionAppSurface({id,title,preview=false,previewWorkspaceId}:{id:string;title:string;preview?:boolean;previewWorkspaceId?:string}){
  const frame=useRef<HTMLIFrameElement>(null);const channel=`production-${useId().replace(/[^a-zA-Z0-9-]/g,'')}`;const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;
    const listener=(event:MessageEvent)=>{
      const message=event.data,target=frame.current?.contentWindow;
      if(!target||event.source!==target||message?.type!=='aibrain-app-data'||message.channel!==channel||typeof message.requestId!=='string'||message.requestId.length>50)return;
      const answer=(result:unknown,error?:string)=>{if(active&&frame.current?.contentWindow===target)target.postMessage({type:'aibrain-app-result',channel,requestId:message.requestId,result,error},'*');};
      // The server derives identity and binds id to this mounted app. Programs
      // cannot choose another app or fetch an operator endpoint.
      setError('');
      void fetch('/api/g03/apps/bridge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,sandbox:preview,...previewWorkspaceId?{previewWorkspaceId}:{},operation:message.operation,input:message.input})}).then(async response=>{
        const data=await response.json();if(!response.ok)throw Error(data.error??'No s’ha pogut executar.');answer(data);
      }).catch((cause:unknown)=>{const text=cause instanceof Error?cause.message:'Operació no disponible.';if(active)setError(text);answer(null,text);});
    };
    window.addEventListener('message',listener);return()=>{active=false;window.removeEventListener('message',listener);};
  },[channel,id,preview,previewWorkspaceId]);
  return <section aria-label={title}>{error&&<p role="alert">{error}</p>}<iframe ref={frame} key={`${id}-${channel}`} title={title} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" src={`/api/g03/apps/preview?id=${encodeURIComponent(id)}${preview?'':'&published=1'}&channel=${channel}`} style={{width:'100%',minHeight:'65vh',border:0,background:'white'}}/></section>;
}
